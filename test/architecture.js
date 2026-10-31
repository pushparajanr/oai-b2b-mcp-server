import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { createServer } from "../src/index.js";
import { startHttp } from "../src/http.js";
import { platform } from "../src/platform.js";

// One MCP client per persona, all sharing the same platform state.
async function as(userId) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer(undefined, { identity: platform.auth.identityFor(userId) }).connect(st);
  const c = new Client({ name: userId, version: "1" }); await c.connect(ct);
  return async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    const t = r.content[0].text; let json; try { json = JSON.parse(t); } catch { json = t; }
    return { err: !!r.isError, json, text: t, meta: r._meta };
  };
}
const [ops, cm, creative, brand, data, leader] = await Promise.all(["morgan.ops", "casey.cm", "riley.creative", "bailey.brand", "dana.data", "lee.leader"].map(as));
const ok = (r, m) => { assert(!r.err, `${m ?? ""} ${r.text}`); return r.json; };

// ---------- Layer 4: gateway ----------
assert.match((await leader("aep_create_schema", { name: "x", fields: { a: "string" }, identityField: "a" })).text, /forbidden/);      // RBAC: read-only role
assert.match((await creative("ajo_create_offer", { name: "o", content: "c" })).text, /forbidden/);                                  // role has ajo read only
assert.match((await creative("cja_get_campaign_performance", { campaignId: "x" })).text, /forbidden/);                              // no cja access at all
assert((await leader("gateway_capabilities", { service: "cja" })).json.every((c) => c.service === "cja"));
await creative("ajo_create_offer", { name: "o2", content: "c" }); // third denial for riley within the window
const denied = ok(await ops("gateway_audit_log", { outcome: "forbidden" }));
assert(denied.entries.length >= 3 && denied.chainValid, "denials audited, chain valid");
assert(ok(await ops("gateway_monitoring")).alerts.some((a) => a.type === "repeated_denials"), "alert on repeated denials");
assert.match((await cm("gateway_audit_log")).text, /forbidden/);                                                                       // audit log restricted
assert((await ops("aep_list_schemas")).meta.transport === "mcp" && (await ops("ajo_list_journeys")).meta.transport === "api");        // routing
assert(!JSON.stringify((await ops("aep_list_schemas")).meta).includes("ims_"), "product tokens never leak");

// tokens + tenancy + entitlement
const login = platform.auth.login({ userId: "casey.cm" });
assert.equal((await platform.gateway.invoke({ token: login.token, service: "aep", tool: "list_schemas" })).meta.tenant, "acme");
await assert.rejects(platform.gateway.invoke({ token: "bogus", service: "aep", tool: "list_schemas" }), /Invalid token/);
const expired = new (await import("../src/gateway/auth.js")).AuthBroker({ users: { u: { name: "u", role: "leadership", tenant: "acme" } }, tenants: {}, now: (() => { let n = 0; return () => (n += 4_000_000); })() });
await assert.rejects(async () => expired.verify(expired.login({ userId: "u" }).token), /expired/);
await assert.rejects(platform.gateway.invoke({ identity: platform.auth.identityFor("sam.other"), service: "aep", tool: "list_schemas" }), /not entitled/);
const pt1 = platform.auth.productToken(login.identity, "aep"); assert.equal(pt1, platform.auth.productToken(login.identity, "aep"), "product token cached");

// ---------- Data foundation (as data manager) + PII masking ----------
const sch = ok(await data("aep_create_schema", { name: "Customers", fields: { email: "string", tier: "string", spend: "number" }, identityField: "email" }));
const ds = ok(await data("aep_create_dataset", { name: "cust", schemaId: sch.id, profileEnabled: true }));
const ing = ok(await data("aep_ingest_records", { datasetId: ds.id, sourceMapping: { Email: "email", Tier: "tier", Spend: "spend" },
  records: ["a", "b", "c", "d"].map((x, i) => ({ Email: `${x}@x.com`, Tier: "gold", Spend: 100 * (i + 1) })) }));
