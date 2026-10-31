import http from "node:http";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { z } from "zod";
import { createServer } from "../src/index.js";
import { createPlatform } from "../src/platform.js";
import { loadUpstreamConfig } from "../src/upstream/config.js";

// Mock Adobe MCP endpoint: requires the bearer token + org header, exposes read, write and failing tools.
const seen = [];
const mock = http.createServer(async (req, res) => {
  seen.push({ auth: req.headers.authorization, org: req.headers["x-gw-ims-org-id"] });
  if (req.headers.authorization !== "Bearer secret-token") { res.writeHead(401).end(); return; }
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let body = ""; for await (const c of req) body += c;
  const s = new McpServer({ name: "mock-adobe", version: "1" });
  s.registerTool("list_audiences", { description: "List audiences", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: JSON.stringify([{ id: "a1", name: "Gold", owner: "pat@acme.com" }]) }] }));
  s.registerTool("create_destination", { description: "Create destination", inputSchema: { name: z.string() }, annotations: { readOnlyHint: false } }, async ({ name }) => ({ content: [{ type: "text", text: JSON.stringify({ id: "d1", name }) }] }));
  s.registerTool("boom", { description: "Always fails", inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "upstream exploded" }] }));
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { t.close(); s.close(); });
  await s.connect(t); await t.handleRequest(req, res, JSON.parse(body));
});
await new Promise((r) => mock.listen(0, r));
const url = `http://127.0.0.1:${mock.address().port}/mcp`;

// Config safety: tokens are never sent to non-Adobe hosts unless explicitly allowed.
assert.throws(() => loadUpstreamConfig({ ADOBE_IMS_TOKEN: "t", ADOBE_CDP_URL: "https://evil.example.com/mcp" }), /Refusing to send credentials/);
assert.throws(() => loadUpstreamConfig({ ADOBE_IMS_TOKEN: "t", ADOBE_CDP_URL: "http://rtcdp-mcp.adobe.io/mcp" }), /Refusing/);
assert.equal(loadUpstreamConfig({}).length, 0, "no token -> no live upstreams");
const defaults = loadUpstreamConfig({ ADOBE_IMS_TOKEN: "t" });
assert.deepEqual(defaults.map((d) => d.key), ["cdp", "aem", "cloud_manager", "marketo_mcp", "workfront_mcp", "marketing_agent", "brand_intelligence", "genstudio", "coworker"]);
assert.equal(defaults.find((d) => d.key === "cdp").url, "https://rtcdp-mcp.adobe.io/mcp");
assert.equal(defaults.find((d) => d.key === "workfront_mcp").url, "https://mcp.workfront.adobe.com/mcp/v1/workfront");

// Tool-route map: re-point a built-in tool at a live upstream tool.
const mapFile = fileURLToPath(new URL("./tmp-map.json", import.meta.url));
writeFileSync(mapFile, JSON.stringify({ "aep.list_audiences": { service: "cdp", tool: "list_audiences" } }));

const env = { USE_COWORKER_LOGIN: "0", ADOBE_ALLOW_CUSTOM_HOSTS: "1", ADOBE_UPSTREAMS: "cdp,cloud_manager,brand_intelligence", ADOBE_IMS_TOKEN: "secret-token", ADOBE_ORG_ID: "ORG@AdobeOrg", ADOBE_CDP_URL: url, ADOBE_CLOUD_MANAGER_URL: url, ADOBE_BRAND_INTELLIGENCE_URL: url, ADOBE_TOOL_MAP: mapFile };
const p = createPlatform({ env });
const status = await p.initUpstreams();
assert.deepEqual(status.filter((s) => s.service !== "email_lists").map((s) => [s.service, s.connected, s.tools]), [["cdp", true, 3], ["cloud_manager", true, 3], ["brand_intelligence", true, 3]]);
assert(seen.every((r) => r.auth === "Bearer secret-token" && r.org === "ORG@AdobeOrg"), "credentials + org header sent upstream");

async function as(userId) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer(undefined, { identity: p.auth.identityFor(userId), platform: p }).connect(st);
  const c = new Client({ name: userId, version: "1" }); await c.connect(ct);
  return async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); let j; try { j = JSON.parse(r.content[0].text); } catch { j = r.content[0].text; } return { err: !!r.isError, json: j, text: r.content[0].text, meta: r._meta }; };
}
const [ops, leader, creative, cm] = await Promise.all(["morgan.ops", "lee.leader", "riley.creative", "casey.cm"].map(as));

// Discovery + calls through the gateway
assert.equal((await ops("upstream_status")).json.length, 4); // 3 Adobe upstreams + local email_lists
assert((await ops("upstream_list_tools", { service: "cdp" })).json.map((t) => t.name).includes("list_audiences"));
let r = await leader("upstream_call", { service: "cdp", tool: "list_audiences" });
assert(!r.err && r.json[0].id === "a1" && r.meta.transport === "mcp-remote");
assert.equal(r.json[0].owner, "p***@acme.com", "PII masking applies to live responses");
assert(!JSON.stringify(r.meta).includes("secret-token"), "token never surfaced");

// cdp is a read-only upstream: every tool is classified read (upstream enforces), yet RBAC still gates the service
assert.equal((await ops("upstream_list_tools", { service: "cdp" })).json.find((t) => t.name === "create_destination").kind, "read");
// cloud_manager is not read-only: annotations drive kind, and role access applies (only marketing_ops has it)
assert.equal((await ops("upstream_list_tools", { service: "cloud_manager" })).json.find((t) => t.name === "create_destination").kind, "write");
assert.match((await cm("upstream_call", { service: "cloud_manager", tool: "list_audiences" })).text, /forbidden/);
assert(!(await ops("upstream_call", { service: "cloud_manager", tool: "create_destination", args: { name: "S3" } })).err);
// brand_intelligence maps to brand_concierge access: creative (read) may read but not write
assert(!(await creative("upstream_call", { service: "brand_intelligence", tool: "list_audiences" })).err);
assert.match((await creative("upstream_call", { service: "brand_intelligence", tool: "create_destination", args: { name: "x" } })).text, /forbidden/);

// Error normalization, unknown tool, unconnected service
assert.match((await ops("upstream_call", { service: "cloud_manager", tool: "boom" })).text, /upstream exploded/);
assert.match((await ops("upstream_call", { service: "cloud_manager", tool: "nope" })).text, /not_found|No capability/);
assert.match((await ops("upstream_call", { service: "genstudio", tool: "x" })).text, /not connected/);

// Built-in tool re-routed to live upstream by ADOBE_TOOL_MAP; audit records the real target
r = await ops("aep_list_audiences");
assert(!r.err && r.json[0].id === "a1" && r.meta.service === "cdp");
assert((await ops("gateway_audit_log", { service: "cdp" })).json.entries.length >= 2);

// Auth failure upstream is reported, not fatal
const bad = createPlatform({ env: { ...env, ADOBE_IMS_TOKEN: "wrong", ADOBE_UPSTREAMS: "cdp" } });
const bs = await bad.initUpstreams();
const bad_cdp = bs.find((s) => s.service === "cdp");
assert.equal(bad_cdp.connected, false); assert(bad_cdp.error);
console.log("upstream OK");
const fs = await import("node:fs"); fs.unlinkSync(mapFile);
mock.close(); process.exit(0);
