import { createHash } from "node:crypto";
import { ROLES } from "./config.js";
import { ACCESS_ALIAS } from "../upstream/endpoints.js";
import { GatewayError } from "./transform.js";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SENSITIVE_ARG = /email|phone|identity|members/i;

function maskValue(key, v) {
  if (typeof v !== "string") return v;
  if (EMAIL.test(v)) return `${v[0]}***${v.slice(v.indexOf("@"))}`;
  if (/phone/i.test(key)) return `***${v.slice(-2)}`;
  return v;
}
function maskDeep(v, key = "") {
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, k)]));
  return maskValue(key, v);
}
const redactArgs = (a) => Object.fromEntries(Object.entries(a ?? {}).map(([k, v]) => [k, SENSITIVE_ARG.test(k) ? "[redacted]" : typeof v === "object" ? "[object]" : v]));

/** Permission enforcement, hash-chained audit log, PII masking, monitoring and alerting. */
export class Security {
  constructor({ now = Date.now, denialThreshold = 3, windowMs = 300_000 } = {}) {
    Object.assign(this, { now, denialThreshold, windowMs });
    this.entries = []; this.alerts = []; this.denials = new Map(); this.stats = new Map();
  }
  authorize(identity, cap) {
    const grants = [].concat(ACCESS_ALIAS[cap.service] ?? cap.service).map((k) => ROLES[identity.role]?.access[k] ?? "");
    if (grants.some((g) => g && (cap.kind === "read" || g.includes("w")))) return;
    const recent = [...(this.denials.get(identity.userId) ?? []), this.now()].filter((t) => t > this.now() - this.windowMs);
    this.denials.set(identity.userId, recent);
    if (recent.length === this.denialThreshold) this.alerts.push({ type: "repeated_denials", userId: identity.userId, count: recent.length, at: new Date(this.now()).toISOString() });
    throw new GatewayError("forbidden", `Role '${identity.role}' has no ${cap.kind} access to ${cap.service}`, { service: cap.service });
  }
  mask(identity, result) { return ROLES[identity.role]?.pii ? result : maskDeep(result); }
  audit(e) {
    const prev = this.entries.at(-1)?.hash ?? "genesis";
    const body = { seq: this.entries.length + 1, ts: new Date(this.now()).toISOString(), ...e, args: redactArgs(e.args), prev };
    this.entries.push({ ...body, hash: createHash("sha256").update(JSON.stringify(body)).digest("hex") });
  }
  verifyChain() {
    let prev = "genesis";
    return this.entries.every(({ hash, ...body }) => body.prev === prev && (prev = hash) === createHash("sha256").update(JSON.stringify(body)).digest("hex"));
  }
  query({ user, service, outcome, limit = 50 } = {}) {
    return this.entries.filter((e) => (!user || e.user === user) && (!service || e.service === service) && (!outcome || e.outcome === outcome)).slice(-limit);
  }
  record(service, ok) {
    const s = this.stats.get(service) ?? { calls: 0, errors: 0, alerted: false };
    s.calls++; if (!ok) s.errors++;
    if (s.calls >= 10 && s.errors / s.calls >= 0.5 && !s.alerted) { s.alerted = true; this.alerts.push({ type: "high_error_rate", service, errors: s.errors, calls: s.calls }); }
    this.stats.set(service, s);
  }
  metrics() { return Object.fromEntries([...this.stats].map(([k, { calls, errors }]) => [k, { calls, errors }])); }
}
