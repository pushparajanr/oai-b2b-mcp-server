import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { checkHost, DEFAULT_IMS_AUTHORIZE } from "./upstream/config.js";
import { ROLES } from "./gateway/config.js";
import { log, loggedFetch } from "./log.js";
import { useCoworkerLogin, COWORKER_CONNECTION, signinScopes } from "./auth/coworker.js";

const signinFetch = loggedFetch(fetch, "adobe-signin");

const DEFAULT_IMS_TOKEN = "https://ims-na1.adobelogin.com/ims/token/v3";
const DEFAULT_IMS_USERINFO = "https://ims-na1.adobelogin.com/ims/userinfo/v2";
const TX_TTL_MS = 10 * 60_000;
const cookieValue = (header, name) => (header ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === name)?.[1];

const CODE_TTL_MS = 5 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 3_600_000;
const MAX_CLIENTS = 100;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const DEFAULT_REDIRECT_HOSTS = "chatgpt.com,openai.com,localhost,127.0.0.1";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const same = (a, b) => { const x = Buffer.from(String(a ?? "")); const y = Buffer.from(String(b ?? "")); return x.length === y.length && timingSafeEqual(x, y); };
const sendJson = (res, code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
const sendHtml = (res, code, html) => {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
  res.end(html);
};
const readText = (req, limit = 100_000) => new Promise((resolve, reject) => {
  let d = ""; req.on("data", (c) => { d += c; if (d.length > limit) { reject(new Error("body too large")); req.destroy(); } });
  req.on("end", () => resolve(d)); req.on("error", reject);
});
const readParams = async (req) => {
  const text = await readText(req);
  if ((req.headers["content-type"] ?? "").includes("application/json")) return text ? JSON.parse(text) : {};
  return Object.fromEntries(new URLSearchParams(text));
};

/**
 * OAuth 2.1 authorization server for MCP clients such as ChatGPT: dynamic client registration, authorization code + PKCE (S256),
 * rotating refresh tokens. The consent page is gated by LOGIN_SECRET (the owner approves and picks the demo identity), and
 * access tokens are ordinary gateway tokens. All state is in memory, so restarting the server requires reconnecting.
 */
export function createOAuth({ auth, loginSecret, broker, now = Date.now, env = process.env }) {
  const coworkerLogin = useCoworkerLogin(env);
  const clients = new Map(); const codes = new Map(); const refreshTokens = new Map(); const fails = new Map();
  const allowedHosts = (env.OAUTH_ALLOWED_REDIRECT_HOSTS ?? DEFAULT_REDIRECT_HOSTS).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const hostAllowed = (host) => allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));

  // Adobe IMS sign-in (preferred). When configured, the consent page is replaced by Adobe's login and only allow-listed accounts get in.
  const signin = env.ADOBE_SIGNIN_CLIENT_ID && env.ADOBE_SIGNIN_CLIENT_SECRET && env.ADOBE_SIGNIN_REDIRECT_URI ? (() => {
    const cfg = {
      clientId: env.ADOBE_SIGNIN_CLIENT_ID, clientSecret: env.ADOBE_SIGNIN_CLIENT_SECRET, redirectUri: env.ADOBE_SIGNIN_REDIRECT_URI,
      scope: signinScopes(env.ADOBE_SIGNIN_SCOPES ?? "openid,AdobeID,profile", env),
      authorizeUrl: env.ADOBE_IMS_AUTHORIZE_URL ?? DEFAULT_IMS_AUTHORIZE, tokenUrl: env.ADOBE_IMS_URL ?? DEFAULT_IMS_TOKEN, userinfoUrl: env.ADOBE_IMS_USERINFO_URL ?? DEFAULT_IMS_USERINFO,
    };
    for (const u of [cfg.authorizeUrl, cfg.tokenUrl, cfg.userinfoUrl]) checkHost(env, u, "adobe sign-in");
    cfg.callbackPath = new URL(cfg.redirectUri).pathname;
    return cfg;
  })() : null;
  const allowList = new Map();
  for (const entry of (env.OAUTH_ALLOWED_EMAILS ?? "").split(",")) {
    const [mail, role] = entry.trim().split(":");
    if (!mail) continue;
    const r = role || env.OAUTH_DEFAULT_ROLE || "leadership";
    if (!ROLES[r]) throw new Error(`OAUTH_ALLOWED_EMAILS: unknown role '${r}'`);
    allowList.set(mail.toLowerCase(), r);
  }
  const txs = new Map();
  const adobeProfile = async (code) => {
    const tr = await signinFetch(signin.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: signin.clientId, client_secret: signin.clientSecret, code, redirect_uri: signin.redirectUri }) });
    const t = await tr.json().catch(() => ({}));
    if (!tr.ok || !t.access_token) throw new Error(`Adobe token exchange failed: ${tr.status} ${t.error ?? ""}`.trim());
    const ur = await signinFetch(`${signin.userinfoUrl}?${new URLSearchParams({ client_id: signin.clientId })}`, { headers: { authorization: `Bearer ${t.access_token}` } });
    const u = await ur.json().catch(() => ({}));
    if (!ur.ok) throw new Error(`Adobe userinfo failed: ${ur.status}`);
    let email = String(u.email ?? u.preferred_username ?? "").toLowerCase();
    const id = u.sub ?? u.userId ?? u.user_id;
    if (!email) {
      try {
        const pr = await signinFetch(new URL("/ims/profile/v1", signin.userinfoUrl), { headers: { authorization: `${"Bearer"} ${t.access_token}`, "x-api-key": signin.clientId } });
        if (pr.ok) email = String((await pr.json()).email ?? "").toLowerCase();
      } catch { /* fall back to the Adobe ID */ }
    }
    if (!email && !id) { log.warn("oauth.userinfo_incomplete", { fields: Object.keys(u).join(",") }); throw new Error("Adobe did not return an email for this account"); }
    return { email, id: id ? String(id).toLowerCase() : "", name: u.name ?? u.display_name ?? email, tokens: t };
  };

  const baseUrl = (req) => (env.PUBLIC_URL ?? `${req.headers["x-forwarded-proto"]?.split(",")[0] ?? "http"}://${req.headers["x-forwarded-host"]?.split(",")[0] ?? req.headers.host}`).replace(/\/$/, "");
  const ipOf = (req) => req.headers["x-forwarded-for"]?.split(",")[0].trim() ?? req.socket.remoteAddress;
  const prune = () => {
    const t = now();
    for (const m of [codes, refreshTokens]) for (const [k, v] of m) if (v.exp < t) m.delete(k);
    for (const [k, v] of fails) if (v.resetAt < t) fails.delete(k);
    for (const [k, v] of txs) if (v.exp < t) txs.delete(k);
  };
  const redirectOk = (u) => {
    try { const p = new URL(u); return !p.hash && (p.protocol === "https:" || (p.protocol === "http:" && ["localhost", "127.0.0.1"].includes(p.hostname))) && hostAllowed(p.hostname.toLowerCase()); }
    catch { return false; }
  };
  const issue = (userId, clientId) => {
    const { token, expiresAt } = auth.login({ userId });
    const refresh = randomBytes(32).toString("base64url");
    refreshTokens.set(refresh, { clientId, userId, exp: now() + REFRESH_TTL_MS });
    return { access_token: token, token_type: "Bearer", expires_in: Math.max(1, Math.floor((new Date(expiresAt) - now()) / 1000)), refresh_token: refresh, scope: "mcp" };
  };
  const oauthError = (res, code, error, description) => sendJson(res, code, { error, error_description: description });

  /** Validates the authorization request. Returns { error } (render, never redirect) or { client, params }. */
  const checkAuthorize = (p) => {
    const client = clients.get(p.client_id);
    if (!client) return { error: "Unknown client. Reconnect the connector so it registers again." };
    if (!client.redirectUris.includes(p.redirect_uri)) return { error: "redirect_uri is not registered for this client." };
    if (p.response_type !== "code") return { client, redirectError: "unsupported_response_type" };
    if (!p.code_challenge || p.code_challenge_method !== "S256") return { client, redirectError: "invalid_request" };
    return { client };
  };
  const redirectBack = (res, redirectUri, params) => {
    const u = new URL(redirectUri); for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    res.writeHead(302, { location: u.href, "cache-control": "no-store" }); res.end();
  };
  const page = (p, message = "") => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize MCP access</title>
