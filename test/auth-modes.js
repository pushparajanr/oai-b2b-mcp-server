import http from "node:http";
import { createHash } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { createServer } from "../src/index.js";
import { createPlatform } from "../src/platform.js";
import { startHttp } from "../src/http.js";
import { AuthPolicy } from "../src/auth/auth-policy.js";
import { TokenBroker } from "../src/auth/token-broker.js";

// ---------------- mock Adobe IMS ----------------
const WEB = { id: "web-app", secret: "web-sec" };
const S2S = { "s2s-default": "sec-default", "s2s-workfront": "sec-wf" };
const ims = { tokens: new Map(), codes: new Map(), log: [], n: 0 };
const imsSrv = http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const f = new URLSearchParams(b); const g = f.get("grant_type"); const client = f.get("client_id");
  ims.log.push({ grant: g, client, scope: f.get("scope") });
  const send = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  const mint = (rec, extra = {}) => { const t = `${rec.kind}_${rec.user ?? client}_${++ims.n}`; ims.tokens.set(t, rec); return { access_token: t, token_type: "bearer", expires_in: 3600, ...extra }; };
  if (g === "client_credentials") return S2S[client] && S2S[client] === f.get("client_secret") ? send(200, mint({ kind: "s2s", client })) : send(401, { error: "invalid_client" });
  if (client !== WEB.id || f.get("client_secret") !== WEB.secret) return send(401, { error: "invalid_client" });
  if (g === "authorization_code") {
    const c = ims.codes.get(f.get("code")); ims.codes.delete(f.get("code"));
    const ok = c && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === c.challenge && f.get("redirect_uri") === c.redirectUri;
    return ok ? send(200, mint({ kind: "user", client, user: c.user }, { refresh_token: `refresh_${c.user}` })) : send(400, { error: "invalid_grant" });
  }
  if (g === "refresh_token") return send(200, mint({ kind: "user", client, user: f.get("refresh_token").replace("refresh_", "") }));
  send(400, { error: "unsupported_grant_type" });
});

// ---------------- mock Adobe MCP (enforces token + x-api-key pairing) ----------------
const calls = [];
let caller = null;
const mcpSrv = http.createServer(async (req, res) => {
  const tok = (req.headers.authorization ?? "").replace("Bearer ", ""); const rec = ims.tokens.get(tok);
  const entry = { kind: rec?.kind, client: rec?.client, user: rec?.user, apiKey: req.headers["x-api-key"], org: req.headers["x-gw-ims-org-id"], sandbox: req.headers["x-sandbox-name"] };
  if (!rec || entry.apiKey !== rec.client) { res.writeHead(401).end(); return; } // a token must be paired with the client id that issued it
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let body = ""; for await (const c of req) body += c;
  const msg = JSON.parse(body); const tool = msg.method === "tools/call" ? msg.params.name : msg.method;
  calls.push({ ...entry, tool });
  if (tool === "http403") return void res.writeHead(403, { "x-request-id": "rid-403" }).end('{"error":"no access to sandbox"}');
  if (tool === "http500") return void res.writeHead(500, { "x-request-id": "rid-500" }).end("internal boom");
  caller = entry;
  const s = new McpServer({ name: "mock-adobe", version: "1" });
  const ro = { readOnlyHint: true };
  s.registerTool("read_items", { description: "read", inputSchema: {}, annotations: ro }, async () => ({ content: [{ type: "text", text: JSON.stringify({ items: [1] }) }] }));
  s.registerTool("whoami", { description: "who", inputSchema: {}, annotations: ro }, async () => ({ content: [{ type: "text", text: JSON.stringify({ kind: caller.kind, user: caller.user ?? null }) }] }));
  s.registerTool("http403", { description: "403", inputSchema: {}, annotations: ro }, async () => ({ content: [] }));
  s.registerTool("http500", { description: "500", inputSchema: {}, annotations: ro }, async () => ({ content: [] }));
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { t.close(); s.close(); });
  await s.connect(t); await t.handleRequest(req, res, msg);
});
await Promise.all([imsSrv, mcpSrv].map((s) => new Promise((r) => s.listen(0, r))));
const probe = http.createServer(); await new Promise((r) => probe.listen(0, r)); const appPort = probe.address().port; await new Promise((r) => probe.close(r));
const BASE = `http://127.0.0.1:${appPort}`; const imsBase = `http://127.0.0.1:${imsSrv.address().port}`; const mcpUrl = `http://127.0.0.1:${mcpSrv.address().port}/mcp`;

