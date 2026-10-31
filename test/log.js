import assert from "node:assert/strict";
import { log, clean, traced, withContext, loggedFetch, setSink } from "../src/log.js";

process.env.LOG_LEVEL = "debug";
const entries = [];
setSink((e) => entries.push(e));
const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJ1c2VyX2lkIjoiYWJjIn0.c2lnbmF0dXJlMTIzNDU2";

// redaction
const c = clean({ access_token: "x", authorization: `Bearer ${jwt}`, code: "abc", email: "pat@example.com", note: `see ${jwt} and kim@example.com`, tech: "C3F39E0A@techacct.adobe.com",
  org: "D0819D81@AdobeOrg", identity: { a: 1 }, nested: { client_secret: "s", ok: 1 } });
assert.equal(c.access_token, "[redacted]");
assert.equal(c.authorization, "[redacted]");
assert.equal(c.code, "[redacted]");
assert.equal(c.email, "p***@example.com");
assert.ok(!c.note.includes("eyJ") && c.note.includes("[jwt]") && c.note.includes("k***@example.com"));
assert.equal(c.tech, "C3F39E0A@techacct.adobe.com");
assert.equal(c.org, "D0819D81@AdobeOrg");
assert.equal(c.identity, "[redacted]");
assert.equal(c.nested.client_secret, "[redacted]");
assert.equal(c.nested.ok, 1);

// levels + context
process.env.LOG_LEVEL = "warn";
log.info("hidden");
log.warn("shown", { a: 1 });
assert.deepEqual(entries.map((e) => e.event), ["shown"]);
process.env.LOG_LEVEL = "debug";
entries.length = 0;
withContext({ requestId: "req_1", user: "u1" }, () => log.info("ctx"));
assert.equal(entries[0].requestId, "req_1");

// traced
entries.length = 0;
assert.equal(await traced("t", { tool: "x" }, async () => 42), 42);
await assert.rejects(traced("t", { tool: "y" }, async () => { throw Object.assign(new Error("boom"), { status: 401 }); }), /boom/);
assert.deepEqual(entries.map((e) => `${e.event}:${e.level}`), ["t.start:debug", "t.end:info", "t.start:debug", "t.error:warn"]);
assert.equal(entries[3].error.status, 401);
assert.equal(typeof entries[1].ms, "number");

// loggedFetch: no query values, no token bodies, error body logged
entries.length = 0;
const mock = async () => new Response('{"error":"nope"}', { status: 401, headers: { "x-request-id": "rid1" } });
const f = loggedFetch(mock, "ims");
await f("https://ims.example.com/token?code=SECRET&x=1", { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: "cid", client_secret: "SHH" }) });
const call = entries.find((e) => e.event === "api.call");
assert.equal(call.url, "https://ims.example.com/token");
assert.equal(call.query, "code,x");
assert.equal(call.status, 401);
assert.equal(call.requestId, "rid1");
assert.equal(call.grant, "client_credentials");
assert.ok(!JSON.stringify(call).includes("SECRET") && !JSON.stringify(call).includes("SHH"));

entries.length = 0;
await loggedFetch(async () => new Response("{}"), "mcp")("https://x.example.com/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_audiences" } }) });
assert.equal(entries[0].rpc, "tools/call");
assert.equal(entries[0].rpcTool, "search_audiences");

console.log("log ok");
