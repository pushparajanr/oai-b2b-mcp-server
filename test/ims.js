import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { createServer } from "../src/index.js";
import { createPlatform } from "../src/platform.js";
import { loadUpstreamConfig } from "../src/upstream/config.js";
import { ImsTokenProvider } from "../src/upstream/ims.js";

const CLIENT = { id: "client-123", secret: "s3cr3t-value", scope: "openid,AdobeID,rtcdp.read" };
const EXPIRES_IN = 1; // seconds, so expiry is observable
const ims = { issued: new Set(), requests: [], n: 0 };
const imsSrv = http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const f = new URLSearchParams(b); ims.requests.push(Object.fromEntries(f));
  const fail = (code, error) => { res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ error })); };
  if (req.method !== "POST" || req.url !== "/ims/token/v3") return fail(404, "not_found");
  if (!["client_credentials", "refresh_token"].includes(f.get("grant_type"))) return fail(400, "unsupported_grant_type");
  if (f.get("client_id") !== CLIENT.id || f.get("client_secret") !== CLIENT.secret) return fail(401, "invalid_client");
  if (f.get("grant_type") === "refresh_token" && f.get("refresh_token") !== "refresh-value") return fail(401, "invalid_refresh_token");
  const token = `ims_tok_${++ims.n}`; ims.issued.add(token);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: token, token_type: "bearer", expires_in: EXPIRES_IN, ...(f.get("grant_type") === "refresh_token" && { refresh_token: "refresh-value-next" }) }));
});
const up = { seen: [] };
const mcpSrv = http.createServer(async (req, res) => {
  const tok = (req.headers.authorization ?? "").replace("Bearer ", "");
  up.seen.push({ tok, apiKey: req.headers["x-api-key"], org: req.headers["x-gw-ims-org-id"] });
  if (!ims.issued.has(tok) || req.headers["x-api-key"] !== CLIENT.id) { res.writeHead(401).end(); return; }
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let body = ""; for await (const c of req) body += c;
  const s = new McpServer({ name: "mock-cdp", version: "1" });
  s.registerTool("list_audiences", { description: "List audiences", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: JSON.stringify([{ id: "a1", name: "Gold" }]) }] }));
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { t.close(); s.close(); });
  await s.connect(t); await t.handleRequest(req, res, JSON.parse(body));
});
await Promise.all([imsSrv, mcpSrv].map((s) => new Promise((r) => s.listen(0, r))));
const imsUrl = `http://127.0.0.1:${imsSrv.address().port}/ims/token/v3`;
const mcpUrl = `http://127.0.0.1:${mcpSrv.address().port}/mcp`;
const env = (over = {}) => ({ ADOBE_ALLOW_CUSTOM_HOSTS: "1", ADOBE_UPSTREAMS: "cdp", ADOBE_IMS_URL: imsUrl, ADOBE_CDP_URL: mcpUrl, ADOBE_CLIENT_ID: CLIENT.id, ADOBE_CLIENT_SECRET: CLIENT.secret, ADOBE_SCOPES: CLIENT.scope, ADOBE_ORG_ID: "ORG@AdobeOrg", ADOBE_IMS_SKEW_MS: "0", ...over });

// --- config safety
assert.throws(() => loadUpstreamConfig({ ADOBE_CLIENT_ID: "a", ADOBE_CLIENT_SECRET: "b", ADOBE_IMS_URL: "https://evil.example.com/token" }), /Refusing to send credentials/);
const dflt = loadUpstreamConfig({ ADOBE_CLIENT_ID: "a", ADOBE_CLIENT_SECRET: "b" });
assert.equal(dflt.length, 9); assert.equal(dflt[0].ims.tokenUrl, "https://ims-na1.adobelogin.com/ims/token/v3");
assert.equal(dflt[0].headers["x-api-key"], "a", "x-api-key defaults to the client id");
assert(!JSON.stringify(dflt.map((d) => d.headers)).includes("authorization"), "no static auth header when IMS is used");

// --- 1. bad credentials: reported, not fatal, secret never echoed
const bad = createPlatform({ env: env({ ADOBE_CLIENT_SECRET: "wrong-secret" }) });
const bs = await bad.initUpstreams();
assert.equal(bs[0].connected, false);
assert.match(bs[0].error, /IMS token request failed: 401 invalid_client/);
assert(!JSON.stringify(bs).includes("wrong-secret"));

// --- 2. happy path through the gateway
const p = createPlatform({ env: env() });
const st = await p.initUpstreams();
assert.deepEqual([st[0].connected, st[0].tools, st[0].auth], [true, 1, "ims-client-credentials"]);
assert.equal(ims.requests.at(-1).grant_type, "client_credentials");
assert.equal(ims.requests.at(-1).scope, CLIENT.scope);
assert(up.seen.at(-1).tok.startsWith("ims_tok_") && up.seen.at(-1).apiKey === CLIENT.id && up.seen.at(-1).org === "ORG@AdobeOrg");

