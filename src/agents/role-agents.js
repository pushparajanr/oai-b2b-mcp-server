import { z } from "zod";
import { ref } from "../services/policy.js";
import { traced } from "../log.js";

export class RoleAgent {
  constructor({ key, name, instructions, tools }) { Object.assign(this, { key, name, instructions, tools }); }
  describe() { return { key: this.key, name: this.name, instructions: this.instructions, tools: Object.entries(this.tools).map(([n, t]) => ({ name: n, description: t.description })) }; }
  async call(tool, args, ctx) {
    return traced("role_agent.call", { agent: this.key, tool, user: ctx?.identity?.userId, args }, async () => {
      const def = this.tools[tool];
      if (!def) throw new Error(`Agent '${this.key}' has no tool '${tool}'. Available: ${Object.keys(this.tools).join(", ")}`);
      return def.run(z.object(def.shape).parse(args ?? {}), ctx);
    });
  }
}
const t = (description, shape, run) => ({ description, shape, run });
const cid = { campaignId: z.string() };
const slug = (s) => s.toLowerCase().replace(/\W+/g, "-").replace(/^-|-$/g, "");

/** Resolves "$scope.path" references used by plan steps ("$campaign.region", "$step1.suggested"). */
export function resolveRefs(v, scope) {
  if (typeof v === "string") {
    const m = /^\$(\w+)\.(.+)$/.exec(v);
    if (!m) return v;
    if (scope[m[1]] === undefined) throw new Error(`${v}: no result for '${m[1]}'`);
    const val = m[2].split(".").reduce((o, k) => o?.[k], scope[m[1]]);
    if (val === undefined) throw new Error(`${v}: path not found`);
    return val;
  }
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, scope));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x, scope)]));
  return v;
}

function interpret(brief) {
  const l = brief.toLowerCase();
  return {
    objective: /(?:goal|objective)[:\s]+([^.\n]+)/i.exec(brief)?.[1]?.trim() ?? brief.split(/[.\n]/)[0].trim(),
    channels: ["email", "sms", "push", "whatsapp"].filter((c) => l.includes(c)).length ? ["email", "sms", "push", "whatsapp"].filter((c) => l.includes(c)) : ["email"],
    region: /\b(eu|gdpr|uk|germany|france)\b/.test(l) ? "GDPR" : /\b(ccpa|california)\b/.test(l) ? "CCPA" : "US",
    audienceHint: /audience[:\s]+([^.\n,]+)/i.exec(brief)?.[1]?.trim() ?? "",
    tone: ["professional", "playful", "urgent", "friendly"].find((x) => l.includes(x)) ?? "friendly",
  };
}