assert.equal(ing.ingested, 4, "schema mapping applied");
assert.equal(ok(await data("aep_get_profile", { identity: "a@x.com" })).email, "a@x.com");
assert.equal(ok(await cm("aep_get_profile", { identity: "a@x.com" })).email, "a***@x.com", "PII masked for non-pii role");
const seg = ok(await data("aep_create_segment", { name: "Gold", rules: [{ field: "tier", op: "=", value: "gold" }] }));
const aud = ok(await data("aep_create_audience", { name: "Gold Customers", segmentId: seg.id }));
// consent: b opted out of email, c has no record (US -> allowed), d GDPR user without opt-in
ok(await data("policy_set_consent", { profileId: "b@x.com", channels: { email: false } }));
ok(await data("policy_set_consent", { profileId: "d@x.com", region: "GDPR", channels: {} }));
assert.match((await cm("policy_set_consent", { profileId: "a@x.com" })).text, /forbidden/);

// brand governance
ok(await brand("brand_concierge_set_brand_guidelines", { bannedWords: ["guaranteed"], requiredDisclaimer: "Terms apply.", tone: "friendly" }));
ok(await brand("brand_concierge_add_knowledge", { topic: "logo usage", content: "Always use the primary logo on a white background." }));
assert.match(ok(await creative("agent_creative_use_brand_knowledge", { question: "How should the logo be used?" })).answer, /primary logo/);

// ---------- Layer 2+3: role agents, state machine, policy ----------
const plan = ok(await cm("agent_planner_create_plan", { name: "Spring Gold", brief: "Goal: win back gold customers. Email campaign for the gold audience, friendly tone.", approvers: ["bailey.brand"] }));
const cid = plan.campaignId;
assert.equal(plan.state, "planned");
// tool-level audit shows planner acted as casey through the gateway
assert(ok(await ops("gateway_audit_log", { user: "casey.cm", service: "workfront" })).entries.length >= 1);

let run = ok(await cm("agent_planner_coordinate_agents", { campaignId: cid }));
assert(!run.failed, JSON.stringify(run));
assert.equal(run.ran.length, 4, "discover, consent, copy, submit");
assert.match(run.paused, /approved/);
let camp = ok(await cm("campaign_get", { campaignId: cid }));
assert.equal(camp.state, "in_review");
const aref = camp.audienceRefs[0];
assert.equal(aref.eligible, 2, "a,c eligible; b opted out; d GDPR without opt-in");
assert.equal(aref.excluded, 2);
assert(camp.content.every((x) => x.aiGenerated) && camp.content.length === 3);

// approval gate: not launchable until a human approves
let pre = ok(await cm("agent_activation_check_prerequisites", { campaignId: cid }));
assert(!pre.ready && pre.checks.find((c) => c.name === "approval").pass === false && pre.checks.find((c) => c.name === "responsible_ai").pass === false);
assert.match((await cm("agent_activation_coordinate_fusion", { campaignId: cid })).text, /expected 'approved'|Illegal/);
assert.match((await cm("agent_planner_coordinate_agents", { campaignId: cid })).text, /waits for state 'approved'/);

// Workfront decision (as brand manager) -> state machine advances, AI content marked human-reviewed
const apprId = camp.approvalRefs[0].approvalId;
assert.match((await cm("agent_approval_record_decision", { campaignId: cid, approvalId: apprId, approver: "bailey.brand", decision: "approved" })).text, /approved/);
camp = ok(await cm("campaign_get", { campaignId: cid }));
assert.equal(camp.state, "approved");
assert(camp.content.every((x) => x.reviewedBy?.includes("bailey.brand")));
assert(ok(await cm("agent_activation_check_prerequisites", { campaignId: cid })).ready);
assert(ok(await cm("agent_activation_validate_settings", { campaignId: cid })).valid);

