import { z } from "zod";
import { Agent } from "../agents/base.js";
import { traced, loggedFetch } from "../log.js";

const page = { limit: { type: "integer", description: "Page size, 1-200 (default 20)" }, offset: { type: "integer", description: "Offset for paging (default 0)" } };
const pageSchema = { limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() };
const ASSETS = {
  list_programs: { path: "/asset/v1/programs.json", description: "List Marketo programs (id, name, channel, status, workspace)." },
  list_emails: { path: "/asset/v1/emails.json", description: "List Marketo email assets (id, name, status, folder)." },
  list_smart_campaigns: { path: "/asset/v1/smartCampaigns.json", description: "List Marketo smart campaigns (id, name, active, status)." },
  list_forms: { path: "/asset/v1/forms.json", description: "List Marketo forms (id, name, status)." },
  list_static_lists: { path: "/v1/lists.json", description: "List Marketo static lists (id, name, workspace)." },
};

/**
 * Live Marketo Engage via its REST API (reads plus lead CSV import, static-list creation and list membership writes),
 * authenticated with the Marketo-specific MARKETO_CLIENT_ID / MARKETO_CLIENT_SECRET.
 * These credentials are independent of Adobe IMS, so the agent works the same in service and delegated (coworker) flows.
 */
export class MarketoRestAgent extends Agent {
  constructor({ env = process.env, fetchImpl = loggedFetch(fetch, "marketo"), now = Date.now, emailLists = null } = {}) {
    const tools = {
      get_leads_by_email: {
        description: "Look up Marketo leads by email address. Read-only.", annotations: { readOnlyHint: true },
        inputSchema: { type: "object", required: ["emails"], properties: { emails: { type: "array", items: { type: "string" }, description: "Up to 300 email addresses" }, fields: { type: "array", items: { type: "string" }, description: "Lead fields to return (default: id, email, name, score fields)" } } },
      },
      ...Object.fromEntries(Object.entries(ASSETS).map(([k, v]) => [k, { description: `${v.description} Read-only.`, annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: page } }])),
      import_leads_csv: {
        description: "Bulk-import leads into Marketo from CSV (creates or updates leads matched on email; optionally adds them to a static list). Provide `csv` text (header row incl. email) OR `emailListId` of a list uploaded with email_lists_upload_email_list. Asynchronous: returns a batchId; check it with import_leads_status. WRITES to Marketo.",
        annotations: { readOnlyHint: false },
        inputSchema: { type: "object", properties: { csv: { type: "string", description: "CSV text with a header row" }, emailListId: { type: "string", description: "Uploaded email list id to import instead of csv" }, listId: { type: "integer", description: "Marketo static list id to add the imported leads to" }, lookupField: { type: "string", description: "Dedupe field (default email)" }, partitionName: { type: "string" } } },
      },
      import_leads_status: {
        description: "Status of a Marketo bulk lead import batch, with row counts and (when present) failure and warning details. Read-only.", annotations: { readOnlyHint: true },
        inputSchema: { type: "object", required: ["batchId"], properties: { batchId: { type: "integer" } } },
      },
      create_static_list: {
        description: "Create a Marketo static list inside a folder or program. WRITES to Marketo.", annotations: { readOnlyHint: false },
        inputSchema: { type: "object", required: ["name", "folderId"], properties: { name: { type: "string" }, folderId: { type: "integer", description: "Id of the parent folder or program" }, folderType: { type: "string", enum: ["Folder", "Program"], description: "Default Folder" }, description: { type: "string" } } },
      },
      update_list_membership: {
        description: "Add leads to, or remove leads from, a Marketo static list. Identify leads by `leadIds` and/or `emails` (emails are resolved to ids; unknown emails are reported, not created). Up to 300 per request chunk, any total up to 1000. WRITES to Marketo.", annotations: { readOnlyHint: false },
        inputSchema: { type: "object", required: ["listId", "action"], properties: { listId: { type: "integer" }, action: { type: "string", enum: ["add", "remove"] }, leadIds: { type: "array", items: { type: "integer" } }, emails: { type: "array", items: { type: "string" } } } },
      },
    };
    super({ key: "marketo_rest", name: "Marketo Engage (live REST)", product: "Adobe Marketo Engage", description: "Live Marketo REST API", keywords: ["marketo", "lead", "smart campaign"], tools });
    const base = (env.MARKETO_BASE_URL ?? "").replace(/\/+$/, "");
    Object.assign(this, { fetchImpl, now, env, emailLists, selfAuth: true, principal: { type: "technical_account", id: `marketo:${env.MARKETO_CLIENT_ID ?? "unconfigured"}` }, live: true, readOnly: false, base, url: base, token: null, status: { connected: true, tools: Object.keys(tools).length, error: null, auth: "marketo-rest" } });
  }
  static configured(env = process.env) { return !!(env.MARKETO_BASE_URL && env.MARKETO_CLIENT_ID && env.MARKETO_CLIENT_SECRET); }

  async #token(force = false) {
    if (!force && this.token && this.token.exp > this.now() + 30_000) return this.token.value;
    const res = await this.fetchImpl(`${this.base.replace(/\/rest$/, "")}/identity/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.env.MARKETO_CLIENT_ID, client_secret: this.env.MARKETO_CLIENT_SECRET }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new Error(`Marketo token request failed (HTTP ${res.status}): ${body.error_description ?? body.error ?? "no access_token"}`);
    this.token = { value: body.access_token, exp: this.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
  /** Authenticated Marketo call with one retry on an expired token (601/602). `host` paths (/bulk/...) live beside /rest. */
  async #api(method, path, { query, json, form, multipart, raw = false } = {}) {
    const root = path.startsWith("/bulk/") ? this.base.replace(/\/rest$/, "") : this.base;
    const url = `${root}${path}${query ? `?${query}` : ""}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { authorization: `${"Bearer"} ${await this.#token(attempt > 0)}`, accept: raw ? "text/csv, application/json" : "application/json" };
      let body;
      if (json) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
      else if (form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form); }
      else if (multipart) body = multipart;
      const res = await this.fetchImpl(url, { method, headers, body });
      if (raw && res.ok) return { text: await res.text() };
      const parsed = await res.json().catch(() => { throw new Error(`Marketo API returned non-JSON (HTTP ${res.status})`); });
      const expired = (parsed.errors ?? []).some((e) => ["601", "602"].includes(String(e.code)));
      if (expired && attempt === 0) continue;
      if (!res.ok || parsed.success === false) throw new Error(`Marketo API error: ${(parsed.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`}`);
      return parsed;
    }
  }
  #get(path, query) { return this.#api("GET", path, { query }); }

  async #leadIds({ leadIds = [], emails = [] }) {
    const ids = new Set(leadIds), notFound = [];
    const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    for (let i = 0; i < wanted.length; i += 300) {
      const chunk = wanted.slice(i, i + 300);
      const body = await this.#get("/v1/leads.json", new URLSearchParams({ filterType: "email", filterValues: chunk.join(","), fields: "email" }));
      const found = new Map((body.result ?? []).map((l) => [String(l.email).toLowerCase(), l.id]));
      for (const e of chunk) found.has(e) ? ids.add(found.get(e)) : notFound.push(e);
    }
    return { ids: [...ids], notFound };
  }

  call(tool, args = {}, identity, authCtx) {
    return traced("upstream.call", { agent: this.key, tool, api: "marketo-rest", args: tool === "import_leads_csv" ? { ...args, csv: args.csv && `[${args.csv.length} chars]` } : args }, () => this.#call(tool, args, identity));
  }
  async #call(tool, args, identity) {
    let body;
    if (tool === "import_leads_csv") return this.#importCsv(args, identity);
    if (tool === "import_leads_status") return this.#importStatus(args);
    if (tool === "create_static_list") {
      const a = z.object({ name: z.string().trim().min(1).max(255), folderId: z.number().int(), folderType: z.enum(["Folder", "Program"]).default("Folder"), description: z.string().max(2000).optional() }).parse(args);
      body = await this.#api("POST", "/asset/v1/staticLists.json", { form: { name: a.name, folder: JSON.stringify({ id: a.folderId, type: a.folderType }), ...(a.description && { description: a.description }) } });
    } else if (tool === "update_list_membership") {
      const a = z.object({ listId: z.number().int(), action: z.enum(["add", "remove"]), leadIds: z.array(z.number().int()).optional(), emails: z.array(z.string()).optional() }).parse(args);
      const { ids, notFound } = await this.#leadIds(a);
      if (!ids.length) throw new Error(`No leads to ${a.action}${notFound.length ? ` (emails not found in Marketo: ${notFound.slice(0, 10).join(", ")})` : ""}.`);
      if (ids.length > 1000) throw new Error(`Too many leads (${ids.length}); max 1000 per call.`);
      const result = [];
      for (let i = 0; i < ids.length; i += 300) {
        const r = await this.#api(a.action === "add" ? "POST" : "DELETE", `/v1/lists/${a.listId}/leads.json`, { json: { input: ids.slice(i, i + 300).map((id) => ({ id })) } });
        result.push(...(r.result ?? []));
      }
      this.log.push({ tool, at: new Date().toISOString() });
      return { calledAs: "marketo-api-credential", listId: a.listId, action: a.action, requested: ids.length, emailsNotFound: notFound, result };
    } else if (tool === "get_leads_by_email") {
      const a = z.object({ emails: z.array(z.string()).min(1).max(300), fields: z.array(z.string()).optional() }).parse(args);
      const q = new URLSearchParams({ filterType: "email", filterValues: a.emails.join(",") });
      if (a.fields?.length) q.set("fields", a.fields.join(","));
      body = await this.#get("/v1/leads.json", q);
    } else if (ASSETS[tool]) {
      const a = z.object(pageSchema).parse(args);
      body = await this.#get(ASSETS[tool].path, new URLSearchParams({ maxReturn: String(a.limit ?? 20), offset: String(a.offset ?? 0) }));
    } else throw new Error(`Live service 'marketo_rest' has no tool '${tool}'.`);
    this.log.push({ tool, at: new Date().toISOString() });
    return { calledAs: "marketo-api-credential", returned: (body.result ?? []).length, moreResult: body.moreResult ?? false, result: body.result ?? [] };
  }

  async #importCsv(args, identity) {
    const a = z.object({ csv: z.string().optional(), emailListId: z.string().optional(), listId: z.number().int().optional(), lookupField: z.string().default("email"), partitionName: z.string().optional() }).parse(args);
    let csv = a.csv;
    if (!csv && a.emailListId) {
      if (!this.emailLists) throw new Error("Email lists are not available on this server.");
      csv = this.emailLists.exportCsv(identity, a.emailListId);
    }
    if (!csv?.trim()) throw new Error("Provide `csv` or `emailListId`.");
    const header = csv.split(/\r?\n/, 1)[0].toLowerCase();
    if (!header.split(",").map((h) => h.trim().replace(/^"|"$/g, "")).includes(a.lookupField.toLowerCase())) throw new Error(`The CSV header must include the '${a.lookupField}' column.`);
    if (Buffer.byteLength(csv) > 10 * 1024 * 1024) throw new Error("CSV exceeds the 10 MB Marketo bulk import limit.");
    const fd = new FormData();
    fd.set("format", "csv"); fd.set("lookupField", a.lookupField);
    if (a.listId) fd.set("listId", String(a.listId));
    if (a.partitionName) fd.set("partitionName", a.partitionName);
    fd.set("file", new Blob([csv], { type: "text/csv" }), "import.csv");
    const r = await this.#api("POST", "/bulk/v1/leads.json", { multipart: fd });
    const b = r.result?.[0] ?? {};
    this.log.push({ tool: "import_leads_csv", at: new Date().toISOString() });
    return { calledAs: "marketo-api-credential", batchId: b.batchId, status: b.status, importId: b.importId, rows: csv.split(/\r?\n/).filter((l) => l.trim()).length - 1, addedToListId: a.listId ?? null, next: "Call import_leads_status with this batchId." };
  }
  async #importStatus(args) {
    const { batchId } = z.object({ batchId: z.number().int() }).parse(args);
    const r = await this.#get(`/bulk/v1/leads/batch/${batchId}.json`);
    const b = r.result?.[0] ?? {};
    const out = { calledAs: "marketo-api-credential", batchId, status: b.status, rowsProcessed: b.numOfLeadsProcessed, rowsFailed: b.numOfRowsFailed, rowsWithWarning: b.numOfRowsWithWarning, message: b.message };
    for (const [key, n] of [["failures", b.numOfRowsFailed], ["warnings", b.numOfRowsWithWarning]]) {
      if (n > 0 && ["Complete", "Failed"].includes(b.status)) out[`${key}Csv`] = (await this.#api("GET", `/bulk/v1/leads/batch/${batchId}/${key}.json`, { raw: true })).text.slice(0, 4000);
    }
    return out;
  }
}