// ---------------- configuration under test ----------------
const policyFile = new URL("./tmp-auth-policy.json", import.meta.url).pathname;
writeFileSync(policyFile, JSON.stringify({
  services: { cdp: { mode: "service", sandbox: "prod", sandboxes: ["prod", "dev"] }, aem: { mode: "service" }, workfront_mcp: { mode: "service", credential: "workfront" }, marketing_agent: { mode: "delegated" } },
  operations: { "aem.whoami": { mode: "delegated" }, "cdp.http500": { allowedRoles: ["marketing_ops"] } },
}));
let t = Date.now(); const now = () => t;
const env = { ADOBE_ALLOW_CUSTOM_HOSTS: "1", ADOBE_UPSTREAMS: "cdp,aem,workfront_mcp,marketing_agent", ADOBE_AUTH_POLICY: policyFile,
  ADOBE_CLIENT_ID: "s2s-default", ADOBE_CLIENT_SECRET: "sec-default", ADOBE_SCOPES: "scopeB,scopeA", ADOBE_ORG_ID: "ORG@AdobeOrg", ADOBE_SANDBOX_NAME: "prod",
  ADOBE_CRED_WORKFRONT_CLIENT_ID: "s2s-workfront", ADOBE_CRED_WORKFRONT_CLIENT_SECRET: "sec-wf", ADOBE_CRED_WORKFRONT_SCOPES: "wfscope", ADOBE_CRED_WORKFRONT_ORG_ID: "WFORG@AdobeOrg",
  ADOBE_SIGNIN_CLIENT_ID: WEB.id, ADOBE_SIGNIN_CLIENT_SECRET: WEB.secret, ADOBE_SIGNIN_SCOPES: "openid,AdobeID",
  ADOBE_IMS_URL: `${imsBase}/token`, ADOBE_IMS_AUTHORIZE_URL: `${imsBase}/authorize`, PUBLIC_URL: BASE,
  ADOBE_CDP_URL: mcpUrl, ADOBE_AEM_URL: mcpUrl, ADOBE_WORKFRONT_MCP_URL: mcpUrl, ADOBE_MARKETING_AGENT_URL: mcpUrl };
const p = createPlatform({ env, now });
const status = await p.initUpstreams();
assert.deepEqual(status.map((s) => s.connected), [true, true, true, true], JSON.stringify(status));
assert(calls.every((c) => c.kind === "s2s"), "startup discovery uses service credentials only");
const app = await startHttp({ port: appPort, platform: p });

const inv = (user, service, tool, args = {}) => p.gateway.invoke({ identity: p.auth.identityFor(user), service, tool, args });
const fails = async (user, service, tool, args) => inv(user, service, tool, args).then(() => assert.fail(`${service}.${tool} should have failed`), (e) => e);
const toolCalls = (tool) => calls.filter((c) => c.tool === tool);

// ---- 1. SERVICE mode: S2S token + the S2S client id (never the web-app id) + org + trusted sandbox; principal audited
let r = await inv("casey.cm", "cdp", "read_items");
let c = toolCalls("read_items").at(-1);
assert.deepEqual([c.kind, c.client, c.apiKey, c.org, c.sandbox], ["s2s", "s2s-default", "s2s-default", "ORG@AdobeOrg", "prod"]);
assert.deepEqual(r.meta.auth, { mode: "service", principal: { type: "technical_account", id: "s2s-default", credential: "default", orgId: "ORG@AdobeOrg" } });
let a = p.gateway.security.query({ user: "casey.cm", service: "cdp" }).at(-1);
assert.deepEqual([a.outcome, a.authMode, a.principal, a.user], ["ok", "service", "s2s-default", "casey.cm"], "audit records requesting user AND executing principal");

// ---- 2. separate credentials per service; service tokens cached by client + org + scope set
await inv("casey.cm", "workfront_mcp", "read_items");
c = toolCalls("read_items").at(-1);
assert.deepEqual([c.client, c.apiKey, c.org], ["s2s-workfront", "s2s-workfront", "WFORG@AdobeOrg"]);
await inv("morgan.ops", "aem", "read_items"); await inv("casey.cm", "cdp", "read_items");
const grants = (client) => ims.log.filter((x) => x.grant === "client_credentials" && x.client === client);
assert.equal(grants("s2s-default").length, 1, "one token shared by cdp+aem calls (same credential, org, scopes)");
assert.equal(grants("s2s-default")[0].scope, "scopeB,scopeA");
assert.equal(grants("s2s-workfront").length, 1);
const mk = (extra) => new TokenBroker({ env: { ...env, ...extra }, policy: AuthPolicy.load(env) });
const b1 = mk({}), b2 = mk({ ADOBE_CRED_OTHER_CLIENT_ID: "s2s-default", ADOBE_CRED_OTHER_CLIENT_SECRET: "sec-default", ADOBE_CRED_OTHER_SCOPES: "scopeA,scopeB" }), b3 = mk({ ADOBE_CRED_OTHER_CLIENT_ID: "s2s-default", ADOBE_CRED_OTHER_CLIENT_SECRET: "sec-default", ADOBE_CRED_OTHER_SCOPES: "scopeC", ADOBE_CRED_OTHER_ORG_ID: "X@AdobeOrg" });
assert.equal(b2.serviceProvider("other"), b2.serviceProvider("default"), "same client+org+scope set (any order) -> shared cache entry");
assert.notEqual(b3.serviceProvider("other"), b3.serviceProvider("default"), "different scopes/org -> separate cache entry");