// Activation through Fusion + AJO, then live -> reporting
run = ok(await cm("agent_planner_coordinate_agents", { campaignId: cid }));
assert(run.complete, JSON.stringify(run));
camp = ok(await cm("campaign_get", { campaignId: cid }));
assert.equal(camp.state, "reporting");
assert(camp.journeyRef.journeyId && camp.journeyRef.scenarioId);
const hist = camp.history.filter((h) => h.type === "state_changed").map((h) => h.to);
assert.deepEqual(hist, ["planned", "content_ready", "in_review", "approved", "activating", "live", "reporting"]);
assert.match((await cm("agent_planner_track_execution", { campaignId: cid })).text, /reporting/);
assert((await ops("notifications_list", { kind: "approval" })).json.length >= 1 && (await ops("notifications_list", { kind: "status" })).json.length >= 6);

// Insights from CJA
ok(await ops("cja_ingest_events", { campaignId: cid, events: [
  ...Array(100).fill({ type: "delivered" }), ...Array(30).fill({ type: "open" }), ...Array(2).fill({ type: "click" }), ...Array(3).fill({ type: "bounce" }), { type: "conversion", revenue: 50 }] }));
ok(await ops("cja_record_experiment", { campaignId: cid, variant: "A", delivered: 100, conversions: 2 }));
ok(await ops("cja_record_experiment", { campaignId: cid, variant: "B", delivered: 100, conversions: 6 }));
const an = ok(await cm("agent_insights_analyze_performance", { campaignId: cid }));
assert.equal(an.performance.openRate, 30);
const opt = ok(await cm("agent_insights_identify_optimizations", { campaignId: cid }));
assert(opt.suggestions.some((x) => /Click rate/.test(x)) && opt.suggestions.some((x) => /winner 'B'/.test(x)));
assert.match(ok(await leader("agent_insights_generate_reports", { campaignId: cid })).report, /performance report/);

// Policy gates: brand violation blocks activation; SLA escalation
const plan2 = ok(await cm("agent_planner_create_plan", { name: "Risky", brief: "Goal: guaranteed savings for gold audience", approvers: ["bailey.brand"] }));
run = ok(await cm("agent_planner_coordinate_agents", { campaignId: plan2.campaignId }));
const c2 = ok(await cm("campaign_get", { campaignId: plan2.campaignId }));
assert(c2.content.some((x) => x.brandViolations?.some((v) => /guaranteed/.test(v))));
assert.equal(ok(await cm("agent_approval_monitor_status", { campaignId: plan2.campaignId, slaMinutes: -1 })).escalated, 1);
assert.equal(ok(await ops("notifications_list", { kind: "escalation" })).length, 1);
ok(await cm("agent_approval_record_decision", { campaignId: plan2.campaignId, approvalId: c2.approvalRefs[0].approvalId, approver: "bailey.brand", decision: "approved" }));
assert.match((await cm("agent_activation_coordinate_fusion", { campaignId: plan2.campaignId })).text, /Policy gate failed.*brand_rules/);
// rejection sends it back for changes
const plan3 = ok(await cm("agent_planner_create_plan", { name: "Rejected", brief: "Goal: spring sale for gold audience", approvers: ["bailey.brand"] }));
ok(await cm("agent_planner_coordinate_agents", { campaignId: plan3.campaignId }));
const c3 = ok(await cm("campaign_get", { campaignId: plan3.campaignId }));
ok(await cm("integration_handle_event", { source: "workfront", type: "approval.decided", payload: { campaignId: plan3.campaignId } })); // no decision yet -> still pending
ok(await brand("agent_approval_record_decision", { campaignId: plan3.campaignId, approvalId: c3.approvalRefs[0].approvalId, approver: "bailey.brand", decision: "rejected" }));
assert.equal(ok(await cm("campaign_get", { campaignId: plan3.campaignId })).state, "changes_requested");

