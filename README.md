# oai-b2b-mcp-server

Node MCP server (stdio) replicating the capabilities in *Adobe Coworker and Native MarOps Capabilities v2*.
All state is in-memory; image generation, DNS lookups, and PDF/Word rendering are stubbed.

```bash
npm install
npm start      # stdio server
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