// ---- 3. MISSING CONNECTION: delegated op without a connection asks for authorization and never uses the technical account
const before = calls.length;
let e = await fails("casey.cm", "marketing_agent", "read_items");
assert.equal(e.code, "connection_required"); assert.equal(e.details.connection, "adobe");
assert(e.details.connectUrl.startsWith(`${BASE}/connect/`), e.details.connectUrl);
assert.match(e.message, /will not use a technical account/);
assert.equal(calls.length, before, "no Adobe call was made on behalf of a user without a connection");
a = p.gateway.security.query({ outcome: "connection_required" }).at(-1);
assert.deepEqual([a.user, a.principal ?? null], ["casey.cm", null], "no executing principal when nothing ran");

// ---- 4. CONNECT flow (authorization code + PKCE, single-use, bound to the requesting user's browser session)
const startConnect = async (url) => fetch(url, { redirect: "manual" });
let start = await startConnect(e.details.connectUrl);
assert.equal(start.status, 302);
const loc = new URL(start.headers.get("location"));
assert.deepEqual([loc.origin, loc.pathname, loc.searchParams.get("client_id"), loc.searchParams.get("response_type"), loc.searchParams.get("code_challenge_method"), loc.searchParams.get("redirect_uri"), loc.searchParams.get("scope")],
  [imsBase, "/authorize", WEB.id, "code", "S256", `${BASE}/connect/callback`, "openid,AdobeID"]);
const state = loc.searchParams.get("state"); const cookie = start.headers.get("set-cookie").split(";")[0];
assert.match(start.headers.get("set-cookie"), /HttpOnly/);
const grantCode = (user) => { const code = `code_${++ims.n}`; ims.codes.set(code, { challenge: loc.searchParams.get("code_challenge"), user, redirectUri: `${BASE}/connect/callback` }); return code; };
const noCookie = await fetch(`${BASE}/connect/callback?code=${grantCode("casey.cm")}&state=${state}`);
assert.equal(noCookie.status, 400, "callback without the browser cookie is rejected");
start = await startConnect((await fails("casey.cm", "marketing_agent", "read_items")).details.connectUrl); // fresh link
const loc2 = new URL(start.headers.get("location")); const cookie2 = start.headers.get("set-cookie").split(";")[0];
const code2 = `code_${++ims.n}`; ims.codes.set(code2, { challenge: loc2.searchParams.get("code_challenge"), user: "casey.cm", redirectUri: `${BASE}/connect/callback` });
const done = await fetch(`${BASE}/connect/callback?code=${code2}&state=${loc2.searchParams.get("state")}`, { headers: { cookie: cookie2 } });
assert.equal(done.status, 200); assert.match(await done.text(), /Connected/);
const replay = await fetch(`${BASE}/connect/callback?code=${code2}&state=${loc2.searchParams.get("state")}`, { headers: { cookie: cookie2 } });
assert.equal(replay.status, 400, "authorization link is single use");
assert.equal((await fetch(`${BASE}/connect/not-a-real-id-xxxxxxxxxxxx`, { redirect: "manual" })).status, 400);

// ---- 5. DELEGATED mode: the user's own token + the web-app client id; other users are unaffected
r = await inv("casey.cm", "marketing_agent", "read_items");
c = toolCalls("read_items").at(-1);
assert.deepEqual([c.kind, c.user, c.client, c.apiKey], ["user", "casey.cm", WEB.id, WEB.id]);
assert.deepEqual([r.meta.auth.mode, r.meta.auth.principal.type, r.meta.auth.principal.id], ["delegated", "user", "casey.cm"]);
assert.equal((await fails("morgan.ops", "marketing_agent", "read_items")).code, "connection_required", "connections are per user");
// operation-level override: aem is service mode, but aem.whoami is delegated
assert.equal((await fails("morgan.ops", "aem", "whoami")).code, "connection_required");
const who = await inv("casey.cm", "aem", "whoami"); assert.equal(who.result.kind, "user");
assert.equal((await inv("morgan.ops", "aem", "read_items")).meta.auth.mode, "service");

