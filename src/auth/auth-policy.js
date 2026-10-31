import { readFileSync } from "node:fs";
import { GatewayError } from "../gateway/transform.js";

const MODES = new Set(["delegated", "service"]);

/**
 * Authentication mode per API operation (`service.tool`), resolved most-specific first:
 *   operations["svc.tool"]  >  services["svc"]  >  default
 * Rule fields: mode ("service" | "delegated"), credential (service mode; a named S2S credential),
 * connection (delegated mode; which user connection), allowedRoles (who may invoke), sandbox / sandboxes (trusted sandbox config).
 */
export const DEFAULT_POLICY = {
  default: { mode: "service", credential: "default", connection: "adobe" },
  services: { aep: {}, cdp: {}, ajo: {}, aem: {}, aem_assets: {}, workfront_mcp: {}, fusion: {}, brand_intelligence: {} },
  operations: {},
};

export class AuthPolicy {
  constructor(policy = DEFAULT_POLICY, { defaultSandbox } = {}) {
    this.policy = { default: { ...DEFAULT_POLICY.default, ...policy.default }, services: policy.services ?? {}, operations: policy.operations ?? {} };
    this.defaultSandbox = defaultSandbox;
    for (const [where, r] of [["default", this.policy.default], ...Object.entries(this.policy.services), ...Object.entries(this.policy.operations)]) {
      if (r.mode && !MODES.has(r.mode)) throw new Error(`Auth policy '${where}': unknown mode '${r.mode}' (use service or delegated)`);
    }
  }
  /** Policy from defaults, ADOBE_AUTH_POLICY (JSON file), ADOBE_AUTH_MODE_<SERVICE>, and legacy ADOBE_USER_TOKEN_UPSTREAMS. */
  static load(env = process.env) {
    const p = structuredClone(DEFAULT_POLICY);
    if (env.ADOBE_AUTH_POLICY) {
      const f = JSON.parse(readFileSync(env.ADOBE_AUTH_POLICY, "utf8"));
      Object.assign(p.default, f.default); Object.assign(p.services, f.services); Object.assign(p.operations, f.operations);
    }
    for (const k of (env.ADOBE_USER_TOKEN_UPSTREAMS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) p.services[k] = { ...p.services[k], mode: "delegated" };
    for (const [k, v] of Object.entries(env)) {
      const m = /^ADOBE_AUTH_MODE_(.+)$/.exec(k);
      if (m && v) { const s = m[1].toLowerCase(); p.services[s] = { ...p.services[s], mode: v }; }
    }
    return new AuthPolicy(p, { defaultSandbox: env.ADOBE_SANDBOX_NAME });
  }
  rule(service, tool) { return { ...this.policy.default, ...this.policy.services[service], ...this.policy.operations[`${service}.${tool}`] }; }
  /** Sandbox comes from trusted config; a caller-supplied one is honoured only if the rule allows it. */
  resolveSandbox(rule, args = {}) {
    return args.sandboxName ?? args.sandbox ?? rule.sandbox ?? this.defaultSandbox;
  }
  /** Resource-level authorization (who may run this operation, in which sandbox). Role-to-service access is checked separately. */
  check(identity, service, tool, args = {}) {
    const r = this.rule(service, tool);
    if (r.allowedRoles && !r.allowedRoles.includes(identity.role)) throw new GatewayError("forbidden", `${service}.${tool} is restricted to roles: ${r.allowedRoles.join(", ")}`, { service });
    const asked = args.sandboxName ?? args.sandbox;
    if (asked !== undefined) {
      const allowed = r.sandboxes ?? [r.sandbox ?? this.defaultSandbox].filter(Boolean);
      if (!allowed.includes(asked)) throw new GatewayError("sandbox_not_allowed", `Sandbox '${asked}' is not allowed for ${service}.${tool}${allowed.length ? ` (allowed: ${allowed.join(", ")})` : ""}`, { service });
    }
  }
}