const planner = new RoleAgent({ key: "planner", name: "Campaign Planner Agent", instructions: "Interpret briefs, create plans, coordinate agents, track execution.", tools: {
  interpret_brief: t("Interpret a natural-language brief into objective, channels, region, tone, audience hint.", { brief: z.string() }, ({ brief }) => interpret(brief)),
  create_plan: t("Create the campaign record and an ordered, gated plan across agents; opens a Workfront project.", { name: z.string(), brief: z.string(), approvers: z.array(z.string()).default(["bailey.brand"]) }, async ({ name, brief, approvers }, ctx) => {
    const i = interpret(brief);
    const c = ctx.p.data.create({ name, ...i });
    const prj = await ctx.call("workfront", "create_project", { name, owner: ctx.identity.userId, campaignId: c.id });
    c.projectId = prj.id;
    const S = (agent, tool, args, gate) => ({ agent, tool, args: { campaignId: c.id, ...args }, gate: gate ?? null, status: "pending" });
    c.plan = [
      S("audience", "discover_audiences", { query: "$campaign.audienceHint" }),
      S("audience", "validate_consent", { audienceId: "$step1.suggested", channel: "$campaign.primaryChannel", region: "$campaign.region" }),
      S("creative", "generate_copy", { channel: "$campaign.primaryChannel", tone: "$campaign.tone" }),
      S("approval", "submit_for_review", { deliverable: "creative", approvers }),
      S("activation", "coordinate_fusion", {}, "approved"),
      S("activation", "monitor_activation", {}, "live-or-activating"),
      S("insights", "generate_reports", { format: "markdown" }, "live"),
    ];
    ctx.p.orchestration.transition(c.id, "planned", { actor: ctx.identity.userId });
    return { campaignId: c.id, projectId: prj.id, state: c.state, plan: c.plan.map(({ agent, tool, gate }) => ({ agent, tool, gate })) };
  }),
  coordinate_agents: t("Run pending plan steps in order via the role agents; pauses at gates (e.g. waiting for approval) or on error.", cid, async ({ campaignId }, ctx) => {
    const c = ctx.p.data.get(campaignId); const ran = []; const scope = { campaign: c };
    for (const [i, st] of c.plan.entries()) {
      if (st.status === "done") { if (st.result !== undefined) scope[`step${i + 1}`] = st.result; continue; }
      const gateOk = !st.gate || st.gate === c.state || (st.gate === "live-or-activating" && ["activating", "live"].includes(c.state));
      if (!gateOk) { return { campaignId, state: c.state, ran, paused: `step ${i + 1} (${st.agent}.${st.tool}) waits for state '${st.gate}'` }; }
      try {
        st.result = await ctx.runRole(st.agent, st.tool, resolveRefs(st.args, scope));
        st.status = "done"; scope[`step${i + 1}`] = st.result; ran.push({ step: i + 1, agent: st.agent, tool: st.tool });
        ctx.p.data.record(campaignId, "plan_step_done", { step: i + 1, agent: st.agent, tool: st.tool });
      } catch (e) {
        st.status = "failed"; st.error = e.message; ctx.p.data.record(campaignId, "plan_step_failed", { step: i + 1, error: e.message });
        return { campaignId, state: c.state, ran, failed: { step: i + 1, agent: st.agent, tool: st.tool, error: e.message } };
      }
    }
    return { campaignId, state: c.state, ran, complete: true };
  }),
  track_execution: t("Campaign state, plan progress and execution history.", cid, ({ campaignId }, ctx) => {
    const c = ctx.p.data.get(campaignId);
    return { campaignId, name: c.name, state: c.state, plan: c.plan.map(({ agent, tool, status, error }) => ({ agent, tool, status, error })), history: c.history.slice(-20) };
  }),
} });

const audience = new RoleAgent({ key: "audience", name: "Audience Agent", instructions: "Discover audiences, analyze segments, validate consent, provide insights.", tools: {
  discover_audiences: t("Find candidate AEP audiences matching a query.", { campaignId: z.string().optional(), query: z.string().default("") }, async ({ query }, ctx) => {
    const all = await ctx.call("aep", "list_audiences");
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const scored = all.map((a) => ({ ...a, score: words.filter((w) => a.name.toLowerCase().includes(w)).length })).filter((a) => !words.length || a.score > 0)
      .sort((x, y) => y.score - x.score || y.size - x.size);
    return { candidates: scored.map(({ id, name, size }) => ({ id, name, size })), suggested: scored[0]?.id ?? null };
  }),
  analyze_segments: t("Aggregate profile attribute distribution for a segment.", { segmentId: z.string() }, (a, ctx) => ctx.call("aep", "get_segment_stats", a)),
  validate_consent: t("Apply consent policy to an audience; creates a consent-filtered audience and links it to the campaign.", { ...cid, audienceId: z.string(), channel: z.string().optional(), region: z.string().optional() }, async (a, ctx) => {
    const c = ctx.p.data.get(a.campaignId); const channel = a.channel ?? c.primaryChannel, region = a.region ?? c.region;
    const r = ctx.p.policy.consentCheck({ audienceId: a.audienceId, channel, region });
    if (!r.eligible.length) throw new Error(`No eligible members for ${channel}/${region}: ${r.summary.excluded} excluded`);
    const created = await ctx.call("aep", "create_audience_from_members", { name: `${r.audienceName} (consented ${channel})`, members: r.eligible, sourceAudienceId: a.audienceId });
    ctx.p.data.addAudienceRef(a.campaignId, { audienceId: created.id, sourceAudienceId: a.audienceId, channel, region, eligible: r.summary.eligible, excluded: r.summary.excluded, consentValidated: true });
    ctx.p.orchestration.autoAdvance(a.campaignId);
    return { consentedAudienceId: created.id, ...r.summary, excludedRefs: r.excluded.map((x) => ({ ref: ref(x.id), reason: x.reason })) };
  }),
  provide_insights: t("Size and composition insights for an audience.", { audienceId: z.string() }, async ({ audienceId }, ctx) => {
    const a = await ctx.call("aep", "get_audience", { audienceId });
    const stats = a.segmentId ? await ctx.call("aep", "get_segment_stats", { segmentId: a.segmentId }) : null;
    return { audienceId, name: a.name, size: a.members.length, composition: stats && { distributions: stats.distributions, numeric: stats.numeric } };
  }),
} });

