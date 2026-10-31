import { createHash, randomBytes } from "node:crypto";
import { GatewayError } from "../gateway/transform.js";
import { ImsTokenProvider } from "../upstream/ims.js";
import { checkHost, DEFAULT_IMS_AUTHORIZE } from "../upstream/config.js";
import { persistEnvValue } from "../upstream/local-env.js";
import { loggedFetch } from "../log.js";
import { COWORKER_CONNECTION, signinScopes } from "./coworker.js";

const DEFAULT_IMS_TOKEN = "https://ims-na1.adobelogin.com/ims/token/v3";
const CONNECT_TTL_MS = 10 * 60_000;

/** Token source for a connection that has no refresh token: usable until the access token expires. */
class ExpiringToken {
  constructor(token, expiresAt, now) { Object.assign(this, { token, expiresAt, now }); }
  expired() { return this.expiresAt - 30_000 <= this.now(); }
  async getToken() { if (this.expired()) throw new GatewayError("connection_required", "The Adobe connection expired"); return this.token; }
  invalidate() {}
  status() { return { method: "user-access-token", hasToken: true, expiresAt: new Date(this.expiresAt).toISOString() }; }
}

/**
 * Token broker. Resolves, for one operation and one user, WHICH Adobe principal acts and with WHICH token:
 *  - service mode:   a server-to-server (technical account) token. Cached by client + org + scope set. Which users may invoke the
 *                    operation is enforced by the gateway (roles, allowedRoles) before the broker is reached.
 *  - delegated mode: the user's own Adobe token from a connection (cached per user + connection). If the user has no connection the
 *                    broker raises `connection_required` with an authorization link. It NEVER falls back to a technical account.
 * Secrets and tokens stay inside this class and the providers it owns.
 */
export class TokenBroker {
  constructor({ env = process.env, policy, now = Date.now, fetchImpl = loggedFetch(fetch, "ims") } = {}) {
    Object.assign(this, { env, policy, now, fetchImpl });
    this.tokenUrl = env.ADOBE_IMS_URL ?? DEFAULT_IMS_TOKEN; checkHost(env, this.tokenUrl, "ims");
    this.credentials = this.#loadCredentials(env);
    this.serviceProviders = new Map();
    this.connections = new Map();
    this.connectRequests = new Map();
    this.webApp = env.ADOBE_SIGNIN_CLIENT_ID && env.ADOBE_SIGNIN_CLIENT_SECRET ? {
      clientId: env.ADOBE_SIGNIN_CLIENT_ID, secret: env.ADOBE_SIGNIN_CLIENT_SECRET,
      authorizeUrl: env.ADOBE_IMS_AUTHORIZE_URL ?? DEFAULT_IMS_AUTHORIZE,
    } : null;
    if (this.webApp) checkHost(env, this.webApp.authorizeUrl, "adobe authorize");
    this.publicUrl = (env.PUBLIC_URL ?? "").replace(/\/$/, "") || null;
    this.redirectUri = env.ADOBE_CONNECT_REDIRECT_URI ?? (this.publicUrl ? `${this.publicUrl}/connect/callback` : null);
  }

