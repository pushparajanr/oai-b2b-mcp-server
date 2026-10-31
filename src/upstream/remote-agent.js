import { Agent } from "../agents/base.js";
import { UpstreamClient } from "./client.js";
import { traced } from "../log.js";

/** A live Adobe MCP endpoint presented as a gateway service. Tool catalog is discovered, never hard-coded. */
export class RemoteAgent extends Agent {
  constructor(cfg, client = new UpstreamClient(cfg)) {
    super({ key: cfg.key, name: `${cfg.label} (live)`, product: cfg.label, description: `Live MCP upstream (${cfg.note})`, keywords: cfg.keywords ?? [], tools: {} });
    Object.assign(this, { client, cfg, clients: new Map(), auth: cfg.ims ? cfg.ims : null, live: true, readOnly: !!cfg.readOnly, url: cfg.url, status: { connected: false, tools: 0, error: null } });
  }
  /** One client per acting principal (service credential+sandbox, or user+connection), created on first use. */
  #clientFor(authCtx) {
    if (!authCtx || (authCtx.mode === "service" && !authCtx.provider)) return this.client; // static-token setup
    if (!this.clients.has(authCtx.key)) {
      this.clients.set(authCtx.key, new UpstreamClient({ key: this.key, url: this.url, headers: { ...this.cfg.extraHeaders, ...authCtx.headers }, ims: authCtx.provider }));
    }
    return this.clients.get(authCtx.key);
  }
  /** Drop cached clients for a user (called when their connection changes). */
  dropUser(userId) { for (const [k, c] of this.clients) if (k.startsWith(`delegated|${userId}|`)) { c.close(); this.clients.delete(k); } }
  async discover() {
    try {
      const tools = await this.client.listTools();
      this.tools = Object.fromEntries(tools.map((t) => [t.name, { description: t.description ?? "", inputSchema: t.inputSchema, annotations: t.annotations ?? {}, remote: true }]));
      this.status = { connected: true, tools: tools.length, error: null, auth: this.auth?.status().method ?? "static-token" };
    } catch (e) { this.status = { connected: false, tools: 0, error: e.message, auth: this.auth?.status().method ?? "static-token" }; }
    return this.status;
  }
  async call(tool, args = {}, identity, authCtx) {
    return traced("upstream.call", { agent: this.key, tool, url: this.url, authMode: authCtx?.mode, sandbox: authCtx?.sandbox, args }, async () => {
      if (!this.tools[tool]) throw new Error(`Live service '${this.key}' has no tool '${tool}'. Use upstream_list_tools.`);
      const result = await this.#clientFor(authCtx).callTool(tool, args);
      this.log.push({ tool, at: new Date().toISOString() });
      return result;
    });
  }
}
