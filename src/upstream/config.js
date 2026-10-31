import "dotenv/config";
import { UPSTREAMS } from "./endpoints.js";
import { ImsTokenProvider } from "./ims.js";
import { persistEnvValue } from "./local-env.js";

const TRUSTED_HOST = /(^|\.)(adobe\.io|adobeaemcloud\.com|adobe\.com|adobelogin\.com)$/;
const DEFAULT_IMS = "https://ims-na1.adobelogin.com/ims/token/v3";
export const DEFAULT_IMS_AUTHORIZE = "https://ims-na1.adobelogin.com/ims/authorize/v2";
export const checkHost = (env, url, what) => {
  const u = new URL(url);
  if (env.ADOBE_ALLOW_CUSTOM_HOSTS !== "1" && !(u.protocol === "https:" && TRUSTED_HOST.test(u.hostname))) throw new Error(`Refusing to send credentials to ${u.origin} for '${what}'; set ADOBE_ALLOW_CUSTOM_HOSTS=1 to override`);
};

/**
 * Reads upstream settings from env.
 *   ADOBE_CLIENT_ID + ADOBE_CLIENT_SECRET [+ ADOBE_SCOPES]  IMS OAuth Server-to-Server (preferred; tokens are fetched and refreshed)
 *   ADOBE_IMS_URL / ADOBE_IMS_SKEW_MS                       IMS token endpoint (default ims-na1) / refresh-ahead window
 *   ADOBE_IMS_TOKEN            static bearer token (or ADOBE_<KEY>_TOKEN per upstream, e.g. ADOBE_CDP_TOKEN)
 *   ADOBE_<KEY>_URL            override endpoint URL
 *   ADOBE_API_KEY / ADOBE_ORG_ID / ADOBE_SANDBOX_NAME   sent as x-api-key / x-gw-ims-org-id / x-sandbox-name
 *   ADOBE_<KEY>_HEADERS        JSON object of extra headers
 *   ADOBE_UPSTREAMS            comma list to restrict which upstreams are enabled (default: all with a token)
 *   ADOBE_ALLOW_CUSTOM_HOSTS=1 allow non-Adobe or non-https URLs (tests / private proxies only)
 * Tokens are only ever sent to https Adobe hosts unless ADOBE_ALLOW_CUSTOM_HOSTS=1.
 */
export function loadUpstreamConfig(env = process.env, { providerFor } = {}) {
  const only = env.ADOBE_UPSTREAMS?.split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  const authMode = env.ADOBE_AUTH_MODE ?? "client_credentials";
  if (!["client_credentials", "authorization_code"].includes(authMode)) throw new Error(`Unsupported ADOBE_AUTH_MODE '${authMode}'`);
  const hasRefreshCredentials = authMode !== "authorization_code" || !!env.ADOBE_REFRESH_TOKEN;
  const ims = providerFor ? null : env.ADOBE_CLIENT_ID && env.ADOBE_CLIENT_SECRET && hasRefreshCredentials ? (() => {
    const tokenUrl = env.ADOBE_IMS_URL ?? DEFAULT_IMS; checkHost(env, tokenUrl, "ims");
    return new ImsTokenProvider({
      tokenUrl, clientId: env.ADOBE_CLIENT_ID, clientSecret: env.ADOBE_CLIENT_SECRET,
      scope: env.ADOBE_SCOPES,
      refreshToken: authMode === "authorization_code" ? env.ADOBE_REFRESH_TOKEN : undefined,
      onRefreshToken: authMode === "authorization_code" && env === process.env
        ? (value) => persistEnvValue(".env", "ADOBE_REFRESH_TOKEN", value)
        : undefined,
      skewMs: env.ADOBE_IMS_SKEW_MS ? Number(env.ADOBE_IMS_SKEW_MS) : undefined,
    });
  })() : null;
  for (const [key, def] of Object.entries(UPSTREAMS)) {
    const K = key.toUpperCase();
    const token = env[`ADOBE_${K}_TOKEN`] ?? env.ADOBE_IMS_TOKEN;
    const shared = providerFor?.(key) ?? null; // token broker's credential for this service: { provider, apiKey, orgId }
    if ((!token && !ims && !shared) || (only && !only.includes(key))) continue;
    const url = env[`ADOBE_${K}_URL`] ?? def.url;
    checkHost(env, url, key);
    const useIms = !env[`ADOBE_${K}_TOKEN`] && (shared?.provider ?? ims); // an explicit per-upstream static token wins
    const apiKey = shared ? shared.apiKey : env.ADOBE_API_KEY ?? (useIms ? env.ADOBE_CLIENT_ID : undefined);
    const orgId = shared ? shared.orgId : env.ADOBE_ORG_ID;
    const headers = { ...(!useIms && { authorization: `Bearer ${token}` }),
      ...(apiKey && { "x-api-key": apiKey }), ...(orgId && { "x-gw-ims-org-id": orgId }),
      ...(env.ADOBE_SANDBOX_NAME && { "x-sandbox-name": env.ADOBE_SANDBOX_NAME }), ...JSON.parse(env[`ADOBE_${K}_HEADERS`] ?? "{}") };
    out.push({ ...def, key, url, headers, extraHeaders: JSON.parse(env[`ADOBE_${K}_HEADERS`] ?? "{}"), ims: useIms || null });
  }
  return out;
}
