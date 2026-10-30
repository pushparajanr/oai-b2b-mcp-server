/** Integration Service: retry with backoff for upstream calls, plus inbound event processing (webhooks). */
export class Integration {
  constructor({ retries = 2, baseMs = 0 } = {}) { Object.assign(this, { retries, baseMs }); this.handlers = new Map(); this.processed = []; }
  async withRetry(fn) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (!(e?.transient || e?.retryable) || attempt >= this.retries) throw e;
        if (this.baseMs) await new Promise((r) => setTimeout(r, this.baseMs * 2 ** attempt));
      }
    }
  }
  onEvent(source, type, fn) { this.handlers.set(`${source}:${type}`, fn); }
  /** Inbound event (e.g. Workfront approval webhook). Unknown events are recorded, not failed. */
  async handleEvent(source, type, payload) {
    const fn = this.handlers.get(`${source}:${type}`);
    const rec = { at: new Date().toISOString(), source, type, handled: !!fn };
    this.processed.push(rec);
    if (fn) rec.result = await fn(payload);
    return rec;
  }
}
