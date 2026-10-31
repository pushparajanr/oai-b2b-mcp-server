import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";

/**
 * Structured logging to stderr (stdout is reserved for the stdio MCP transport).
 *   LOG_LEVEL      silent | error | warn | info (default) | debug | trace
 *   LOG_FORMAT     text (default) | json
 *   LOG_FILE       optional path; lines are also appended there
 *   LOG_MAX_CHARS  cap for any logged string/object (default 800)
 * Secrets, tokens and PII are redacted before anything is written. Request-scoped fields (requestId, user, ...) are
 * attached to nested log lines through AsyncLocalStorage.
 */
const LEVELS = { silent: -1, error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const store = new AsyncLocalStorage();
let sink = null;

const threshold = () => LEVELS[String(process.env.LOG_LEVEL ?? "info").toLowerCase()] ?? LEVELS.info;
const maxChars = () => Number(process.env.LOG_MAX_CHARS) || 800;
export const enabled = (level) => LEVELS[level] <= threshold();
/** Test hook: capture entries instead of writing them. Returns the previous sink. */
export const setSink = (fn) => { const prev = sink; sink = fn; return prev; };

const SECRET_KEY = /token|secret|authorization|password|passwd|api[-_]?key|cookie|verifier|refresh|signature|^code$|^state$/i;
const HIDDEN_KEY = /identity|members/i;
const EMAIL_KEY = /email/i;
const EMAIL_IN_TEXT = /[^\s@"',;<>()]+@[^\s@"',;<>()]+\.[^\s@"',;<>()]+/g;
const JWT_IN_TEXT = /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g;
const TECH_ACCOUNT = /@techacct\.adobe\.com$/i;

const maskEmail = (s) => (TECH_ACCOUNT.test(s) ? s : `${s[0]}***${s.includes("@") ? s.slice(s.indexOf("@")) : ""}`);

function cleanString(s, key) {
  if (/^Bearer\s/i.test(s)) return "[token]";
  let out = s.replace(JWT_IN_TEXT, "[jwt]");
  if (EMAIL_KEY.test(key) && out) out = maskEmail(out);
  else out = out.replace(EMAIL_IN_TEXT, maskEmail);
  if (/phone/i.test(key) && out) out = `***${out.slice(-2)}`;
  const max = maxChars();
  return out.length > max ? `${out.slice(0, max)}…(+${out.length - max})` : out;
}

export function errorInfo(e) {
  if (!(e instanceof Error) && typeof e !== "object") return { message: String(e) };
  const up = e?.details?.upstream;
  return {
    name: e?.name, code: e?.code, message: e?.message,
    status: e?.status ?? up?.status, requestId: e?.requestId ?? up?.requestId,
    ...(enabled("debug") && e?.stack && { stack: String(e.stack).split("\n").slice(1, 6).map((l) => l.trim()) }),
  };
}

/** Deep copy with secrets redacted, PII masked and size/depth bounded. */
export function clean(v, key = "", depth = 0) {
  if (SECRET_KEY.test(key)) return v == null ? v : "[redacted]";
  if (HIDDEN_KEY.test(key)) return v == null ? v : "[redacted]";
  if (typeof v === "string") return cleanString(v, key);
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return String(v);
  if (v instanceof Error) return clean(errorInfo(v), key, depth + 1);
  if (typeof v !== "object") return String(v);
  if (depth >= 4) return Array.isArray(v) ? `[array(${v.length})]` : "[object]";
  if (Array.isArray(v)) {
    const out = v.slice(0, 10).map((x) => clean(x, key, depth + 1));
    if (v.length > 10) out.push(`…+${v.length - 10} more`);
    return out;
  }
  return Object.fromEntries(Object.entries(v).slice(0, 40).filter(([, x]) => x !== undefined).map(([k, x]) => [k, clean(x, k, depth + 1)]));
}

const fmt = (v) => {
  if (typeof v === "string") return /^[\w.:/@+#-]+$/.test(v) ? v : JSON.stringify(v);
  const j = JSON.stringify(v), max = maxChars();
  return j.length > max ? `${j.slice(0, max)}…` : j;
};

export function emit(level, event, fields = {}) {
  if (!enabled(level)) return;
  const body = clean({ ...store.getStore(), ...fields });
  const ts = new Date().toISOString();
  const entry = { ts, level, event, ...body };
  if (sink) return sink(entry);
  const line = process.env.LOG_FORMAT === "json" ? JSON.stringify(entry)
    : `${ts} ${level.toUpperCase().padEnd(5)} ${event} ${Object.entries(body).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${fmt(v)}`).join(" ")}`;
  process.stderr.write(`${line}\n`);
  if (process.env.LOG_FILE) { try { appendFileSync(process.env.LOG_FILE, `${line}\n`); } catch { /* logging must never break a request */ } }
}

export const log = Object.fromEntries(["error", "warn", "info", "debug", "trace"].map((l) => [l, (event, fields) => emit(l, event, fields)]));

/** Run fn with extra fields attached to every log line emitted inside it (including nested async calls). */
export const withContext = (fields, fn) => store.run({ ...store.getStore(), ...fields }, fn);

const failLevel = (e) => (e?.name === "ZodError" || (e?.status && e.status < 500) || (e?.code && typeof e.code === "string") ? "warn" : "error");

/** Log `<event>.start` (debug), then `<event>.end` / `<event>.error` with duration; the result/error is passed through unchanged. */
export async function traced(event, fields, fn) {
  const t0 = performance.now();
  emit("debug", `${event}.start`, fields);
  try {
    const result = await fn();
    emit("info", `${event}.end`, { ...fields, outcome: "ok", ms: Math.round(performance.now() - t0), ...(enabled("debug") && { result }) });
    return result;
  } catch (e) {
    emit(failLevel(e), `${event}.error`, { ...fields, outcome: "error", ms: Math.round(performance.now() - t0), error: errorInfo(e) });
    throw e;
  }
}

const ID_HEADERS = ["x-request-id", "x-gw-ims-request-id", "x-adobe-request-id", "x-correlation-id"];

/** Safe request description: origin + path, query parameter NAMES only (values can carry codes/keys). */
function describeUrl(input) {
  try {
    const u = new URL(String(input?.url ?? input));
    const names = [...new Set(u.searchParams.keys())];
    return { url: `${u.origin}${u.pathname}`, ...(names.length && { query: names.join(",") }) };
  } catch { return { url: "[invalid-url]" }; }
}

function describeBody(body) {
  if (body instanceof URLSearchParams) {
    const pick = (k) => body.get(k) ?? undefined;
    return { grant: pick("grant_type"), clientId: pick("client_id"), scope: pick("scope"), redirectUri: pick("redirect_uri") };
  }
  if (typeof body === "string" && body.length < 200_000 && body.startsWith("{")) {
    try { const m = JSON.parse(body); return { rpc: m.method, rpcTool: m.params?.name, rpcId: m.id }; } catch { /* not JSON-RPC */ }
  }
  return {};
}

/** fetch wrapper that logs every outbound API call: method, URL (no query values), status, duration, upstream request id. */
export const loggedFetch = (inner = fetch, label = "http") => async (input, init = {}) => {
  const t0 = performance.now();
  const base = { api: label, method: init.method ?? input?.method ?? "GET", ...describeUrl(input), ...describeBody(init.body) };
  try {
    const res = await inner(input, init);
    const requestId = ID_HEADERS.map((k) => res.headers?.get?.(k)).find(Boolean);
    const fields = { ...base, status: res.status, ms: Math.round(performance.now() - t0), requestId };
    if (res.ok) emit("info", "api.call", fields);
    else {
      const body = enabled("warn") ? (await res.clone().text().catch(() => "")).slice(0, 500) : undefined;
      emit(res.status >= 500 ? "error" : "warn", "api.call", { ...fields, outcome: "http_error", body });
    }
    return res;
  } catch (e) {
    emit("error", "api.call", { ...base, outcome: "network_error", ms: Math.round(performance.now() - t0), error: errorInfo(e) });
    throw e;
  }
};
