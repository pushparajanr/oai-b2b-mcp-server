export function createAuthorizationUrl({ authorizeUrl, clientId, redirectUri, scopes, state }) {
  const url = new URL(authorizeUrl);
  if (url.protocol !== "https:") throw new Error("Adobe authorization URL must use HTTPS");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);
  return url;
}

export function parseAuthorizationCallback(callbackUrl, { redirectUri, state }) {
  let actual;
  let expected;
  try {
    actual = new URL(callbackUrl);
    expected = new URL(redirectUri);
  } catch {
    throw new Error("Paste the full redirect URL from the browser");
  }
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
    throw new Error("OAuth callback does not match the registered redirect URI");
  }
  if (actual.searchParams.get("state") !== state) throw new Error("OAuth state validation failed");
  if (actual.searchParams.has("error")) throw new Error(`Adobe authorization failed: ${actual.searchParams.get("error")}`);
  const code = actual.searchParams.get("code");
  if (!code) throw new Error("OAuth callback did not include an authorization code");
  return code;
}