async function as(userId) {
  const [ct, s] = InMemoryTransport.createLinkedPair();
  await createServer(undefined, { identity: p.auth.identityFor(userId), platform: p }).connect(s);
  const c = new Client({ name: userId, version: "1" }); await c.connect(ct);
  return async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); let j; try { j = JSON.parse(r.content[0].text); } catch { j = r.content[0].text; } return { err: !!r.isError, json: j, text: r.content[0].text, meta: r._meta }; };
}
const lee = await as("lee.leader"), ops = await as("morgan.ops");
let r = await lee("upstream_call", { service: "cdp", tool: "list_audiences" });
assert(!r.err && r.json[0].id === "a1", r.text);
assert.match((await as("riley.creative").then((f) => f("upstream_call", { service: "cdp", tool: "list_audiences" }))).text, /forbidden/, "RBAC still applies on top of IMS");

// --- 3. token is cached and reused
const provider = p.upstreams.get("cdp").auth;
await lee("upstream_call", { service: "cdp", tool: "list_audiences" });
await new Promise((r) => setTimeout(r, 1200)); // let the 1s token expire
const before = provider.requests;
r = await lee("upstream_call", { service: "cdp", tool: "list_audiences" });
assert(!r.err, r.text);
assert.equal(provider.requests, before + 1, "expired token refreshed exactly once");
const t2 = up.seen.at(-1).tok;

// --- 4. revoked token: upstream 401 -> invalidate -> refresh -> retry succeeds
ims.issued.clear(); ims.issued.add("never-matches");
const b2 = provider.requests;
r = await lee("upstream_call", { service: "cdp", tool: "list_audiences" });
assert(!r.err, `retry after 401 failed: ${r.text}`);
assert(provider.requests > b2 && up.seen.at(-1).tok !== t2, "fresh token obtained after 401");

// --- 5. single-flight: concurrent callers share one IMS request
const sf = new ImsTokenProvider({ tokenUrl: imsUrl, clientId: CLIENT.id, clientSecret: CLIENT.secret });
const ns = ims.requests.length;
const toks = await Promise.all(Array.from({ length: 8 }, () => sf.getToken()));
assert.equal(new Set(toks).size, 1); assert.equal(ims.requests.length - ns, 1);
assert.equal(sf.status().hasToken, true);
assert(!JSON.stringify(sf.status()).includes(CLIENT.secret), "status never exposes the secret");

// --- 6. OAuth Web App credentials use refresh-token grants and persist token rotation
const rotated = [];
const web = new ImsTokenProvider({
  tokenUrl: imsUrl, clientId: CLIENT.id, clientSecret: CLIENT.secret,
  refreshToken: "refresh-value", onRefreshToken: async (value) => rotated.push(value),
});
assert.match(await web.getToken(), /^ims_tok_/);
assert.equal(ims.requests.at(-1).grant_type, "refresh_token");
assert.equal(ims.requests.at(-1).refresh_token, "refresh-value");
assert.deepEqual(rotated, ["refresh-value-next"]);
assert.equal(web.status().method, "ims-refresh-token");
assert(!JSON.stringify(web.status()).includes("refresh-value"), "status never exposes the refresh token");

// --- 6. secret and tokens never leak via gateway outputs
const out = JSON.stringify([r.meta, (await ops("gateway_audit_log", { limit: 500 })).json, (await ops("upstream_status")).json, (await ops("gateway_monitoring")).json]);
assert(!out.includes(CLIENT.secret) && !/ims_tok_\d/.test(out), "no secret/token in audit, meta, status");

// --- 7. IMS outage surfaces as a transient error
const down = new ImsTokenProvider({ tokenUrl: "http://127.0.0.1:9/ims/token/v3", clientId: "x", clientSecret: "y" });
await assert.rejects(down.getToken(), (e) => e.transient === true && /IMS token request failed/.test(e.message));

console.log(`ims e2e OK (IMS token requests: ${ims.requests.length}, upstream calls: ${up.seen.length})`);

// --- 8. optional live check (real Adobe IMS), only when credentials are present and explicitly requested
if (process.env.LIVE_IMS === "1" && process.env.ADOBE_CLIENT_ID && process.env.ADOBE_CLIENT_SECRET) {
  const live = loadUpstreamConfig(process.env)[0].ims; await live.getToken(); console.log("LIVE IMS OK", live.status().expiresAt);
} else console.log("live IMS check skipped (set LIVE_IMS=1 with ADOBE_CLIENT_ID/ADOBE_CLIENT_SECRET, or run `npm run ims:check`)");
imsSrv.close(); mcpSrv.close(); process.exit(0);
