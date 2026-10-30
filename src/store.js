import { randomUUID } from "node:crypto";

export const id = (p) => `${p}_${randomUUID().slice(0, 8)}`;

export class Store {
  constructor() {
    this.brandKit = { logos: [], colors: [], typography: [], rules: [], guidelinePdfs: [] };
    this.audiences = new Map();
    this.domains = new Map();
    this.campaigns = new Map();
    this.connectors = new Set(["salesforce", "hubspot"]);
  }
  campaign(cid) {
    const c = this.campaigns.get(cid);
    if (!c) throw new Error(`Unknown campaign '${cid}'`);
    return c;
  }
}

export const TEMPLATES = [
  { id: "tpl_welcome", name: "Welcome Series", channels: ["email"], steps: [["touchpoint", "email", "Welcome"], ["wait", "2 days"], ["touchpoint", "email", "Getting Started"]] },
  { id: "tpl_abandon", name: "Cart Abandonment", channels: ["email", "sms"], steps: [["wait", "1 hours"], ["touchpoint", "email", "You left something behind"], ["wait", "1 days"], ["touchpoint", "sms", "Still interested?"]] },
  { id: "tpl_reengage", name: "Re-engagement", channels: ["email", "push"], steps: [["touchpoint", "email", "We miss you"], ["wait", "3 days"], ["touchpoint", "push", "Come back for 10% off"]] },
  { id: "tpl_launch", name: "Product Launch", channels: ["email", "push", "sms"], steps: [["touchpoint", "email", "Announcing"], ["wait", "1 days"], ["touchpoint", "push", "It's live"]] },
];
