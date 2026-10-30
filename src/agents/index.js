import { z } from "zod";
import { Orchestrator, stepSchema } from "./orchestrator.js";

/**
 * Registers every tool for one MCP session. `session.identity` is the authenticated user; all product calls
 * (direct tools, orchestrator steps, role agents) are made as that user through the gateway.
 */
export function registerAgents(server, platform, session) {
  const { gateway, productAgents, roleAgents } = platform;
  const inv = (service, tool, args) => gateway.invoke({ identity: session.identity, service, tool, args });
  const ctx = () => platform.makeCtx(session.identity);
  const orch = new Orchestrator(productAgents, inv);

  const text = (d) => ({ type: "text", text: JSON.stringify(d, null, 2) });
  const add = (name, description, inputSchema, fn) => server.registerTool(name, { description, inputSchema }, async (args) => {
    try { const r = await fn(args); return r?.__meta ? { content: [text(r.data)], _meta: r.__meta } : { content: [text(r)] }; }
    catch (e) { return { isError: true, content: [{ type: "text", text: e.code ? `[${e.code}] ${e.message}` : e.message }] }; }
  });

  // ---- Layer 5 product tools (via gateway) ----
  for (const a of productAgents) for (const [name, def] of Object.entries(a.tools)) {
    add(`${a.key}_${name}`, `[${a.product}] ${def.description}`, def.shape ? def.schema.shape : {}, async (args) => {
      const { result, meta } = await inv(a.key, name, args); return { __meta: meta, data: result };
    });
  }

  // ---- Product-level orchestrator ----
  add("orchestrator_list_agents", "List product sub-agents and their tools.", {}, () => orch.list());
  add("orchestrator_plan", "Route a free-text request to the product agents that should handle it, in dependency order.", { request: z.string() },
    ({ request }) => orch.plan(request).length ? orch.plan(request) : { message: "No agent matched; use orchestrator_list_agents." });
  add("orchestrator_execute", "Run a multi-agent workflow: ordered steps {agent, tool, args}; args may reference '$step1.id'. Stops at first failure unless continueOnError.",
    { steps: z.array(stepSchema).min(1), continueOnError: z.boolean().optional() }, ({ steps, continueOnError }) => orch.execute(steps, { continueOnError }));
  add("orchestrator_delegate", "Call a single product agent tool directly.", { agent: z.string(), tool: z.string(), args: z.record(z.any()).optional() },
    async ({ agent, tool, args }) => (await inv(agent, tool, args ?? {})).result);

  // ---- Layer 2 role agents ----
  for (const a of roleAgents.values()) for (const [name, def] of Object.entries(a.tools)) {
    add(`agent_${a.key}_${name}`, `[${a.name}] ${def.description}`, def.shape, (args) => a.call(name, args, ctx()));
  }
  add("agents_list", "List the campaign role agents (planner, audience, creative, asset, approval, activation, insights).", {}, () => [...roleAgents.values()].map((a) => a.describe()));

  // ---- Layer 4 gateway ----
  add("auth_login", "Authenticate as a user (SSO simulation). Returns a gateway token and switches this session's identity.", { userId: z.string() }, ({ userId }) => {
    const r = gateway.auth.login({ userId }); session.identity = r.identity; return r;
  });
  add("auth_whoami", "Show this session's identity and role.", {}, () => session.identity);
  add("gateway_capabilities", "Capability registry: tools visible to the current user's tenant, with read/write kind and transport.", { service: z.string().optional(), kind: z.enum(["read", "write"]).optional() },
    ({ service, kind }) => gateway.registry.catalog({ service, kind, tenant: session.identity.tenant }).map(({ service: s, tool, kind: k, transport }) => ({ service: s, tool, kind: k, transport })));
  add("gateway_audit_log", "Audit log (hash-chained). Restricted to marketing_ops and leadership.", { user: z.string().optional(), service: z.string().optional(), outcome: z.string().optional(), limit: z.number().int().max(500).optional() }, (q) => {
    if (!["marketing_ops", "leadership"].includes(session.identity.role)) throw Object.assign(new Error("Audit log requires marketing_ops or leadership"), { code: "forbidden" });
    return { chainValid: gateway.security.verifyChain(), entries: gateway.security.query(q) };
  });
  add("gateway_monitoring", "Monitoring: per-service call/error metrics and alerts. Restricted to marketing_ops and leadership.", {}, () => {
    if (!["marketing_ops", "leadership"].includes(session.identity.role)) throw Object.assign(new Error("Monitoring requires marketing_ops or leadership"), { code: "forbidden" });
    return { metrics: gateway.security.metrics(), alerts: gateway.security.alerts };
  });
  add("gateway_usage", "Cost & usage controls: tenant usage against quota.", {}, () => gateway.usageFor(session.identity.tenant));

  // ---- Layer 3 application services ----
  add("campaign_get", "Campaign Data Service: full campaign record (state, plan, audience/asset refs, content, history).", { campaignId: z.string() }, ({ campaignId }) => platform.data.get(campaignId));
  add("campaign_list", "List campaigns.", {}, () => platform.data.list());
  add("forms_get", "GenUI Forms: context-aware form spec (Adobe Spectrum).", { formId: z.enum(["campaign_brief", "approval_request", "activation_checklist"]), campaignId: z.string().optional() }, async ({ formId, campaignId }) => {
    const audiences = await inv("aep", "list_audiences", {}).then((r) => r.result).catch(() => []);
    return platform.forms.get(formId, { identity: session.identity, campaign: campaignId ? platform.data.get(campaignId) : undefined, audiences });
  });
  add("forms_submit", "Validate and submit a form (campaign_brief creates a draft campaign).", { formId: z.enum(["campaign_brief", "approval_request", "activation_checklist"]), values: z.record(z.any()), campaignId: z.string().optional() }, async ({ formId, values, campaignId }) => {
    const audiences = await inv("aep", "list_audiences", {}).then((r) => r.result).catch(() => []);
    return platform.forms.submit(formId, values, { identity: session.identity, campaign: campaignId ? platform.data.get(campaignId) : undefined, audiences });
  });
  add("policy_set_consent", "Consent management: record a profile's consent (channels, region, opt-out categories).", { profileId: z.string(), region: z.string().optional(), channels: z.record(z.boolean()).default({}), optOutCategories: z.array(z.string()).optional() }, async ({ profileId, ...rec }) => {
    if (!["data_manager", "marketing_ops"].includes(session.identity.role)) throw Object.assign(new Error("Consent changes require data_manager or marketing_ops"), { code: "forbidden" });
    return platform.policy.setConsent(profileId, rec);
  });
  add("policy_evaluate_launch", "Policy engine: evaluate the launch gate for a campaign.", { campaignId: z.string() }, ({ campaignId }) => platform.policy.evaluateLaunch(platform.data.get(campaignId)));
  add("notifications_list", "Notification outbox (Teams/email), optionally filtered.", { kind: z.string().optional(), to: z.string().optional() }, (q) => platform.notify.list(q));
  add("privacy_request", "Data privacy (GDPR/CCPA): erasure or access request for a profile identity.", { type: z.enum(["erasure", "access"]), identity: z.string() }, (a) => platform.privacyRequest(ctx(), a));
  add("integration_handle_event", "Integration service: process an inbound product event (e.g. workfront approval.decided with {campaignId}).", { source: z.string(), type: z.string(), payload: z.record(z.any()).default({}) },
    ({ source, type, payload }) => platform.integration.handleEvent(source, type, payload));
}
