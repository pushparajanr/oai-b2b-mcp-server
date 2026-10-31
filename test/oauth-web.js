import assert from "node:assert/strict";
import { createAuthorizationUrl, parseAuthorizationCallback } from "../src/upstream/oauth-web.js";
import { loadUpstreamConfig } from "../src/upstream/config.js";

const redirectUri = "https://example.ngrok-free.dev/oauth/callback";
const state = "random-state";
const url = createAuthorizationUrl({
  authorizeUrl: "https://ims-na1.adobelogin.com/ims/authorize/v2",
  clientId: "client-id",
  redirectUri,
  scopes: "openid,AdobeID,offline_access",
  state,
});
assert.equal(url.searchParams.get("response_type"), "code");
assert.equal(url.searchParams.get("client_id"), "client-id");
assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
assert.equal(url.searchParams.get("scope"), "openid,AdobeID,offline_access");
assert.equal(url.searchParams.get("state"), state);
assert.equal(parseAuthorizationCallback(`${redirectUri}?code=one-time-code&state=${state}`, { redirectUri, state }), "one-time-code");
assert.throws(() => parseAuthorizationCallback(`${redirectUri}?code=abc&state=wrong`, { redirectUri, state }), /state validation failed/);
assert.throws(() => parseAuthorizationCallback(`https://other.example/callback?code=abc&state=${state}`, { redirectUri, state }), /does not match/);
assert.throws(() => createAuthorizationUrl({ authorizeUrl: "http://example.test", clientId: "x", redirectUri, scopes: "x", state }), /HTTPS/);

const webEnv = {
  ADOBE_AUTH_MODE: "authorization_code",
  ADOBE_CLIENT_ID: "client-id",
  ADOBE_CLIENT_SECRET: "client-secret",
  ADOBE_REFRESH_TOKEN: "refresh-value",
  ADOBE_UPSTREAMS: "cdp",
};
assert.equal(loadUpstreamConfig(webEnv).length, 1);
assert.equal(loadUpstreamConfig({ ...webEnv, ADOBE_REFRESH_TOKEN: "" }).length, 0);

console.log("oauth web OK");
