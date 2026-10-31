import { z } from "zod";
import { Agent } from "../agents/base.js";
import { fromResponse } from "./errors.js";

const AJO_TEMPLATES_URL = "https://platform.adobe.io/ajo/content/templates";

/**
 * Live Adobe Journey Optimizer via its REST API (Content Templates). Adobe has no AJO MCP endpoint, so this
 * service calls the API directly. The acting principal (user or technical account) is chosen by the token broker per auth policy.
 */
export class AjoRestAgent extends Agent {
  constructor({ fetchImpl = fetch } = {}) {
    super({ key: "ajo", name: "Adobe Journey Optimizer (live REST)", product: "Adobe Journey Optimizer", description: "Live AJO content templates via the AJO REST API", keywords: ["ajo", "journey", "email template"], tools: {
      list_email_templates: {
        description: "List the email templates that exist in Adobe Journey Optimizer (id, name, description, labels, created/modified). Read-only.",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: {
          sandboxName: { type: "string", description: "AJO sandbox; must be allowed by server policy (default from server config)" },
          limit: { type: "integer", description: "Page size, 1-100 (default 20)" },
          start: { type: "integer", description: "Offset for paging (default 0)" },
          name: { type: "string", description: "Only templates whose name contains this text" },
        } },
      },
    } });
    Object.assign(this, { fetchImpl, live: true, readOnly: true, url: AJO_TEMPLATES_URL, status: { connected: true, tools: 1, error: null, auth: "ajo-rest" } });
    this.schema = z.object({ sandboxName: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), start: z.number().int().min(0).optional(), name: z.string().optional() });
  }
  async call(tool, args = {}, identity, authCtx) {
    if (tool !== "list_email_templates") throw new Error(`Live service 'ajo' has no tool '${tool}'.`);
    if (!authCtx?.provider) throw new Error("AJO needs an auth context from the token broker.");
    const a = this.schema.parse(args);
    const q = new URLSearchParams({ orderBy: "-modifiedAt", limit: String(a.limit ?? 20), start: String(a.start ?? 0) });
    const res = await this.fetchImpl(`${AJO_TEMPLATES_URL}?${q}`, { headers: {
      authorization: `${"Bearer"} ${await authCtx.provider.getToken()}`, ...authCtx.headers,
      "x-sandbox-name": authCtx.sandbox ?? "prod", accept: "application/vnd.adobe.ajo.template-list.v1+json",
    } });
    if (!res.ok) throw await fromResponse(res, `AJO templates API (as ${authCtx.mode} ${authCtx.principal.type})`);
    const body = await res.json().catch(() => { throw new Error("AJO templates API returned non-JSON"); });
    const items = (body.items ?? []).filter((t) => (!t.templateType || t.templateType === "html") && (!a.name || String(t.name ?? "").toLowerCase().includes(a.name.toLowerCase())));
    this.log.push({ tool, at: new Date().toISOString() });
    return { calledAs: authCtx.mode, total: body.page?.count ?? body.totalCount ?? items.length, returned: items.length,
      templates: items.map((t) => ({ id: t.id, name: t.name, description: t.description, labels: t.labels, templateType: t.templateType, channels: t.channels, createdAt: t.createdAt, modifiedAt: t.modifiedAt, createdBy: t.createdBy, modifiedBy: t.modifiedBy })) };
  }
}