const creative = new RoleAgent({ key: "creative", name: "Creative Agent", instructions: "Generate copy and images grounded in brand knowledge; create variations.", tools: {
  generate_copy: t("Generate brand-grounded copy variants; each is brand- and regulatory-checked and labeled AI-generated.", { ...cid, channel: z.string().optional(), tone: z.string().optional(), count: z.number().int().min(1).max(5).default(3) }, async (a, ctx) => {
    const c = ctx.p.data.get(a.campaignId); const channel = a.channel ?? c.primaryChannel;
    const g = await ctx.call("brand_concierge", "get_brand_guidelines");
    const goal = c.objective, tone = a.tone ?? g.tone ?? c.tone;
    const footer = channel === "sms" ? "Reply STOP to opt out." : channel === "email" ? "{{unsubscribe}} to unsubscribe." : "";
    const openers = ["Here's something for you", "A quick note", "Don't miss this"];
    const out = [];
    for (let i = 0; i < a.count; i++) {
      const subject = `${openers[i % 3]}: ${goal}`.slice(0, g.maxSubjectLength ?? 60);
      const body = [`Hi {{first_name}}, ${goal}.`, `(${tone} tone)`, g.requiredDisclaimer, footer].filter(Boolean).join(" ");
      const item = { type: "copy", channel, subject, body, tone, aiGenerated: true, aiDisclosure: "AI-generated, pending human review" };
      item.brandViolations = ctx.p.policy.brandCheck(item); item.regulatoryViolations = ctx.p.policy.regulatoryCheck(item, channel);
      out.push(ctx.p.data.addContent(a.campaignId, item));
    }
    ctx.p.orchestration.autoAdvance(a.campaignId);
    return { generated: out.length, variants: out.map(({ id, subject, brandViolations, regulatoryViolations }) => ({ id, subject, brandViolations, regulatoryViolations })) };
  }),
  create_images: t("Generate a campaign image from a prompt (image-model call is stubbed) and store it in AEM Assets.", { ...cid, prompt: z.string(), filename: z.string().optional() }, async (a, ctx) => {
    const c = ctx.p.data.get(a.campaignId); const folder = `/content/dam/campaigns/${c.id}`;
    for (const path of ["/content/dam/campaigns", folder]) await ctx.call("aem_assets", "create_folder", { path });
    const asset = await ctx.call("aem_assets", "upload_asset", { folder, filename: a.filename ?? `${slug(a.prompt).slice(0, 30)}.png`, sizeBytes: 250_000, metadata: { "dc:description": a.prompt, generator: "openai-image (stub)" }, tags: ["ai-generated", c.id] });
    ctx.p.data.addAssetRef(c.id, { assetId: asset.id, path: asset.path });
    const item = ctx.p.data.addContent(c.id, { type: "image", assetId: asset.id, prompt: a.prompt, aiGenerated: true, aiDisclosure: "AI-generated, pending human review" });
    ctx.p.orchestration.autoAdvance(c.id);
    return { contentId: item.id, assetId: asset.id, path: asset.path };
  }),
  use_brand_knowledge: t("Ask the Brand Concierge a question.", { question: z.string() }, (a, ctx) => ctx.call("brand_concierge", "ask_brand_question", a)),
  create_variations: t("Create variations of an existing copy item.", { ...cid, contentId: z.string(), count: z.number().int().min(1).max(5).default(2) }, async (a, ctx) => {
    const c = ctx.p.data.get(a.campaignId); const src = c.content.find((x) => x.id === a.contentId && x.type === "copy");
    if (!src) throw new Error(`Unknown copy '${a.contentId}'`);
    const prefixes = ["Hello again,", "Quick update:", "For you:"];
    const out = Array.from({ length: a.count }, (_, i) => {
      const item = { ...src, id: undefined, variantOf: src.id, body: src.body.replace(/^Hi /, `${prefixes[i % 3]} `) };
      item.brandViolations = ctx.p.policy.brandCheck(item); item.regulatoryViolations = ctx.p.policy.regulatoryCheck(item, item.channel);
      return ctx.p.data.addContent(c.id, item);
    });
    return { variants: out.map((x) => x.id) };
  }),
} });

