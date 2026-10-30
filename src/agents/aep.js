import { z } from "zod";
import { Agent, uid } from "./base.js";

const OPS = { "=": (a, b) => a == b, "!=": (a, b) => a != b, ">": (a, b) => a > b, "<": (a, b) => a < b, ">=": (a, b) => a >= b, "<=": (a, b) => a <= b, contains: (a, b) => String(a).includes(b) };
const ruleSchema = z.object({ field: z.string(), op: z.enum(Object.keys(OPS)), value: z.union([z.string(), z.number(), z.boolean()]) });
const matches = (rec, rules, mode) => (mode === "any" ? rules.some : rules.every).call(rules, (r) => OPS[r.op](rec[r.field], r.value));
const init = (s) => { for (const k of ["schemas", "datasets", "segments", "audiences"]) s[k] ??= new Map(); s.profiles ??= new Map(); };

export const aep = new Agent({
  key: "aep", name: "AEP Agent", product: "Adobe Experience Platform",
  description: "Schemas, datasets, profiles, audiences, segmentation and query execution.",
  keywords: ["aep", "schema", "dataset", "profile", "segment", "audience", "query", "sql", "xdm", "identity"],
  tools: {
    create_schema: { description: "Define an XDM-style schema with typed fields and an identity field.", shape: 1,
      schema: z.object({ name: z.string(), fields: z.record(z.enum(["string", "number", "boolean", "date"])), identityField: z.string() }),
      run(a, s) { init(s); if (!(a.identityField in a.fields)) throw new Error("identityField must be one of the fields");
        const v = { id: uid("sch"), ...a }; s.schemas.set(v.id, v); return v; } },
    list_schemas: { description: "List schemas.", run: (_, s) => (init(s), [...s.schemas.values()]) },
    create_dataset: { description: "Create a dataset bound to a schema; optionally profile-enabled.", shape: 1,
      schema: z.object({ name: z.string(), schemaId: z.string(), profileEnabled: z.boolean().default(false) }),
      run(a, s) { init(s); const sch = s.schemas.get(a.schemaId); if (!sch) throw new Error(`Unknown schema '${a.schemaId}'`);
        const v = { id: uid("ds"), ...a, records: [] }; s.datasets.set(v.id, v); return { id: v.id, name: v.name, profileEnabled: v.profileEnabled }; } },
    ingest_records: { description: "Ingest records into a dataset (validated against schema; profile-enabled datasets merge into profiles by identity).", shape: 1,
      schema: z.object({ datasetId: z.string(), records: z.array(z.record(z.any())).min(1) }),
      run(a, s) { init(s); const ds = s.datasets.get(a.datasetId); if (!ds) throw new Error(`Unknown dataset '${a.datasetId}'`);
        const sch = s.schemas.get(ds.schemaId); let ok = 0; const errors = [];
        a.records.forEach((r, i) => {
          const bad = Object.keys(r).find((k) => !(k in sch.fields)) ?? (r[sch.identityField] == null ? sch.identityField : null);
          if (bad) return errors.push(`row ${i}: invalid or missing field '${bad}'`);
          ds.records.push(r); ok++;
          if (ds.profileEnabled) { const k = String(r[sch.identityField]); s.profiles.set(k, { ...(s.profiles.get(k) ?? {}), ...r }); }
        });
        return { ingested: ok, rejected: errors.length, errors }; } },
    get_profile: { description: "Look up a unified profile by identity value.", shape: 1, schema: z.object({ identity: z.string() }),
      run(a, s) { init(s); const p = s.profiles.get(a.identity); if (!p) throw new Error(`No profile '${a.identity}'`); return p; } },
    create_segment: { description: "Create a segment from rules (all/any).", shape: 1,
      schema: z.object({ name: z.string(), rules: z.array(ruleSchema).min(1), mode: z.enum(["all", "any"]).default("all") }),
      run(a, s) { init(s); const v = { id: uid("seg"), ...a }; s.segments.set(v.id, v); return v; } },
    evaluate_segment: { description: "Evaluate a segment against all profiles; returns members.", shape: 1, schema: z.object({ segmentId: z.string() }),
      run(a, s) { init(s); const g = s.segments.get(a.segmentId); if (!g) throw new Error(`Unknown segment '${a.segmentId}'`);
        const members = [...s.profiles.entries()].filter(([, p]) => matches(p, g.rules, g.mode)).map(([k]) => k);
        return { segmentId: g.id, count: members.length, members }; } },
    create_audience: { description: "Publish a segment as a named audience (snapshot of members).", shape: 1, schema: z.object({ name: z.string(), segmentId: z.string() }),
      run(a, s) { init(s); const g = s.segments.get(a.segmentId); if (!g) throw new Error(`Unknown segment '${a.segmentId}'`);
        const members = [...s.profiles.entries()].filter(([, p]) => matches(p, g.rules, g.mode)).map(([k]) => k);
        const v = { id: uid("aud"), name: a.name, segmentId: g.id, members }; s.audiences.set(v.id, v); return { id: v.id, name: v.name, size: members.length }; } },
    run_query: { description: "Run a simple SQL: SELECT <cols|*> FROM <dataset name or id> [WHERE col op value [AND ...]] [LIMIT n].", shape: 1, schema: z.object({ sql: z.string() }),
      run(a, s) { init(s);
        const m = /^\s*select\s+(.+?)\s+from\s+(\S+)(?:\s+where\s+(.+?))?(?:\s+limit\s+(\d+))?\s*;?\s*$/i.exec(a.sql);
        if (!m) throw new Error("Unsupported SQL. Form: SELECT cols FROM dataset [WHERE a = 'x' AND b > 3] [LIMIT n]");
        const [, cols, from, where, limit] = m;
        const ds = [...s.datasets.values()].find((d) => d.id === from || d.name === from); if (!ds) throw new Error(`Unknown dataset '${from}'`);
        const rules = (where ? where.split(/\s+and\s+/i) : []).map((c) => {
          const w = /^(\w+)\s*(>=|<=|!=|=|>|<)\s*(.+)$/.exec(c.trim()); if (!w) throw new Error(`Bad condition '${c}'`);
          const raw = w[3].trim().replace(/^'(.*)'$/, "$1"); return { field: w[1], op: w[2], value: raw !== "" && !isNaN(raw) && !/^'/.test(w[3].trim()) ? Number(raw) : raw };
        });
        let rows = ds.records.filter((r) => matches(r, rules, "all"));
        if (limit) rows = rows.slice(0, +limit);
        if (cols.trim() !== "*") { const c = cols.split(",").map((x) => x.trim()); rows = rows.map((r) => Object.fromEntries(c.map((k) => [k, r[k]]))); }
        return { rowCount: rows.length, rows }; } },
  },
});
