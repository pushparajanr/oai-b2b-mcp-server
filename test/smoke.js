import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { createServer } from "../src/index.js";

const [ct, st] = InMemoryTransport.createLinkedPair();
await createServer().connect(st);
const client = new Client({ name: "t", version: "1" });
await client.connect(ct);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0].text;
  return { err: !!r.isError, text: t, json: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};

console.log("tools:", (await client.listTools()).tools.length);
const { campaignId } = (await call("create_campaign", { name: "Spring" })).json;
await call("ingest_brief", { campaignId, brief: "Goal: drive signups. Use email and sms." });
await call("remix_journey_template", { campaignId, templateId: "tpl_welcome" });
let r = await call("launch_campaign", { campaignId, confirm: true });
assert(r.err, "launch must be gated");
const aud = (await call("ingest_audience_csv", { name: "A", csv: "email,name\na@x.com,A\nbad,B\na@x.com,C", connector: "hubspot" })).json;
assert.equal(aud.valid, 1);
await call("validate_audience", { campaignId, audienceId: aud.id });
const snd = (await call("setup_sender_domain", { domain: "x.com", senderEmail: "hi@x.com" })).json;
await call("select_sender", { campaignId, senderId: snd.id });
const j = (await call("get_journey", { campaignId })).json;
for (const s of j.steps.filter((s) => s.emailId)) {
  await call("edit_email", { campaignId, emailId: s.emailId, html: "<p>Hello</p>" });
}
assert((await call("check_workflow_completion", { campaignId })).json.blockers.length === 1, "unverified domain");
const v = (await call("verify_sender_domain", { senderId: snd.id, observed: snd.records.map((x) => ({ name: x.name, value: x.expected })) })).json;
assert(v.verified);
const first = j.steps.find((s) => s.emailId);
assert((await call("send_test_email", { campaignId, emailId: first.emailId, recipients: ["q@x.com"] })).json.from === "hi@x.com");
await call("undo_email_edit", { campaignId, emailId: first.emailId });
await call("redo_email_edit", { campaignId, emailId: first.emailId });
assert((await call("launch_campaign", { campaignId, confirm: true })).json.launched);
assert.equal((await call("get_post_launch_status", { campaignId })).json.state, "ready_awaiting_data");
await call("record_email_metrics", { campaignId, stepId: first.id, delivered: 100, opens: 40, clicks: 10, bounces: 2 });
assert.equal((await call("get_email_metrics", { campaignId })).json[0].openRate, 40);
assert((await call("export_campaign_doc", { campaignId, format: "pdf" })).json.markdown.includes("mermaid"));
assert.equal((await call("list_native_setup_requirements")).json.length, 16);
console.log("OK");
process.exit(0);
