import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { imsFetch } from "./ims.js";
import { UpstreamError, capture, observingFetch } from "./errors.js";

const textOf = (r) => r.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";

/** Thin MCP client for one remote endpoint: lazy connect, reconnect on transport failure, JSON result parsing. */
export class UpstreamClient {
  constructor({ key, url, headers, ims = null, timeoutMs = 30_000 }) { Object.assign(this, { key, url, headers, ims, timeoutMs }); this.client = null; }
  async connect() {
    if (this.client) return this.client;
    const c = new Client({ name: "oai-b2b-mcp-server", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: this.headers }, fetch: this.ims ? imsFetch(this.ims, observingFetch()) : observingFetch() }));
    return (this.client = c);
  }
  async close() { await this.client?.close().catch(() => {}); this.client = null; }
  async #run(fn) {
    const store = { last: null };
    return capture.run(store, async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await fn(await this.connect()); }
        catch (e) {
          if (e instanceof UpstreamError) throw e;
          const httpStatus = typeof e?.code === "number" && e.code >= 400 && e.code < 600 ? e.code : null;
          if (httpStatus) throw new UpstreamError(`${this.key}: upstream rejected the request`, { status: httpStatus, requestId: store.last?.requestId, body: store.last?.body ?? e.message });
          if (e?.name === "McpError" && !/connection closed|timed out/i.test(e.message) && e.code !== -32000) throw e; // protocol-level error: don't retry
          await this.close();
          if (attempt >= 1) throw Object.assign(new Error(`${this.key}: ${e.message}`), { transient: true });
        }
      }
    });
  }
  async listTools() {
    const tools = [];
    let cursor;
    do { const r = await this.#run((c) => c.listTools({ cursor })); tools.push(...r.tools); cursor = r.nextCursor; } while (cursor);
    return tools;
  }
  async callTool(name, args = {}) {
    const r = await this.#run((c) => c.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs }));
    if (r.isError) throw new UpstreamError(textOf(r) || `${this.key}.${name} failed`, { body: textOf(r) });
    if (r.structuredContent) return r.structuredContent;
    const t = textOf(r);
    try { return JSON.parse(t); } catch { return t; }
  }
}
