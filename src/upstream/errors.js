import { AsyncLocalStorage } from "node:async_hooks";

/** An error returned by an Adobe API/MCP endpoint. Keeps the upstream status, request id and body verbatim (capped). */
export class UpstreamError extends Error {
  constructor(message, { status, requestId, body, url } = {}) {
    super(message);
    Object.assign(this, { name: "UpstreamError", status, requestId: requestId ?? null, body, url });
  }
}

const ID_HEADERS = ["x-request-id", "x-gw-ims-request-id", "x-adobe-request-id", "x-correlation-id"];
export const requestIdOf = (headers) => ID_HEADERS.map((k) => headers?.get?.(k)).find(Boolean) ?? null;
export const fromResponse = async (res, message) => new UpstreamError(message, { status: res.status, requestId: requestIdOf(res.headers), body: (await res.text().catch(() => "")).slice(0, 4000) });

/** Per-call capture of the last failing HTTP response, because the MCP SDK throws without headers/body. */
export const capture = new AsyncLocalStorage();
export function observingFetch(inner = fetch) {
  return async (input, init) => {
    const res = await inner(input, init);
    const store = capture.getStore();
    if (store && !res.ok) store.last = { status: res.status, requestId: requestIdOf(res.headers), body: (await res.clone().text().catch(() => "")).slice(0, 4000) };
    return res;
  };
}
