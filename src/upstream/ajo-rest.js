import { z } from "zod";
import { Agent } from "../agents/base.js";

const AJO_TEMPLATES_URL = "https://platform.adobe.io/ajo/content/templates";

/**
 * Live Adobe Journey Optimizer via its REST API (Content Templates). Adobe has no AJO MCP endpoint, so this
 * service calls the API directly: as the signed-in user when they have a personal Adobe token, otherwise with the shared IMS credential.
 */
export class AjoRestAgent extends Agent {
  constructor({ env = process.env, ims = null, userAuth = null, fetchImpl = fetch } = {}) {
    super({ key: "ajo", name: "Adobe Journey Optimizer (live REST)", product: "Adobe Journey Optimizer", description: "Live AJO content templates via the AJO REST API", keywords: ["ajo", "journey", "email template"], tools: {
      list_email_templates: {
        description: "List the email templates that exist in Adobe Journey Optimizer (id, name, description, labels, created/modified). Read-only.",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: {
          sandboxName: { type: "string", description: "AJO sandbox (default from ADOBE_SANDBOX_NAME, else prod)" },
          limit: { type: "integer", description: "Page size, 1-100 (default 20)" },
          start: { type: "integer", description: "Offset for paging (default 0)" },
          name: { type: "string", description: "Only templates whose name contains this text" },
        } },
      },
    } });
    Object.assign(this, { env, ims, userAuth, fetchImpl, live: true, readOnly: true, url: AJO_TEMPLATES_URL, status: { connected: true, tools: 1, error: null, auth: "ajo-rest" } });
    this.schema = z.object({ sandboxName: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), start: z.number().int().min(0).optional(), name: z.string().optional() });
  }
  async #credentials(identity) {
    if (this.userAuth && identity?.userId && this.userAuth.has(identity.userId)) {
      return { token: await this.userAuth.provider(identity.userId).getToken(), apiKey: this.userAuth.clientId, as: "user" };
    }
    if (this.ims) return { token: await this.ims.getToken(), apiKey: this.env.ADOBE_API_KEY ?? this.env.ADOBE_CLIENT_ID, as: "shared" };
    throw new Error("No Adobe credentials available for AJO.");
  }
  async call(tool, args = {}, identity) {
    if (tool !== "list_email_templates") throw new Error(`Live service 'ajo' has no tool '${tool}'.`);
    const a = this.schema.parse(args);
    const { token, apiKey, as } = await this.#credentials(identity);
    const org = this.env.ADOBE_ORG_ID;
    const q = new URLSearchParams({ orderBy: "-modifiedAt", limit: String(a.limit ?? 20), start: String(a.start ?? 0) });
    const res = await this.fetchImpl(`${AJO_TEMPLATES_URL}?${q}`, { headers: {
      authorization: `${"Bearer"} ${token}`, "x-api-key": apiKey, ...(org && { "x-gw-ims-org-id": org }),
      "x-sandbox-name": a.sandboxName ?? this.env.ADOBE_SANDBOX_NAME ?? "prod", accept: "application/vnd.adobe.ajo.template-list.v1+json",
    } });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`AJO templates API returned HTTP ${res.status} (as ${as} credential): ${text.slice(0, 400)}`), { code: "upstream_error" });
    let body; try { body = JSON.parse(text); } catch { throw new Error("AJO templates API returned non-JSON"); }
    const items = (body.items ?? []).filter((t) => (!t.templateType || t.templateType === "html") && (!a.name || String(t.name ?? "").toLowerCase().includes(a.name.toLowerCase())));
    this.log.push({ tool, at: new Date().toISOString() });
    return { calledAs: as, total: body.page?.count ?? body.totalCount ?? items.length, returned: items.length,
      templates: items.map((t) => ({ id: t.id, name: t.name, description: t.description, labels: t.labels, templateType: t.templateType, channels: t.channels, createdAt: t.createdAt, modifiedAt: t.modifiedAt, createdBy: t.createdBy, modifiedBy: t.modifiedBy })) };
  }
}
