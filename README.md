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
