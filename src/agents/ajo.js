import { z } from "zod";
import { Agent, uid, coll } from "./base.js";

const init = (s) => coll(s, "journeys", "campaigns", "offers", "decisions", "actions");

export const ajo = new Agent({
  key: "ajo", name: "AJO Agent", product: "Adobe Journey Optimizer",
  description: "Journeys, campaigns, offers, decisioning and custom actions.",
  keywords: ["ajo", "journey", "campaign", "offer", "decision", "custom action", "webhook", "orchestrat"],
  tools: {
    create_custom_action: { description: "Define a REST custom action (URL, auth, timeout) usable in journeys.", shape: 1,
      schema: z.object({ name: z.string(), url: z.string().url(), method: z.enum(["POST", "PUT", "GET"]).default("POST"), auth: z.enum(["none", "bearer", "oauth2"]).default("none"), timeoutMs: z.number().int().min(100).max(30000).default(5000) }),
      run(a, s) { init(s); const v = { id: uid("act"), ...a }; s.actions.set(v.id, v); return v; } },
    create_journey: { description: "Create a draft journey from ordered steps (event/audience entry, email, wait, condition, action).", shape: 1,
      schema: z.object({ name: z.string(), audienceId: z.string(), steps: z.array(z.object({ type: z.enum(["email", "sms", "push", "wait", "condition", "action"]), label: z.string(), duration: z.string().optional(), actionId: z.string().optional() })).min(1) }),
      run(a, s) { init(s);
        for (const st of a.steps) { if (st.type === "wait" && !st.duration) throw new Error("wait step needs duration");
          if (st.type === "action" && !s.actions.get(st.actionId)) throw new Error(`action step '${st.label}' needs a valid actionId`); }
        const v = { id: uid("jny"), ...a, status: "draft" }; s.journeys.set(v.id, v); return v; } },
    publish_journey: { description: "Validate and publish a journey (must be draft).", shape: 1, schema: z.object({ journeyId: z.string() }),
      run(a, s) { init(s); const j = s.journeys.get(a.journeyId); if (!j) throw new Error(`Unknown journey '${a.journeyId}'`);
        if (j.status !== "draft") throw new Error(`Journey is ${j.status}`);
        if (!j.steps.some((x) => ["email", "sms", "push"].includes(x.type))) throw new Error("Journey needs at least one message step");
        j.status = "live"; return { id: j.id, status: j.status }; } },
    create_campaign: { description: "Create a one-off or recurring campaign for an audience.", shape: 1,
      schema: z.object({ name: z.string(), audienceId: z.string(), channel: z.enum(["email", "sms", "push"]), schedule: z.enum(["immediate", "scheduled", "recurring"]).default("immediate") }),
      run(a, s) { init(s); const v = { id: uid("cmp"), ...a, status: "draft" }; s.campaigns.set(v.id, v); return v; } },
    create_offer: { description: "Create a personalization offer with eligibility rule and priority.", shape: 1,
      schema: z.object({ name: z.string(), content: z.string(), priority: z.number().int().default(0), eligibility: z.object({ field: z.string(), equals: z.union([z.string(), z.number(), z.boolean()]) }).optional(), capPerProfile: z.number().int().optional() }),
      run(a, s) { init(s); const v = { id: uid("off"), ...a, served: {} }; s.offers.set(v.id, v); return { id: v.id, name: v.name }; } },
    create_decision: { description: "Create a decision policy ranking a set of offers (highest priority wins among eligible).", shape: 1,
      schema: z.object({ name: z.string(), offerIds: z.array(z.string()).min(1), fallbackOfferId: z.string().optional() }),
      run(a, s) { init(s); for (const o of [...a.offerIds, ...(a.fallbackOfferId ? [a.fallbackOfferId] : [])]) if (!s.offers.has(o)) throw new Error(`Unknown offer '${o}'`);
        const v = { id: uid("dec"), ...a }; s.decisions.set(v.id, v); return v; } },
    decide_offer: { description: "Run a decision for a profile (attributes object) and return the winning offer.", shape: 1,
      schema: z.object({ decisionId: z.string(), profileId: z.string(), attributes: z.record(z.any()).default({}) }),
      run(a, s) { init(s); const d = s.decisions.get(a.decisionId); if (!d) throw new Error(`Unknown decision '${a.decisionId}'`);
        const ok = (o) => (!o.eligibility || a.attributes[o.eligibility.field] === o.eligibility.equals) && (!o.capPerProfile || (o.served[a.profileId] ?? 0) < o.capPerProfile);
        const win = d.offerIds.map((i) => s.offers.get(i)).filter(ok).sort((x, y) => y.priority - x.priority)[0] ?? (d.fallbackOfferId && s.offers.get(d.fallbackOfferId));
        if (!win) return { offer: null, reason: "no eligible offer" };
        win.served[a.profileId] = (win.served[a.profileId] ?? 0) + 1; return { offer: { id: win.id, name: win.name, content: win.content } }; } },
    list_journeys: { description: "List journeys and statuses.", run: (_, s) => (init(s), [...s.journeys.values()].map(({ id, name, status }) => ({ id, name, status }))) },
  },
});
