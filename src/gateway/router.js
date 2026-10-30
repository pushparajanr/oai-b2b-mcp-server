import { GatewayError } from "./transform.js";

class Bucket {
  constructor(capacity, perSec, now) { Object.assign(this, { capacity, perSec, now, tokens: capacity, last: now() }); }
  take() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1; return true;
  }
}

/** Request router: picks MCP vs API transport, attaches product token + sandbox/org context, rate limits, retries. */
export class Router {
  constructor({ services, auth, integration, now = Date.now, rate = { capacity: 120, perSec: 2 } }) {
    Object.assign(this, { services, auth, integration, now, rate });
    this.buckets = new Map();
  }
  async dispatch({ identity, cap, args }) {
    const key = `${identity.userId}:${cap.service}`;
    if (!this.buckets.has(key)) this.buckets.set(key, new Bucket(this.rate.capacity, this.rate.perSec, this.now));
    if (!this.buckets.get(key).take()) throw new GatewayError("rate_limited", `Rate limit exceeded for ${cap.service}`, { service: cap.service, retryable: true });
    const svc = this.services.get(cap.service);
    const route = { transport: cap.transport, sandbox: identity.sandbox, tenant: identity.tenant, imsOrg: identity.imsOrg, productToken: this.auth.productToken(identity, cap.service) };
    const result = await this.integration.withRetry(() => svc.call(cap.tool, args));
    const { productToken, ...safeRoute } = route; // never surface tokens to callers
    return { result, route: safeRoute };
  }
}