<style>body{font:16px system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem}label{display:block;margin:1rem 0 .25rem}input,select,button{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box}button{margin-top:1.25rem;cursor:pointer}.err{color:#b00020}</style>
<h1>Authorize access</h1><p><b>${esc(clients.get(p.client_id)?.name)}</b> wants to use the Adobe B2B marketing MCP server.</p>${message ? `<p class="err">${esc(message)}</p>` : ""}
<form method="post" action="/oauth/authorize">${["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope"].map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join("")}
<label for="user">Act as</label><select id="user" name="user_id">${Object.entries(auth.users).map(([id, u]) => `<option value="${esc(id)}"${id === (env.OAUTH_DEFAULT_USER ?? "lee.leader") ? " selected" : ""}>${esc(u.name)} (${esc(u.role)})</option>`).join("")}</select>
<label for="secret">Server login secret</label><input id="secret" name="secret" type="password" autocomplete="off" required>
<button type="submit">Approve</button></form>`;

  /** Returns true when the request was an OAuth/discovery route and has been answered. */
  return async function handle(req, res, url) {
    const path = url.pathname;
    if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
      const base = baseUrl(req);
      sendJson(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] }); return true;
    }
    if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")) {
      const base = baseUrl(req);
      sendJson(res, 200, { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["mcp"] }); return true;
    }
    if (!path.startsWith("/oauth/")) return false;
    prune();

    if (req.method === "POST" && path === "/oauth/register") {
      let body; try { body = await readParams(req); } catch { oauthError(res, 400, "invalid_client_metadata", "Invalid request body"); return true; }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
      if (!uris.length || !uris.every((u) => typeof u === "string" && redirectOk(u))) { oauthError(res, 400, "invalid_redirect_uri", `redirect_uris must be https URLs on: ${allowedHosts.join(", ")}`); return true; }
      if (clients.size >= MAX_CLIENTS) { oauthError(res, 429, "temporarily_unavailable", "Too many registered clients"); return true; }
      const client = { id: randomUUID(), name: String(body.client_name ?? "MCP client").slice(0, 80), redirectUris: uris };
      clients.set(client.id, client);
      sendJson(res, 201, { client_id: client.id, client_name: client.name, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }); return true;
    }

    if (req.method === "GET" && path === "/oauth/authorize") {
      const p = Object.fromEntries(url.searchParams); const r = checkAuthorize(p);
      if (r.error) sendHtml(res, 400, `<!doctype html><meta charset="utf-8"><p>${esc(r.error)}</p>`);
      else if (r.redirectError) redirectBack(res, p.redirect_uri, { error: r.redirectError, state: p.state });
      else if (signin) {
        const id = randomBytes(24).toString("base64url");
        txs.set(id, { clientId: p.client_id, redirectUri: p.redirect_uri, challenge: p.code_challenge, state: p.state, exp: now() + TX_TTL_MS });
        const a = new URL(signin.authorizeUrl);
        for (const [k, v] of Object.entries({ response_type: "code", client_id: signin.clientId, redirect_uri: signin.redirectUri, scope: signin.scope, state: id })) a.searchParams.set(k, v);
        const secure = baseUrl(req).startsWith("https:") ? "; Secure" : "";
        res.writeHead(302, { location: a.href, "cache-control": "no-store", "set-cookie": `oauth_tx=${id}; HttpOnly; SameSite=Lax; Path=${signin.callbackPath}; Max-Age=600${secure}` }); res.end();
      } else sendHtml(res, 200, page(p));
      return true;
    }

    if (signin && req.method === "GET" && path === signin.callbackPath) {
      const p = Object.fromEntries(url.searchParams);
      const tx = txs.get(p.state); txs.delete(p.state); // single use
      const clear = { "set-cookie": `oauth_tx=; HttpOnly; SameSite=Lax; Path=${signin.callbackPath}; Max-Age=0` };
      const fail = (code, msg) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...clear }); res.end(`<!doctype html><meta charset="utf-8"><p>${esc(msg)}</p>`); return true; };
      if (!tx || !same(cookieValue(req.headers.cookie, "oauth_tx"), p.state)) return fail(400, "Sign-in session expired or invalid. Start again from ChatGPT.");
      if (p.error || !p.code) { res.writeHead(302, { location: (() => { const u = new URL(tx.redirectUri); u.searchParams.set("error", "access_denied"); if (tx.state) u.searchParams.set("state", tx.state); return u.href; })(), ...clear }); res.end(); return true; }
      let who;
      try { who = await adobeProfile(p.code); } catch (e) { log.error("oauth.signin_failed", { error: e }); return fail(502, "Adobe sign-in could not be completed. Try again."); }
      const role = allowList.get(who.email) ?? allowList.get(who.id);
      if (!role) { log.warn("oauth.signin_refused", { reason: "not_on_allow_list", email: who.email, imsUserId: who.id }); return fail(403, "This Adobe account is not authorized for this server."); }
      const userId = `adobe:${who.email || who.id}`;
      auth.registerUser(userId, { name: who.name, role });
      if (coworkerLogin && broker) {
        const ok = broker.connect(userId, COWORKER_CONNECTION, { accessToken: who.tokens.access_token, refreshToken: who.tokens.refresh_token, expiresIn: who.tokens.expires_in });
        log.info("oauth.coworker_connected", { user: userId, stored: ok, refreshable: !!who.tokens.refresh_token, expiresIn: who.tokens.expires_in, scope: signin.scope });
      }
      const code = randomBytes(32).toString("base64url");
      codes.set(code, { clientId: tx.clientId, redirectUri: tx.redirectUri, challenge: tx.challenge, userId, exp: now() + CODE_TTL_MS });
      const u = new URL(tx.redirectUri); u.searchParams.set("code", code); if (tx.state) u.searchParams.set("state", tx.state);
      res.writeHead(302, { location: u.href, "cache-control": "no-store", ...clear }); res.end(); return true;
    }

    if (req.method === "POST" && path === "/oauth/authorize") {
      if (signin) { sendHtml(res, 404, "<p>Use Adobe sign-in.</p>"); return true; }
      let p; try { p = await readParams(req); } catch { sendHtml(res, 400, "<p>Invalid request.</p>"); return true; }
      const r = checkAuthorize(p);
      if (r.error) { sendHtml(res, 400, `<!doctype html><meta charset="utf-8"><p>${esc(r.error)}</p>`); return true; }
      if (r.redirectError) { redirectBack(res, p.redirect_uri, { error: r.redirectError, state: p.state }); return true; }
      if (!loginSecret) { sendHtml(res, 503, "<p>LOGIN_SECRET is not configured on the server, so approval is disabled.</p>"); return true; }
      const ip = ipOf(req); const f = fails.get(ip);
      if (f && f.count >= MAX_FAILS && f.resetAt > now()) { sendHtml(res, 429, page(p, "Too many failed attempts. Try again later.")); return true; }
      if (!same(p.secret, loginSecret) || !auth.users[p.user_id]) {
        fails.set(ip, { count: (f && f.resetAt > now() ? f.count : 0) + 1, resetAt: f && f.resetAt > now() ? f.resetAt : now() + FAIL_WINDOW_MS });
        sendHtml(res, 401, page(p, "Invalid login secret or user.")); return true;
      }
      fails.delete(ip);
      const code = randomBytes(32).toString("base64url");
      codes.set(code, { clientId: p.client_id, redirectUri: p.redirect_uri, challenge: p.code_challenge, userId: p.user_id, exp: now() + CODE_TTL_MS });
      redirectBack(res, p.redirect_uri, { code, state: p.state }); return true;
    }

    if (req.method === "POST" && path === "/oauth/token") {
      let p; try { p = await readParams(req); } catch { oauthError(res, 400, "invalid_request", "Invalid request body"); return true; }
      if (!clients.has(p.client_id)) { oauthError(res, 401, "invalid_client", "Unknown client"); return true; }
      if (p.grant_type === "authorization_code") {
        const rec = codes.get(p.code); codes.delete(p.code); // single use
        const verifierOk = rec && p.code_verifier && same(createHash("sha256").update(p.code_verifier).digest("base64url"), rec.challenge);
        if (!rec || rec.clientId !== p.client_id || rec.redirectUri !== p.redirect_uri || !verifierOk) { oauthError(res, 400, "invalid_grant", "Invalid or expired authorization code, redirect_uri or code_verifier"); return true; }
        sendJson(res, 200, issue(rec.userId, rec.clientId)); return true;
      }
      if (p.grant_type === "refresh_token") {
        const rec = refreshTokens.get(p.refresh_token); refreshTokens.delete(p.refresh_token); // rotated on every use
        if (!rec || rec.clientId !== p.client_id) { oauthError(res, 400, "invalid_grant", "Invalid or expired refresh token"); return true; }
        sendJson(res, 200, issue(rec.userId, rec.clientId)); return true;
      }
      oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token"); return true;
    }
    return false;
  };
}
