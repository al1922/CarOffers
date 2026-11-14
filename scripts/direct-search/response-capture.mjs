const DEFAULT_FIELDS = /^(?:id|uuid|slug|url|href|link|title|name|headline|subject|label|key|value|text|brand|make|model|generation|price|pricecurrency|currency|productiondate|productionyear|year|mileagefromodometer|mileage|odometer|mileageunit|vin|availability|fueltype|vehicletransmission|bodytype|addresslocality|addressregion|seller|sellername|offerid|itemid|advertid|listingid|(?:offer|advert|listing|item)(?:url|href|link)|(?:url|href|link)(?:offer|advert|listing|item))$/i;

function projectJson(value, depth = 0, budget = { entries: 0 }) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 800);
  if (depth >= 8 || budget.entries >= 5000) return undefined;
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value.slice(0, 100)) {
      const projected = projectJson(item, depth + 1, budget);
      if (projected !== undefined) result.push(projected);
    }
    return result;
  }
  if (typeof value !== "object") return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    budget.entries += 1;
    if (!DEFAULT_FIELDS.test(key) && !Array.isArray(item) && (item === null || typeof item !== "object")) continue;
    const projected = projectJson(item, depth + 1, budget);
    if (projected !== undefined) result[key.slice(0, 100)] = projected;
    if (budget.entries >= 5000) break;
  }
  return result;
}

function graphqlRequestInfo(urlValue, request) {
  if (!String(urlValue).includes("/graphql")) return null;
  try {
    const url = new URL(urlValue);
    let operationName = url.searchParams.get("operationName") ?? "";
    let variables = {};
    const rawVariables = url.searchParams.get("variables");
    if (rawVariables) variables = JSON.parse(rawVariables);
    if (!operationName || !rawVariables) {
      try {
        const body = JSON.parse(request.postData() ?? "{}");
        operationName ||= body.operationName ?? "";
        variables = body.variables ?? variables;
      } catch { /* GET requests or non-JSON request bodies are already covered by URL values. */ }
    }
    if (!operationName) return null;
    const filters = Array.isArray(variables.filters) ? variables.filters
      .filter((item) => typeof item?.name === "string" && item.value !== undefined)
      .map((item) => ({ name: item.name, value: item.value })) : [];
    return { operationName, page: Number(variables.page ?? 1), filters };
  } catch { return null; }
}

export function attachResponseCapture(page, { origin, maxResponseBytes, maxRunResponseBytes, timings, shouldCaptureResponse }) {
  const captures = [];
  const pending = new Set();
  let totalBytes = 0;
  let dropped = 0;

  page.on("response", (response) => {
    const request = response.request();
    if (!["xhr", "fetch"].includes(request.resourceType())) return;
    if (shouldCaptureResponse && !shouldCaptureResponse(response.url(), request)) return;
    let responseUrl;
    try { responseUrl = new URL(response.url()); } catch { return; }
    if (responseUrl.origin !== origin) return;
    const contentType = String(response.headers()["content-type"] ?? "").toLowerCase();
    const requestInfo = graphqlRequestInfo(response.url(), request);
    if (!contentType.includes("json")) {
      captures.push({ url: response.url(), method: request.method(), status: response.status(), resourceType: request.resourceType(),
        contentType, jsonCaptured: false, omittedReason: "non_json_response", ...(requestInfo ? { requestInfo } : {}) });
      return;
    }
    const contentLength = Number(response.headers()["content-length"] ?? 0);
    if (contentLength > maxResponseBytes || totalBytes + contentLength > maxRunResponseBytes) {
      dropped += 1;
      captures.push({ url: response.url(), method: request.method(), status: response.status(), resourceType: request.resourceType(),
        contentType, bodyBytes: contentLength || null, jsonCaptured: false, omittedReason: "configured_size_limit",
        ...(requestInfo ? { requestInfo } : {}) });
      return;
    }
    const started = performance.now();
    const task = (async () => {
      const body = await response.body();
      if (body.byteLength > maxResponseBytes || totalBytes + body.byteLength > maxRunResponseBytes) {
        dropped += 1;
        captures.push({ url: response.url(), method: request.method(), status: response.status(), resourceType: request.resourceType(),
          contentType, bodyBytes: body.byteLength, jsonCaptured: false, omittedReason: "configured_size_limit",
          ...(requestInfo ? { requestInfo } : {}) });
        return;
      }
      totalBytes += body.byteLength;
      let jsonSummary = null;
      let parseError = null;
      try { jsonSummary = projectJson(JSON.parse(body.toString("utf8"))); }
      catch { parseError = "response_body_not_valid_json"; }
      const requestTiming = request.timing();
      const networkMs = Number.isFinite(requestTiming.responseEnd) && Number.isFinite(requestTiming.requestStart)
        ? Math.max(0, Math.round(requestTiming.responseEnd - requestTiming.requestStart)) : null;
      captures.push({ url: response.url(), method: request.method(), status: response.status(), resourceType: request.resourceType(),
        contentType, bodyBytes: body.byteLength, networkMs, jsonCaptured: jsonSummary !== null,
        ...(requestInfo ? { requestInfo } : {}),
        ...(parseError ? { parseError } : {}), ...(jsonSummary !== null ? { jsonSummary } : {}) });
      timings.record("api_response_capture", performance.now() - started, jsonSummary === null ? "partial" : "ok",
        { responseUrl: response.url(), responseStatus: response.status(), bodyBytes: body.byteLength, networkMs });
    })().catch((error) => {
      captures.push({ url: response.url(), method: request.method(), status: response.status(), resourceType: request.resourceType(),
        contentType, jsonCaptured: false, captureError: String(error?.message ?? error).slice(0, 200),
        ...(requestInfo ? { requestInfo } : {}) });
      timings.record("api_response_capture", performance.now() - started, "error", { responseUrl: response.url(), responseStatus: response.status() });
    }).finally(() => pending.delete(task));
    pending.add(task);
  });

  return {
    mark() { return captures.length; },
    async flush() { while (pending.size) await Promise.allSettled([...pending]); },
    since(mark = 0) { return captures.slice(mark); },
    all() { return [...captures]; },
    stats() { return { count: captures.length, jsonCount: captures.filter((item) => item.jsonCaptured).length,
      bodyBytes: totalBytes, omitted: dropped }; },
  };
}
