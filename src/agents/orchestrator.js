import { z } from "zod";
import { resolveRefs } from "./role-agents.js";

// Canonical order when a request spans products: data -> assets -> brand -> content -> activation -> delivery tracking.
const ORDER = ["aep", "aem_assets", "brand_concierge", "aem_sites", "ajo", "marketo", "fusion", "workfront", "cja"];

/** Product-level orchestrator. All execution goes through `invoke` (the gateway, as the calling user). */
export class Orchestrator {
  constructor(agents, invoke) {
    this.agents = new Map(agents.map((a) => [a.key, a]));
    this.invoke = invoke;
  }
  list() { return [...this.agents.values()].map((a) => a.describe()); }
  agent(key) {
    const a = this.agents.get(key);
    if (!a) throw new Error(`Unknown agent '${key}'. Available: ${[...this.agents.keys()].join(", ")}`);
    return a;
  }
  plan(request) {
    const scored = [...this.agents.values()].map((a) => ({ a, s: a.score(request) })).filter((x) => x.s > 0);
    scored.sort((x, y) => ORDER.indexOf(x.a.key) - ORDER.indexOf(y.a.key));
    const t = request.toLowerCase();
    return scored.map(({ a, s }, i) => ({
      order: i + 1, agent: a.key, product: a.product, relevance: s,
      suggestedTools: Object.keys(a.tools).filter((n) => t.includes(n.replace(/_/g, " ")) || n.split("_").some((w) => w.length > 3 && t.includes(w))),
    }));
  }
  /** Execute explicit steps sequentially; args may reference earlier results as "$step1.id". */
  async execute(steps, { continueOnError = false } = {}) {
    const results = [];
    for (const [i, st] of steps.entries()) {
      try {
        const scope = Object.fromEntries(results.map((r) => [`step${r.step}`, r.ok ? r.result : undefined]));
        this.agent(st.agent);
        const { result } = await this.invoke(st.agent, st.tool, resolveRefs(st.args ?? {}, scope));
        results.push({ step: i + 1, agent: st.agent, tool: st.tool, ok: true, result });
      } catch (e) {
        results.push({ step: i + 1, agent: st.agent, tool: st.tool, ok: false, error: e.message, code: e.code });
        if (!continueOnError) break;
      }
    }
    return { at: new Date().toISOString(), completed: results.filter((r) => r.ok).length, total: steps.length, results };
  }
}

export const stepSchema = z.object({ agent: z.string(), tool: z.string(), args: z.record(z.any()).optional() });
