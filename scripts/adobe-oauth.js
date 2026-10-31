#!/usr/bin/env node
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { checkHost, DEFAULT_IMS_AUTHORIZE } from "../src/upstream/config.js";
import { createAuthorizationUrl, parseAuthorizationCallback } from "../src/upstream/oauth-web.js";
import { persistEnvValue } from "../src/upstream/local-env.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: npm run adobe:login");
  console.log("Starts Adobe IMS OAuth Web App sign-in and saves the refresh token to .env.");
  process.exit(0);
}

const { ADOBE_CLIENT_ID: clientId, ADOBE_CLIENT_SECRET: clientSecret, ADOBE_REDIRECT_URI: redirectUri, ADOBE_SCOPES: scopes } = process.env;
if (!clientId || !clientSecret || !redirectUri || !scopes) {
  console.error("Set ADOBE_CLIENT_ID, ADOBE_CLIENT_SECRET, ADOBE_REDIRECT_URI and ADOBE_SCOPES in .env first.");
  process.exit(2);
}

const authorizeUrl = process.env.ADOBE_IMS_AUTHORIZE_URL ?? DEFAULT_IMS_AUTHORIZE;
const tokenUrl = process.env.ADOBE_IMS_URL ?? "https://ims-na1.adobelogin.com/ims/token/v3";
checkHost(process.env, authorizeUrl, "ims authorization");
checkHost(process.env, tokenUrl, "ims token");

const state = randomBytes(32).toString("base64url");
const loginUrl = createAuthorizationUrl({ authorizeUrl, clientId, redirectUri, scopes, state });
console.log("Open this Adobe authorization URL, sign in, and approve access:\n");
console.log(loginUrl.href);
console.log("\nAfter Adobe redirects, paste the complete redirect URL here. The authorization code is not printed or saved.");

const prompt = createInterface({ input: stdin, output: stdout });
let code;
try {
  const callbackUrl = await prompt.question("Redirect URL: ");
  code = parseAuthorizationCallback(callbackUrl.trim(), { redirectUri, state });
} finally {
  prompt.close();
}

const body = new URLSearchParams({
  grant_type: "authorization_code",
  client_id: clientId,
  client_secret: clientSecret,
  code,
  redirect_uri: redirectUri,
});
const response = await fetch(tokenUrl, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body,
});
const data = await response.json().catch(() => ({}));
if (!response.ok || !data.access_token) {
  throw new Error(`Adobe token exchange failed: ${response.status} ${data.error ?? ""} ${data.error_description ?? ""}`.trim());
}
if (!data.refresh_token) throw new Error("Adobe did not return a refresh token; ensure the OAuth app permits offline_access.");

persistEnvValue(resolve(".env"), "ADOBE_REFRESH_TOKEN", data.refresh_token);
console.log("Adobe refresh token saved in .env. Restart the MCP server to connect live upstreams.");
