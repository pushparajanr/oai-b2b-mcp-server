import { z } from "zod";
import { Agent, uid } from "./base.js";

/** Pure brand-rule check, shared with the policy engine. */
export function checkBrand(g, { subject = "", body = "" }) {
  const text = `${subject} ${body}`.toLowerCase();
  const violations = [];
  for (const w of g.bannedWords) if (new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) violations.push(`banned word '${w}'`);
  if (g.requiredDisclaimer && !body.includes(g.requiredDisclaimer)) violations.push("missing required disclaimer");
  if (subject && subject.length > g.maxSubjectLength) violations.push(`subject exceeds ${g.maxSubjectLength} characters`);
  return violations;
}

const init = (s) => (s.g ??= { tone: "friendly", bannedWords: [], requiredDisclaimer: "", maxSubjectLength: 60, colors: [], knowledge: [] });

export const brandConcierge = new Agent({
  key: "brand_concierge", name: "Brand Concierge Agent", product: "Adobe Brand Concierge & AEM Agents",
  description: "Brand knowledge, content advisor, brand governance checks and guidelines.",
  keywords: ["brand", "guideline", "tone of voice", "brand concierge", "banned word", "disclaimer"],
  tools: {
    set_brand_guidelines: { description: "Set brand guidelines: tone, banned words, required disclaimer, max subject length, colors.", shape: 1,
      schema: z.object({ tone: z.string().optional(), bannedWords: z.array(z.string()).optional(), requiredDisclaimer: z.string().optional(), maxSubjectLength: z.number().int().positive().optional(), colors: z.array(z.string()).optional() }),
      run(a, s) { init(s); Object.assign(s.g, a); return s.g; } },
    get_brand_guidelines: { description: "Get brand guidelines.", run: (_, s) => init(s) },
    add_knowledge: { description: "Add a brand knowledge entry.", shape: 1, schema: z.object({ topic: z.string(), content: z.string() }),
      run(a, s) { init(s); const v = { id: uid("kn"), ...a }; s.g.knowledge.push(v); return v; } },
    ask_brand_question: { description: "Answer a brand question from knowledge entries and guidelines (content advisor).", shape: 1, schema: z.object({ question: z.string() }),
      run(a, s) { init(s); const words = a.question.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
        const scored = s.g.knowledge.map((k) => ({ k, n: words.filter((w) => `${k.topic} ${k.content}`.toLowerCase().includes(w)).length })).filter((x) => x.n).sort((x, y) => y.n - x.n);
        return scored.length ? { answer: scored[0].k.content, source: scored[0].k.topic } : { answer: null, guidelines: { tone: s.g.tone, requiredDisclaimer: s.g.requiredDisclaimer }, note: "No matching knowledge entry" }; } },
    check_brand_compliance: { description: "Brand governance: check copy against guidelines.", shape: 1, schema: z.object({ subject: z.string().optional(), body: z.string() }),
      run(a, s) { init(s); const violations = checkBrand(s.g, a); return { compliant: !violations.length, violations }; } },
  },
});
