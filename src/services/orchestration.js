const FLOW = {
  draft: ["planned"], planned: ["content_ready"], content_ready: ["in_review"], in_review: ["approved", "changes_requested"],
  changes_requested: ["in_review", "content_ready"], approved: ["activating"], activating: ["live"], live: ["reporting"], reporting: [], cancelled: [],
};

/** Orchestration Service: campaign state machine, guards, and event handling. */
export class OrchestrationService {
  constructor({ data, policy, notify }) { Object.assign(this, { data, policy, notify }); this.listeners = []; }
  on(fn) { this.listeners.push(fn); }
  emit(evt) { for (const fn of this.listeners) fn(evt); }

  transition(campaignId, to, { actor = "system", reason } = {}) {
    const c = this.data.get(campaignId);
    if (to !== "cancelled" && !FLOW[c.state]?.includes(to)) throw new Error(`Illegal transition ${c.state} -> ${to}. Allowed: ${[...FLOW[c.state], "cancelled"].join(", ")}`);
    if (to === "cancelled" && ["live", "reporting", "cancelled"].includes(c.state)) throw new Error(`Cannot cancel a campaign in state ${c.state}`);
    if (to === "planned" && !c.plan.length) throw new Error("Cannot plan: campaign has no plan");
    if (to === "in_review" && c.state === "content_ready" && !c.content.length) throw new Error("Cannot submit for review without content");
    if (to === "activating") {
      const r = this.policy.evaluateLaunch(c);
      if (!r.pass) throw new Error(`Policy gate failed: ${r.checks.filter((x) => !x.pass).map((x) => `${x.name} (${x.detail})`).join("; ")}`);
    }
    const from = c.state;
    c.state = to;
    this.data.record(campaignId, "state_changed", { from, to, actor, reason });
    this.emit({ type: "state_changed", campaignId, from, to });
    this.notify.statusUpdate(c, `${from} -> ${to}`);
    return { campaignId, from, to };
  }

  /** planned -> content_ready automatically once a validated audience and content exist. */
  autoAdvance(campaignId) {
    const c = this.data.get(campaignId);
    if (c.state === "planned" && c.audienceRefs.some((a) => a.consentValidated) && c.content.length) this.transition(campaignId, "content_ready", { actor: "orchestrator", reason: "audience and content ready" });
    return c.state;
  }
}