const versions = new Map();
const asset = new RoleAgent({ key: "asset", name: "Asset Agent", instructions: "Upload assets, manage metadata, link to campaigns, track versions.", tools: {
  upload_asset: t("Upload to AEM Assets; re-uploading the same name creates a new version (_vN).", { folder: z.string(), filename: z.string(), sizeBytes: z.number().int().positive(), metadata: z.record(z.string()).default({}), tags: z.array(z.string()).default([]), campaignId: z.string().optional() }, async (a, ctx) => {
    const key = `${a.folder}/${a.filename}`; const hist = versions.get(key) ?? []; const n = hist.length + 1;
    const filename = n === 1 ? a.filename : a.filename.replace(/(\.[^.]+)?$/, `_v${n}$1`);
    const up = await ctx.call("aem_assets", "upload_asset", { folder: a.folder, filename, sizeBytes: a.sizeBytes, metadata: a.metadata, tags: a.tags });
    hist.push({ version: n, assetId: up.id, path: up.path, by: ctx.identity.userId }); versions.set(key, hist);
    if (a.campaignId) ctx.p.data.addAssetRef(a.campaignId, { assetId: up.id, path: up.path });
    return { assetId: up.id, path: up.path, version: n };
  }),
  manage_metadata: t("Update metadata/tags on an asset.", { assetId: z.string(), metadata: z.record(z.string()).default({}), addTags: z.array(z.string()).default([]) }, (a, ctx) => ctx.call("aem_assets", "update_metadata", a)),
  link_to_campaign: t("Link an existing asset to a campaign.", { ...cid, assetId: z.string() }, async (a, ctx) => {
    const x = await ctx.call("aem_assets", "get_asset", { assetId: a.assetId });
    ctx.p.data.addAssetRef(a.campaignId, { assetId: x.id, path: x.path }); return { campaignId: a.campaignId, assetId: x.id, path: x.path };
  }),
  track_versions: t("Version history of an asset name in a folder.", { folder: z.string(), filename: z.string() }, ({ folder, filename }) => versions.get(`${folder}/${filename}`) ?? []),
} });

const sync = async (c, ctx) => {
  if (!c.projectId) return;
  const list = await ctx.call("workfront", "list_approvals", { projectId: c.projectId });
  for (const r of c.approvalRefs) { const w = list.find((x) => x.id === r.approvalId); if (w) { r.status = w.status; r.decisions = w.decisions; } }
};
const approval = new RoleAgent({ key: "approval", name: "Approval Coordinator Agent", instructions: "Submit to Workfront Proof, monitor review status, track decisions, notify stakeholders.", tools: {
  submit_for_review: t("Submit a deliverable for Workfront approval and move the campaign to in_review.", { ...cid, deliverable: z.string().default("creative"), approvers: z.array(z.string()).min(1) }, async (a, ctx) => {
    const c = ctx.p.data.get(a.campaignId);
    ctx.p.orchestration.autoAdvance(a.campaignId);
    if (c.state !== "content_ready") throw new Error(`Campaign is '${c.state}', needs 'content_ready' (audience consent-validated and content present)`);
    const w = await ctx.call("workfront", "request_approval", { projectId: c.projectId, deliverable: a.deliverable, approvers: a.approvers });
    c.approvalRefs.push({ approvalId: w.id, deliverable: a.deliverable, approvers: a.approvers, status: "pending", requestedAt: new Date().toISOString() });
    ctx.p.orchestration.transition(c.id, "in_review", { actor: ctx.identity.userId });
    ctx.p.notify.approvalRequest(c, a.deliverable, a.approvers);
    return { approvalId: w.id, status: "pending", state: c.state };
  }),
  monitor_status: t("Sync approval status from Workfront and run SLA escalations.", { ...cid, slaMinutes: z.number().default(60) }, async (a, ctx) => {
    const c = ctx.p.data.get(a.campaignId); await sync(c, ctx);
    const esc = ctx.p.notify.sweepEscalations(c, { slaMinutes: a.slaMinutes });
    return { state: c.state, approvals: c.approvalRefs.map(({ approvalId, deliverable, status }) => ({ approvalId, deliverable, status })), escalated: esc.length };
  }),
  record_decision: t("Record an approver's decision in Workfront; advances or rewinds the campaign state.", { ...cid, approvalId: z.string(), approver: z.string(), decision: z.enum(["approved", "rejected"]), comment: z.string().optional() }, async (a, ctx) => {
    const c = ctx.p.data.get(a.campaignId);
    await ctx.call("workfront", "decide_approval", { approvalId: a.approvalId, approver: a.approver, decision: a.decision, comment: a.comment });
    return applyDecisionSync(c, ctx);
  }),
  track_decisions: t("Decisions recorded per approval.", cid, async ({ campaignId }, ctx) => {
    const c = ctx.p.data.get(campaignId); await sync(c, ctx);
    return c.approvalRefs.map(({ approvalId, deliverable, status, decisions }) => ({ approvalId, deliverable, status, decisions }));
  }),
  notify_stakeholders: t("Send a message to stakeholders over Teams/email.", { ...cid, to: z.array(z.string()).min(1), message: z.string(), channel: z.enum(["teams", "email"]).default("teams") }, ({ campaignId, to, message, channel }, ctx) => {
    const c = ctx.p.data.get(campaignId); return ctx.p.notify.send({ channel, to, subject: c.name, body: message, kind: "message" });
  }),
} });

