function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const OPTIONAL_HOOKS = [
  "applyFilters",
  "auditListingPage",
  "auditListingRequest",
  "buildFilteredSearchUrl",
  "chooseNecessaryCookies",
  "extractApiListings",
  "findListingResponse",
  "navigateNextPage",
  "nextPageAction",
  "prepareFilterPlan",
  "routeDetailResources",
  "shouldCaptureResponse",
  "shouldCaptureResponseBody",
  "submitUrlFilters",
  "waitForAppliedFiltersOnPage",
  "waitForDetailReady",
  "waitForListingPage",
  "waitForListingResponse",
];

const OPTIONAL_FLAGS = ["retryFilterSetupOnce"];

export function assertSourceAdapter(adapter, sourceId) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error(`Adapter źródła ${sourceId} nie eksportuje obiektu adaptera.`);
  }
  if (adapter.id !== sourceId) {
    throw new Error(`Adapter źródła ${sourceId} deklaruje niezgodne id: ${String(adapter.id)}.`);
  }
  for (const method of ["extractListings", "extractDetail"]) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`Adapter ${sourceId} nie implementuje wymaganej metody ${method}().`);
    }
  }
  for (const method of OPTIONAL_HOOKS) {
    if (adapter[method] !== undefined && typeof adapter[method] !== "function") {
      throw new Error(`Opcjonalny hook adaptera ${sourceId}.${method} musi być funkcją.`);
    }
  }
  for (const flag of OPTIONAL_FLAGS) {
    if (adapter[flag] !== undefined && typeof adapter[flag] !== "boolean") {
      throw new Error(`Opcjonalna flaga adaptera ${sourceId}.${flag} musi być wartością logiczną.`);
    }
  }
  return adapter;
}

function canonicalListingUrl(sourceId, value, index) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`Adapter ${sourceId}: wynik listy nr ${index + 1} nie ma poprawnego URL-a.`); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Adapter ${sourceId}: wynik listy nr ${index + 1} musi używać bezpiecznego URL-a HTTPS.`);
  }
  url.hash = "";
  return url.href;
}

export function normalizeSourceListings(sourceId, listings) {
  if (!Array.isArray(listings)) {
    throw new Error(`Adapter ${sourceId}: extractListings() musi zwrócić tablicę.`);
  }
  return listings.map((listing, index) => {
    if (!listing || typeof listing !== "object" || Array.isArray(listing)) {
      throw new Error(`Adapter ${sourceId}: wynik listy nr ${index + 1} musi być obiektem.`);
    }
    const visibleText = typeof listing.visibleText === "string" ? listing.visibleText.trim() : "";
    const title = (typeof listing.title === "string" ? listing.title.trim() : "") ||
      visibleText.split(/\r?\n/, 1)[0].trim().slice(0, 180);
    if (!title) throw new Error(`Adapter ${sourceId}: wynik listy nr ${index + 1} nie zawiera tytułu.`);
    const { sourceData: legacySourceData, ...rest } = listing;
    return {
      ...rest,
      sourceId,
      url: canonicalListingUrl(sourceId, listing.url, index),
      title,
      visibleText,
      sourceFields: record(listing.sourceFields ?? legacySourceData),
      sourceEvidence: record(listing.sourceEvidence ?? listing.apiEvidence),
    };
  });
}

export function normalizeSourceDetail(sourceId, detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new Error(`Adapter ${sourceId}: extractDetail() musi zwrócić obiekt karty.`);
  }
  if (typeof detail.bodyText !== "string") {
    throw new Error(`Adapter ${sourceId}: wynik extractDetail() musi zawierać bodyText typu string.`);
  }
  const { sourceData: legacySourceData, ...rest } = detail;
  return {
    ...rest,
    sourceId,
    title: typeof detail.title === "string" ? detail.title.trim() : "",
    bodyText: detail.bodyText,
    fields: record(detail.fields),
    structuredData: Array.isArray(detail.structuredData) ? detail.structuredData : [],
    ctas: Array.isArray(detail.ctas) ? detail.ctas : [],
    photos: Array.isArray(detail.photos) ? detail.photos : [],
    sourceFields: record(detail.sourceFields ?? legacySourceData),
    sourceEvidence: record(detail.sourceEvidence),
  };
}
