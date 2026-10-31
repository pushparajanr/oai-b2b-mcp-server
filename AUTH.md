# Authentication

Flow (one request): **web user → Adobe web-app sign-in → validated application session → MCP authorization (user, action, resource) → token broker → delegated user token *or* technical-account token → product API.**

| Step | Code |
|---|---|
| Adobe web-app sign-in, validated session | `src/oauth.js`, bearer session in `src/http.js` |
| MCP authorization: user × action × resource | role access `gateway/security.js` + operation policy `auth/auth-policy.js` (`allowedRoles`, `sandboxes`) |
| Token broker | `auth/token-broker.js` |
| Missing connection / incremental authorization | `auth/connect.js` (`/connect/<id>`), tools `auth_connect`, `auth_connections` |
| Audit: requesting user **and** executing principal | `gateway/gateway.js` → `gateway_audit_log` (`user`, `authMode`, `principal`, `requestingPrincipal`, `executingPrincipal`, `clientId`, `orgId`, `sandbox`, `upstreamStatus`, `upstreamRequestId`). `executingPrincipal` is the technical account ID from the S2S token's `user_id` claim (null until the first token is issued); `clientId` identifies the application, not a principal |

## Mode per operation
Rules resolve most-specific first: `operations["service.tool"]` > `services["service"]` > `default` (`mode: service`). Put them in a JSON file named by `ADOBE_AUTH_POLICY`:

```json
{
  "services": {
    "cdp": { "mode": "service", "sandbox": "prod", "sandboxes": ["prod", "dev"] },
    "marketo_mcp": { "mode": "service", "credential": "marketo" },
    "workfront_mcp": { "mode": "service", "credential": "workfront" },
    "marketing_agent": { "mode": "delegated" }
  },
  "operations": { "aem.some-write-tool": { "mode": "delegated" }, "cdp.some-tool": { "allowedRoles": ["marketing_ops"] } }
}
```
- **service**: server-to-server token for a named credential. This server decides who may invoke it (role access to the service, optional `allowedRoles`). Adobe sees the technical account, so use it only for operations the application is authorized to perform for those users.
- **delegated**: the user's own Adobe token from a connection. Use it when Adobe must enforce the individual's access.
- **missing connection**: a delegated operation without a connection returns `connection_required` with a single-use authorization link. **It never falls back to a technical account**, and a delegated request Adobe denies (401/403) is returned as-is, never retried with a more powerful credential.

Shortcuts: `ADOBE_AUTH_MODE_<SERVICE>=delegated`; legacy `ADOBE_USER_TOKEN_UPSTREAMS=a,b` marks those services delegated.

## Coworker login (`USE_COWORKER_LOGIN`, default on)

With the key on (or unset), signing in with Adobe also stores the user's own token as their `coworker` connection, and every `coworker` and `cdp` call (including list audiences) runs in **delegated** mode as that user (no technical account, no fallback), so Adobe enforces the user's own AEP role. Extra scopes for the coworker gateway go in `ADOBE_COWORKER_SCOPES` (add `offline_access` for a refresh token) and must be enabled on the sign-in client; `ADOBE_COWORKER_SERVICES` can route more services through the same connection. Connections are in memory, so after a restart a user re-signs in (or opens the connect link the server returns). A policy file entry or `ADOBE_AUTH_MODE_COWORKER` still overrides the mode. Set `USE_COWORKER_LOGIN=0` for the original flow: identity-only sign-in and the technical account for coworker.

