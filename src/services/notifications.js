/** Notification Service: status updates, approvals, alerts and escalations over Teams / email (simulated outbox). */
export class Notifications {
  constructor({ now = Date.now } = {}) { this.now = now; this.outbox = []; }
  send({ channel = "teams", to, subject, body, kind = "status" }) {
    const m = { id: this.outbox.length + 1, at: new Date(this.now()).toISOString(), channel, to: [].concat(to), subject, body, kind };
    this.outbox.push(m); return m;
  }
  statusUpdate(campaign, text, to = ["campaign-owners"]) { return this.send({ to, subject: `${campaign.name}: ${text}`, body: text, kind: "status" }); }
  approvalRequest(campaign, deliverable, approvers) { return this.send({ to: approvers, subject: `Approval needed: ${campaign.name} / ${deliverable}`, body: "Please review and decide.", kind: "approval", channel: "email" }); }
  /** Escalate approvals pending longer than slaMinutes (once each). */
  sweepEscalations(campaign, { slaMinutes = 60 } = {}) {
    const out = [];
    for (const a of campaign.approvalRefs) {
      if (a.status === "pending" && !a.escalated && this.now() - Date.parse(a.requestedAt) > slaMinutes * 60_000) {
        a.escalated = true;
        out.push(this.send({ to: [...a.approvers, "marketing-ops-lead"], subject: `ESCALATION: ${campaign.name} / ${a.deliverable} pending > ${slaMinutes}m`, body: "Approval overdue.", kind: "escalation" }));
      }
    }
    return out;
  }
  list({ kind, to } = {}) { return this.outbox.filter((m) => (!kind || m.kind === kind) && (!to || m.to.includes(to))); }
}
