#!/usr/bin/env node
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./index.js";
import { platform as defaultPlatform } from "./platform.js";
import { createConnect } from "./auth/connect.js";
import { createOAuth } from "./oauth.js";
import { log } from "./log.js";

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let d = ""; req.on("data", (c) => { d += c; if (d.length > 2_000_000) reject(new Error("body too large")); });
  req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } }); req.on("error", reject);
});

const secretMatches = (given, expected) => {
  const a = Buffer.from(String(given ?? "")); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Remote MCP endpoint for ChatGPT custom apps, Teams, web and Adobe Experience Cloud embeds.
 * POST /mcp requires `Authorization: Bearer <gateway token>`. POST /auth/login is a dev stand-in for Entra SSO
 * and is disabled when NODE_ENV=production unless ALLOW_DEV_LOGIN=1. POST /events/:source/:type needs WEBHOOK_SECRET.
 */
export function startHttp({ port = Number(process.env.PORT ?? 3000), platform = defaultPlatform } = {}) {
  const devLogin = process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_LOGIN === "1";
  const apiKey = process.env.MCP_API_KEY;
  if (apiKey && apiKey.length < 24) throw new Error("MCP_API_KEY must be at least 24 characters");
  const apiKeyIdentity = apiKey ? platform.auth.identityFor(process.env.MCP_API_KEY_USER ?? "morgan.ops") : null;
  const oauth = createOAuth({ auth: platform.auth, loginSecret: process.env.LOGIN_SECRET, broker: platform.broker });
  const connect = createConnect({ broker: platform.broker });
  const server = http.createServer(async (req, res) => {
    const t0 = performance.now();
    const meta = {};
    res.on("finish", () => {
      const path = (req.url ?? "").split("?")[0];
      log[path === "/healthz" ? "debug" : "info"]("http.request", { method: req.method, path, status: res.statusCode, ms: Math.round(performance.now() - t0),
        ip: String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim(), ua: req.headers["user-agent"], ...meta });
    });
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/") {
        return json(res, 200, { name: "oai-b2b-mcp-server", mcp_endpoint: "/mcp", note: "Add <this-host>/mcp as an MCP connector; browsers cannot use /mcp directly." });
      }
      if (await connect(req, res, url)) return;
      if (await oauth(req, res, url)) return;
      if (req.method === "POST" && url.pathname === "/auth/login") {
        if (!devLogin) return json(res, 404, { error: "not found" });
        // Tunneled (proxied) logins must present LOGIN_SECRET; with no secret configured they are refused.
        const proxied = !!(req.headers["x-forwarded-for"] || req.headers["ngrok-trace-id"]);
        const secret = process.env.LOGIN_SECRET;
        if (secret ? !secretMatches(req.headers["x-login-secret"], secret) : proxied) return json(res, 401, { error: "login secret required" });
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
        const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        try { identity = apiKey && secretMatches(bearer, apiKey) ? apiKeyIdentity : platform.auth.verify(bearer); }
        catch (e) {
          const proto = req.headers["x-forwarded-proto"]?.split(",")[0] ?? "http";
          const base = (process.env.PUBLIC_URL ?? `${proto}://${req.headers["x-forwarded-host"]?.split(",")[0] ?? req.headers.host}`).replace(/\/$/, "");
          res.setHeader("www-authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
          log.warn("mcp.auth_failed", { reason: e.message });
          return json(res, 401, { error: e.message });
        }
        meta.user = identity.userId;
        const mcp = createServer(undefined, { identity, platform });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { transport.close(); mcp.close(); });
        await mcp.connect(transport);
        const body = await readBody(req);
        const rpc = Array.isArray(body) ? body[0] : body;
        Object.assign(meta, { rpc: rpc?.method, rpcTool: rpc?.params?.name });
        return transport.handleRequest(req, res, body);
      }
      json(res, 404, { error: "not found" });
    } catch (e) { log.error("http.unhandled", { path: req.url?.split("?")[0], error: e }); if (!res.headersSent) json(res, 500, { error: e.message }); }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await defaultPlatform.initUpstreams();
  const s = await startHttp();
  const ups = [...defaultPlatform.upstreams.values()].map((u) => `${u.key}:${u.status.connected ? `ok(${u.status.tools})` : "down"}`);
  log.info("server.start", { port: s.address().port, publicUrl: process.env.PUBLIC_URL, level: process.env.LOG_LEVEL ?? "info", sandbox: process.env.ADOBE_SANDBOX_NAME, policy: process.env.ADOBE_AUTH_POLICY, upstreams: ups.join(",") });
  console.error(`MCP HTTP listening on :${s.address().port}/mcp`);
}