## Credentials (keep Web App and Server-to-Server separate)
| Purpose | Env | Sent as |
|---|---|---|
| Default S2S credential | `ADOBE_CLIENT_ID`, `ADOBE_CLIENT_SECRET`, `ADOBE_SCOPES`, `ADOBE_ORG_ID` | token + `x-api-key` = S2S client id, `x-gw-ims-org-id` |
| Marketo-specific S2S credential (`credential: "marketo"`) | `ADOBE_CRED_MARKETO_CLIENT_ID/_CLIENT_SECRET/_SCOPES/_ORG_ID` | same, with Marketo credential's own client id and org |
| Another S2S credential (`credential: "workfront"`) | `ADOBE_CRED_WORKFRONT_CLIENT_ID/_CLIENT_SECRET/_SCOPES/_ORG_ID` | same, with that credential's own client id and org |
| Web App (user sign-in and connections) | `ADOBE_SIGNIN_CLIENT_ID`, `ADOBE_SIGNIN_CLIENT_SECRET`, `ADOBE_SIGNIN_SCOPES`, `PUBLIC_URL` | user token + `x-api-key` = **web-app** client id |
| Adobe organization | `ADOBE_ORG_ID` | `x-gw-ims-org-id` and `identity.imsOrg`; the internal tenant key remains separate |
| Sandbox | `ADOBE_SANDBOX_NAME`, or `sandbox` / `sandboxes` in the policy | `x-sandbox-name`; a caller may pick only an allowed sandbox |

A token is always paired with the client id that issued it. Header sets are product specific: use `ADOBE_<KEY>_HEADERS` (JSON) for extras. The broker resolves credential, org and sandbox from server configuration, not from request arguments. If no trusted sandbox is
configured, requests that explicitly select one are rejected; set `ADOBE_SANDBOX_NAME` or an explicit policy allow-list after
verifying the sandbox exists and the Adobe principal has access.

The live `aem` and `marketo_mcp` services connect to Adobe's MCP endpoints (`ADOBE_AEM_URL` and
`ADOBE_MARKETO_MCP_URL` override those MCP URLs). `AEM_AUTHOR_URL` and `AEM_API_KEY` are
direct-product REST settings and are not consumed by these MCP integrations. `MARKETO_BASE_URL`,
`MARKETO_CLIENT_ID` and `MARKETO_CLIENT_SECRET` enable the separate `marketo_rest` service (tools
`marketo_rest_*`), which authenticates with the Marketo credential itself in both service and coworker/delegated
flows. Configure the Adobe S2S
credential and product permissions instead; an upstream 401/403 indicates that Adobe rejected the
credential or its entitlement, not that those REST variables were used.

Connection scopes: `ADOBE_CONNECTION_<NAME>_SCOPES` (default `ADOBE_SIGNIN_SCOPES`). Register `PUBLIC_URL/connect/callback` (or `ADOBE_CONNECT_REDIRECT_URI`) as a redirect URI on the Web App credential.

## Caching and renewal
Service tokens are cached by **client id + org + scope set** (shared by every service using that credential); delegated tokens by **user + connection**. Both renew from `expires_in` (refresh token for delegated; a connection without one must be re-authorized at expiry). Secrets and tokens never leave the broker, audit log, errors or status output.

## Errors
Upstream failures keep `status`, `requestId` and `body` under `details.upstream`. 401/403 are `upstream_unauthorized` / `upstream_forbidden` with a hint naming the acting principal; a 5xx is `upstream_error` and says it is not evidence of an authentication problem.

## Provisioning checklist (done in Adobe, not in code)
| Service | Do this |
|---|---|
| Experience Platform | Developer Console: OAuth Server-to-Server + product profile. AEP **Permissions → Roles → role → API credentials → Add API credentials**, pick the credential, then verify permissions **and sandboxes**. Assigning a human to the role does not cover the service account. |
| Journey Optimizer | Same product profile / AEP role; grant endpoint-specific permissions and sandbox access. |
| AEM | Product profile for the right author environment; configure that AEM instance to allow the S2S client and verify the MCP endpoint's entitlement. |
| Marketo Engage | Grant the S2S client the required Marketo product profile and API permissions; verify Marketo MCP entitlement. |
| Workfront | Find the technical-account user in Workfront; grant access level and resource access. |
| Workfront Fusion | Add the technical account to the required teams; org-wide/admin operations need more. |
| Brand Intelligence | Confirm entitlement and completed brand-profile onboarding. |

Adding an API card to a project does not complete authorization, and S2S and Web App credentials in one project are not interchangeable. Verify each product directly first: `npm run auth:diagnose` (IMS token, direct call, brokered call, per service).