// ---- 6. a denied delegated request is NOT retried with the technical account; upstream details are preserved
const k0 = calls.length;
e = await fails("casey.cm", "marketing_agent", "http403");
assert.equal(e.code, "upstream_forbidden");
assert.deepEqual([e.details.upstream.status, e.details.upstream.requestId], [403, "rid-403"]);
assert.match(e.details.upstream.body, /no access to sandbox/);
assert.deepEqual([e.details.principal.type, e.details.mode], ["user", "delegated"]);
assert.match(e.details.hint, /does not retry with a different credential/);
assert(calls.slice(k0).filter((x) => x.tool === "http403").every((x) => x.kind === "user"), "only the user's token was ever presented");

// ---- 7. a 5xx is reported as an upstream failure with its status/request id/body, not as an auth failure
e = await fails("morgan.ops", "cdp", "http500");
assert.equal(e.code, "upstream_error");
assert.deepEqual([e.details.upstream.status, e.details.upstream.requestId, e.details.upstream.body], [500, "rid-500", "internal boom"]);
assert.match(e.message, /does not by itself indicate an authentication problem/); assert(!e.details.hint);

// ---- 8. resource authorization: allowedRoles and sandbox come from trusted policy
const h0 = toolCalls("http500").length;
e = await fails("casey.cm", "cdp", "http500");
assert.equal(e.code, "forbidden"); assert.equal(toolCalls("http500").length, h0, "blocked before reaching Adobe");
await inv("casey.cm", "cdp", "read_items", { sandboxName: "dev" });
assert.equal(toolCalls("read_items").at(-1).sandbox, "dev");
assert.equal((await fails("casey.cm", "cdp", "read_items", { sandboxName: "secret" })).code, "sandbox_not_allowed");
assert.equal((await fails("casey.cm", "aem", "read_items", { sandboxName: "dev" })).code, "sandbox_not_allowed", "only the configured sandbox is allowed when no list is set");

// ---- 9. token renewal from expires_in (service and delegated), cached per credential / per user+connection
const count = (g) => ims.log.filter((x) => x.grant === g).length;
const [cc0, rf0] = [count("client_credentials"), count("refresh_token")];
t += 2 * 3_600_000;
await inv("casey.cm", "cdp", "read_items"); await inv("casey.cm", "marketing_agent", "read_items"); await inv("casey.cm", "marketing_agent", "read_items");
assert.equal(count("client_credentials"), cc0 + 1, "service token renewed once");
assert.equal(count("refresh_token"), rf0 + 1, "delegated token renewed once with its refresh token");
assert.equal(toolCalls("read_items").at(-1).user, "casey.cm");

// ---- 10. the MCP surface explains modes and connection state without exposing secrets
const [ct, st] = InMemoryTransport.createLinkedPair();
await createServer(undefined, { identity: p.auth.identityFor("morgan.ops"), platform: p }).connect(st);
const mcp = new Client({ name: "t", version: "1" }); await mcp.connect(ct);
const tool = async (name, args) => { const r = await mcp.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content[0].text }; };
let x = await tool("auth_explain", { service: "marketing_agent", tool: "read_items" });
assert.match(x.text, /"mode": "delegated"/); assert.match(x.text, /"connected": false/);
x = await tool("auth_explain", { service: "cdp", tool: "read_items" });
assert.match(x.text, /technical account s2s-default/);
x = await tool("upstream_call", { service: "marketing_agent", tool: "read_items" });
assert(x.err && /connection_required/.test(x.text) && /connectUrl/.test(x.text));
x = await tool("auth_connect", { connection: "adobe" }); assert.match(x.text, /\/connect\//);
x = await tool("auth_connections", {}); assert.match(x.text, /"connections": \[\]/);

// ---- 11. no secret or token appears in audit, metadata, status or errors
const dump = JSON.stringify([p.gateway.security.entries, p.upstreamStatus(), p.broker.connectionsFor("casey.cm"), r.meta]);
for (const s of ["sec-default", "sec-wf", "web-sec", "refresh_casey", "s2s_s2s", "user_casey"]) assert(!dump.includes(s), `leaked ${s}`);
assert(p.gateway.security.verifyChain(), "audit chain intact");

// ---- 12. policy loading and validation
assert.throws(() => new AuthPolicy({ services: { x: { mode: "both" } } }), /unknown mode/);
assert.equal(AuthPolicy.load({ ADOBE_USER_TOKEN_UPSTREAMS: "cdp" }).rule("cdp").mode, "delegated", "legacy env list maps to delegated");
assert.equal(AuthPolicy.load({ ADOBE_AUTH_MODE_AEM: "delegated" }).rule("aem", "x").mode, "delegated");
assert.equal(AuthPolicy.load({}).rule("workfront_mcp", "x").mode, "service", "default is service");

console.log(`auth modes e2e OK (IMS grants: ${ims.log.length}, Adobe calls: ${calls.length})`);
unlinkSync(policyFile); app.close(); imsSrv.close(); mcpSrv.close(); process.exit(0);