/** After a Workfront decision: sync refs, mark human review on AI content, transition state. */
export async function applyDecisionSync(c, ctx) {
  await sync(c, ctx);
  const status = c.approvalRefs.some((r) => r.status === "rejected") ? "rejected" : c.approvalRefs.every((r) => r.status === "approved") ? "approved" : "pending";
  if (status === "approved" && c.state === "in_review") {
    const reviewers = [...new Set(c.approvalRefs.flatMap((r) => Object.entries(r.decisions ?? {}).filter(([, d]) => d.decision === "approved").map(([u]) => u)))];
    for (const x of c.content) if (x.aiGenerated) x.reviewedBy = reviewers;
    ctx.p.orchestration.transition(c.id, "approved", { actor: "approval-agent" });
  } else if (status === "rejected" && c.state === "in_review") ctx.p.orchestration.transition(c.id, "changes_requested", { actor: "approval-agent" });
  return { approval: status, state: c.state };
}

const activation = new RoleAgent({ key: "activation", name: "Activation Agent", instructions: "Check prerequisites, coordinate Fusion, validate settings, monitor activation.", tools: {
  check_prerequisites: t("Evaluate the launch gate (audience consent, content, brand, regulatory, approval, responsible AI).", cid, ({ campaignId }, ctx) => {
    const c = ctx.p.data.get(campaignId); const r = ctx.p.policy.evaluateLaunch(c); return { state: c.state, ready: r.pass && c.state === "approved", ...r };
  }),
  validate_settings: t("Validate journey settings: channel, consented audience, region, content for channel.", cid, ({ campaignId }, ctx) => {
    const c = ctx.p.data.get(campaignId); const a = c.audienceRefs.find((x) => x.consentValidated);
    const checks = [
      { name: "audience", pass: !!a }, { name: "region", pass: !!c.region }, { name: "channel_content", pass: c.content.some((x) => x.type === "copy" && x.channel === c.primaryChannel) },
      { name: "native_console_prereqs", pass: true, detail: "Sender/DNS, IP warmup, gateways and fatigue rules are configured in native consoles; verify via check_native_prerequisites" },
    ];
    return { valid: checks.every((x) => x.pass), checks };
  }),
  coordinate_fusion: t("Move to activating (policy-gated), fire the approval-to-activation Fusion scenario, then create and publish the AJO journey.", { ...cid, journeyName: z.string().optional() }, async (a, ctx) => {
    const c = ctx.p.data.get(a.campaignId);
    if (c.state === "approved") ctx.p.orchestration.transition(c.id, "activating", { actor: ctx.identity.userId });
    if (c.state !== "activating") throw new Error(`Campaign is '${c.state}', expected 'approved'`);
    const aud = c.audienceRefs.find((x) => x.consentValidated);
    const copy = c.content.find((x) => x.type === "copy");
    const sc = await ctx.call("fusion", "create_scenario", { name: `approval-to-activation:${c.id}`, trigger: "approval.approved", steps: [{ service: "ajo", tool: "create_journey" }, { service: "ajo", tool: "publish_journey" }] });
    const run = await ctx.call("fusion", "trigger_scenario", { scenarioId: sc.id, payload: { campaignId: c.id } });
    const j = await ctx.call("ajo", "create_journey", { name: a.journeyName ?? `${c.name} journey`, audienceId: aud.audienceId, steps: [{ type: c.primaryChannel, label: copy.subject }, { type: "wait", label: "Wait", duration: "2 days" }] });
    await ctx.call("ajo", "publish_journey", { journeyId: j.id });
    c.journeyRef = { journeyId: j.id, scenarioId: sc.id, runId: run.id };
    ctx.p.data.record(c.id, "activation_dispatched", c.journeyRef);
    return { state: c.state, journeyId: j.id, scenarioId: sc.id };
  }),
  monitor_activation: t("Check journey status in AJO; moves the campaign to live once published.", cid, async ({ campaignId }, ctx) => {
    const c = ctx.p.data.get(campaignId); if (!c.journeyRef) throw new Error("No journey has been activated");
    const j = (await ctx.call("ajo", "list_journeys")).find((x) => x.id === c.journeyRef.journeyId);
    if (j?.status === "live" && c.state === "activating") ctx.p.orchestration.transition(c.id, "live", { actor: "activation-agent" });
    return { journeyStatus: j?.status ?? "unknown", state: c.state };
  }),
} });

