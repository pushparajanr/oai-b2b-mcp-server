import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { imsFetch } from "./ims.js";

const textOf = (r) => r.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";

/** Thin MCP client for one remote endpoint: lazy connect, reconnect on transport failure, JSON result parsing. */
export class UpstreamClient {
  constructor({ key, url, headers, ims = null, timeoutMs = 30_000 }) { Object.assign(this, { key, url, headers, ims, timeoutMs }); this.client = null; }
  async connect() {
    if (this.client) return this.client;
    const c = new Client({ name: "oai-b2b-mcp-server", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: this.headers }, ...(this.ims && { fetch: imsFetch(this.ims) }) }));
    return (this.client = c);
  }
  async close() { await this.client?.close().catch(() => {}); this.client = null; }
  async #run(fn) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(await this.connect()); }
      catch (e) {
        if (e?.name === "McpError" && !/connection closed|timed out/i.test(e.message) && e.code !== -32000) throw e; // protocol-level error: don't retry
        await this.close();
        if (attempt >= 1) throw Object.assign(new Error(`${this.key}: ${e.message}`), { transient: true });
      }
    }
  }
  async listTools() {
    const tools = [];
    let cursor;
    do { const r = await this.#run((c) => c.listTools({ cursor })); tools.push(...r.tools); cursor = r.nextCursor; } while (cursor);
    return tools;
  }
  async callTool(name, args = {}) {
    const r = await this.#run((c) => c.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs }));
    if (r.isError) throw new Error(textOf(r) || `${this.key}.${name} failed`);
    if (r.structuredContent) return r.structuredContent;
    const t = textOf(r);
    try { return JSON.parse(t); } catch { return t; }
  }
}
