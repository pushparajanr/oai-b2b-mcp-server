import { randomUUID } from "node:crypto";
import { AuthBroker } from "./auth.js";
import { CapabilityRegistry } from "./registry.js";
import { Security } from "./security.js";
import { Router } from "./router.js";
import { GatewayError, normalizeError, transformRequest } from "./transform.js";
import { ROLES, SERVICE_ROUTES, TENANTS, USERS } from "./config.js";

/** Adobe Marketing MCP Gateway: every product call (human or agent) goes through invoke(). */
export class Gateway {
  constructor({ agents, integration, now = Date.now, users = USERS, tenants = TENANTS, rate, routes = {}, broker = null, policy = null }) {
    this.services = new Map(agents.map((a) => [a.key, a]));
    this.now = now;
    this.auth = new AuthBroker({ users, tenants, now });
    this.registry = new CapabilityRegistry(tenants);
    this.security = new Security({ now });
    this.router = new Router({ services: this.services, auth: this.auth, broker, integration, now, rate });
    this.policy = policy; this.broker = broker;
    this.tenants = tenants;
    this.usage = new Map();
    this.routes = new Map(Object.entries(routes));
    for (const a of agents) this.addService(a);
  }
  /** Register (or refresh) a service and its capabilities. Live services take read/write from MCP annotations. */
  addService(a) {
    this.services.set(a.key, a);
    for (const k of [...this.registry.caps.keys()]) if (k.startsWith(`${a.key}.`)) this.registry.caps.delete(k);
    for (const [tool, def] of Object.entries(a.tools)) {
      const kind = a.live ? (a.readOnly || def.annotations?.readOnlyHint === true ? "read" : def.annotations?.readOnlyHint === false ? "write" : undefined) : undefined;
      this.registry.register(a.key, tool, { description: def.description, kind, transport: a.live ? "mcp-remote" : SERVICE_ROUTES[a.key] ?? "api" });
    }
  }
  usageFor(tenant) { return { ...(this.usage.get(tenant) ?? { calls: 0, cost: 0 }), quota: this.tenants[tenant]?.quota.cost }; }

  async invoke({ token, identity, service, tool, args = {} }) {
    const requestId = `req_${randomUUID().slice(0, 8)}`;
    // Optional re-route of a built-in tool to a live upstream tool (see ADOBE_TOOL_MAP).
    const route = this.routes.get(`${service}.${tool}`);
    if (route && this.services.has(route.service)) {
      args = Object.fromEntries(Object.entries(args).map(([k, v]) => [route.argMap?.[k] ?? k, v]));
      Object.assign(args, route.fixed);
      ({ service, tool } = route);
    }
    const base = { requestId, service, tool };
    try {
      identity ??= this.auth.verify(token);
      const cap = this.registry.lookup(service, tool);
      if (!this.registry.entitled(identity.tenant, service)) throw new GatewayError("not_entitled", `Tenant '${identity.tenant}' is not entitled to ${service}`, { service });
      this.security.authorize(identity, cap); // user x action (role access)
      this.policy?.check(identity, service, tool, args); // user x resource (allowed roles, sandbox)
      const u = this.usage.get(identity.tenant) ?? { calls: 0, cost: 0 };
      if (u.cost + cap.cost > this.tenants[identity.tenant].quota.cost) throw new GatewayError("quota_exceeded", `Usage quota exceeded for tenant '${identity.tenant}'`, { service });
      const { result, route } = await this.router.dispatch({ identity, cap, args: transformRequest(service, tool, args) });
      this.usage.set(identity.tenant, { calls: u.calls + 1, cost: u.cost + cap.cost });
      this.security.audit({ ...base, user: identity.userId, role: identity.role, kind: cap.kind, outcome: "ok", args, authMode: route.auth?.mode, principal: route.auth?.principal?.id });
      this.security.record(service, true);
      return { result: this.security.mask(identity, result), meta: { requestId, service, tool, kind: cap.kind, ...route } };
    } catch (e) {
      const err = normalizeError(e, service);
      if (e.principal) {
        err.details = { ...err.details, principal: e.principal, mode: e.authMode };
        if (["upstream_unauthorized", "upstream_forbidden"].includes(err.code)) err.details.hint = `Adobe rejected the ${e.authMode} credential acting as ${e.principal.id}. Check that principal's product profile, role and sandbox access in the product. The server does not retry with a different credential.`;
      }
      this.security.audit({ ...base, user: identity?.userId ?? "anonymous", role: identity?.role, outcome: err.code, args, authMode: e.authMode, principal: e.principal?.id, upstreamStatus: err.details?.upstream?.status, upstreamRequestId: err.details?.upstream?.requestId });
      if (!["forbidden", "unauthenticated", "not_found", "invalid_request", "not_entitled", "connection_required", "sandbox_not_allowed"].includes(err.code)) this.security.record(service, false);
      throw err;
    }
  }
}

export { ROLES };
