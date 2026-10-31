import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

// Real HTTP server on an ephemeral port; exercises API-key auth and the full OAuth + PKCE flow ChatGPT uses.
process.env.LOGIN_SECRET = "test-login-secret-1234567890";
process.env.MCP_API_KEY = "test-api-key-abcdefghijklmnop12345";
process.env.MCP_API_KEY_USER = "lee.leader";
process.env.PUBLIC_URL = "https://mcp.example.test";
// Consent-page mode: blank Adobe sign-in settings so values from a developer's .env don't switch modes.
for (const k of ["ADOBE_SIGNIN_CLIENT_ID", "ADOBE_SIGNIN_CLIENT_SECRET", "ADOBE_SIGNIN_REDIRECT_URI"]) process.env[k] = "";
delete process.env.ADOBE_CLIENT_ID; delete process.env.ADOBE_CLIENT_SECRET;
const { startHttp } = await import("../src/http.js");
const server = await startHttp({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const form = (o) => new URLSearchParams(o).toString();
const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const rpc = (token, method = "tools/list") => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }) });

// --- API key (Codex)
assert.equal((await rpc(null)).status, 401);
const unauth = await rpc("wrong");
assert.equal(unauth.status, 401);
assert.match(unauth.headers.get("www-authenticate"), /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource"/);
const ok = await rpc(process.env.MCP_API_KEY);
assert.equal(ok.status, 200); assert.match(await ok.text(), /"tools"/);

// --- discovery
const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
assert.equal(prm.resource, "https://mcp.example.test/mcp"); assert.deepEqual(prm.authorization_servers, ["https://mcp.example.test"]);
const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]); assert.equal(asm.token_endpoint, "https://mcp.example.test/oauth/token");

// --- dynamic client registration: untrusted redirect hosts are refused
assert.equal((await post("/oauth/register", { redirect_uris: ["https://evil.example/cb"] }, { "content-type": "application/json" })).status, 400);
assert.equal((await post("/oauth/register", { redirect_uris: ["http://chatgpt.com/cb"] }, { "content-type": "application/json" })).status, 400);
const reg = await post("/oauth/register", { client_name: "ChatGPT", redirect_uris: [REDIRECT] }, { "content-type": "application/json" });
assert.equal(reg.status, 201); const { client_id } = await reg.json();

// --- authorize: PKCE is mandatory; consent needs the login secret; failures never yield a code
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const q = { response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "mcp" };
assert.equal((await fetch(`${base}/oauth/authorize?${form({ ...q, redirect_uri: "https://evil.example/cb" })}`)).status, 400, "unregistered redirect is never redirected to");
const noPkce = await fetch(`${base}/oauth/authorize?${form({ ...q, code_challenge: "" })}`, { redirect: "manual" });
assert.equal(noPkce.status, 302); assert.match(noPkce.headers.get("location"), /error=invalid_request/);
const consent = await fetch(`${base}/oauth/authorize?${form(q)}`);
assert.equal(consent.status, 200); assert.match(await consent.text(), /Server login secret/);
const bad = await post("/oauth/authorize", form({ ...q, user_id: "lee.leader", secret: "wrong" }));
assert.equal(bad.status, 401); assert(!(bad.headers.get("location") ?? "").includes("code="));
const approve = await post("/oauth/authorize", form({ ...q, user_id: "lee.leader", secret: process.env.LOGIN_SECRET }));
assert.equal(approve.status, 302);
const loc = new URL(approve.headers.get("location"));
assert.equal(loc.origin + loc.pathname, REDIRECT); assert.equal(loc.searchParams.get("state"), "xyz");
const code = loc.searchParams.get("code"); assert(code);

// --- token: wrong verifier burns the code; correct exchange works once
const tok = (o) => post("/oauth/token", form({ client_id, ...o }));
assert.equal((await tok({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: "wrong-verifier" })).status, 400);
assert.equal((await tok({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier })).status, 400, "code is single use");
const code2 = new URL((await post("/oauth/authorize", form({ ...q, user_id: "lee.leader", secret: process.env.LOGIN_SECRET }))).headers.get("location")).searchParams.get("code");
const t = await (await tok({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, code_verifier: verifier })).json();
assert(t.access_token && t.refresh_token && t.token_type === "Bearer" && t.expires_in > 0);

// --- the issued access token works on /mcp as the chosen identity
const viaOauth = await rpc(t.access_token);
assert.equal(viaOauth.status, 200); assert.match(await viaOauth.text(), /"tools"/);

// --- refresh rotates the token; the old one is dead
const r = await (await tok({ grant_type: "refresh_token", refresh_token: t.refresh_token })).json();
assert(r.access_token && r.refresh_token && r.refresh_token !== t.refresh_token);
assert.equal((await tok({ grant_type: "refresh_token", refresh_token: t.refresh_token })).status, 400);
assert.equal((await rpc(r.access_token)).status, 200);
assert.equal((await post("/oauth/token", form({ client_id: "unknown", grant_type: "refresh_token", refresh_token: r.refresh_token }))).status, 401);

// --- brute force on the consent secret is throttled
let last;
for (let i = 0; i < 6; i++) last = await post("/oauth/authorize", form({ ...q, user_id: "lee.leader", secret: `guess${i}` }));
assert.equal(last.status, 429);

console.log("oauth server OK");
server.close(); process.exit(0);
