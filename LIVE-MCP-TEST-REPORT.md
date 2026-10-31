# Live Adobe MCP Capability Test Report

- **Run date:** 2026-10-30T17:16:34.031Z
- **Environment:** Production credentials and production org; live Adobe MCP endpoints, no mocks.
- **Authentication:** Adobe IMS OAuth Server-to-Server (`client_credentials`); secret and access token omitted.
- **Gateway identity:** `morgan.ops` (marketing operations).
- **Call safety:** Only tools explicitly annotated read-only and with no required input parameters were invoked. No write/mutating tools were called.
- **Inputs:** `{}` for every function actually invoked. No record IDs or filters were guessed.
- **Output privacy:** Successful response data is summarized by type, item count, and field names; record contents are redacted. Errors are reported as returned, with no credential data.

## Summary

- Services configured: 9
- Services connected: 7
- Read-only no-required-argument calls: 22
- Successful calls: 19
- Failed/denied calls: 3
- Tools requiring arguments and all non-read-only tools were not invoked.

## Per-service results

### cdp

- **Connection:** Connected; 37 tools discovered.
- **Catalog annotations:** 37 read-only, 0 write, 0 unclassified.
- **Selection:** 1 read-only tools with no required arguments called; 36 read-only tools requiring arguments skipped.

| Function tested | Input | Result | Output returned |
|---|---|---|---|
| `search_organizations` | `{}` | PASS | array (1 items; first-item fields/types: orgName, orgId) |

### aem

- **Connection:** Connected; 6 tools discovered.
- **Catalog annotations:** 4 read-only, 2 write, 0 unclassified.
- **Selection:** 2 read-only tools with no required arguments called; 2 read-only tools requiring arguments skipped.

| Function tested | Input | Result | Output returned |
|---|---|---|---|
| `list-aem-environments` | `{}` | PASS | object { text: string (value redacted) } |
| `list-aem-capabilities` | `{}` | PASS | object { text: string (value redacted); detail: string (value redacted) } |

### cloud_manager

- **Connection:** Connected; 6 tools discovered.
- **Catalog annotations:** 0 read-only, 0 write, 6 unclassified.
- **Selection:** 0 read-only tools with no required arguments called; 0 read-only tools requiring arguments skipped.

No tools invoked.

### marketo_mcp

- **Connection:** Failed during MCP discovery.
- **Output:** marketo_mcp: Streamable HTTP error: Error POSTing to endpoint: {"detail":"Unauthorized"}

### workfront_mcp

- **Connection:** Connected; 49 tools discovered.
- **Catalog annotations:** 48 read-only, 1 write, 0 unclassified.
- **Selection:** 10 read-only tools with no required arguments called; 38 read-only tools requiring arguments skipped.

| Function tested | Input | Result | Output returned |
|---|---|---|---|
| `approvals_list_aem_providers` | `{}` | PASS | string (122 chars; content redacted) |
| `approvals_list_templates` | `{}` | PASS | string (495 chars; content redacted) |
| `insights_get_current_user` | `{}` | PASS | object { user_id: string (value redacted); user_name: string (value redacted); wf_url: string (value redacted) } |
| `insights_list_entities` | `{}` | PASS | object { result: array(25) } |
| `list_resources` | `{}` | PASS | object { resources: array(13); templates: array(2) } |
| `planning_get_template_list` | `{}` | PASS | object { results: array(7) } |
| `planning_get_workspace_list` | `{}` | PASS | object { results: array(0) } |
| `planning_list_global_record_types` | `{}` | PASS | object { results: array(0) } |
| `planning_search_users` | `{}` | PASS | object { results: array(13); totalCount: number (value redacted) } |
| `reporting_read` | `{}` | PASS | object { data: object{dashboards}; kind: string (value redacted) } |

### marketing_agent

- **Connection:** Connected; 12 tools discovered.
- **Catalog annotations:** 3 read-only, 9 write, 0 unclassified.
- **Selection:** 1 read-only tools with no required arguments called; 2 read-only tools requiring arguments skipped.

| Function tested | Input | Result | Output returned |
|---|---|---|---|
| `core-list_tasks` | `{}` | PASS | object { contextId: string (value redacted); tasks: array(0) } |

### brand_intelligence

- **Connection:** Connected; 23 tools discovered.
- **Catalog annotations:** 6 read-only, 4 write, 13 unclassified.
- **Selection:** 4 read-only tools with no required arguments called; 2 read-only tools requiring arguments skipped.

| Function tested | Input | Result | Output returned |
|---|---|---|---|
| `list_simulations` | `{}` | FAIL / DENIED | ERROR: Error executing tool list_simulations: not_entitled: No Adobe Brand Intelligence tenant is entitled for your Adobe org.; blocked by Adobe org entitlement |
| `list_workspaces` | `{}` | FAIL / DENIED | ERROR: Error executing tool list_workspaces: not_entitled: No Adobe Brand Intelligence tenant is entitled for your Adobe org.; blocked by Adobe org entitlement |
| `get_simulation_options` | `{}` | FAIL / DENIED | ERROR: Error executing tool get_simulation_options: not_entitled: No Adobe Brand Intelligence tenant is entitled for your Adobe org.; blocked by Adobe org entitlement |
| `initialize_simulate` | `{}` | PASS | object { skill_name: string (value redacted); skill_document: string (value redacted); message: string (value redacted) } |

### genstudio

- **Connection:** Failed during MCP discovery.
- **Output:** genstudio: Streamable HTTP error: Error POSTing to endpoint: 

### coworker

- **Connection:** Connected; 8 tools discovered.
- **Catalog annotations:** 4 read-only, 4 write, 0 unclassified.
- **Selection:** 4 read-only tools with no required arguments called; 0 read-only tools requiring arguments skipped.

| Function tested | Input | Result | Output returned |
|---|---|---|---|
| `core_list_sandboxes` | `{}` | PASS | object { sandboxes: array(0) } |
| `core_list_dataviews` | `{}` | PASS | object { dataviews: array(0); notice: string (value redacted) } |
| `core_list_orgs` | `{}` | PASS | object { current_org: object{orgName, orgId, userId}; orgs: array(1) } |
| `core_list_sub_orgs` | `{}` | PASS | object { sub_orgs: array(5) } |

## Coverage limits

This report is not a claim that every tool was executed. Parameterized read tools require valid production resource identifiers/filters and were skipped. Write tools were deliberately not run because they can create, modify, publish, or delete Adobe data. Unclassified tools were also skipped because their effects could not be established as read-only from MCP annotations. A service that connects successfully is not evidence that every tool is entitled or operational.
