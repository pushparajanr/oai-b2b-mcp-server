// Adobe-hosted MCP endpoints. Each becomes a gateway service keyed by `key` when credentials are configured.
export const UPSTREAMS = {
  cdp: { label: "CDP (RT-CDP)", url: "https://rtcdp-mcp.adobe.io/mcp", readOnly: true, note: "Audiences, destinations, sources, flows (beta; read-only)", keywords: ["rt-cdp", "destination", "flow", "source connector"] },
  aem: { label: "AEM (unified)", url: "https://mcp.adobeaemcloud.com/adobe/mcp/aem", note: "Content, assets, launches, brand/compliance checks", keywords: ["aem content", "launch", "aem live"] },
  cloud_manager: { label: "AEM Cloud Manager", url: "https://mcp.adobeaemcloud.com/adobe/mcp/cloudmanager", note: "Programs, environments, pipelines", keywords: ["cloud manager", "pipeline", "environment", "deploy"] },
  marketo_mcp: { label: "Marketo Engage (MCP)", url: "https://marketo-mcp.adobe.io/mcp", note: "Forms, smart campaigns, leads, programs, emails", keywords: ["smart campaign", "marketo form"] },
  workfront_mcp: { label: "Adobe Workfront (MCP)", url: "https://mcp.workfront.adobe.com/mcp/v1/workfront", note: "Work, projects, planning, approvals", keywords: ["workfront planning"] },
  marketing_agent: { label: "Adobe Marketing Agent", url: "https://aep-ai-ama.adobe.io/mcp", note: "Audience analysis, AEP diagnostics, AJO B2B orchestration", keywords: ["aep diagnostics", "b2b orchestration", "audience analysis"] },
  brand_intelligence: { label: "Brand Intelligence Validate", url: "https://abi-mcp.adobe.io/mcp", note: "Brand/compliance validation", keywords: ["brand validation", "compliance validation"] },
  genstudio: { label: "GenStudio for Performance Marketing", url: "https://genstudio-services.adobe.io/mcp", note: "Ad performance, creative insights", keywords: ["genstudio", "ad performance", "creative insights"] },
  coworker: { label: "CX Enterprise Coworker Gateway", url: "https://cx-coworker-gateway.adobe.io/mcp", note: "Single endpoint surfacing entitled product tools", keywords: ["coworker gateway"] },
};

// Gateway RBAC/entitlement keys that govern each live service (a role needs access to any one of them).
export const ACCESS_ALIAS = {
  cdp: "aep", aem: ["aem_assets", "aem_sites"], marketo_mcp: "marketo", workfront_mcp: "workfront",
  marketing_agent: ["ajo", "aep"], brand_intelligence: "brand_concierge", genstudio: "cja",
};
