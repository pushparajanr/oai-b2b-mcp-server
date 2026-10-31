import { loggedFetch } from "../log.js";

/**
 * Adobe IMS OAuth Server-to-Server (client_credentials) token provider.
 * Caches the access token, refreshes shortly before expiry, and de-duplicates concurrent refreshes.
 * Never logs or returns the client secret.
 */
export class ImsTokenProvider {
  constructor({ tokenUrl, clientId, clientSecret, scope, refreshToken, onRefreshToken, fetchImpl = loggedFetch(fetch, "ims"), now = Date.now, skewMs = 60_000 }) {
    Object.assign(this, { tokenUrl, clientId, scope, refreshToken, onRefreshToken, fetchImpl, now, skewMs });
    this.secret = clientSecret;
    this.cached = null; this.inflight = null; this.requests = 0;
  }
  async getToken() {
    if (this.cached && this.cached.expiresAt - this.skewMs > this.now()) return this.cached.token;
    this.inflight ??= this.#fetch().finally(() => { this.inflight = null; });
    return this.inflight;
  }
  invalidate() { this.cached = null; }
  status() { return { method: this.refreshToken ? "ims-refresh-token" : "ims-client-credentials", hasToken: !!this.cached, expiresAt: this.cached ? new Date(this.cached.expiresAt).toISOString() : null, tokenRequests: this.requests }; }
  async #fetch() {
    this.requests++;
    const body = new URLSearchParams(this.refreshToken
      ? { grant_type: "refresh_token", client_id: this.clientId, client_secret: this.secret, refresh_token: this.refreshToken }
      : { grant_type: "client_credentials", client_id: this.clientId, client_secret: this.secret });
    if (!this.refreshToken && this.scope) body.set("scope", this.scope);
    let res;
    try { res = await this.fetchImpl(this.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }); }
    catch (e) { throw Object.assign(new Error(`IMS token request failed: ${e.message}`), { transient: true }); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`IMS token request failed: ${res.status} ${data.error ?? ""} ${data.error_description ?? ""}`.trim());
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
      this.refreshToken = data.refresh_token;
      await this.onRefreshToken?.(data.refresh_token);
    }
    this.cached = { token: data.access_token, expiresAt: this.now() + Number(data.expires_in ?? 3600) * 1000 };
    this.subject = tokenSubject(data.access_token) ?? this.subject;
    return this.cached.token;
  }
}

/** The IMS principal (`user_id` claim, e.g. a technical account ID) of a JWT access token; null for opaque tokens. Claims are read, not trusted for authorization. */
function tokenSubject(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).user_id ?? null; } catch { return null; }
}

/** fetch wrapper that injects a fresh IMS bearer token and retries once after a 401 (revoked/expired token). */
export function imsFetch(provider, fetchImpl = fetch) {
  return async (input, init = {}) => {
    const call = async () => { const h = new Headers(init.headers); h.set("authorization", `Bearer ${await provider.getToken()}`); return fetchImpl(input, { ...init, headers: h }); };
    let res = await call();
    if (res.status === 401) { provider.invalidate(); res = await call(); }
    return res;
  };
}
