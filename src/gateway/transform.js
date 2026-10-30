export class GatewayError extends Error {
  constructor(code, message, { service, retryable = false } = {}) {
    super(message);
    Object.assign(this, { code, service, retryable });
  }
}

/** Normalize any upstream failure into a GatewayError (error normalization). */
export function normalizeError(e, service) {
  if (e instanceof GatewayError) return e.service ? e : Object.assign(e, { service });
  if (e?.name === "ZodError") return new GatewayError("invalid_request", e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), { service });
  return new GatewayError(e?.transient ? "upstream_unavailable" : "upstream_error", e?.message ?? String(e), { service, retryable: !!e?.transient });
}

/** Schema mapping: rename source fields to target (e.g. XDM) field names. Unmapped fields pass through. */
export function mapFields(records, mapping) {
  return records.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [mapping[k] ?? k, v])));
}

/** Request-side transformation hook; currently supports AEP ingest `sourceMapping`. */
export function transformRequest(service, tool, args) {
  if (service === "aep" && tool === "ingest_records" && args.sourceMapping) {
    const { sourceMapping, ...rest } = args;
    return { ...rest, records: mapFields(rest.records, sourceMapping) };
  }
  return args;
}
