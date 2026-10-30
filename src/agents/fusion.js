import { z } from "zod";
import { Agent, uid, coll } from "./base.js";

const init = (s) => coll(s, "scenarios");

export const fusion = new Agent({
  key: "fusion", name: "Fusion Agent", product: "Adobe Workfront Fusion",
  description: "Event-driven orchestration scenarios, connectors and approval-to-activation workflows.",
  keywords: ["fusion", "scenario", "connector", "event-driven", "approval to activation"],
  tools: {
    create_scenario: { description: "Define an event-driven scenario: trigger + ordered steps across products.", shape: 1,
      schema: z.object({ name: z.string(), trigger: z.string(), steps: z.array(z.object({ service: z.string(), tool: z.string(), args: z.record(z.any()).optional() })).min(1) }),
      run(a, s) { init(s); const v = { id: uid("scn"), ...a, active: true, runs: [] }; s.scenarios.set(v.id, v); return { id: v.id, name: v.name, trigger: v.trigger, steps: v.steps.length }; } },
    list_scenarios: { description: "List scenarios.", run: (_, s) => (init(s), [...s.scenarios.values()].map(({ id, name, trigger, active, runs }) => ({ id, name, trigger, active, runs: runs.length }))) },
    trigger_scenario: { description: "Fire a scenario with an event payload. Simulation: records each step as dispatched; the caller performs the product calls.", shape: 1,
      schema: z.object({ scenarioId: z.string(), payload: z.record(z.any()).default({}) }),
      run(a, s) { init(s); const sc = s.scenarios.get(a.scenarioId); if (!sc) throw new Error(`Unknown scenario '${a.scenarioId}'`);
        if (!sc.active) throw new Error("Scenario is inactive");
        const run = { id: uid("run"), at: new Date().toISOString(), payload: a.payload, steps: sc.steps.map((st) => ({ step: `${st.service}.${st.tool}`, status: "dispatched" })) };
        sc.runs.push(run); return run; } },
    get_scenario_runs: { description: "Get run history of a scenario.", shape: 1, schema: z.object({ scenarioId: z.string() }),
      run(a, s) { init(s); const sc = s.scenarios.get(a.scenarioId); if (!sc) throw new Error(`Unknown scenario '${a.scenarioId}'`); return sc.runs; } },
  },
});