const BENCH = { openRate: 20, clickRate: 2.5, bounceRate: 2 };
const perf = async (id, ctx) => ctx.call("cja", "get_campaign_performance", { campaignId: id });
const insights = new RoleAgent({ key: "insights", name: "Insights Agent", instructions: "Retrieve CJA data, analyze performance, identify optimizations, generate reports.", tools: {
  retrieve_cja_data: t("Raw CJA performance and funnel for a campaign.", cid, async ({ campaignId }, ctx) => ({ performance: await perf(campaignId, ctx), journey: await ctx.call("cja", "get_journey_analysis", { campaignId }) })),
  analyze_performance: t("Compare performance to benchmarks.", cid, async ({ campaignId }, ctx) => {
    const p = await perf(campaignId, ctx); if (!p.delivered) return { status: "no_data", message: "No delivered events yet" };
    return { performance: p, findings: [
      { metric: "openRate", value: p.openRate, benchmark: BENCH.openRate, status: p.openRate >= BENCH.openRate ? "above" : "below" },
      { metric: "clickRate", value: p.clickRate, benchmark: BENCH.clickRate, status: p.clickRate >= BENCH.clickRate ? "above" : "below" },
      { metric: "bounceRate", value: p.bounceRate, benchmark: BENCH.bounceRate, status: p.bounceRate <= BENCH.bounceRate ? "ok" : "high" },
    ] };
  }),
  identify_optimizations: t("Rule-based optimization suggestions from metrics and experiments.", cid, async ({ campaignId }, ctx) => {
    const p = await perf(campaignId, ctx); const ex = await ctx.call("cja", "get_experiment_results", { campaignId }); const s = [];
    if (!p.delivered) return { suggestions: [], note: "No data yet" };
    if (p.openRate < BENCH.openRate) s.push("Open rate is below benchmark: test subject lines and send times.");
    if (p.clickRate < BENCH.clickRate) s.push("Click rate is below benchmark: strengthen the call to action.");
    if (p.bounceRate > BENCH.bounceRate) s.push("Bounce rate is high: clean the list and check sender authentication.");
    if (ex.winner) s.push(`Experiment winner '${ex.winner}': roll out to remaining audience.`);
    return { suggestions: s, experiment: ex.status };
  }),
  generate_reports: t("Generate a Markdown performance report; moves a live campaign to reporting.", { ...cid, format: z.enum(["markdown"]).default("markdown") }, async ({ campaignId }, ctx) => {
    const c = ctx.p.data.get(campaignId); const p = await perf(campaignId, ctx);
    const md = [`# ${c.name} — performance report`, `State: ${c.state}`, `Objective: ${c.objective}`, "", "| Metric | Value |", "|---|---|",
      ...Object.entries({ delivered: p.delivered, opens: p.opens, clicks: p.clicks, bounces: p.bounces, conversions: p.conversions, revenue: p.revenue, openRate: `${p.openRate}%`, clickRate: `${p.clickRate}%`, conversionRate: `${p.conversionRate}%` }).map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
    if (c.state === "live") ctx.p.orchestration.transition(c.id, "reporting", { actor: "insights-agent" });
    return { format: "markdown", report: md, state: c.state };
  }),
} });

export const ROLE_AGENTS = [planner, audience, creative, asset, approval, activation, insights];
