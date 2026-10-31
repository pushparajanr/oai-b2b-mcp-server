import { timingSafeEqual } from "node:crypto";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const same = (a, b) => { const x = Buffer.from(String(a ?? "")); const y = Buffer.from(String(b ?? "")); return x.length === y.length && timingSafeEqual(x, y); };
const cookieValue = (h, n) => (h ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === n)?.[1];
const html = (res, code, body, headers = {}) => {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", ...headers });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;max-width:30rem;margin:3rem auto;padding:0 1rem">${body}`);
};

/**
 * Incremental product authorization. A tool call that needs a delegated Adobe connection returns a single-use link
 * (/connect/<id>) bound server-side to the requesting user. Opening it sends the browser to Adobe (authorization code + PKCE);
 * the callback stores the user's token as a broker connection. Returns true when the request was handled.
 */
export function createConnect({ broker }) {
  return async function handle(req, res, url) {
    if (req.method !== "GET") return false;
    const secure = broker.publicUrl?.startsWith("https:") ? "; Secure" : "";
    if (url.pathname === "/connect/callback") {
      const state = url.searchParams.get("state") ?? "";
      const clear = { "set-cookie": `connect_tx=; HttpOnly; SameSite=Lax; Path=/connect; Max-Age=0${secure}` };
      if (!same(cookieValue(req.headers.cookie, "connect_tx"), state)) { html(res, 400, "<p>Authorization session is invalid or expired. Ask the assistant for a new link.</p>", clear); return true; }
      if (url.searchParams.get("error") || !url.searchParams.get("code")) { html(res, 400, `<p>Adobe did not grant access (${esc(url.searchParams.get("error") ?? "no code")}).</p>`, clear); return true; }
      try {
        const r = await broker.completeConnect({ state, code: url.searchParams.get("code") });
        html(res, 200, `<h1>Connected</h1><p>Your Adobe account is now connected for <b>${esc(r.connection)}</b>. Return to the assistant and retry your request.</p>`, clear);
      } catch (e) {
        if (e.code === "session_invalid") { html(res, 400, "<p>This authorization link was already used or has expired. Ask the assistant for a new one.</p>", clear); return true; }
        console.error(`Adobe connect failed: ${e.message}`);
        html(res, 502, "<p>Adobe authorization could not be completed. Ask the assistant for a new link and try again.</p>", clear);
      }
      return true;
    }
    const m = /^\/connect\/([\w-]{20,})$/.exec(url.pathname);
    if (!m) return false;
    try {
      const target = broker.startConnect(m[1]);
      res.writeHead(302, { location: target.href, "cache-control": "no-store", "set-cookie": `connect_tx=${m[1]}; HttpOnly; SameSite=Lax; Path=/connect; Max-Age=600${secure}` });
      res.end();
    } catch (e) { html(res, 400, `<p>${esc(e.message)}</p>`); }
    return true;
  };
}
