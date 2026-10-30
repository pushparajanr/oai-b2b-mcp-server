import { GatewayError } from "./transform.js";

const READ = /^(list|get|search|evaluate|run_query|project_status|decide|ask|check|validate|analy|retrieve|find|discover)/;

/** Capability registry: tool catalog, API/MCP mapping, entitlement checks, read/write classification. */
export class CapabilityRegistry {
  constructor(tenants) { this.tenants = tenants; this.caps = new Map(); }
  register(service, tool, { description, transport, kind: forced }) {
    const kind = forced ?? (READ.test(tool) ? "read" : "write");
    this.caps.set(`${service}.${tool}`, { service, tool, kind, description, transport, cost: kind === "read" ? 1 : 3 });
  }
  lookup(service, tool) {
    const cap = this.caps.get(`${service}.${tool}`);
    if (!cap) throw new GatewayError("not_found", `No capability '${service}.${tool}'`, { service });
    return cap;
  }
  entitled(tenantId, service) { return !!this.tenants[tenantId]?.entitlements.includes(service); }
  catalog({ service, kind, tenant } = {}) {
    return [...this.caps.values()].filter((c) => (!service || c.service === service) && (!kind || c.kind === kind) && (!tenant || this.entitled(tenant, c.service)));
  }
}
