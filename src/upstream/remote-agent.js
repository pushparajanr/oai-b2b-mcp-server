import { Agent } from "../agents/base.js";
import { UpstreamClient } from "./client.js";

/** A live Adobe MCP endpoint presented as a gateway service. Tool catalog is discovered, never hard-coded. */
export class RemoteAgent extends Agent {
  constructor(cfg, client = new UpstreamClient(cfg)) {
    super({ key: cfg.key, name: `${cfg.label} (live)`, product: cfg.label, description: `Live MCP upstream (${cfg.note})`, keywords: cfg.keywords ?? [], tools: {} });
    Object.assign(this, { client, live: true, readOnly: !!cfg.readOnly, url: cfg.url, status: { connected: false, tools: 0, error: null } });
  }
  async discover() {
    try {
      const tools = await this.client.listTools();
      this.tools = Object.fromEntries(tools.map((t) => [t.name, { description: t.description ?? "", inputSchema: t.inputSchema, annotations: t.annotations ?? {}, remote: true }]));
      this.status = { connected: true, tools: tools.length, error: null };
    } catch (e) { this.status = { connected: false, tools: 0, error: e.message }; }
    return this.status;
  }
  async call(tool, args = {}) {
    if (!this.tools[tool]) throw new Error(`Live service '${this.key}' has no tool '${tool}'. Use upstream_list_tools.`);
    const result = await this.client.callTool(tool, args);
    this.log.push({ tool, at: new Date().toISOString() });
    return result;
  }
}
