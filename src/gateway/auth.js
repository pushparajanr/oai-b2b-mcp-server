import { randomUUID } from "node:crypto";
import { GatewayError } from "./transform.js";

/** Authentication broker: SSO login (simulated Entra ID), gateway tokens, per-product IMS token minting, role mapping. */
export class AuthBroker {
  constructor({ users, tenants, now = Date.now, ttlMs = 3_600_000, productTtlMs = 900_000 }) {
    Object.assign(this, { users, tenants, now, ttlMs, productTtlMs });
    this.tokens = new Map();
    this.productTokens = new Map();
  }
  identityFor(userId) {
    const u = this.users[userId];
    if (!u) throw new GatewayError("unauthenticated", `Unknown user '${userId}'`);
    return { userId, name: u.name, role: u.role, tenant: u.tenant, sandbox: u.sandbox ?? "prod", imsOrg: `${u.tenant}@AdobeOrg` };
  }
  login({ userId }) {
    const identity = this.identityFor(userId);
    const token = `gw_${randomUUID()}`;
    const expiresAt = this.now() + this.ttlMs;
    this.tokens.set(token, { identity, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString(), identity, federation: "Entra ID SSO -> Adobe IMS" };
  }
  verify(token) {
    const rec = this.tokens.get(token);
    if (!rec) throw new GatewayError("unauthenticated", "Invalid token");
    if (rec.expiresAt < this.now()) { this.tokens.delete(token); throw new GatewayError("unauthenticated", "Token expired"); }
    return rec.identity;
  }
  revoke(token) { this.tokens.delete(token); }
  /** Token management: short-lived, cached, product-specific tokens (IMS exchange). */
  productToken(identity, service) {
    const key = `${identity.userId}:${service}`;
    const cached = this.productTokens.get(key);
    if (cached && cached.expiresAt - this.now() > 60_000) return cached.value;
    const value = `ims_${service}_${randomUUID().slice(0, 8)}`;
    this.productTokens.set(key, { value, expiresAt: this.now() + this.productTtlMs });
    return value;
  }
}
