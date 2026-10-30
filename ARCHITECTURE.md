# Architecture → code map

Each layer of the reference diagram and where it lives. Everything runs on in-memory simulated Adobe products.

| Layer | Diagram | Code |
|---|---|---|
| 1 Users / channels | ChatGPT custom app, Web, Teams, Adobe Experience Cloud | `src/http.js`: remote MCP endpoint (`POST /mcp`, bearer auth), `POST /auth/login` (dev SSO stand-in), `POST /events/:source/:type` (webhooks). Personas → roles in `gateway/config.js`. **Not built:** the UIs themselves and Mobile. |
| 2 AI orchestration | Campaign Planner, Audience, Creative, Asset, Approval Coordinator, Activation, Insights agents | `agents/role-agents.js` (tools exposed as `agent_<agent>_<tool>`). The planner builds a gated plan and `coordinate_agents` runs it. Agents act **as the calling user** via the gateway. |
| 3 Application layer | GenUI Forms, Orchestration Service, Business Rules & Policy, Campaign Data, Integration, Notification | `services/forms.js`, `orchestration.js` (state machine), `policy.js`, `campaign-data.js`, `integration.js` (retry + inbound events), `notifications.js` |
| 4 MCP Gateway | Auth broker, Capability registry, Request router, Data transformation, Security & audit | `gateway/auth.js`, `registry.js`, `router.js`, `transform.js`, `security.js`, composed in `gateway.js` |
| 5 Adobe services | RT-CDP, Brand Concierge, AEM/Assets, Workfront, Fusion, AJO, Marketo, CJA | `agents/aep.js`, `brand-concierge.js`, `aem-sites.js`, `aem-assets.js`, `workfront.js`, `fusion.js`, `ajo.js`, `marketo.js`, `cja.js` |
| 6 Data sources | First-party, ingestion, XDM, enterprise, third-party, channels | First-party/batch ingestion = `aep_ingest_records` (with `sourceMapping`). Others are out of scope. |
| Cross-cutting | Policy, consent, brand governance, audit, cost, privacy, responsible AI | see below |

## Gateway behaviour (every product call goes through `Gateway.invoke`)
1. Token → identity (`AuthBroker`, Entra→IMS simulated; per-product tokens cached, never returned).
2. Registry lookup, tenant **entitlement** check, read/write classification.
3. **RBAC** per role and service (`ROLES`), denials audited; 3 denials/5 min raises an alert.
4. **Usage quota** per tenant (read cost 1, write cost 3).
5. Router: MCP vs API transport, per-user/service **rate limit**, **retry** on transient errors, sandbox/org context.
6. Request/response transformation: field mapping, normalized `GatewayError`, response `_meta` (request id, transport, tenant).
7. **PII masking** for roles without `pii`; **hash-chained audit log** (args redacted).

## Cross-cutting governance
- **Policy & compliance / Consent:** `PolicyEngine.consentCheck` (GDPR opt-in, SMS opt-in, CCPA opt-out) feeds a consent-filtered audience; `regulatoryCheck` (unsubscribe / STOP).
- **Brand governance:** Brand Concierge guidelines + `checkBrand` (banned words, disclaimer, subject length).
- **Responsible AI:** AI-generated content is labeled and cannot launch until a human approver has reviewed it.
- **Audit & observability:** `gateway_audit_log`, `gateway_monitoring` (restricted to ops/leadership).
- **Cost & usage:** `gateway_usage`. **Data privacy:** `privacy_request` (erasure/access) + masking.

## Campaign state machine
`draft → planned → content_ready → in_review → approved | changes_requested → activating → live → reporting`.
`activating` is blocked unless the launch gate passes (consent-validated audience, content, brand, regulatory, approval, responsible AI).

## OpenAI Agents SDK
This repo is the tool/gateway side. An Agents SDK orchestrator connects to `/mcp` (Streamable HTTP, bearer token) and sees the same
tools; `agent_*` tools are the seven role agents. No Agents SDK runtime or LLM is included here.

## Live upstreams (`src/upstream/`)
`endpoints.js` (URLs + RBAC aliases), `config.js` (env, host allow-list), `client.js` (MCP client with reconnect), `remote-agent.js`
(discovered tools as a gateway service). `Gateway.addService` registers them; read/write comes from MCP `readOnlyHint`
annotations (all tools of read-only upstreams are read). `ADOBE_TOOL_MAP` re-routes built-in tool names to live tools.
