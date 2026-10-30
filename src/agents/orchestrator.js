import { z } from "zod";

// Canonical order when a request spans products: data -> assets -> content -> activation -> delivery tracking.
const ORDER = ["aep", "aem_assets", "aem_sites", "ajo", "workfront"];

export class Orchestrator {
  constructor(agents) {
    this.agents = new Map(agents.map((a) => [a.key, a]));
    this.runs = [];
  }
  list() { return [...this.agents.values()].map((a) => a.describe()); }
  agent(key) {
    const a = this.agents.get(key);
    if (!a) throw new Error(`Unknown agent '${key}'. Available: ${[...this.agents.keys()].join(", ")}`);
    return a;
  }
  /** Route free text to the relevant agents, with the tools most likely needed. */
  plan(request) {
    const scored = [...this.agents.values()].map((a) => ({ a, s: a.score(request) })).filter((x) => x.s > 0);
    scored.sort((x, y) => ORDER.indexOf(x.a.key) - ORDER.indexOf(y.a.key));
    const t = request.toLowerCase();
    return scored.map(({ a, s }, i) => ({
      order: i + 1, agent: a.key, product: a.product, relevance: s,
      suggestedTools: Object.entries(a.tools).filter(([n, d]) => t.includes(n.replace(/_/g, " ")) || n.split("_").some((w) => w.length > 3 && t.includes(w))).map(([n]) => n),
    }));
  }
  /** Execute explicit steps sequentially. Later steps may reference earlier results as "$stepN.path.to.field". */
  async execute(steps, { continueOnError = false } = {}) {
    const results = [];
    const resolve = (v) => {
      if (typeof v === "string") {
        const m = /^\$step(\d+)\.(.+)$/.exec(v);
        if (m) {
          const r = results[+m[1] - 1];
          if (!r || !r.ok) throw new Error(`${v}: step ${m[1]} has no successful result`);
          const val = m[2].split(".").reduce((o, k) => o?.[k], r.result);
          if (val === undefined) throw new Error(`${v}: path not found`);
          return val;
        }
      }
      if (Array.isArray(v)) return v.map(resolve);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
      return v;
    };
    for (const [i, st] of steps.entries()) {
      try {
        const result = await this.agent(st.agent).call(st.tool, resolve(st.args ?? {}));
        results.push({ step: i + 1, agent: st.agent, tool: st.tool, ok: true, result });
      } catch (e) {
        results.push({ step: i + 1, agent: st.agent, tool: st.tool, ok: false, error: e.message });
        if (!continueOnError) break;
      }
    }
    const run = { at: new Date().toISOString(), completed: results.filter((r) => r.ok).length, total: steps.length, results };
    this.runs.push(run);
    return run;
  }
}

export const stepSchema = z.object({ agent: z.string(), tool: z.string(), args: z.record(z.any()).optional() });
