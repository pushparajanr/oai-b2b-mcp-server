import assert from "node:assert/strict";
import { AjoRestAgent } from "../src/upstream/ajo-rest.js";
import { UserUpstreamAuth } from "../src/upstream/user-auth.js";

const calls = [];
const fetchImpl = async (url, init) => {
  calls.push({ url: String(url), h: init.headers });
  return new Response(JSON.stringify({ page: { count: 2 }, items: [
    { id: "t1", name: "Welcome email", templateType: "html", labels: ["a"], modifiedAt: "2026-01-01" },
    { id: "t2", name: "Promo", templateType: "html" },
    { id: "t3", name: "Code snippet", templateType: "fragment" },
  ] }), { status: 200 });
};
const ims = { getToken: async () => "shared-token" };
const ua = new UserUpstreamAuth({ tokenUrl: "http://x", clientId: "web-client", clientSecret: "s" });
ua.set("adobe:pat", { accessToken: "pat-token", refreshToken: "r", expiresIn: 3600 });
const env = { ADOBE_ORG_ID: "ORG@AdobeOrg", ADOBE_CLIENT_ID: "s2s-client" };
const agent = new AjoRestAgent({ env, ims, userAuth: ua, fetchImpl });

let r = await agent.call("list_email_templates", { name: "wel", sandboxName: "dev" }, { userId: "adobe:pat" });
assert.equal(r.calledAs, "user"); assert.deepEqual(r.templates.map((t) => t.id), ["t1"]);
assert.equal(calls[0].h.authorization, "Bearer pat-token"); assert.equal(calls[0].h["x-api-key"], "web-client");
assert.equal(calls[0].h["x-sandbox-name"], "dev"); assert.equal(calls[0].h["x-gw-ims-org-id"], "ORG@AdobeOrg");
assert.match(calls[0].url, /^https:\/\/platform\.adobe\.io\/ajo\/content\/templates\?/);

r = await agent.call("list_email_templates", {}, { userId: "morgan.ops" });
assert.equal(r.calledAs, "shared"); assert.equal(r.returned, 2); // fragment excluded
assert.equal(calls[1].h.authorization, "Bearer shared-token"); assert.equal(calls[1].h["x-api-key"], "s2s-client");

const bad = new AjoRestAgent({ env, ims, fetchImpl: async () => new Response('{"error":"nope"}', { status: 403 }) });
await assert.rejects(bad.call("list_email_templates", {}, {}), /HTTP 403/);
await assert.rejects(agent.call("list_email_templates", { limit: 500 }, {}));
console.log("ajo rest OK");
process.exit(0);
