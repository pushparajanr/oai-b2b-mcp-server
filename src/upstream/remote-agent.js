import { Agent } from "../agents/base.js";
import { UpstreamClient } from "./client.js";

/** A live Adobe MCP endpoint presented as a gateway service. Tool catalog is discovered, never hard-coded. */
export class RemoteAgent extends Agent {
  constructor(cfg, client = new UpstreamClient(cfg), userAuth = null) {
    super({ key: cfg.key, name: `${cfg.label} (live)`, product: cfg.label, description: `Live MCP upstream (${cfg.note})`, keywords: cfg.keywords ?? [], tools: {} });
    Object.assign(this, { client, cfg, userAuth, userClients: new Map(), auth: cfg.ims ? cfg.ims : null, live: true, readOnly: !!cfg.readOnly, url: cfg.url, status: { connected: false, tools: 0, error: null } });
  }
  /** Client that calls this endpoint as the signed-in user (their own Adobe token), created once per user. */
  #clientFor(identity) {
    const id = identity?.userId;
    if (!id || !this.userAuth.has(id)) throw new Error(`'${this.key}' runs as your own Adobe account. Remove and re-add the connector and sign in with Adobe (API-key and demo logins can't use it).`);
    if (!this.userClients.has(id)) {
      const headers = { ...this.cfg.headers, "x-api-key": this.userAuth.clientId };
      this.userClients.set(id, new UpstreamClient({ key: this.key, url: this.url, headers, ims: this.userAuth.provider(id) }));
    }
    return this.userClients.get(id);
  }
  /** Called when a user signs in again with fresh tokens. */
  resetUser(userId) { this.userClients.get(userId)?.close(); this.userClients.delete(userId); }
  async discover() {
    try {
      const tools = await this.client.listTools();
      this.tools = Object.fromEntries(tools.map((t) => [t.name, { description: t.description ?? "", inputSchema: t.inputSchema, annotations: t.annotations ?? {}, remote: true }]));
      this.status = { connected: true, tools: tools.length, error: null, auth: this.auth?.status().method ?? "static-token" };
    } catch (e) { this.status = { connected: false, tools: 0, error: e.message, auth: this.auth?.status().method ?? "static-token" }; }
    return this.status;
  }
  async call(tool, args = {}, identity) {
    if (!this.tools[tool]) throw new Error(`Live service '${this.key}' has no tool '${tool}'. Use upstream_list_tools.`);
    const client = this.userAuth ? this.#clientFor(identity) : this.client;
    const result = await client.callTool(tool, args);
    this.log.push({ tool, at: new Date().toISOString() });
    return result;
  }
}
