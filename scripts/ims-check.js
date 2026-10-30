#!/usr/bin/env node
// Live check against real Adobe IMS and the configured MCP endpoints. Requires network access to Adobe.
//   ADOBE_CLIENT_ID=... ADOBE_CLIENT_SECRET=... ADOBE_SCOPES="openid,AdobeID,..." ADOBE_ORG_ID=... npm run ims:check
import { createPlatform } from "../src/platform.js";
import { loadUpstreamConfig } from "../src/upstream/config.js";

const cfgs = loadUpstreamConfig();
const ims = cfgs[0]?.ims;
if (!ims) { console.error("Set ADOBE_CLIENT_ID and ADOBE_CLIENT_SECRET (IMS client credentials)."); process.exit(2); }
try {
  const token = await ims.getToken();
  const [, payload] = token.split(".");
  const claims = payload ? JSON.parse(Buffer.from(payload, "base64url").toString()) : {};
  console.log("IMS token OK", { client_id: claims.client_id, scope: claims.scope, expires: ims.status().expiresAt });
} catch (e) { console.error("IMS token FAILED:", e.message); process.exit(1); }
const status = await createPlatform().initUpstreams();
console.table(status.map(({ service, connected, tools, error }) => ({ service, connected, tools, error: error?.slice(0, 80) })));
process.exit(status.some((s) => s.connected) ? 0 : 1);
