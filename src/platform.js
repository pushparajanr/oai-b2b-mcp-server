import { aep } from "./agents/aep.js";
import { ajo } from "./agents/ajo.js";
import { workfront } from "./agents/workfront.js";
import { aemSites } from "./agents/aem-sites.js";
import { aemAssets } from "./agents/aem-assets.js";
import { brandConcierge } from "./agents/brand-concierge.js";
import { fusion } from "./agents/fusion.js";
import { marketo } from "./agents/marketo.js";
import { cja } from "./agents/cja.js";
import { ROLE_AGENTS, applyDecisionSync } from "./agents/role-agents.js";
import { Gateway } from "./gateway/gateway.js";
import { Integration } from "./services/integration.js";
import { CampaignData } from "./services/campaign-data.js";
import { Notifications } from "./services/notifications.js";
import { PolicyEngine } from "./services/policy.js";
import { OrchestrationService } from "./services/orchestration.js";
import { FormsService } from "./services/forms.js";

export const PRODUCT_AGENTS = [aep, ajo, workfront, aemSites, aemAssets, brandConcierge, fusion, marketo, cja];
const DEFAULT_GUIDELINES = { tone: "friendly", bannedWords: [], requiredDisclaimer: "", maxSubjectLength: 60 };

/** Wires layers 3-5 together. One shared instance per process (state lives in the product agents). */
export function createPlatform({ now = Date.now } = {}) {
  const integration = new Integration();
  const gateway = new Gateway({ agents: PRODUCT_AGENTS, integration, now });
  const data = new CampaignData({ now: () => new Date(now()).toISOString() });
  const notify = new Notifications({ now });
  const internal = {
    audience(id) { const a = aep.state.audiences?.get(id); if (!a) throw new Error(`Unknown audience '${id}'`); return a; },
    guidelines: () => brandConcierge.state.g ?? DEFAULT_GUIDELINES,
  };
  const policy = new PolicyEngine({ internal });
  const orchestration = new OrchestrationService({ data, policy, notify });
  const forms = new FormsService({ data, policy });
  const p = { data, policy, orchestration, notify, forms, integration };
  const roleAgents = new Map(ROLE_AGENTS.map((a) => [a.key, a]));

  /** Execution context for role agents: every product call is made as `identity` through the gateway. */
  const makeCtx = (identity) => {
    const ctx = { identity, p,
      call: async (service, tool, args) => (await gateway.invoke({ identity, service, tool, args })).result,
      runRole: (agent, tool, args) => { const a = roleAgents.get(agent); if (!a) throw new Error(`Unknown role agent '${agent}'`); return a.call(tool, args, ctx); } };
    return ctx;
  };
  const systemIdentity = { userId: "system", name: "System", role: "marketing_ops", tenant: "acme", sandbox: "prod", imsOrg: "acme@AdobeOrg" };

  // Inbound events (e.g. Workfront webhook): sync approval decisions and advance state.
  integration.onEvent("workfront", "approval.decided", async ({ campaignId }) => applyDecisionSync(data.get(campaignId), makeCtx(systemIdentity)));

  /** Data privacy: erasure / access requests, applied to AEP and the consent store. */
  const privacyRequest = async (ctx, { type, identity }) => {
    if (type === "erasure") {
      const r = await ctx.call("aep", "delete_profile", { identity });
      policy.consent.delete(identity);
      gateway.security.audit({ requestId: "privacy", service: "privacy", tool: "erasure", user: ctx.identity.userId, role: ctx.identity.role, outcome: "ok", args: { identity } });
      return { type, erased: r.erased, consentRemoved: true };
    }
    return { type, profile: await ctx.call("aep", "get_profile", { identity }), consent: policy.consent.get(identity) ?? null };
  };

  return { gateway, auth: gateway.auth, productAgents: PRODUCT_AGENTS, roleAgents, makeCtx, systemIdentity, privacyRequest, ...p };
}

export const platform = createPlatform();
