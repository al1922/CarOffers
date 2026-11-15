export function normalizeRunResult({ runId, sourceId, sourceName, startedAt, model, query, pages, candidates, errors, blocked }) {
  const offers = candidates.filter((item) => item.classification.status === "available").map((item) => item.classification.offer);
  const coverageComplete = !blocked && errors.length === 0 && pages.length > 0 && pages.at(-1)?.nextUrl == null;
  return {
    schemaVersion: 1,
    runId,
    sourceId,
    sourceName,
    modelKey: model.key,
    modelName: model.name,
    generatedAt: new Date().toISOString(),
    startedAt,
    outcome: blocked ? "blocked" : errors.length || !coverageComplete ? "partial" : "completed",
    query,
    coverage: {
      pagesChecked: pages.length,
      listingsSeen: pages.reduce((sum, page) => sum + page.listings.length, 0),
      listingsOpened: candidates.length,
      offersQualified: offers.length,
      coverageComplete,
      pages: pages.map(({ url, status, listings, nextUrl, filterAudit, apiResponses }) => ({ url, status, listingCount: listings.length,
        listingUrls: listings.map((item) => item.url), nextUrl, filterAudit: filterAudit ?? null, apiResponses })),
    },
    candidates,
    offers,
    errors,
  };
}
