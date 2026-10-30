// Personas from layer 1 mapped to gateway roles. access: 'r' = read tools, 'rw' = read + write tools.
export const ROLES = {
  campaign_manager: { label: "Campaign Manager", pii: false, access: { aep: "rw", ajo: "rw", workfront: "rw", aem_sites: "r", aem_assets: "rw", brand_concierge: "r", fusion: "rw", marketo: "rw", cja: "r" } },
  creative_team: { label: "Creative Team", pii: false, access: { aem_assets: "rw", aem_sites: "rw", brand_concierge: "r", workfront: "r", ajo: "r" } },
  brand_manager: { label: "Brand Manager", pii: false, access: { brand_concierge: "rw", aem_assets: "r", aem_sites: "r", workfront: "rw" } },
  data_manager: { label: "Data / Audience Manager", pii: true, access: { aep: "rw", ajo: "r", cja: "r", marketo: "r" } },
  marketing_ops: { label: "Marketing Operations", pii: true, access: { aep: "rw", ajo: "rw", workfront: "rw", aem_sites: "rw", aem_assets: "rw", brand_concierge: "rw", fusion: "rw", marketo: "rw", cja: "rw" } },
  leadership: { label: "Leadership", pii: false, access: { cja: "r", workfront: "r", ajo: "r", aep: "r" } },
};

// Demo directory standing in for Microsoft Entra ID groups -> roles.
export const USERS = {
  "casey.cm": { name: "Casey", role: "campaign_manager", tenant: "acme" },
  "riley.creative": { name: "Riley", role: "creative_team", tenant: "acme" },
  "bailey.brand": { name: "Bailey", role: "brand_manager", tenant: "acme" },
  "dana.data": { name: "Dana", role: "data_manager", tenant: "acme" },
  "morgan.ops": { name: "Morgan", role: "marketing_ops", tenant: "acme" },
  "lee.leader": { name: "Lee", role: "leadership", tenant: "acme" },
  "sam.other": { name: "Sam (other org)", role: "marketing_ops", tenant: "globex" },
};

const ALL = ["aep", "ajo", "workfront", "aem_sites", "aem_assets", "brand_concierge", "fusion", "marketo", "cja"];
export const TENANTS = {
  acme: { entitlements: ALL, quota: { cost: 5000 } },
  globex: { entitlements: ["workfront", "aem_assets"], quota: { cost: 100 } },
};

// Per-service route (diagram layer 5 footer: MCP vs API).
export const SERVICE_ROUTES = {
  aep: "mcp", aem_assets: "mcp", aem_sites: "mcp", workfront: "mcp", cja: "mcp",
  ajo: "api", marketo: "api", fusion: "api", brand_concierge: "api",
};