// Assets: versioning + linking
const folder = (await ops("aem_assets_create_folder", { path: "/content/dam/brand" })).json.path;
const v1 = ok(await creative("agent_asset_upload_asset", { folder, filename: "logo.png", sizeBytes: 10, campaignId: cid }));
const v2 = ok(await creative("agent_asset_upload_asset", { folder, filename: "logo.png", sizeBytes: 12 }));
assert.deepEqual([v1.version, v2.version], [1, 2]); assert.match(v2.path, /logo_v2\.png/);
assert.equal(ok(await creative("agent_asset_track_versions", { folder, filename: "logo.png" })).length, 2);
ok(await creative("agent_asset_link_to_campaign", { campaignId: plan2.campaignId, assetId: v2.assetId }));
const img = ok(await creative("agent_creative_create_images", { campaignId: plan3.campaignId, prompt: "Spring hero banner" }));
assert.match(img.path, /\/content\/dam\/campaigns\//);

// Forms (context-aware)
const f1 = ok(await cm("forms_get", { formId: "approval_request", campaignId: cid }));
assert.match(f1.blocked, /reporting/); assert.equal(f1.ui.library, "Adobe Spectrum");
assert(ok(await cm("forms_get", { formId: "campaign_brief" })).fields.find((f) => f.name === "audienceId").options.length >= 1);
assert.equal(ok(await creative("forms_get", { formId: "campaign_brief" })).fields.some((f) => f.name === "audienceId"), false, "roles without AEP access still get the form, without audience options");
assert(!ok(await cm("forms_submit", { formId: "campaign_brief", values: { name: "X", brief: "b", channels: ["fax"] } })).valid);
assert(ok(await cm("forms_submit", { formId: "campaign_brief", values: { name: "X", brief: "b", channels: ["email"] } })).campaignId);

// Data privacy + usage
assert.equal(ok(await ops("privacy_request", { type: "erasure", identity: "a@x.com" })).erased, true);
assert(!(await data("aep_get_profile", { identity: "a@x.com" })).json.email);
assert.equal(ok(await cm("gateway_usage")).quota, 5000);
assert(ok(await ops("gateway_audit_log", { limit: 500 })).chainValid);

// Rate limit, retry, quota
const { Gateway } = await import("../src/gateway/gateway.js");
const tight = new Gateway({ agents: platform.productAgents, integration: platform.integration, rate: { capacity: 2, perSec: 0 } });
const idn = platform.auth.identityFor("morgan.ops");
await tight.invoke({ identity: idn, service: "aep", tool: "list_schemas" }); await tight.invoke({ identity: idn, service: "aep", tool: "list_schemas" });
await assert.rejects(tight.invoke({ identity: idn, service: "aep", tool: "list_schemas" }), /Rate limit/);
let n = 0;
assert.equal(await platform.integration.withRetry(async () => { if (++n < 3) throw Object.assign(new Error("flaky"), { transient: true }); return "ok"; }), "ok");
await assert.rejects(platform.integration.withRetry(async () => { throw new Error("fatal"); }), /fatal/);
const sam = platform.auth.identityFor("sam.other");
await assert.rejects(async () => { for (let i = 0; i < 40; i++) await platform.gateway.invoke({ identity: sam, service: "workfront", tool: "create_project", args: { name: `p${i}`, owner: "s" } }); }, /quota/);

// ---------- Layer 1: remote HTTP transport (ChatGPT / Teams / web) ----------
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const srv = await startHttp({ port: 0 }); const base = `http://127.0.0.1:${srv.address().port}`;
assert.equal((await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status, 401);
const { token } = await (await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ userId: "lee.leader" }),
  headers: { "x-login-secret": process.env.LOGIN_SECRET ?? "" } })).json();
const hc = new Client({ name: "chatgpt", version: "1" });
await hc.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
assert.equal(JSON.parse((await hc.callTool({ name: "auth_whoami", arguments: {} })).content[0].text).role, "leadership");
assert.match((await hc.callTool({ name: "aep_create_schema", arguments: { name: "x", fields: { a: "string" }, identityField: "a" } })).content[0].text, /forbidden/);
await hc.close();
await new Promise((resolve) => srv.close(resolve));
console.log("architecture OK");
