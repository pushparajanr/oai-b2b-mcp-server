import { z } from "zod";
import { Agent, coll } from "./base.js";

const init = (s) => coll(s, "events", "experiments");
const EVENT = z.enum(["delivered", "open", "click", "bounce", "conversion"]);
const pct = (n, d) => (d ? +((n / d) * 100).toFixed(2) : 0);
const count = (s, cid, t) => (s.events.get(cid) ?? []).filter((e) => e.type === t).length;

export const cja = new Agent({
  key: "cja", name: "CJA Agent", product: "Adobe Customer Journey Analytics",
  description: "Campaign performance, journey analysis, experimentation and optimization insights.",
  keywords: ["cja", "analytics", "performance", "journey analysis", "experiment", "attribution", "funnel", "report"],
  tools: {
    ingest_events: { description: "Ingest campaign events (delivered/open/click/bounce/conversion).", shape: 1,
      schema: z.object({ campaignId: z.string(), events: z.array(z.object({ type: EVENT, profileId: z.string().optional(), revenue: z.number().optional() })).min(1) }),
      run(a, s) { init(s); const l = s.events.get(a.campaignId) ?? []; l.push(...a.events); s.events.set(a.campaignId, l); return { campaignId: a.campaignId, total: l.length }; } },
    get_campaign_performance: { description: "Per-campaign delivery, engagement and conversion metrics.", shape: 1, schema: z.object({ campaignId: z.string() }),
      run(a, s) { init(s); const c = (t) => count(s, a.campaignId, t); const delivered = c("delivered");
        return { campaignId: a.campaignId, delivered, opens: c("open"), clicks: c("click"), bounces: c("bounce"), conversions: c("conversion"),
          revenue: (s.events.get(a.campaignId) ?? []).reduce((x, e) => x + (e.revenue ?? 0), 0),
          openRate: pct(c("open"), delivered), clickRate: pct(c("click"), delivered), bounceRate: pct(c("bounce"), delivered + c("bounce")), conversionRate: pct(c("conversion"), delivered) }; } },
    get_journey_analysis: { description: "Funnel analysis with step-to-step drop-off.", shape: 1, schema: z.object({ campaignId: z.string() }),
      run(a, s) { init(s); const steps = ["delivered", "open", "click", "conversion"].map((t) => ({ step: t, count: count(s, a.campaignId, t) }));
        return { campaignId: a.campaignId, funnel: steps.map((x, i) => ({ ...x, dropOffPct: i && steps[i - 1].count ? pct(steps[i - 1].count - x.count, steps[i - 1].count) : 0 })) }; } },
    record_experiment: { description: "Record variant results for an experiment.", shape: 1,
      schema: z.object({ campaignId: z.string(), variant: z.string(), delivered: z.number().int().positive(), conversions: z.number().int().min(0) }),
      run(a, s) { init(s); const l = s.experiments.get(a.campaignId) ?? {}; l[a.variant] = { delivered: a.delivered, conversions: a.conversions }; s.experiments.set(a.campaignId, l); return l; } },
    get_experiment_results: { description: "Experiment results with winner if sample and lift are sufficient (>=50 each, >=10% relative lift).", shape: 1, schema: z.object({ campaignId: z.string() }),
      run(a, s) { init(s); const l = s.experiments.get(a.campaignId) ?? {};
        const rows = Object.entries(l).map(([variant, v]) => ({ variant, ...v, conversionRate: pct(v.conversions, v.delivered) })).sort((x, y) => y.conversionRate - x.conversionRate);
        const [best, second] = rows; const winner = best && second && rows.every((r) => r.delivered >= 50) && best.conversionRate >= second.conversionRate * 1.1 ? best.variant : null;
        return { campaignId: a.campaignId, variants: rows, winner, status: rows.length < 2 ? "needs_more_variants" : winner ? "winner" : "inconclusive" }; } },
  },
});
