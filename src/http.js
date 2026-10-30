#!/usr/bin/env node
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./index.js";
import { platform } from "./platform.js";

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let d = ""; req.on("data", (c) => { d += c; if (d.length > 2_000_000) reject(new Error("body too large")); });
  req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } }); req.on("error", reject);
});

/**
 * Remote MCP endpoint for ChatGPT custom apps, Teams, web and Adobe Experience Cloud embeds.
 * POST /mcp requires `Authorization: Bearer <gateway token>`. POST /auth/login is a dev stand-in for Entra SSO
 * and is disabled when NODE_ENV=production unless ALLOW_DEV_LOGIN=1. POST /events/:source/:type needs WEBHOOK_SECRET.
 */
export function startHttp({ port = Number(process.env.PORT ?? 3000) } = {}) {
  const devLogin = process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_LOGIN === "1";
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (req.method === "POST" && url.pathname === "/auth/login") {
        if (!devLogin) return json(res, 404, { error: "not found" });
        return json(res, 200, platform.auth.login(await readBody(req)));
      }
      if (req.method === "POST" && url.pathname.startsWith("/events/")) {
        const [, , source, type] = url.pathname.split("/");
        if (!process.env.WEBHOOK_SECRET || req.headers["x-webhook-secret"] !== process.env.WEBHOOK_SECRET) return json(res, 401, { error: "invalid webhook secret" });
        return json(res, 200, await platform.integration.handleEvent(source, type, await readBody(req)));
      }
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed (stateless server)" });
        let identity;
        try { identity = platform.auth.verify((req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")); }
        catch (e) { return json(res, 401, { error: e.message }); }
        const mcp = createServer(undefined, { identity });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { transport.close(); mcp.close(); });
        await mcp.connect(transport);
        return transport.handleRequest(req, res, await readBody(req));
      }
      json(res, 404, { error: "not found" });
    } catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }); }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startHttp();
  console.error(`MCP HTTP listening on :${s.address().port}/mcp`);
}
