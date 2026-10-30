import { randomUUID } from "node:crypto";

/** Campaign Data Service: campaign records, audience references, asset references, execution history. */
export class CampaignData {
  constructor({ now = () => new Date().toISOString() } = {}) { this.now = now; this.campaigns = new Map(); }
  create(fields) {
    const c = { id: `cmp_${randomUUID().slice(0, 8)}`, region: "US", channels: ["email"], tone: "friendly", ...fields, state: "draft", plan: [], audienceRefs: [], assetRefs: [], content: [], approvalRefs: [], journeyRef: null, projectId: null, history: [], createdAt: this.now() };
    c.primaryChannel = c.channels[0];
    this.campaigns.set(c.id, c);
    this.record(c.id, "created", { name: c.name });
    return c;
  }
  get(id) { const c = this.campaigns.get(id); if (!c) throw new Error(`Unknown campaign '${id}'`); return c; }
  list() { return [...this.campaigns.values()].map(({ id, name, state }) => ({ id, name, state })); }
  record(id, type, detail = {}) { this.campaigns.get(id).history.push({ at: this.now(), type, ...detail }); }
  addAudienceRef(id, ref) { const c = this.get(id); c.audienceRefs.push(ref); this.record(id, "audience_linked", { audienceId: ref.audienceId }); return ref; }
  addAssetRef(id, ref) { const c = this.get(id); if (!c.assetRefs.some((r) => r.assetId === ref.assetId)) c.assetRefs.push(ref); this.record(id, "asset_linked", { assetId: ref.assetId }); return ref; }
  addContent(id, item) { const c = this.get(id); const v = { id: `ct_${randomUUID().slice(0, 6)}`, ...item }; c.content.push(v); this.record(id, "content_added", { contentId: v.id, type: v.type }); return v; }
}
