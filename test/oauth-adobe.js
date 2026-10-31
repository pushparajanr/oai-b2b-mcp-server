import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

// Adobe sign-in mode against a local stand-in for IMS (authorize is only redirected to; token + userinfo are served).
const ims = { accounts: { good: "pat@acme.test", other: "intruder@evil.test" }, tokens: new Map(), codes: new Map(), seen: [] };
const imsSrv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"); let body = ""; for await (const c of req) body += c;
  const send = (code, o) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
  if (u.pathname === "/ims/token") {
    const f = new URLSearchParams(body); ims.seen.push(Object.fromEntries(f));
    if (f.get("client_id") !== "web-client" || f.get("client_secret") !== "web-secret" || f.get("redirect_uri") !== "https://mcp.example.test/oauth/adobe/callback" || !ims.codes.has(f.get("code"))) return send(400, { error: "invalid_grant" });
    const token = `at_${randomBytes(6).toString("hex")}`; ims.tokens.set(token, ims.codes.get(f.get("code"))); ims.codes.delete(f.get("code"));
    return send(200, { access_token: token, expires_in: 3600 });
  }
  if (u.pathname === "/ims/userinfo") {
    const email = ims.tokens.get((req.headers.authorization ?? "").replace("Bearer ", ""));
    return email ? send(200, { sub: `sub-${email}`, email, name: "Test User" }) : send(401, { error: "invalid_token" });
  }
  send(404, {});
});
await new Promise((r) => imsSrv.listen(0, r));
const imsBase = `http://127.0.0.1:${imsSrv.address().port}`;

Object.assign(process.env, {
  LOGIN_SECRET: "test-login-secret-1234567890", PUBLIC_URL: "https://mcp.example.test", ADOBE_ALLOW_CUSTOM_HOSTS: "1",
  ADOBE_SIGNIN_CLIENT_ID: "web-client", ADOBE_SIGNIN_CLIENT_SECRET: "web-secret", ADOBE_SIGNIN_REDIRECT_URI: "https://mcp.example.test/oauth/adobe/callback",
  ADOBE_IMS_AUTHORIZE_URL: `${imsBase}/ims/authorize`, ADOBE_IMS_URL: `${imsBase}/ims/token`, ADOBE_IMS_USERINFO_URL: `${imsBase}/ims/userinfo`,
  OAUTH_ALLOWED_EMAILS: "pat@acme.test:marketing_ops", MCP_API_KEY: "", ADOBE_COWORKER_SCOPES: "offline_access,additional_info.roles",
});
const { startHttp } = await import("../src/http.js");
const { platform } = await import("../src/platform.js");
const server = await startHttp({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const form = (o) => new URLSearchParams(o).toString();
const json = { "content-type": "application/json" };

const reg = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: json, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT] }) })).json();
const verifier = randomBytes(32).toString("base64url");
const q = { response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "st1" };

async function startSignin() {
  const r = await fetch(`${base}/oauth/authorize?${form(q)}`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const adobe = new URL(r.headers.get("location"));
  assert.equal(adobe.origin + adobe.pathname, `${imsBase}/ims/authorize`, "login goes to Adobe, not a local user picker");
  assert.equal(adobe.searchParams.get("client_id"), "web-client");
  assert.equal(adobe.searchParams.get("redirect_uri"), "https://mcp.example.test/oauth/adobe/callback");
  assert.equal(adobe.searchParams.get("response_type"), "code");
  assert.equal(adobe.searchParams.get("scope"), "openid,AdobeID,profile,offline_access,additional_info.roles", "coworker scopes are requested at sign-in");
  const cookie = r.headers.get("set-cookie");
  assert.match(cookie, /oauth_tx=.*HttpOnly.*SameSite=Lax/);
  return { state: adobe.searchParams.get("state"), cookie: cookie.split(";")[0] };
}
const callback = (qs, cookie) => fetch(`${base}/oauth/adobe/callback?${form(qs)}`, { redirect: "manual", headers: cookie ? { cookie } : {} });

// consent-page POST is disabled in Adobe mode
assert.equal((await fetch(`${base}/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ ...q, user_id: "morgan.ops", secret: process.env.LOGIN_SECRET }) })).status, 404);

// callback without the browser-bound cookie or with unknown state is rejected (login CSRF)
let tx = await startSignin(); ims.codes.set("c1", "pat@acme.test");
assert.equal((await callback({ code: "c1", state: tx.state })).status, 400, "missing cookie");
assert.equal((await callback({ code: "c1", state: "nope" }, tx.cookie)).status, 400, "unknown state");

// allow-listed Adobe account: full flow to an MCP token
tx = await startSignin(); ims.codes.set("c2", "pat@acme.test");
const ok = await callback({ code: "c2", state: tx.state }, tx.cookie);
assert.equal(ok.status, 302);
const conns = platform.broker.connectionsFor("adobe:pat@acme.test");
assert.deepEqual(conns.map((c) => c.connection), ["coworker"], "coworker login keeps the sign-in token as the user's coworker connection");
assert.equal(platform.authPolicy.rule("coworker", "x").mode, "delegated");
assert.equal(platform.authPolicy.rule("aep", "x").mode, "service", "other services keep their configured mode");
const back = new URL(ok.headers.get("location"));
assert.equal(back.origin + back.pathname, REDIRECT); assert.equal(back.searchParams.get("state"), "st1");
const tok = await (await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "authorization_code", client_id: reg.client_id, code: back.searchParams.get("code"), redirect_uri: REDIRECT, code_verifier: verifier }) })).json();
assert(tok.access_token, JSON.stringify(tok));
const rpc = await fetch(`${base}/mcp`, { method: "POST", headers: { ...json, accept: "application/json, text/event-stream", authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
assert.equal(rpc.status, 200);
assert.equal(ims.seen.at(-1).grant_type, "authorization_code");
assert.equal(ims.seen.at(-1).redirect_uri, "https://mcp.example.test/oauth/adobe/callback");

// the state is single use
assert.equal((await callback({ code: "c2", state: tx.state }, tx.cookie)).status, 400);

// valid Adobe account that is NOT on the allow-list is refused and gets no code
tx = await startSignin(); ims.codes.set("c3", "intruder@evil.test");
const denied = await callback({ code: "c3", state: tx.state }, tx.cookie);
assert.equal(denied.status, 403); assert(!(denied.headers.get("location") ?? "").includes("code="));

// user cancels at Adobe -> access_denied back to the client
tx = await startSignin();
const cancelled = await callback({ error: "access_denied", state: tx.state }, tx.cookie);
assert.equal(cancelled.status, 302); assert.match(cancelled.headers.get("location"), /error=access_denied/);

// bad code from Adobe -> failure page, no redirect with a code
tx = await startSignin();
assert.equal((await callback({ code: "forged", state: tx.state }, tx.cookie)).status, 502);

console.log("oauth adobe sign-in OK");
server.close(); imsSrv.close(); process.exit(0);
