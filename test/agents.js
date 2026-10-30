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
  let json; try { json = JSON.parse(r.content[0].text); } catch { json = r.content[0].text; }
  return { err: !!r.isError, json };
};

assert.equal((await call("orchestrator_list_agents")).json.length, 9);
const plan = (await call("orchestrator_plan", { request: "Create a segment audience, publish the landing page and track the project approval" })).json;
assert.deepEqual(plan.map((p) => p.agent), ["aep", "aem_sites", "workfront"]);

// Cross-agent workflow with $stepN references.
const run = (await call("orchestrator_execute", { steps: [
  { agent: "aep", tool: "create_schema", args: { name: "Customers", fields: { email: "string", tier: "string", spend: "number" }, identityField: "email" } },
  { agent: "aep", tool: "create_dataset", args: { name: "customers", schemaId: "$step1.id", profileEnabled: true } },
  { agent: "aep", tool: "ingest_records", args: { datasetId: "$step2.id", records: [{ email: "a@x.com", tier: "gold", spend: 500 }, { email: "b@x.com", tier: "basic", spend: 20 }, { email: "c@x.com", tier: "gold", spend: 90 }] } },
  { agent: "aep", tool: "create_segment", args: { name: "Gold", rules: [{ field: "tier", op: "=", value: "gold" }] } },
  { agent: "aep", tool: "create_audience", args: { name: "Gold Audience", segmentId: "$step4.id" } },
  { agent: "ajo", tool: "create_journey", args: { name: "Gold Welcome", audienceId: "$step5.id", steps: [{ type: "email", label: "Hi" }, { type: "wait", label: "w", duration: "2 days" }] } },
  { agent: "ajo", tool: "publish_journey", args: { journeyId: "$step6.id" } },
  { agent: "workfront", tool: "create_project", args: { name: "Gold Launch", owner: "pat" } },
  { agent: "workfront", tool: "request_approval", args: { projectId: "$step8.id", deliverable: "Journey", approvers: ["lee"] } },
  { agent: "workfront", tool: "decide_approval", args: { approvalId: "$step9.id", approver: "lee", decision: "approved" } },
] })).json;
assert.equal(run.completed, 10, JSON.stringify(run.results.find((r) => !r.ok)));
assert.equal(run.results[4].result.size, 2);
assert.equal(run.results[9].result.status, "approved");

const q = (await call("aep_run_query", { sql: "SELECT email FROM customers WHERE spend > 50 AND tier = 'gold' LIMIT 5" })).json;
assert.equal(q.rowCount, 2);
assert((await call("aep_ingest_records", { datasetId: run.results[1].result.id, records: [{ bogus: 1 }] })).json.rejected === 1);

// AJO decisioning
const o1 = (await call("ajo_create_offer", { name: "10%", content: "10% off", priority: 1 })).json.id;
const o2 = (await call("ajo_create_offer", { name: "VIP", content: "VIP gift", priority: 5, eligibility: { field: "tier", equals: "gold" } })).json.id;
const dec = (await call("ajo_create_decision", { name: "d", offerIds: [o1, o2] })).json.id;
assert.equal((await call("ajo_decide_offer", { decisionId: dec, profileId: "a", attributes: { tier: "gold" } })).json.offer.name, "VIP");
assert.equal((await call("ajo_decide_offer", { decisionId: dec, profileId: "b", attributes: { tier: "basic" } })).json.offer.name, "10%");

// AEM Sites: publish gated on fragments
const frag = (await call("aem_sites_create_content_fragment", { name: "hero", model: "hero", elements: { title: "Hi" } })).json.id;
const page = (await call("aem_sites_create_page", { path: "/content/site/en/home", title: "Home" })).json.id;
await call("aem_sites_add_component", { pageId: page, type: "fragment", props: { fragmentId: frag } });
assert((await call("aem_sites_publish_page", { pageId: page })).err);
assert.equal((await call("aem_sites_publish_page", { pageId: page, includeFragments: true })).json.fragmentsPublished, 1);

// AEM Assets
await call("aem_assets_create_folder", { path: "/content/dam/brand" });
const ast = (await call("aem_assets_upload_asset", { folder: "/content/dam/brand", filename: "hero.png", sizeBytes: 1000, tags: ["spring"] })).json;
assert.equal((await call("aem_assets_search_assets", { tag: "spring", type: "image" })).json.length, 1);
assert.equal((await call("aem_assets_run_asset_workflow", { assetId: ast.id, workflow: "approve" })).json.status, "approved");

// Workfront dependency blocking
const pj = (await call("workfront_create_project", { name: "p", owner: "o" })).json.id;
const t1 = (await call("workfront_create_task", { projectId: pj, name: "a" })).json.id;
const t2 = (await call("workfront_create_task", { projectId: pj, name: "b", dependsOn: [t1] })).json.id;
assert((await call("workfront_update_task_status", { taskId: t2, status: "in_progress" })).err);
await call("workfront_update_task_status", { taskId: t1, status: "complete" });
assert.equal((await call("workfront_project_status", { projectId: pj })).json.complete, 1);

// Failed step halts workflow
const bad = (await call("orchestrator_execute", { steps: [{ agent: "aep", tool: "nope" }, { agent: "aep", tool: "list_schemas" }] })).json;
assert.equal(bad.completed, 0); assert.equal(bad.results.length, 1);
console.log("agents OK");
process.exit(0);
