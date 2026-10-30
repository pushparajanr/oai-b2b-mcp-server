import { z } from "zod";
import { aep } from "./aep.js";
import { ajo } from "./ajo.js";
import { workfront } from "./workfront.js";
import { aemSites } from "./aem-sites.js";
import { aemAssets } from "./aem-assets.js";
import { Orchestrator, stepSchema } from "./orchestrator.js";

/** Registers orchestrator tools plus one namespaced tool per sub-agent tool (e.g. aep_run_query). */
export function registerAgents(server, agents = [aep, ajo, workfront, aemSites, aemAssets]) {
  const orch = new Orchestrator(agents);
  const reply = (d) => ({ content: [{ type: "text", text: JSON.stringify(d, null, 2) }] });
  const safe = (fn) => async (args) => { try { return reply(await fn(args)); } catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; } };

  server.registerTool("orchestrator_list_agents", { description: "List sub-agents (AEP, AJO, Workfront, AEM Sites, AEM Assets) and their tools.", inputSchema: {} }, safe(() => orch.list()));
  server.registerTool("orchestrator_plan", { description: "Route a free-text request to the sub-agents that should handle it, in dependency order, with suggested tools.", inputSchema: { request: z.string() } },
    safe(({ request }) => { const plan = orch.plan(request); return plan.length ? plan : { message: "No agent matched; use orchestrator_list_agents." }; }));
  server.registerTool("orchestrator_execute", {
    description: "Run a multi-agent workflow: ordered steps {agent, tool, args}. Args may reference prior results as '$step1.id'. Stops at first failure unless continueOnError.",
    inputSchema: { steps: z.array(stepSchema).min(1), continueOnError: z.boolean().optional() } }, safe(({ steps, continueOnError }) => orch.execute(steps, { continueOnError })));
  server.registerTool("orchestrator_delegate", { description: "Call a single sub-agent tool directly.", inputSchema: { agent: z.string(), tool: z.string(), args: z.record(z.any()).optional() } },
    safe(({ agent, tool, args }) => orch.agent(agent).call(tool, args ?? {})));

  for (const a of agents) for (const [name, def] of Object.entries(a.tools)) {
    server.registerTool(`${a.key}_${name}`, { description: `[${a.product}] ${def.description}`, inputSchema: def.shape ? def.schema.shape : {} }, safe((args) => a.call(name, args)));
  }
  return orch;
}
