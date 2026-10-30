import { createHash } from "node:crypto";
import { checkBrand } from "../agents/brand-concierge.js";

export const ref = (id) => createHash("sha1").update(String(id)).digest("hex").slice(0, 8);

/**
 * Business Rules & Policy Engine: consent checks, brand rules, approval requirements, regulatory compliance,
 * responsible-AI gate. `internal` gives privileged server-side reads (audience members, guidelines);
 * results exposed to callers use hashed refs, never raw identities.
 */
export class PolicyEngine {
  constructor({ internal }) { this.internal = internal; this.consent = new Map(); }
  setConsent(profileId, rec) { this.consent.set(String(profileId), rec); return rec; }

  consentCheck({ audienceId, channel, region }) {
    const aud = this.internal.audience(audienceId);
    const eligible = [], excluded = [];
    for (const id of aud.members) {
      const rec = this.consent.get(id);
      const r = rec?.region ?? region;
      const ch = rec?.channels?.[channel];
      let reason = null;
      if (ch === false) reason = "opted out";
      else if (r === "GDPR" && ch !== true) reason = "GDPR requires explicit opt-in";
      else if (channel === "sms" && ch !== true) reason = "SMS requires explicit opt-in";
      else if (r === "CCPA" && rec?.optOutCategories?.includes("marketing")) reason = "CCPA marketing opt-out";
      (reason ? excluded.push({ id, reason }) : eligible.push(id));
    }
    return { audienceName: aud.name, eligible, excluded, summary: { total: aud.members.length, eligible: eligible.length, excluded: excluded.length } };
  }

  brandCheck(item) { return checkBrand(this.internal.guidelines(), item); }

  regulatoryCheck(item, channel) {
    const text = `${item.subject ?? ""} ${item.body ?? ""}`.toLowerCase(), v = [];
    if (channel === "email" && !text.includes("unsubscribe")) v.push("email must include an unsubscribe mechanism");
    if (channel === "sms" && !/\bstop\b/.test(text)) v.push("sms must include opt-out instructions (STOP)");
    return v;
  }

  /** Aggregate launch gate over a campaign record. */
  evaluateLaunch(c) {
    const copies = c.content.filter((x) => x.type === "copy");
    const approvals = c.approvalRefs;
    const ai = c.content.filter((x) => x.aiGenerated);
    const checks = [
      { name: "audience_consent", pass: c.audienceRefs.some((a) => a.consentValidated && a.eligible > 0), detail: "A consent-validated audience with eligible members is required" },
      { name: "content_present", pass: c.content.length > 0, detail: "At least one content item is required" },
      { name: "brand_rules", pass: copies.every((x) => !x.brandViolations?.length), detail: copies.flatMap((x) => x.brandViolations ?? []).join("; ") || "ok" },
      { name: "regulatory", pass: copies.every((x) => !x.regulatoryViolations?.length), detail: copies.flatMap((x) => x.regulatoryViolations ?? []).join("; ") || "ok" },
      { name: "approval", pass: approvals.length > 0 && approvals.every((a) => a.status === "approved"), detail: approvals.length ? approvals.map((a) => `${a.deliverable}:${a.status}`).join(", ") : "No approvals requested" },
      { name: "responsible_ai", pass: ai.every((x) => x.reviewedBy?.length), detail: ai.length ? `${ai.filter((x) => x.reviewedBy?.length).length}/${ai.length} AI-generated items human-reviewed` : "no AI-generated content" },
    ];
    return { pass: checks.every((x) => x.pass), checks };
  }
}
