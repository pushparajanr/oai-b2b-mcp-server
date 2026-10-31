import http from "node:http";
import assert from "node:assert/strict";
import { UserUpstreamAuth } from "../src/upstream/user-auth.js";
import { RemoteAgent } from "../src/upstream/remote-agent.js";

// A stand-in upstream that records who called it (the MCP handshake fails, which is fine: we only inspect the headers).
const seen = [];
const upstream = http.createServer((req, res) => { seen.push({ auth: req.headers.authorization, key: req.headers["x-api-key"] }); res.writeHead(500).end(); });
await new Promise((r) => upstream.listen(0, r));
const url = `http://127.0.0.1:${upstream.address().port}/mcp`;

let refreshes = 0;
const fetchImpl = async (u, init) => {
  refreshes++;
  assert.equal(new URLSearchParams(init.body).get("grant_type"), "refresh_token");
  return new Response(JSON.stringify({ access_token: "refreshed-token", expires_in: 3600 }), { status: 200 });
};
let t = 1_000_000;
const ua = new UserUpstreamAuth({ tokenUrl: "http://ims.test/token", clientId: "web-client", clientSecret: "s", now: () => t, fetchImpl });
ua.set("adobe:pat", { accessToken: "pat-token", refreshToken: "pat-refresh", expiresIn: 3600 });
ua.set("adobe:noref", { accessToken: "noref-token", expiresIn: 60 });

const agent = new RemoteAgent({ key: "cdp", label: "CDP", note: "", url, headers: { "x-api-key": "shared-client", "x-gw-ims-org-id": "ORG" }, ims: null }, undefined, ua);
agent.tools = { search: { description: "", inputSchema: {}, annotations: {}, remote: true } };

// no user token (e.g. API-key / demo identity): refused, never falls back to the shared credential
await assert.rejects(agent.call("search", {}, { userId: "morgan.ops" }), /your own Adobe account/);
await assert.rejects(agent.call("search", {}), /your own Adobe account/);
assert.equal(seen.length, 0);

// signed-in user: their token and the sign-in app's client id are sent, never the shared credential
await agent.call("search", {}, { userId: "adobe:pat" }).catch(() => {});
assert(seen.length > 0);
assert(seen.every((s) => s.auth === "Bearer pat-token" && s.key === "web-client"));

// expired access token is renewed with the user's refresh token
seen.length = 0; t += 3_700_000;
await agent.call("search", {}, { userId: "adobe:pat" }).catch(() => {});
assert.equal(refreshes, 1);
assert(seen.some((s) => s.auth === "Bearer refreshed-token"));

// no refresh token: works until expiry, then asks the user to sign in again
await agent.call("search", {}, { userId: "adobe:noref" }).catch(() => {}); // already past its 60s lifetime
await assert.rejects(agent.call("search", {}, { userId: "adobe:noref" }), /sign-in expired|sign in again/i);

console.log("user upstream auth OK");
upstream.close(); process.exit(0);
