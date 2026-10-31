import assert from "node:assert/strict";
import { MarketoRestAgent } from "../src/upstream/marketo-rest.js";

const env = { MARKETO_BASE_URL: "https://123-ABC-456.mktorest.com/rest", MARKETO_CLIENT_ID: "cid", MARKETO_CLIENT_SECRET: "sec" };
assert.equal(MarketoRestAgent.configured(env), true);
assert.equal(MarketoRestAgent.configured({}), false);

const calls = [];
let tokens = 0, expireNext = false;
const fetchImpl = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
  if (String(url).includes("/identity/oauth/token")) return json({ access_token: `tok${++tokens}`, expires_in: 3600 });
  if (expireNext) { expireNext = false; return json({ success: false, errors: [{ code: "602", message: "Access token expired" }] }); }
  return json({ success: true, result: [{ id: 1, name: "x" }], moreResult: false });
};
const agent = new MarketoRestAgent({ env, fetchImpl });
assert.equal(agent.selfAuth, true);
assert.ok(agent.tools.get_leads_by_email && agent.tools.list_programs);

const r = await agent.call("list_programs", { limit: 5 });
assert.equal(r.returned, 1);
const token = calls[0];
assert.equal(token.url, "https://123-ABC-456.mktorest.com/identity/oauth/token");
assert.match(String(token.init.body), /grant_type=client_credentials/);
assert.equal(calls[1].url, "https://123-ABC-456.mktorest.com/rest/asset/v1/programs.json?maxReturn=5&offset=0");
assert.equal(calls[1].init.headers.authorization, "Bearer tok1");

await agent.call("get_leads_by_email", { emails: ["a@b.com"] });
assert.equal(tokens, 1, "token is cached");
assert.match(calls.at(-1).url, /\/rest\/v1\/leads\.json\?filterType=email&filterValues=a%40b\.com/);

expireNext = true;
await agent.call("list_forms");
assert.equal(tokens, 2, "expired token (602) is refreshed once");
await assert.rejects(() => agent.call("nope"), /no tool/);

// ---- writes ----
const { EmailListAgent } = await import("../src/upstream/email-lists.js");
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = mkdtempSync(join(tmpdir(), "mk-"));
const lists = new EmailListAgent({ file: join(dir, "l.json") });
const me = { userId: "u1" };
const up = await lists.call("upload_email_list", { name: "L", csv: "email,firstName\nann@x.com,Ann\nbob@x.com,\"B, ob\"\n" }, me);

const w = [];
const wfetch = async (url, init = {}) => {
  const u = String(url); w.push({ url: u, init });
  const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => (typeof b === "string" ? b : JSON.stringify(b)) });
  if (u.includes("/identity/oauth/token")) return json({ access_token: "t", expires_in: 3600 });
  if (u.endsWith("/bulk/v1/leads.json")) return json({ success: true, result: [{ batchId: 77, status: "Queued", importId: "77" }] });
  if (u.endsWith("/bulk/v1/leads/batch/77.json")) return json({ success: true, result: [{ batchId: 77, status: "Complete", numOfLeadsProcessed: 1, numOfRowsFailed: 1, numOfRowsWithWarning: 0 }] });
  if (u.endsWith("/failures.json")) return { ok: true, status: 200, text: async () => "email,Import Failure Reason\nbad,Value for lookup field is invalid\n" };
  if (u.endsWith("/staticLists.json")) return json({ success: true, result: [{ id: 555, name: "NewList" }] });
  if (u.includes("/v1/leads.json")) return json({ success: true, result: [{ id: 11, email: "ann@x.com" }] });
  if (u.includes("/v1/lists/9/leads.json")) return json({ success: true, result: JSON.parse(init.body).input.map((i) => ({ id: i.id, status: init.method === "POST" ? "added" : "removed" })) });
  return json({ success: false, errors: [{ code: "1", message: "unexpected " + u }] }, 400);
};
const mk = new MarketoRestAgent({ env, fetchImpl: wfetch, emailLists: lists });
assert.equal(mk.readOnly, false);
assert.equal(mk.tools.import_leads_csv.annotations.readOnlyHint, false);
assert.equal(mk.tools.list_programs.annotations.readOnlyHint, true);

// import from an uploaded email list (multipart to the bulk host, header validated)
const imp = await mk.call("import_leads_csv", { emailListId: up.listId, listId: 9 }, me);
assert.deepEqual([imp.batchId, imp.rows, imp.addedToListId], [77, 2, 9]);
const bulk = w.find((x) => x.url.endsWith("/bulk/v1/leads.json"));
assert.equal(bulk.url, "https://123-ABC-456.mktorest.com/bulk/v1/leads.json");
const fd = bulk.init.body;
assert.equal(fd.get("format"), "csv"); assert.equal(fd.get("listId"), "9"); assert.equal(fd.get("lookupField"), "email");
assert.equal(await fd.get("file").text(), 'email,firstName\nann@x.com,Ann\nbob@x.com,"B, ob"');
await assert.rejects(() => mk.call("import_leads_csv", { csv: "name\nx" }, me), /must include the 'email' column/);
await assert.rejects(() => mk.call("import_leads_csv", {}, me), /Provide/);
await assert.rejects(() => mk.call("import_leads_csv", { emailListId: up.listId }, { userId: "other" }), /Unknown email list/);
const st = await mk.call("import_leads_status", { batchId: 77 });
assert.equal(st.status, "Complete"); assert.match(st.failuresCsv, /lookup field is invalid/);

// static list creation
const sl = await mk.call("create_static_list", { name: "NewList", folderId: 12, folderType: "Program" });
assert.equal(sl.result[0].id, 555);
const slReq = w.find((x) => x.url.endsWith("/staticLists.json"));
assert.equal(String(slReq.init.body), `name=NewList&folder=${encodeURIComponent('{"id":12,"type":"Program"}')}`);

// membership: emails resolved to ids, unknown reported, chunked JSON body
const m = await mk.call("update_list_membership", { listId: 9, action: "add", leadIds: [5], emails: ["Ann@x.com", "ghost@x.com"] });
assert.deepEqual(m.emailsNotFound, ["ghost@x.com"]);
assert.deepEqual(m.result.map((r) => [r.id, r.status]), [[5, "added"], [11, "added"]]);
const rm = await mk.call("update_list_membership", { listId: 9, action: "remove", leadIds: [5] });
assert.equal(w.at(-1).init.method, "DELETE"); assert.equal(rm.result[0].status, "removed");
await assert.rejects(() => mk.call("update_list_membership", { listId: 9, action: "add", emails: ["ghost@x.com"] }), /No leads/);
rmSync(dir, { recursive: true, force: true });
console.log("marketo-rest ok");
