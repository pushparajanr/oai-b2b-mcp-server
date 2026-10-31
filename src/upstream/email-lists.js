import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Agent } from "../agents/base.js";
import { traced } from "../log.js";

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const MAX_ROWS = 10_000;
const id = (p) => `${p}_${randomUUID().slice(0, 8)}`;

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((v) => v.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

/** Turn CSV text (header row required unless it is a single column of emails) into row objects. */
function csvToRows(csv) {
  const t = parseCsv(csv.replace(/^\uFEFF/, ""));
  if (!t.length) return [];
  const headerLike = t[0].some((h) => /[a-z]/i.test(h) && !EMAIL.test(h.trim()));
  const header = headerLike ? t.shift().map((h) => h.trim().replace(/\s+/g, "_").replace(/^e-?mail(_address)?$/i, "email")) : ["email"];
  return t.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()]).filter(([h]) => h)));
}

/**
 * Per-user email lists held by this server (JSON file persistence). Users can upload a list (CSV text or JSON rows),
 * view it, and edit a single row. Lists are private to the signed-in user.
 */
export class EmailListAgent extends Agent {
  constructor({ file = process.env.EMAIL_LISTS_FILE ?? "./data/email-lists.json", now = () => new Date().toISOString() } = {}) {
    const ref = { listId: { type: "string", description: "List id from email_lists_list_email_lists" } };
    super({ key: "email_lists", name: "Email Lists", product: "Email Lists", description: "Upload, view and edit email lists", keywords: ["email list", "upload list", "recipients"], tools: {
      upload_email_list: {
        description: "Upload an email list. Provide `csv` text (header row such as email,firstName,lastName,company) or `rows` (array of objects with an `email`). Invalid and duplicate emails are skipped and reported. Creates a new list.",
        annotations: { readOnlyHint: false },
        inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "List name" }, csv: { type: "string", description: "CSV text" }, rows: { type: "array", items: { type: "object" }, description: "Rows as objects" } } },
      },
      list_email_lists: { description: "List the email lists you have uploaded (id, name, row count, updated).", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
      view_email_list: {
        description: "View the rows of an uploaded email list, optionally filtered by text.", annotations: { readOnlyHint: true },
        inputSchema: { type: "object", required: ["listId"], properties: { ...ref, limit: { type: "integer", description: "Page size 1-500 (default 50)" }, offset: { type: "integer", description: "Offset (default 0)" }, search: { type: "string", description: "Only rows containing this text" } } },
      },
      edit_email_list_row: {
        description: "Edit one row of an uploaded list. Identify the row by `rowId` (or its current `email`) and pass the fields to change in `fields` (set a field to null to clear it). Changing the email must keep it valid and unique.",
        annotations: { readOnlyHint: false },
        inputSchema: { type: "object", required: ["listId", "fields"], properties: { ...ref, rowId: { type: "string" }, email: { type: "string", description: "Current email of the row (alternative to rowId)" }, fields: { type: "object", description: "Field values to set" } } },
      },
    } });
    Object.assign(this, { file, nowIso: now, selfAuth: true, live: true, readOnly: false, url: "local:email-lists", status: { connected: true, tools: 4, error: null, auth: "none (server-side store)" } });
    this.lists = this.#load();
  }
  #load() { try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {}; } catch { return {}; } }
  #save() { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(this.lists)); }
  #mine(identity) { return (this.lists[identity?.userId ?? "anonymous"] ??= {}); }
  #list(identity, listId) { const mine = this.#mine(identity); const l = Object.hasOwn(mine, listId) ? mine[listId] : null; if (!l) throw new Error(`Unknown email list '${listId}'.`); return l; }

  call(tool, args = {}, identity) {
    return traced("upstream.call", { agent: this.key, tool, api: "email-lists", user: identity?.userId }, async () => {
      const r = this[`_${tool}`]?.(args, identity);
      if (r === undefined) throw new Error(`Live service 'email_lists' has no tool '${tool}'.`);
      this.log.push({ tool, at: this.nowIso() });
      return r;
    });
  }
  /** CSV of one of the caller's lists (rowId excluded) for handing to another service, e.g. Marketo bulk import. */
  exportCsv(identity, listId) {
    const l = this.#list(identity, listId);
    const cols = [...new Set(l.rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== "rowId");
    const q = (v) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    return [cols.map(q).join(","), ...l.rows.map((r) => cols.map((c) => q(String(r[c] ?? ""))).join(","))].join("\n");
  }
  _upload_email_list(args, identity) {
    const a = z.object({ name: z.string().trim().min(1).max(120), csv: z.string().optional(), rows: z.array(z.record(z.any())).optional() }).parse(args);
    if (!a.csv && !a.rows) throw new Error("Provide `csv` or `rows`.");
    const input = a.rows ?? csvToRows(a.csv);
    if (input.length > MAX_ROWS) throw new Error(`List too large (${input.length} rows; max ${MAX_ROWS}).`);
    const seen = new Set(), rows = [], skipped = [];
    input.forEach((r, i) => {
      const email = String(r.email ?? "").trim().toLowerCase();
      if (!EMAIL.test(email)) return skipped.push({ row: i + 1, reason: "invalid email", value: String(r.email ?? "") });
      if (seen.has(email)) return skipped.push({ row: i + 1, reason: "duplicate", value: email });
      seen.add(email);
      rows.push({ rowId: id("r"), ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? "" : String(v)])), email });
    });
    if (!rows.length) throw new Error(`No valid email rows found (${skipped.length} skipped).`);
    const listId = id("list"), at = this.nowIso();
    this.#mine(identity)[listId] = { listId, name: a.name, createdAt: at, updatedAt: at, rows };
    this.#save();
    return { listId, name: a.name, uploaded: rows.length, skipped: skipped.length, skippedDetails: skipped.slice(0, 50) };
  }
  _list_email_lists(_a, identity) {
    return { lists: Object.values(this.#mine(identity)).map((l) => ({ listId: l.listId, name: l.name, rows: l.rows.length, createdAt: l.createdAt, updatedAt: l.updatedAt })) };
  }
  _view_email_list(args, identity) {
    const a = z.object({ listId: z.string(), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional(), search: z.string().optional() }).parse(args);
    const l = this.#list(identity, a.listId), q = a.search?.toLowerCase();
    const match = q ? l.rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(q))) : l.rows;
    const off = a.offset ?? 0, lim = a.limit ?? 50;
    return { listId: l.listId, name: l.name, total: match.length, offset: off, returned: Math.min(lim, Math.max(0, match.length - off)), rows: match.slice(off, off + lim) };
  }
  _edit_email_list_row(args, identity) {
    const a = z.object({ listId: z.string(), rowId: z.string().optional(), email: z.string().optional(), fields: z.record(z.any()) }).parse(args);
    if (!a.rowId && !a.email) throw new Error("Provide `rowId` or `email` to identify the row.");
    const l = this.#list(identity, a.listId);
    const row = l.rows.find((r) => (a.rowId ? r.rowId === a.rowId : r.email === a.email.trim().toLowerCase()));
    if (!row) throw new Error("Row not found in that list.");
    const { rowId: _ignored, ...fields } = a.fields;
    if (!Object.keys(fields).length) throw new Error("`fields` has nothing to change.");
    const next = { ...row };
    for (const [k, v] of Object.entries(fields)) { if (v === null) delete next[k]; else next[k] = String(v); }
    next.email = String(next.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(next.email)) throw new Error(`'${next.email}' is not a valid email address.`);
    if (l.rows.some((r) => r !== row && r.email === next.email)) throw new Error(`Another row already uses ${next.email}.`);
    const before = { ...row };
    Object.keys(row).forEach((k) => delete row[k]); Object.assign(row, next);
    l.updatedAt = this.nowIso(); this.#save();
    return { listId: l.listId, before, after: row };
  }
}
