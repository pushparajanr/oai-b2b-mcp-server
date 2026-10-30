const UI = { library: "Adobe Spectrum", layout: "single-column" };
const CHANNELS = ["email", "sms", "push", "whatsapp"];

/** GenUI Dynamic Forms & UI Service: context-aware form specs (role, campaign state, live options) and validation. */
export class FormsService {
  constructor({ data, policy }) { Object.assign(this, { data, policy }); }

  spec(formId, { identity, campaign, audiences = [] }) {
    const f = (name, label, type, extra = {}) => ({ name, label, type, required: false, ...extra });
    switch (formId) {
      case "campaign_brief":
        return { title: "New campaign brief", fields: [
          f("name", "Campaign name", "text", { required: true }), f("brief", "Brief", "textarea", { required: true }),
          f("channels", "Channels", "multiselect", { required: true, options: CHANNELS }),
          f("region", "Consent region", "select", { options: ["US", "GDPR", "CCPA"], default: "US" }),
          ...(audiences.length ? [f("audienceId", "Audience", "select", { options: audiences.map((a) => ({ value: a.id, label: `${a.name} (${a.size})` })) })] : []),
        ] };
      case "approval_request": {
        const blocked = campaign && campaign.state !== "content_ready" ? `Campaign is '${campaign.state}'; approvals are requested from 'content_ready'` : null;
        return { title: `Request approval${campaign ? `: ${campaign.name}` : ""}`, blocked, fields: [
          f("deliverable", "Deliverable", "select", { required: true, options: ["creative", "journey", "audience"], default: "creative" }),
          f("approvers", "Approvers", "multiselect", { required: true, options: ["bailey.brand", "casey.cm", "morgan.ops"] }),
        ] };
      }
      case "activation_checklist": {
        if (!campaign) throw new Error("activation_checklist needs a campaignId");
        const { checks } = this.policy.evaluateLaunch(campaign);
        return { title: `Activation checklist: ${campaign.name}`, fields: checks.map((c) => f(c.name, c.detail, "checkbox", { value: c.pass, readOnly: true })) };
      }
      default: throw new Error(`Unknown form '${formId}'. Available: campaign_brief, approval_request, activation_checklist`);
    }
  }

  get(formId, ctx) {
    const s = this.spec(formId, ctx);
    return { id: formId, ui: UI, context: { role: ctx.identity?.role, campaignId: ctx.campaign?.id ?? null, state: ctx.campaign?.state ?? null }, ...s };
  }

  validate(formId, values, ctx) {
    const { fields, blocked } = this.spec(formId, ctx);
    const errors = blocked ? [blocked] : [];
    for (const fd of fields) {
      const v = values[fd.name];
      if (fd.required && (v == null || v === "" || (Array.isArray(v) && !v.length))) { errors.push(`${fd.name} is required`); continue; }
      if (v == null || !fd.options) continue;
      const allowed = fd.options.map((o) => o.value ?? o);
      for (const x of [].concat(v)) if (!allowed.includes(x)) errors.push(`${fd.name}: '${x}' is not an allowed option`);
    }
    return { valid: !errors.length, errors };
  }

  submit(formId, values, ctx) {
    const r = this.validate(formId, values, ctx);
    if (!r.valid) return r;
    if (formId === "campaign_brief") {
      const c = this.data.create({ name: values.name, objective: values.brief, channels: values.channels, region: values.region ?? "US", audienceHint: values.audienceId ?? "" });
      return { ...r, campaignId: c.id };
    }
    return r;
  }
}