  // ---- credentials (service mode) ----
  #loadCredentials(env) {
    const out = new Map();
    const authCode = env.ADOBE_AUTH_MODE === "authorization_code";
    if (env.ADOBE_CLIENT_ID && env.ADOBE_CLIENT_SECRET && (!authCode || env.ADOBE_REFRESH_TOKEN)) {
      out.set("default", { name: "default", clientId: env.ADOBE_CLIENT_ID, secret: env.ADOBE_CLIENT_SECRET, scopes: env.ADOBE_SCOPES ?? "", orgId: env.ADOBE_ORG_ID, apiKey: env.ADOBE_API_KEY,
        refreshToken: authCode ? env.ADOBE_REFRESH_TOKEN : undefined,
        onRefreshToken: authCode && env === process.env ? (v) => persistEnvValue(".env", "ADOBE_REFRESH_TOKEN", v) : undefined });
    }
    for (const k of Object.keys(env)) {
      const m = /^ADOBE_CRED_(.+)_CLIENT_ID$/.exec(k);
      if (!m) continue;
      const P = `ADOBE_CRED_${m[1]}_`;
      if (!env[`${P}CLIENT_SECRET`]) continue;
      out.set(m[1].toLowerCase(), { name: m[1].toLowerCase(), clientId: env[k], secret: env[`${P}CLIENT_SECRET`], scopes: env[`${P}SCOPES`] ?? "", orgId: env[`${P}ORG_ID`] ?? env.ADOBE_ORG_ID });
    }
    return out;
  }
  /** One cached provider per (client id, org, scope set), shared by every service that uses that credential. */
  serviceProvider(name = "default") {
    const c = this.credentials.get(name);
    if (!c) return null;
    const scopes = c.scopes.split(/[,\s]+/).filter(Boolean).sort().join(",");
    const key = createHash("sha256").update(`${c.clientId}|${c.orgId ?? ""}|${scopes}`).digest("hex");
    if (!this.serviceProviders.has(key)) {
      this.serviceProviders.set(key, new ImsTokenProvider({ tokenUrl: this.tokenUrl, clientId: c.clientId, clientSecret: c.secret, scope: c.scopes || undefined,
        refreshToken: c.refreshToken, onRefreshToken: c.onRefreshToken, fetchImpl: this.fetchImpl, now: this.now, skewMs: this.env.ADOBE_IMS_SKEW_MS ? Number(this.env.ADOBE_IMS_SKEW_MS) : undefined }));
    }
    return this.serviceProviders.get(key);
  }
  #hasStatic(service) { return !!(this.env[`ADOBE_${service.toUpperCase()}_TOKEN`] ?? this.env.ADOBE_IMS_TOKEN); }

  // ---- delegated connections ----
  /** Store a user's Adobe tokens as a connection (from sign-in or the connect flow). Returns false if no web-app client is configured. */
  connect(userId, connection, { accessToken, refreshToken, expiresIn }) {
    if (!this.webApp) return false;
    const expiresAt = this.now() + Number(expiresIn ?? 3600) * 1000;
    let provider;
    if (refreshToken) {
      provider = new ImsTokenProvider({ tokenUrl: this.tokenUrl, clientId: this.webApp.clientId, clientSecret: this.webApp.secret, refreshToken, fetchImpl: this.fetchImpl, now: this.now });
      provider.cached = { token: accessToken, expiresAt };
      provider.expired = () => false; // renewable
    } else provider = new ExpiringToken(accessToken, expiresAt, this.now);
    this.connections.set(`${userId}|${connection}`, { provider, clientId: this.webApp.clientId, connectedAt: new Date(this.now()).toISOString() });
    return true;
  }
  isConnected(userId, connection) { const c = this.connections.get(`${userId}|${connection}`); return !!c && !c.provider.expired?.(); }
  disconnect(userId, connection) { return this.connections.delete(`${userId}|${connection}`); }

  /** Single-use link that starts product authorization for one user + connection. */
  connectUrl(userId, connection) {
    if (!this.webApp || !this.publicUrl) return null;
    for (const [k, v] of this.connectRequests) if (v.exp < this.now()) this.connectRequests.delete(k);
    if (this.connectRequests.size > 1000) return null;
    const id = randomBytes(24).toString("base64url");
    this.connectRequests.set(id, { userId, connection, exp: this.now() + CONNECT_TTL_MS });
    return `${this.publicUrl}/connect/${id}`;
  }
  startConnect(id) {
    const r = this.connectRequests.get(id);
    if (!r || r.exp < this.now()) throw new Error("This authorization link expired. Ask the assistant for a new one.");
    if (!this.redirectUri) throw new Error("PUBLIC_URL or ADOBE_CONNECT_REDIRECT_URI is not configured");
    const scopes = this.env[`ADOBE_CONNECTION_${r.connection.toUpperCase()}_SCOPES`] ?? this.env.ADOBE_CONNECTION_SCOPES
      ?? (r.connection === COWORKER_CONNECTION ? signinScopes(this.env.ADOBE_SIGNIN_SCOPES ?? "openid,AdobeID,profile", this.env) : undefined);
    if (!scopes?.trim()) throw new GatewayError("connection_scopes_missing",
      `Set ADOBE_CONNECTION_${r.connection.toUpperCase()}_SCOPES to the Adobe product scopes required for this connection, including offline_access if refresh tokens are needed.`);
    r.verifier = randomBytes(32).toString("base64url");
    const u = new URL(this.webApp.authorizeUrl);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: this.webApp.clientId, redirect_uri: this.redirectUri, scope: scopes, state: id,
      code_challenge: createHash("sha256").update(r.verifier).digest("base64url"), code_challenge_method: "S256" })) u.searchParams.set(k, v);
    return u;
  }
  async completeConnect({ state, code }) {
    const r = this.connectRequests.get(state); this.connectRequests.delete(state); // single use
    if (!r || r.exp < this.now() || !r.verifier) throw Object.assign(new Error("Authorization session expired or invalid"), { code: "session_invalid" });
    const res = await this.fetchImpl(this.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: this.webApp.clientId, client_secret: this.webApp.secret, code, code_verifier: r.verifier, redirect_uri: this.redirectUri }) });
    const t = await res.json().catch(() => ({}));
    if (!res.ok || !t.access_token) throw new Error(`Adobe token exchange failed: ${res.status} ${t.error ?? ""}`.trim());
    this.connect(r.userId, r.connection, { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in });
    return { userId: r.userId, connection: r.connection };
  }
  #connectionRequired(identity, service, connection, why) {
    const url = this.connectUrl(identity.userId, connection);
    return new GatewayError("connection_required",
      `${service} runs as your own Adobe account and your '${connection}' connection is ${why}. ${url ? "Open the authorization link, approve access, then retry." : "Sign in with Adobe again (no authorization link is available: set PUBLIC_URL)."} The server will not use a technical account instead.`,
      { service, details: { connection, reason: why, connectUrl: url } });
  }

  // ---- resolution ----
  /** Decide the acting principal and credentials for one operation. Throws connection_required / service_credential_missing. */
  async resolve({ identity, service, tool, args = {} }) {
    const rule = this.policy.rule(service, tool);
    const sandbox = this.policy.resolveSandbox(rule, args);
    const sb = sandbox ? { "x-sandbox-name": sandbox } : {};
    if (rule.mode === "delegated") {
      const c = this.connections.get(`${identity.userId}|${rule.connection}`);
      if (!c) throw this.#connectionRequired(identity, service, rule.connection, "missing");
      if (c.provider.expired?.()) throw this.#connectionRequired(identity, service, rule.connection, "expired");
      return { mode: "delegated", principal: { type: "user", id: identity.userId, connection: rule.connection }, provider: c.provider, sandbox,
        key: `delegated|${identity.userId}|${rule.connection}|${sandbox ?? ""}`,
        headers: { "x-api-key": c.clientId, ...(this.env.ADOBE_ORG_ID && { "x-gw-ims-org-id": this.env.ADOBE_ORG_ID }), ...sb } };
    }
    const cred = this.credentials.get(rule.credential);
    if (!cred) {
      if (this.#hasStatic(service)) return { mode: "service", principal: { type: "technical_account", id: "static-token" }, provider: null, sandbox, key: "service|static", headers: {} };
      throw new GatewayError("service_credential_missing", `No service credential '${rule.credential}' is configured for ${service}.${tool}`, { service });
    }
    return { mode: "service", principal: { type: "technical_account", id: cred.clientId, credential: cred.name, orgId: cred.orgId }, provider: this.serviceProvider(rule.credential), sandbox,
      key: `service|${cred.clientId}|${cred.orgId ?? ""}|${sandbox ?? ""}`,
      headers: { "x-api-key": cred.apiKey ?? cred.clientId, ...(cred.orgId && { "x-gw-ims-org-id": cred.orgId }), ...sb } };
  }

  /** What would happen for this user and operation, without calling Adobe or exposing secrets. */
  explain(identity, service, tool) {
    const r = this.policy.rule(service, tool);
    const base = { operation: `${service}.${tool}`, mode: r.mode, allowedRoles: r.allowedRoles ?? "any role with service access", sandbox: this.policy.resolveSandbox(r) ?? null };
    if (r.mode === "delegated") return { ...base, connection: r.connection, connected: this.isConnected(identity.userId, r.connection), actsAs: `your Adobe account (${identity.userId})` };
    const c = this.credentials.get(r.credential);
    return { ...base, credential: r.credential, configured: !!c || this.#hasStatic(service), actsAs: c ? `technical account ${c.clientId}` : this.#hasStatic(service) ? "static token" : "none (credential missing)" };
  }
  connectionsFor(userId) {
    return [...this.connections].filter(([k]) => k.startsWith(`${userId}|`)).map(([k, c]) => ({ connection: k.split("|")[1], connectedAt: c.connectedAt, ...c.provider.status() }));
  }
}
