#!/usr/bin/env node
// Starts the HTTP MCP server and exposes it through ngrok. Requires the ngrok CLI with an authtoken configured.
import "dotenv/config";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, appendFileSync } from "node:fs";

const port = process.env.PORT ?? "3000";
const ensureSecret = (name) => {
  if (process.env[name]) return;
  process.env[name] = randomBytes(24).toString("base64url");
  appendFileSync(".env", `${existsSync(".env") ? "\n" : ""}${name}="${process.env[name]}"\n`, { mode: 0o600 });
  console.error(`Generated ${name} and saved it to .env.`);
};
ensureSecret("LOGIN_SECRET");
ensureSecret("MCP_API_KEY");

const server = spawn(process.execPath, ["src/http.js"], { stdio: "inherit", env: { MCP_LIVE_ONLY: "1", ...process.env, PORT: port } });
const tunnel = spawn("ngrok", ["http", port, ...(process.env.NGROK_DOMAIN ? [`--url=${process.env.NGROK_DOMAIN}`] : [])], { stdio: "inherit" });

const stop = () => { server.kill(); tunnel.kill(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
server.on("exit", (c) => { tunnel.kill(); process.exit(c ?? 0); });
tunnel.on("exit", (c) => { server.kill(); process.exit(c ?? 0); });
tunnel.on("error", (e) => { console.error(`Could not start ngrok: ${e.message}`); server.kill(); process.exit(1); });
