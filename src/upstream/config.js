import { UPSTREAMS } from "./endpoints.js";

const TRUSTED_HOST = /(^|\.)(adobe\.io|adobeaemcloud\.com|adobe\.com)$/;

/**
 * Reads upstream settings from env.
 *   ADOBE_IMS_TOKEN            shared bearer token (or ADOBE_<KEY>_TOKEN per upstream, e.g. ADOBE_CDP_TOKEN)
 *   ADOBE_<KEY>_URL            override endpoint URL
 *   ADOBE_API_KEY / ADOBE_ORG_ID / ADOBE_SANDBOX_NAME   sent as x-api-key / x-gw-ims-org-id / x-sandbox-name
 *   ADOBE_<KEY>_HEADERS        JSON object of extra headers
 *   ADOBE_UPSTREAMS            comma list to restrict which upstreams are enabled (default: all with a token)
 *   ADOBE_ALLOW_CUSTOM_HOSTS=1 allow non-Adobe or non-https URLs (tests / private proxies only)
 * Tokens are only ever sent to https Adobe hosts unless ADOBE_ALLOW_CUSTOM_HOSTS=1.
 */
export function loadUpstreamConfig(env = process.env) {
  const only = env.ADOBE_UPSTREAMS?.split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const [key, def] of Object.entries(UPSTREAMS)) {
    const K = key.toUpperCase();
    const token = env[`ADOBE_${K}_TOKEN`] ?? env.ADOBE_IMS_TOKEN;
    if (!token || (only && !only.includes(key))) continue;
    const url = env[`ADOBE_${K}_URL`] ?? def.url;
    const u = new URL(url);
    if (env.ADOBE_ALLOW_CUSTOM_HOSTS !== "1" && !(u.protocol === "https:" && TRUSTED_HOST.test(u.hostname))) throw new Error(`Refusing to send credentials to ${u.origin} for '${key}'; set ADOBE_ALLOW_CUSTOM_HOSTS=1 to override`);
    const headers = { authorization: `Bearer ${token}`,
      ...(env.ADOBE_API_KEY && { "x-api-key": env.ADOBE_API_KEY }), ...(env.ADOBE_ORG_ID && { "x-gw-ims-org-id": env.ADOBE_ORG_ID }),
      ...(env.ADOBE_SANDBOX_NAME && { "x-sandbox-name": env.ADOBE_SANDBOX_NAME }), ...JSON.parse(env[`ADOBE_${K}_HEADERS`] ?? "{}") };
    out.push({ ...def, key, url, headers });
  }
  return out;
}
