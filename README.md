# oai-b2b-mcp-server

Node MCP server (stdio) replicating the capabilities in *Adobe Coworker and Native MarOps Capabilities v2*.
All state is in-memory; image generation, DNS lookups, and PDF/Word rendering are stubbed.

```bash
npm install
npm start      # stdio server; reads local .env
npm test       # end-to-end smoke test
```

Claude config: `{"mcpServers":{"marops":{"command":"node","args":["/path/to/src/index.js"]}}}`

## Coworker capabilities → tools
| Stage | Capability | Tools |
|---|---|---|
| Planning | Brief ingestion | `create_campaign`, `ingest_brief` |
| Planning | Template remix | `list_journey_templates`, `remix_journey_template` |
| Planning | Audience ingestion | `list_connectors`, `ingest_audience_csv` |
| Planning | Brand kit | `set_brand_kit`, `get_brand_kit` |
| Production | Journey mapping / touchpoints | `add_journey_step`, `get_journey`, `reorder_touchpoint`, `remove_step` |
| Production | Email authoring | `edit_email`, `undo_email_edit`, `redo_email_edit` |
| Production | AI creative | `generate_email_image`, `suggest_copy` |
| Production | Template/export | `apply_email_template`, `export_email_html` |
| Validation | Completion / audience | `check_workflow_completion`, `validate_audience`, `list_audiences` |
| Validation | Domain & sender | `setup_sender_domain`, `verify_sender_domain`, `select_sender` |
| Validation | Test dispatch | `send_test_email` |
| Launch | Gated launch / export | `launch_campaign`, `export_campaign_doc` |
| Measurement | Metrics / analytics / status | `record_email_metrics`, `get_email_metrics`, `get_journey_analytics`, `get_post_launch_status` |

## Native-console items (sheet 2)
These can't be done in Coworker, so they're exposed as a catalog: `list_native_setup_requirements`, `check_native_prerequisites`.

## Orchestrator + product sub-agents (`src/agents/`)
Each agent owns simulated state and tools, exposed as `<agent>_<tool>`. `orchestrator_*` tools route and chain them.

| Agent | Product | Tools |
|---|---|---|
| `aep` | Experience Platform | `create_schema`, `list_schemas`, `create_dataset`, `ingest_records`, `get_profile`, `create_segment`, `evaluate_segment`, `create_audience`, `run_query` |
| `ajo` | Journey Optimizer | `create_custom_action`, `create_journey`, `publish_journey`, `list_journeys`, `create_campaign`, `create_offer`, `create_decision`, `decide_offer` |
| `workfront` | Workfront | `create_project`, `create_task`, `update_task_status`, `log_issue`, `assign`, `request_approval`, `decide_approval`, `project_status` |
| `aem_sites` | AEM Sites | `create_page`, `add_component`, `create_content_fragment`, `update_content_fragment`, `publish_page`, `unpublish_page`, `list_pages` |
| `aem_assets` | AEM Assets | `create_folder`, `upload_asset`, `update_metadata`, `search_assets`, `list_renditions`, `move_asset`, `run_asset_workflow` |

Orchestrator tools: `orchestrator_list_agents`, `orchestrator_plan` (route text → agents in dependency order: AEP → Assets → Sites → AJO → Workfront), `orchestrator_execute` (sequential steps; `"$step2.id"` references earlier results), `orchestrator_delegate`.
These are simulations: swap each tool's `run` for real Adobe API calls to go live.

## Reference architecture
The server now implements the layered architecture (role agents, application services, MCP gateway with RBAC/audit/masking,
nine Adobe product services, governance). See [ARCHITECTURE.md](ARCHITECTURE.md). Run remotely with `npm run start:http`
(`POST /auth/login` then `POST /mcp` with `Authorization: Bearer <token>`); stdio uses `MCP_USER` (default `morgan.ops`).

## Live Adobe MCP endpoints
The gateway can connect to the real Adobe MCP servers. Each is enabled by a bearer token (see `.env.example`) and appears as a
gateway service; its tools are **discovered at startup** (`upstream_status`, `upstream_list_tools`) and called with `upstream_call`,
so RBAC, entitlement, audit, masking and usage limits apply exactly as for built-in tools.

| Service key | Endpoint | Governed by role access to |
|---|---|---|
| `cdp` (read-only) | `https://rtcdp-mcp.adobe.io/mcp` | `aep` |
| `aem` | `https://mcp.adobeaemcloud.com/adobe/mcp/aem` | `aem_assets` or `aem_sites` |
| `cloud_manager` | `https://mcp.adobeaemcloud.com/adobe/mcp/cloudmanager` | `cloud_manager` (marketing_ops only) |
| `marketo_mcp` | `https://marketo-mcp.adobe.io/mcp` | `marketo` |
| `workfront_mcp` | `https://mcp.workfront.adobe.com/mcp/v1/workfront` | `workfront` |
| `marketing_agent` | `https://aep-ai-ama.adobe.io/mcp` | `ajo` or `aep` |
| `brand_intelligence` | `https://abi-mcp.adobe.io/mcp` | `brand_concierge` |
| `genstudio` | `https://genstudio-services.adobe.io/mcp` | `cja` |
| `coworker` | `https://cx-coworker-gateway.adobe.io/mcp` | `coworker` |

