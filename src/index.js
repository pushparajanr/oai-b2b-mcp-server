#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store, TEMPLATES, id } from "./store.js";
import { NATIVE_SETUP } from "./native-setup.js";
import { registerAgents } from "./agents/index.js";
import { platform } from "./platform.js";

const sharedStore = new Store();

/** `identity` is the authenticated user for this session; stdio defaults to MCP_USER (local trust), HTTP passes the verified bearer identity. */
export function createServer(store = sharedStore, { identity } = {}) {
  const server = new McpServer({ name: "oai-b2b-mcp-server", version: "1.0.0" });

  const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
  const fail = (msg) => ({ isError: true, content: [{ type: "text", text: msg }] });
  const tool = (name, description, shape, fn) =>
    server.registerTool(name, { description, inputSchema: shape }, async (args) => {
      try { return ok(await fn(args)); } catch (e) { return fail(e.message); }
    });
  const touchpoints = (c) => c.steps.filter((s) => s.type === "touchpoint");
  const email = (c, eid) => {
    const e = c.emails.get(eid);
    if (!e) throw new Error(`Unknown email '${eid}' in campaign ${c.id}`);
    return e;
  };
  const addTouchpoint = (c, channel, name, index) => {
    const step = { id: id("step"), type: "touchpoint", channel, name };
    if (channel === "email") {
      const e = { id: id("email"), subject: name, html: `<h1>${name}</h1><p></p>`, history: [], redo: [], images: [], template: null };
      c.emails.set(e.id, e);
      step.emailId = e.id;
    }
    index === undefined ? c.steps.push(step) : c.steps.splice(index, 0, step);
    return step;
  };
  const parseDuration = (d) => {
    const m = /^(\d+)\s*(minutes?|hours?|days?|weeks?)$/i.exec(d.trim());
    if (!m) throw new Error(`Invalid duration '${d}'. Use e.g. '2 days', '4 hours'.`);
    return `${m[1]} ${m[2].toLowerCase().replace(/s$/, "")}s`.replace(/^1 (\w+)s$/, "1 $1");
  };

  // ---------- Planning & Intake ----------
  tool("create_campaign", "Create a campaign board.", { name: z.string() }, ({ name }) => {
    const c = { id: id("cmp"), name, plan: [], steps: [], emails: new Map(), audienceId: null, senderId: null, status: "draft", launchedAt: null, metrics: new Map(), testsSent: [], zoom: 1 };
    store.campaigns.set(c.id, c);
    return { campaignId: c.id, name, status: c.status };
  });

  tool("ingest_brief", "Brief & Strategy Ingestion: parse a natural-language brief (and optional attached file text) and generate a step-by-step plan on the Campaign Board.",
    { campaignId: z.string(), brief: z.string(), attachments: z.array(z.object({ name: z.string(), text: z.string() })).optional() },
    ({ campaignId, brief, attachments = [] }) => {
      const c = store.campaign(campaignId);
      const text = [brief, ...attachments.map((a) => a.text)].join("\n").toLowerCase();
      const channels = ["email", "sms", "push", "whatsapp"].filter((ch) => text.includes(ch));
      if (!channels.length) channels.push("email");
      const goal = /(?:goal|objective)[:\s]+([^.\n]+)/i.exec(brief)?.[1]?.trim() ?? brief.split(/[.\n]/)[0].trim();
      c.plan = [
        `Confirm objective: ${goal}`,
        "Select or ingest target audience",
        "Apply brand kit",
        ...channels.map((ch) => `Draft ${ch} touchpoint`),
        "Map journey with wait steps",
        "Run pre-launch validation",
        "Launch campaign",
      ];
      c.brief = { goal, channels, attachments: attachments.map((a) => a.name) };
      return { campaignId, parsed: c.brief, plan: c.plan };
    });

  tool("list_journey_templates", "List refreshed campaign templates, optionally filtered by channel.", { channel: z.string().optional() },
    ({ channel }) => TEMPLATES.filter((t) => !channel || t.channels.includes(channel.toLowerCase())).map(({ id, name, channels }) => ({ id, name, channels })));

  tool("remix_journey_template", "Template & Journey Remixing: seed a campaign's journey from a template, optionally dropping channels.",
    { campaignId: z.string(), templateId: z.string(), excludeChannels: z.array(z.string()).optional() },
    ({ campaignId, templateId, excludeChannels = [] }) => {
      const c = store.campaign(campaignId);
      const t = TEMPLATES.find((x) => x.id === templateId);
      if (!t) throw new Error(`Unknown template '${templateId}'`);
      c.steps = []; c.emails.clear();
      for (const [type, a, b] of t.steps) {
        if (type === "wait") c.steps.push({ id: id("step"), type: "wait", duration: a });
        else if (!excludeChannels.includes(a)) addTouchpoint(c, a, b);
      }
      return { campaignId, steps: c.steps };
    });

  tool("list_connectors", "List active CRM connectors available for audience mapping.", {}, () => [...store.connectors]);

  tool("ingest_audience_csv", "Audience Ingestion & Mapping: ingest a CSV contact list and map columns to a CRM connector's fields.",
    { name: z.string(), csv: z.string(), connector: z.string().optional(), fieldMap: z.record(z.string()).optional() },
    ({ name, csv, connector, fieldMap = {} }) => {
      if (connector && !store.connectors.has(connector.toLowerCase())) throw new Error(`Connector '${connector}' is not active. Active: ${[...store.connectors].join(", ")}`);
      const [head, ...rows] = csv.trim().split(/\r?\n/).map((l) => l.split(",").map((s) => s.trim()));
      const emailCol = head.findIndex((h) => /^e-?mail/i.test(h));
      if (emailCol < 0) throw new Error("CSV must contain an email column");
      const seen = new Set(); let invalid = 0, dupes = 0;
      for (const r of rows) {
        const e = (r[emailCol] ?? "").toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) invalid++;
        else if (seen.has(e)) dupes++;
        else seen.add(e);
      }
      const mapping = Object.fromEntries(head.map((h) => [h, fieldMap[h] ?? h]));
      const a = { id: id("aud"), name, connector: connector ?? null, mapping, total: rows.length, valid: seen.size, invalid, duplicates: dupes };
      store.audiences.set(a.id, a);
      return a;
    });

  tool("set_brand_kit", "Brand Setup & Context Alignment: store logos, colors, typography, rules and guideline PDFs (max 100 MB each).",
    { logos: z.array(z.string()).optional(), colors: z.array(z.string()).optional(), typography: z.array(z.string()).optional(), rules: z.array(z.string()).optional(),
      guidelinePdfs: z.array(z.object({ name: z.string(), sizeBytes: z.number() })).optional() },
    (p) => {
      for (const f of p.guidelinePdfs ?? []) {
        if (!f.name.toLowerCase().endsWith(".pdf")) throw new Error(`${f.name}: guidelines must be PDF`);
        if (f.sizeBytes > 100 * 1024 * 1024) throw new Error(`${f.name}: exceeds 100 MB limit`);
      }
      for (const k of Object.keys(store.brandKit)) if (p[k]) store.brandKit[k].push(...p[k]);
      return store.brandKit;
    });
  tool("get_brand_kit", "Return the stored brand kit (used as prompt context).", {}, () => store.brandKit);

  // ---------- Production & Execution ----------
  tool("add_journey_step", "Visual Journey Mapping: add a wait step (duration-based), weighted branch, or touchpoint.",
    { campaignId: z.string(), type: z.enum(["wait", "branch", "touchpoint"]), duration: z.string().optional(),
      branches: z.array(z.object({ label: z.string(), weight: z.number().positive() })).min(2).optional(),
      channel: z.string().optional(), name: z.string().optional(), index: z.number().int().min(0).optional() },
    ({ campaignId, type, duration, branches, channel, name, index }) => {
      const c = store.campaign(campaignId);
      if (c.status === "launched") throw new Error("Campaign already launched");
      if (type === "touchpoint") return addTouchpoint(c, (channel ?? "email").toLowerCase(), name ?? "Untitled", index);
      let step;
      if (type === "wait") {
        if (!duration) throw new Error("wait requires duration");
        step = { id: id("step"), type, duration: parseDuration(duration) };
      } else {
        if (!branches) throw new Error("branch requires branches");
        const total = branches.reduce((s, b) => s + b.weight, 0);
        step = { id: id("step"), type, branches: branches.map((b) => ({ label: b.label, weight: b.weight, percent: +((b.weight / total) * 100).toFixed(1) })) };
      }
      index === undefined ? c.steps.push(step) : c.steps.splice(index, 0, step);
      return step;
    });

  tool("get_journey", "Return the journey map; zoom is a display hint (0.25-2).", { campaignId: z.string(), zoom: z.number().min(0.25).max(2).optional() },
    ({ campaignId, zoom }) => { const c = store.campaign(campaignId); if (zoom) c.zoom = zoom; return { campaignId, zoom: c.zoom, plan: c.plan, steps: c.steps }; });

  tool("reorder_touchpoint", "Touchpoint Structuring: move a step to a new index.", { campaignId: z.string(), stepId: z.string(), newIndex: z.number().int().min(0) },
    ({ campaignId, stepId, newIndex }) => {
      const c = store.campaign(campaignId);
      const i = c.steps.findIndex((s) => s.id === stepId);
      if (i < 0) throw new Error(`Unknown step '${stepId}'`);
      c.steps.splice(Math.min(newIndex, c.steps.length - 1), 0, c.steps.splice(i, 1)[0]);
      return c.steps;
    });

  tool("remove_step", "Touchpoint Structuring: remove a step (and its email).", { campaignId: z.string(), stepId: z.string() }, ({ campaignId, stepId }) => {
    const c = store.campaign(campaignId);
    if (c.status === "launched") throw new Error("Campaign already launched");
    const i = c.steps.findIndex((s) => s.id === stepId);
    if (i < 0) throw new Error(`Unknown step '${stepId}'`);
    const [s] = c.steps.splice(i, 1);
    if (s.emailId) c.emails.delete(s.emailId);
    return c.steps;
  });

  const MAX_HISTORY = 50;
  tool("edit_email", "Email Authoring & Recovery: set subject/HTML with auto-save; each edit is undoable. Links are preserved as-is.",
    { campaignId: z.string(), emailId: z.string(), subject: z.string().optional(), html: z.string().optional() },
    ({ campaignId, emailId, subject, html }) => {
      const e = email(store.campaign(campaignId), emailId);
      e.history.push({ subject: e.subject, html: e.html });
      if (e.history.length > MAX_HISTORY) e.history.shift();
      e.redo = [];
      if (subject !== undefined) e.subject = subject;
      if (html !== undefined) e.html = html;
      return { emailId, subject: e.subject, html: e.html, autoSaved: true, undoDepth: e.history.length };
    });
  tool("undo_email_edit", "Undo the last email edit.", { campaignId: z.string(), emailId: z.string() }, ({ campaignId, emailId }) => {
    const e = email(store.campaign(campaignId), emailId);
    const prev = e.history.pop();
    if (!prev) throw new Error("Nothing to undo");
    e.redo.push({ subject: e.subject, html: e.html }); Object.assign(e, prev);
    return { subject: e.subject, html: e.html };
  });
  tool("redo_email_edit", "Redo an undone email edit.", { campaignId: z.string(), emailId: z.string() }, ({ campaignId, emailId }) => {
    const e = email(store.campaign(campaignId), emailId);
    const next = e.redo.pop();
    if (!next) throw new Error("Nothing to redo");
    e.history.push({ subject: e.subject, html: e.html }); Object.assign(e, next);
    return { subject: e.subject, html: e.html };
  });

  tool("generate_email_image", "AI Creative Generation: generate a contextual email image from a description and insert it. Returns a placeholder asset URL (no real model is called).",
    { campaignId: z.string(), emailId: z.string(), description: z.string(), width: z.number().int().optional(), height: z.number().int().optional() },
    ({ campaignId, emailId, description, width = 600, height = 300 }) => {
      const e = email(store.campaign(campaignId), emailId);
      const url = `https://placehold.co/${width}x${height}?text=${encodeURIComponent(description.slice(0, 40))}`;
      e.history.push({ subject: e.subject, html: e.html }); e.redo = [];
      e.images.push({ description, url });
      e.html += `<img src="${url}" alt="${description.replace(/"/g, "&quot;")}" width="${width}">`;
      return { url, html: e.html };
    });

  tool("suggest_copy", "AI Creative Generation: smart copy suggestions for an email, using brief goal and brand rules as context.",
    { campaignId: z.string(), emailId: z.string(), tone: z.string().optional() },
    ({ campaignId, emailId, tone = "friendly" }) => {
      const c = store.campaign(campaignId); const e = email(c, emailId);
      const goal = c.brief?.goal ?? c.name;
      return { context: { goal, tone, brandRules: store.brandKit.rules }, suggestions: [
        { subject: `${e.subject}: ${goal}`, body: `Hi {{first_name}}, we have something for you — ${goal}.` },
        { subject: `Don't miss out: ${goal}`, body: `Hello {{first_name}}, ${goal}. Tap below to get started.` },
        { subject: `A quick note on ${goal}`, body: `Hey {{first_name}}, here's what you need to know about ${goal}.` },
      ] };
    });

  const EMAIL_TEMPLATES = {
    newsletter: (s) => `<table width="600"><tr><td><h1>${s}</h1></td></tr><tr><td><p>Content</p></td></tr><tr><td><a href="{{cta_url}}">Read more</a></td></tr></table>`,
    promo: (s) => `<table width="600"><tr><td><h1>${s}</h1></td></tr><tr><td><a href="{{cta_url}}">Shop now</a></td></tr></table>`,
    transactional: (s) => `<table width="600"><tr><td><h2>${s}</h2><p>Details</p></td></tr></table>`,
  };
  tool("apply_email_template", "Template & Layout Export: apply a pre-built email template.", { campaignId: z.string(), emailId: z.string(), template: z.enum(["newsletter", "promo", "transactional"]) },
    ({ campaignId, emailId, template }) => {
      const e = email(store.campaign(campaignId), emailId);
      e.history.push({ subject: e.subject, html: e.html }); e.redo = []; e.template = template; e.html = EMAIL_TEMPLATES[template](e.subject);
      return { html: e.html };
    });
  tool("export_email_html", "Template & Layout Export: export a finished email as clean standalone HTML.", { campaignId: z.string(), emailId: z.string() }, ({ campaignId, emailId }) => {
    const e = email(store.campaign(campaignId), emailId);
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${esc(e.subject)}</title></head>\n<body>\n${e.html}\n</body></html>`;
  });

  // ---------- Validation & Governance ----------
  const issues = (c) => {
    const out = [];
    const tps = touchpoints(c);
    if (!tps.length) out.push("Journey has no touchpoints");
    if (!c.audienceId) out.push("No audience selected");
    for (const s of tps) {
      if (!s.channel) out.push(`Step ${s.id} has no channel`);
      if (s.channel === "email") {
        const e = c.emails.get(s.emailId);
        if (!e?.subject?.trim()) out.push(`Email ${s.emailId}: missing subject`);
        if (!e || !e.html.replace(/<[^>]+>/g, "").trim()) out.push(`Email ${s.emailId} ("${s.name}"): body is empty`);
      }
    }
    if (tps.some((s) => s.channel === "email")) {
      if (!c.senderId) out.push("No verified sender selected for email channel");
      else if (!store.domains.get(c.senderId)?.verified) out.push("Selected sender domain is not verified");
    }
    return out;
  };
  tool("check_workflow_completion", "Workflow Completion Checks: list blockers preventing launch (steps, emails, channels, audience, sender).", { campaignId: z.string() },
    ({ campaignId }) => { const i = issues(store.campaign(campaignId)); return { canLaunch: !i.length, blockers: i }; });

  tool("list_audiences", "List ingested audiences.", {}, () => [...store.audiences.values()]);
  tool("validate_audience", "Audience Validation: inspect/verify the campaign audience, or swap it by passing audienceId.", { campaignId: z.string(), audienceId: z.string().optional() },
    ({ campaignId, audienceId }) => {
      const c = store.campaign(campaignId);
      if (c.status === "launched" && audienceId) throw new Error("Cannot swap audience after launch");
      if (audienceId) { if (!store.audiences.has(audienceId)) throw new Error(`Unknown audience '${audienceId}'`); c.audienceId = audienceId; }
      const a = store.audiences.get(c.audienceId);
      if (!a) throw new Error("No audience selected");
      const warnings = [];
      if (a.valid === 0) warnings.push("Audience has no valid recipients");
      if (a.invalid) warnings.push(`${a.invalid} invalid email address(es) will be skipped`);
      if (a.duplicates) warnings.push(`${a.duplicates} duplicate(s) will be suppressed`);
      return { audience: a, valid: a.valid > 0, warnings };
    });

  tool("setup_sender_domain", "Domain & Sender Verification: register a sending domain and sender identity; returns the DNS records to publish (generated at your DNS host).",
    { domain: z.string(), senderEmail: z.string().email(), subdomain: z.string().optional() },
    ({ domain, senderEmail, subdomain }) => {
      const host = subdomain ? `${subdomain}.${domain}` : domain;
      if (!senderEmail.toLowerCase().endsWith(`@${host.toLowerCase()}`)) throw new Error(`Sender must be at @${host}`);
      const d = { id: id("snd"), domain: host, senderEmail, verified: false, records: [
        { type: "TXT", name: host, purpose: "SPF", expected: "v=spf1 include:_spf.example.net ~all" },
        { type: "CNAME", name: `selector1._domainkey.${host}`, purpose: "DKIM", expected: "selector1.dkim.example.net" },
        { type: "TXT", name: `_dmarc.${host}`, purpose: "DMARC", expected: "v=DMARC1; p=none" },
      ] };
      store.domains.set(d.id, d);
      return d;
    });
  tool("verify_sender_domain", "Domain & Sender Verification: verify DNS records. Pass the records observed at your DNS host.", { senderId: z.string(), observed: z.array(z.object({ name: z.string(), value: z.string() })) },
    ({ senderId, observed }) => {
      const d = store.domains.get(senderId);
      if (!d) throw new Error(`Unknown sender '${senderId}'`);
      const results = d.records.map((r) => ({ purpose: r.purpose, name: r.name, pass: observed.some((o) => o.name.toLowerCase() === r.name.toLowerCase() && o.value.includes(r.expected.split(" ")[0])) }));
      d.verified = results.every((r) => r.pass);
      return { senderId, verified: d.verified, results };
    });
  tool("select_sender", "Attach a sender identity to a campaign.", { campaignId: z.string(), senderId: z.string() }, ({ campaignId, senderId }) => {
    if (!store.domains.has(senderId)) throw new Error(`Unknown sender '${senderId}'`);
    store.campaign(campaignId).senderId = senderId; return { campaignId, senderId };
  });

  tool("send_test_email", "Proofing & Test Dispatch: send a test of an email; the From address is auto-populated from the verified sender.",
    { campaignId: z.string(), emailId: z.string(), recipients: z.array(z.string().email()).min(1).max(10) },
    ({ campaignId, emailId, recipients }) => {
      const c = store.campaign(campaignId); const e = email(c, emailId);
      const snd = store.domains.get(c.senderId);
      if (!snd) throw new Error("Select a sender first");
      if (!snd.verified) throw new Error(`Sender domain ${snd.domain} is not verified`);
      const rec = { from: snd.senderEmail, to: recipients, subject: `[TEST] ${e.subject}`, sentAt: new Date().toISOString() };
      c.testsSent.push(rec); return { dispatched: true, ...rec };
    });

  // ---------- Launch & Hand-off ----------
  tool("launch_campaign", "Dedicated Campaign Launch: gated launch; requires all checks to pass and explicit confirmation.", { campaignId: z.string(), confirm: z.boolean() },
    ({ campaignId, confirm }) => {
      const c = store.campaign(campaignId);
      if (c.status === "launched") throw new Error("Campaign already launched");
      const i = issues(c);
      if (i.length) throw new Error(`Launch blocked:\n- ${i.join("\n- ")}`);
      if (!confirm) return { launched: false, message: "All checks passed. Re-call with confirm=true to launch.", recipients: store.audiences.get(c.audienceId).valid };
      c.status = "launched"; c.launchedAt = new Date().toISOString();
      for (const s of touchpoints(c)) c.metrics.set(s.id, null);
      return { launched: true, launchedAt: c.launchedAt };
    });

  const mermaid = (c) => {
    const lines = ["flowchart TD"]; let prev = null;
    c.steps.forEach((s, i) => {
      const n = `n${i}`;
      const label = s.type === "wait" ? `Wait ${s.duration}` : s.type === "branch" ? `Split: ${s.branches.map((b) => `${b.label} ${b.percent}%`).join(" / ")}` : `${s.channel}: ${s.name}`;
      lines.push(`  ${n}["${label.replace(/"/g, "'")}"]`);
      if (prev) lines.push(`  ${prev} --> ${n}`);
      prev = n;
    });
    return lines.join("\n");
  };
  tool("export_campaign_doc", "Cross-Functional Exporting: export campaign documentation (PDF/Word) embedding the live journey diagram. Returns the document source (Markdown + Mermaid diagram) and target format hints; binary rendering is left to the caller.",
    { campaignId: z.string(), format: z.enum(["pdf", "docx"]) },
    ({ campaignId, format }) => {
      const c = store.campaign(campaignId);
      const aud = store.audiences.get(c.audienceId);
      const md = [`# ${c.name}`, `Status: ${c.status}`, "", "## Objective", c.brief?.goal ?? "n/a", "", "## Plan", ...c.plan.map((p, i) => `${i + 1}. ${p}`), "",
        "## Audience", aud ? `${aud.name} (${aud.valid} valid recipients)` : "n/a", "", "## Journey", "```mermaid", mermaid(c), "```", "",
        "## Touchpoints", ...touchpoints(c).map((s) => `- **${s.name}** (${s.channel})`)].join("\n");
      return { format, filename: `${c.name.replace(/\W+/g, "_")}.${format}`, convertWith: format === "pdf" ? "pandoc / Adobe pdf_create" : "pandoc -t docx", markdown: md };
    });

  // ---------- Measurement & Insights ----------
  tool("record_email_metrics", "Ingest delivery metrics for an email touchpoint (stand-in for the data stream).",
    { campaignId: z.string(), stepId: z.string(), delivered: z.number().int().min(0), opens: z.number().int().min(0), clicks: z.number().int().min(0), bounces: z.number().int().min(0) },
    ({ campaignId, stepId, ...m }) => {
      const c = store.campaign(campaignId);
      if (c.status !== "launched") throw new Error("Campaign not launched");
      if (!c.metrics.has(stepId)) throw new Error(`Step '${stepId}' is not a touchpoint of this campaign`);
      c.metrics.set(stepId, m); return { stepId, ...m };
    });
  const rate = (n, d) => (d ? +((n / d) * 100).toFixed(1) : 0);
  const rows = (c) => touchpoints(c).filter((s) => s.channel === "email").map((s) => {
    const m = c.metrics.get(s.id);
    return m ? { stepId: s.id, name: s.name, ...m, openRate: rate(m.opens, m.delivered), clickRate: rate(m.clicks, m.delivered), bounceRate: rate(m.bounces, m.delivered + m.bounces) }
             : { stepId: s.id, name: s.name, state: "ready" };
  });
  tool("get_email_metrics", "Per-Email Metrics Breakdown: open, click, bounce, delivery per email touchpoint (tabular).", { campaignId: z.string() }, ({ campaignId }) => rows(store.campaign(campaignId)));
  tool("get_journey_analytics", "Visual Journey Analytics: journey nodes annotated with performance attribution.", { campaignId: z.string() }, ({ campaignId }) => {
    const c = store.campaign(campaignId); const byStep = new Map(rows(c).map((r) => [r.stepId, r]));
    return { campaignId, nodes: c.steps.map((s) => ({ ...s, performance: byStep.get(s.id) ?? null })) };
  });
  tool("get_post_launch_status", "Post-Launch Status Tracking: persistent ready/empty state until data streams in.", { campaignId: z.string() }, ({ campaignId }) => {
    const c = store.campaign(campaignId);
    if (c.status !== "launched") return { state: "not_launched" };
    const has = [...c.metrics.values()].some(Boolean);
    return { state: has ? "reporting" : "ready_awaiting_data", launchedAt: c.launchedAt, message: has ? "Metrics available" : "Campaign deployed. Data will appear as events stream in." };
  });

  // ---------- Native MarOps setup catalog ----------
  tool("list_native_setup_requirements", "List capabilities that must be configured in native Adobe consoles (not in Coworker), optionally filtered by category or text.",
    { category: z.string().optional(), query: z.string().optional() },
    ({ category, query }) => NATIVE_SETUP.filter((r) => (!category || r.category.toLowerCase().includes(category.toLowerCase())) && (!query || JSON.stringify(r).toLowerCase().includes(query.toLowerCase()))));
  tool("check_native_prerequisites", "Given a Coworker capability need, return the native-console prerequisites you must have set up first.", { need: z.string() }, ({ need }) => {
    const n = need.toLowerCase();
    const map = [["email|send|launch|sender|domain", ["DNS & Deliverability Provisioning", "IP Warmup & Sending Throttling", "Consent & Preference Management"]],
      ["sms|push|whatsapp", ["Push, SMS & WhatsApp Gateway Setup", "Consent & Preference Management"]],
      ["audience|segment|csv", ["XDM Schema & Data Modeling", "Identity Resolution & Merge Policies", "Complex Multi-Entity Segmentation"]],
      ["report|metric|analytic|attribution", ["Full Attribution & Customer Journey Analytics", "Real-Time Data Streams & Edge Ingestion"]],
      ["proof|review|sign", ["Formal Creative Proofing & Sign-off"]]];
    const names = new Set(map.filter(([re]) => new RegExp(re).test(n)).flatMap(([, v]) => v));
    return { need, prerequisites: NATIVE_SETUP.filter((r) => names.has(r.capability)) };
  });

  const session = { identity: identity ?? platform.auth.identityFor(process.env.MCP_USER ?? "morgan.ops") };
  registerAgents(server, platform, session);

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await createServer().connect(new StdioServerTransport());
}
