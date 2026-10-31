export class GatewayError extends Error {
  constructor(code, message, { service, retryable = false, details } = {}) {
    super(message);
    Object.assign(this, { code, service, retryable, details });
  }
}

/** Normalize any upstream failure into a GatewayError (error normalization). */
export function normalizeError(e, service) {
  if (e instanceof GatewayError) return e.service ? e : Object.assign(e, { service });
  if (e?.name === "UpstreamError") {
    const s = e.status;
    const code = s === 401 ? "upstream_unauthorized" : s === 403 ? "upstream_forbidden" : s === 429 ? "rate_limited" : "upstream_error";
    const note = s === 401 || s === 403 ? ` (HTTP ${s}: Adobe rejected the credential)` : s >= 500 ? ` (HTTP ${s} is an upstream failure; it does not by itself indicate an authentication problem)` : s ? ` (HTTP ${s})` : "";
    return new GatewayError(code, `${e.message}${note}`, { service, retryable: [429, 502, 503, 504].includes(s), details: { upstream: { status: s, requestId: e.requestId, body: e.body } } });
  }
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
