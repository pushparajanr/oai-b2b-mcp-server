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
import { loadUpstreamConfig } from "./upstream/config.js";
import { RemoteAgent } from "./upstream/remote-agent.js";
import { UserUpstreamAuth } from "./upstream/user-auth.js";
import { AjoRestAgent } from "./upstream/ajo-rest.js";
import { readFileSync } from "node:fs";

export const PRODUCT_AGENTS = [aep, ajo, workfront, aemSites, aemAssets, brandConcierge, fusion, marketo, cja];
const DEFAULT_GUIDELINES = { tone: "friendly", bannedWords: [], requiredDisclaimer: "", maxSubjectLength: 60 };

/** Wires layers 3-5 together. One shared instance per process (state lives in the product agents). */
export function createPlatform({ now = Date.now, env = process.env } = {}) {
  const integration = new Integration();
  const routes = env.ADOBE_TOOL_MAP ? JSON.parse(readFileSync(env.ADOBE_TOOL_MAP, "utf8")) : {};
  const gateway = new Gateway({ agents: PRODUCT_AGENTS, integration, now, routes });
  const upstreams = new Map();
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

  const userAuthKeys = new Set((env.ADOBE_USER_TOKEN_UPSTREAMS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const userAuth = userAuthKeys.size && env.ADOBE_SIGNIN_CLIENT_ID && env.ADOBE_SIGNIN_CLIENT_SECRET
    ? new UserUpstreamAuth({ tokenUrl: env.ADOBE_IMS_URL ?? "https://ims-na1.adobelogin.com/ims/token/v3", clientId: env.ADOBE_SIGNIN_CLIENT_ID, clientSecret: env.ADOBE_SIGNIN_CLIENT_SECRET, now })
    : null;
  /** Store a signed-in user's own Adobe tokens; user-token upstreams then call as that user. */
  const setUserTokens = (userId, tokens) => {
    if (!userAuth) return;
    userAuth.set(userId, tokens);
    for (const a of upstreams.values()) a.resetUser?.(userId);
  };

  /** Connect configured live Adobe MCP endpoints and register their discovered tools. Failures are recorded, not fatal. */
  const initUpstreams = async () => {
    const cfgs = loadUpstreamConfig(env);
    if (env.MCP_LIVE_ONLY === "1" && cfgs[0]?.ims) {
      // Live mode: AJO is served by the real AJO REST API instead of the simulated agent (same role/entitlement key).
      const ajo = new AjoRestAgent({ env, ims: cfgs[0].ims, userAuth: userAuthKeys.has("ajo") ? userAuth : null });
      upstreams.set("ajo", ajo); gateway.addService(ajo);
    }
    await Promise.all(cfgs.map(async (cfg) => {
      const agent = upstreams.get(cfg.key) ?? new RemoteAgent(cfg, undefined, userAuth && userAuthKeys.has(cfg.key) ? userAuth : null);
      upstreams.set(cfg.key, agent);
      await agent.discover();
      if (agent.status.connected) gateway.addService(agent);
    }));
    return upstreamStatus();
  };
  const upstreamStatus = () => [...upstreams.values()].map((a) => ({ service: a.key, product: a.product, url: a.url, readOnly: a.readOnly, ...a.status }));

  return { initUpstreams, upstreamStatus, upstreams, setUserTokens, userAuth, gateway, auth: gateway.auth, productAgents: PRODUCT_AGENTS, roleAgents, makeCtx, systemIdentity, privacyRequest, ...p };
}

export const platform = createPlatform();
