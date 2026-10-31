#!/usr/bin/env node
// Live end-to-end check against a running server (default: the public tunnel). No mocks: lists tools and calls a read-only live tool.
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? `${process.env.PUBLIC_URL ?? "http://127.0.0.1:3000"}/mcp`;
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { authorization: `Bearer ${process.env.MCP_API_KEY}`, "ngrok-skip-browser-warning": "1" } },
});
const client = new Client({ name: "live-e2e", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
const simulated = tools.filter((t) => /^(aep|ajo|workfront|aemSites|aemAssets|brandConcierge|fusion|marketo|cja|agent|orchestrator)_|^(create_campaign|auth_login)$/.test(t.name));
console.log(`tools: ${tools.length} (simulated exposed: ${simulated.length})`);
console.log("sample:", tools.slice(0, 8).map((t) => t.name).join(", "));
const target = tools.find((t) => /list-aem-environments/.test(t.name));
if (target) {
  const r = await client.callTool({ name: target.name, arguments: {} });
  console.log(`${target.name} -> isError=${!!r.isError}`, r.content[0].text.slice(0, 300).replace(/\s+/g, " "));
}
await client.close();
process.exit(simulated.length ? 1 : 0);
