#!/usr/bin/env node
// Step-by-step auth diagnosis per service: (1) policy, (2) token from IMS, (3) direct upstream call, (4) same call through the broker.
// Separates Adobe authorization failures from gateway routing problems. Needs network access to Adobe. Never prints secrets.
//   npm run auth:diagnose            all configured services
//   npm run auth:diagnose -- cdp aem
import { createPlatform } from "../src/platform.js";
import { UpstreamError } from "../src/upstream/errors.js";

const p = createPlatform();
const only = process.argv.slice(2);
const rows = [];
await p.initUpstreams();
for (const a of p.upstreams.values()) {
  if (only.length && !only.includes(a.key)) continue;
  const rule = p.authPolicy.rule(a.key);
  const row = { service: a.key, mode: rule.mode, credential: rule.mode === "service" ? rule.credential : `connection:${rule.connection}` };
  try { await p.broker.serviceProvider(rule.credential)?.getToken(); row.imsToken = p.broker.serviceProvider(rule.credential) ? "ok" : "n/a (no service credential)"; }
  catch (e) { row.imsToken = `FAIL ${e.message.slice(0, 60)}`; }
  row.directListTools = a.status.connected ? `ok (${a.status.tools} tools)` : `FAIL ${a.status.error?.slice(0, 80)}`;
  const readTool = Object.entries(a.tools).find(([, d]) => d.annotations?.readOnlyHint && !(d.inputSchema?.required?.length));
  if (!readTool) row.brokerCall = "skipped (no zero-argument read tool)";
  else {
    try { await p.gateway.invoke({ identity: p.systemIdentity, service: a.key, tool: readTool[0], args: {} }); row.brokerCall = `ok (${readTool[0]})`; }
    catch (e) { row.brokerCall = `${e.code}${e.details?.upstream ? ` HTTP ${e.details.upstream.status} req=${e.details.upstream.requestId ?? "-"}` : ""}`; }
  }
  rows.push(row);
}
console.table(rows);
process.exit(rows.length && rows.every((r) => r.directListTools.startsWith("ok")) ? 0 : 1);