Built-in tools (e.g. `aep_list_audiences`) keep running on the simulation unless you map them to a live tool with
`ADOBE_TOOL_MAP=tool-map.json`: `{"aep.list_audiences": {"service": "cdp", "tool": "<name from upstream_list_tools>", "argMap": {}, "fixed": {}}}`.
Credentials are only sent to https Adobe hosts unless `ADOBE_ALLOW_CUSTOM_HOSTS=1`.

## Exposing the server with ngrok
`npm run start:tunnel` starts `src/http.js` and `ngrok http $PORT` (set `NGROK_DOMAIN` for a reserved domain). The MCP endpoint is
`https://<ngrok-host>/mcp`. `/mcp` accepts three kinds of bearer credential:

| Credential | Use | How |
|---|---|---|
| `MCP_API_KEY` (>=24 chars, auto-generated into `.env`) | Codex, scripts | Acts as `MCP_API_KEY_USER` (default `morgan.ops`); long-lived |
| OAuth 2.1 access token | ChatGPT custom connector | Dynamic client registration + PKCE; `/.well-known/oauth-*`, `/oauth/register`, `/oauth/authorize`, `/oauth/token` |
| Gateway token from `POST /auth/login` | Dev | Needs the `x-login-secret` header (`LOGIN_SECRET`) when proxied |

**Codex** (`~/.codex/config.toml`; put `MCP_API_KEY` in the environment Codex runs in):
```toml
[mcp_servers.oai_b2b]
url = "https://<ngrok-host>/mcp"
bearer_token_env_var = "MCP_API_KEY"
```
**ChatGPT**: Settings -> Connectors -> Advanced -> Developer mode -> Create, URL `https://<ngrok-host>/mcp`, authentication OAuth.
**Adobe sign-in (recommended):** set `ADOBE_SIGNIN_CLIENT_ID`, `ADOBE_SIGNIN_CLIENT_SECRET` and `ADOBE_SIGNIN_REDIRECT_URI`
(`https://<ngrok-host>/oauth/adobe/callback`, from an Adobe OAuth Web App credential) plus `OAUTH_ALLOWED_EMAILS`
(`email[:role],...`; role defaults to `OAUTH_DEFAULT_ROLE` or `leadership`). The connector login then redirects to Adobe IMS, and only
allow-listed Adobe accounts get a token (fail closed). Optional: `ADOBE_SIGNIN_SCOPES` (default `openid,AdobeID,profile`).
Upstream Adobe calls use the server-to-server credential by default. To call selected services as the signed-in user instead
(for example when the shared credential has no AEP / RT-CDP access), set `ADOBE_USER_TOKEN_UPSTREAMS=cdp,marketing_agent` and add
`offline_access` to `ADOBE_SIGNIN_SCOPES` (plus any scopes the service needs). Those services then use the user's own Adobe token with the
sign-in app's client id; API-key and demo logins can't call them, and tokens are kept in memory only (restart = sign in again).
Without those settings, the approval page asks for `LOGIN_SECRET` and which demo user to act as. Redirect URIs are limited to `OAUTH_ALLOWED_REDIRECT_HOSTS`
(default `chatgpt.com,openai.com,localhost,127.0.0.1`); consent attempts are throttled. OAuth clients and tokens are in memory, so
restarting the server means reconnecting the connector. Set `PUBLIC_URL` if the issuer URL must not be derived from request headers.
Keep `LOGIN_SECRET` and `MCP_API_KEY` private: either grants access to live Adobe data as a demo user.

### Authenticating with Adobe IMS
Set `ADOBE_CLIENT_ID`, `ADOBE_CLIENT_SECRET` and `ADOBE_SCOPES` (OAuth Server-to-Server credentials from the Adobe Developer Console).
The server requests a `client_credentials` token from IMS, caches it, refreshes before expiry, shares one in-flight refresh across
callers, and retries once after an upstream 401. `x-api-key` defaults to the client id. `npm run ims:check` performs a live token
request and lists which MCP endpoints connect. `npm test` includes `test/ims.js`, an end-to-end run against a mock IMS + MCP.

OAuth Web App credentials use the authorization-code flow instead. Copy `.env.example` to `.env`, set
`ADOBE_AUTH_MODE=authorization_code`, `ADOBE_CLIENT_ID`, `ADOBE_CLIENT_SECRET`, `ADOBE_REDIRECT_URI`, and the exact
`ADOBE_SCOPES` configured in the Adobe Developer Console. Keep `.env` private; it is ignored by Git. Run
`npm run adobe:login`, open the printed URL, sign in, then paste the full browser redirect URL when prompted. The script
validates the redirect URI and OAuth state, exchanges the one-time code, and stores the refresh token only in `.env`.
The server refreshes and caches access tokens and saves any rotated refresh token back to `.env`. Restart the server after
login. If the callback is not routed to this machine, the browser must still reach a page that leaves the full redirect URL
visible so you can copy it into the prompt.
