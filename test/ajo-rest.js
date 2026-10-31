import assert from "node:assert/strict";
import { AjoRestAgent } from "../src/upstream/ajo-rest.js";

const calls = [];
const items = [{ id: "t1", name: "Welcome email", templateType: "html", labels: ["a"], modifiedAt: "2026-01-01" }, { id: "t2", name: "Promo", templateType: "html" }, { id: "t3", name: "Code snippet", templateType: "fragment" }];
const fetchImpl = async (url, init) => { calls.push({ url: String(url), h: init.headers }); return new Response(JSON.stringify({ page: { count: 2 }, items }), { status: 200 }); };
const ctx = (mode, token, key, sandbox) => ({ mode, principal: { type: mode === "delegated" ? "user" : "technical_account", id: "p" }, sandbox, provider: { getToken: async () => token }, headers: { "x-api-key": key, "x-gw-ims-org-id": "ORG@AdobeOrg", ...(sandbox && { "x-sandbox-name": sandbox }) } });
const agent = new AjoRestAgent({ fetchImpl });

// the acting principal and credentials come from the token broker's auth context, never chosen by the agent
let r = await agent.call("list_email_templates", { name: "wel" }, {}, ctx("delegated", "pat-token", "web-client", "dev"));
assert.equal(r.calledAs, "delegated"); assert.deepEqual(r.templates.map((t) => t.id), ["t1"]);
assert.equal(calls[0].h.authorization, "Bearer pat-token"); assert.equal(calls[0].h["x-api-key"], "web-client");
assert.equal(calls[0].h["x-sandbox-name"], "dev"); assert.equal(calls[0].h["x-gw-ims-org-id"], "ORG@AdobeOrg");
assert.match(calls[0].url, /^https:\/\/platform\.adobe\.io\/ajo\/content\/templates\?/);

r = await agent.call("list_email_templates", {}, {}, ctx("service", "shared-token", "s2s-client"));
assert.equal(r.calledAs, "service"); assert.equal(r.returned, 2); // fragment excluded
assert.equal(calls[1].h.authorization, "Bearer shared-token"); assert.equal(calls[1].h["x-sandbox-name"], "prod", "falls back to prod only when no sandbox is configured");

// no auth context -> refused (no implicit credential)
await assert.rejects(agent.call("list_email_templates", {}, { userId: "x" }), /auth context/);

// upstream errors keep status, request id and body
const bad = new AjoRestAgent({ fetchImpl: async () => new Response('{"error":"nope"}', { status: 403, headers: { "x-request-id": "rid-1" } }) });
await assert.rejects(bad.call("list_email_templates", {}, {}, ctx("service", "t", "k")), (e) => e.name === "UpstreamError" && e.status === 403 && e.requestId === "rid-1" && e.body.includes("nope"));
await assert.rejects(agent.call("list_email_templates", { limit: 500 }, {}, ctx("service", "t", "k")));
console.log("ajo rest OK");
process.exit(0);
