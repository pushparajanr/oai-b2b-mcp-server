import { z } from "zod";
import { Agent, uid, coll } from "./base.js";

const init = (s) => coll(s, "programs", "leads", "emailPrograms");
const POINTS = { open: 2, click: 5, visit: 3, form: 10 };

export const marketo = new Agent({
  key: "marketo", name: "Marketo Agent", product: "Adobe Marketo Engage",
  description: "Marketing automation, lead management, email programs and engagement scoring.",
  keywords: ["marketo", "lead", "lead scoring", "email program", "engagement score", "nurture"],
  tools: {
    create_program: { description: "Create a marketing program.", shape: 1, schema: z.object({ name: z.string(), channel: z.string().default("email"), campaignId: z.string().optional() }),
      run(a, s) { init(s); const v = { id: uid("mkp"), ...a }; s.programs.set(v.id, v); return v; } },
    add_lead: { description: "Create or update a lead (keyed by email).", shape: 1, schema: z.object({ email: z.string().email(), firstName: z.string().optional(), programId: z.string().optional() }),
      run(a, s) { init(s); if (a.programId && !s.programs.has(a.programId)) throw new Error(`Unknown program '${a.programId}'`);
        const ex = [...s.leads.values()].find((l) => l.email === a.email); if (ex) { Object.assign(ex, a); return ex; }
        const v = { id: uid("lead"), ...a, score: 0 }; s.leads.set(v.id, v); return v; } },
    create_email_program: { description: "Create an email program under a program.", shape: 1, schema: z.object({ programId: z.string(), name: z.string(), subject: z.string() }),
      run(a, s) { init(s); if (!s.programs.has(a.programId)) throw new Error(`Unknown program '${a.programId}'`); const v = { id: uid("mke"), ...a, status: "draft" }; s.emailPrograms.set(v.id, v); return v; } },
    record_engagement: { description: "Record a lead engagement event and update engagement score.", shape: 1, schema: z.object({ leadId: z.string(), event: z.enum(Object.keys(POINTS)) }),
      run(a, s) { init(s); const l = s.leads.get(a.leadId); if (!l) throw new Error(`Unknown lead '${a.leadId}'`); l.score += POINTS[a.event]; return { leadId: l.id, score: l.score }; } },
    list_leads: { description: "List leads, optionally above a minimum score.", shape: 1, schema: z.object({ minScore: z.number().optional() }),
      run: (a, s) => (init(s), [...s.leads.values()].filter((l) => l.score >= (a.minScore ?? 0))) },
  },
});
