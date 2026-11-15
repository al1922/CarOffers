import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadSearchConfiguration, ROOT } from "../../config/load-search-config.mjs";
import { browserNavigationPolicy } from "./robots-policy.mjs";
import { assertSourceAdapter, normalizeSourceDetail, normalizeSourceListings } from "./adapter-contract.mjs";
import { classifyGenericCard } from "../shared/portal-card-classifier.mjs";
import { extractVisibleFields } from "../shared/portal-screening.mjs";
import { classifierFallbackFields, extractCandidateFields } from "../shared/candidate-field-extractor.mjs";
import { assessVehicleCondition } from "../shared/vehicle-condition.mjs";
import { attachResponseCapture } from "./response-capture.mjs";
import { normalizeRunResult } from "./result-normalizer.mjs";
import { groupModelsByMake, listingMatchesModel } from "./model-groups.mjs";
import { mapWithConcurrency } from "./parallel.mjs";
import { StageTimings } from "./timings.mjs";
import { engineAliasesForModel, profileForModel, requireConfiguredCriteria } from "./criteria.mjs";
import { apiFields, applyListingApiPrice, extractDetailEvidence, mergeListing, mergeListingSources } from "./listing-data.mjs";
import { isAccessDenied, isRequiredDataDenial, pageHasChallenge, persistTimings, selectedModels, splitOversizedModelGroups } from "./runner-helpers.mjs";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, "node_modules", ".cache", "ms-playwright");

export async function runDirectSearch(options) {
  const requestedModelKeys = options.modelKeys ?? (options.modelKey ? [options.modelKey] : []);
  const loaded = await loadSearchConfiguration(options.sourceId, requestedModelKeys);
  const sourceConfig = loaded.sourceConfig;
  const adapterOptions = loaded.adapterOptions;
  const config = { defaults: loaded.runtime.defaults };
  const adapterModule = await import(pathToFileURL(loaded.adapterPath).href);
  const adapter = Object.values(adapterModule).find((value) => value?.id === options.sourceId);
  if (!adapter) throw new Error(`Brak adaptera ${options.sourceId} pod ścieżką ${loaded.adapterPath}.`);
  assertSourceAdapter(adapter, options.sourceId);

  const models = selectedModels(loaded.models, options);
  const engineAliasesByModel = new Map();
  for (const model of models) {
    let knowledge = null;
    if (model.knowledgeFile) {
      try { knowledge = JSON.parse(await readFile(path.join(ROOT, model.knowledgeFile), "utf8")); }
      catch { knowledge = null; }
    }
    engineAliasesByModel.set(model.key, engineAliasesForModel(model, knowledge));
  }
  const groups = splitOversizedModelGroups(groupModelsByMake(models));
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "")}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(ROOT, "runs", "direct-search", runId);
  const resultsDir = path.join(runDir, "results");
  await mkdir(resultsDir, { recursive: true });
  const timings = new StageTimings();
  const runStartedAt = new Date().toISOString();
  const defaults = config.defaults ?? {};
  const sourceLimits = sourceConfig.limits ?? {};
  const maxPages = options.maxPages ?? sourceLimits.maxPages ?? defaults.maxPages ?? 2;
  const maxCardsPerModel = options.maxCards ?? sourceLimits.maxCards ?? defaults.maxCards ?? Number.POSITIVE_INFINITY;
  const hasMaxCardsPerModel = Number.isFinite(maxCardsPerModel);
  const detailConcurrency = options.detailConcurrency ?? sourceLimits.detailConcurrency ?? defaults.detailConcurrency ?? 3;
  const filterOnly = Boolean(options.filterOnly);
  const urlFilters = Boolean(options.urlFilters ?? (sourceConfig.filterMode === "url"));
  const origin = new URL(sourceConfig.searchUrl).origin;
  const runSummary = { schemaVersion: 1, runId, sourceId: options.sourceId, sourceName: sourceConfig.name,
    startedAt: runStartedAt, headless: options.headless, modelKeys: models.map((model) => model.key),
    filterOnly, filterMode: urlFilters ? "url" : "ui",
    searchGroups: [], sourceStatus: "pending", results: [], errors: [], networkWarnings: [] };
  let browser;
  let context;
  let sourceBlocked = false;
  let sourceUnavailable = false;
  let allowed;
  let cookieChoiceForContext;

  try {
    const { chromium } = await import("playwright");
    browser = await timings.measure("browser_launch", { sourceId: options.sourceId }, () => chromium.launch({ headless: options.headless }));
    context = await timings.measure("browser_context_create", { sourceId: options.sourceId }, () => browser.newContext());
    allowed = await timings.measure("robots_check", { sourceId: options.sourceId, url: sourceConfig.searchUrl },
      () => browserNavigationPolicy(context, sourceConfig.searchUrl, timings));
    if (!allowed(sourceConfig.searchUrl)) throw Object.assign(new Error("Adres wyszukiwania jest niedozwolony przez robots.txt."), { blocked: true });
    runSummary.sourceStatus = "ready";
  } catch (error) {
    sourceBlocked = Boolean(error?.blocked) || isAccessDenied(error?.status);
    sourceUnavailable = !sourceBlocked;
    runSummary.sourceStatus = sourceBlocked ? "blocked" : "unavailable";
    runSummary.errors.push({ url: sourceConfig.searchUrl, error: String(error?.message ?? error).split("\n")[0].slice(0, 300) });
  }

  let pendingGroupWork = null;
  const finalizeGroupWork = async (work) => {
    const detailResults = await work.detailPromise;
    timings.record("parallel_detail_batch", Date.now() - work.detailStartedAt,
      work.wasBlocked() || sourceBlocked ? "partial" : "ok",
      { ...work.groupTaskMetadata, listingsScheduled: work.inspectionTasks.length, detailConcurrency });

    const groupBlocked = work.wasBlocked() || sourceBlocked;
    const groupCoverageComplete = work.pages.length > 0 && work.pages.at(-1)?.nextUrl == null &&
      work.pages.at(-1)?.nextAction?.kind !== "unsupported" && work.errors.length === 0 && work.cappedModels.size === 0 && !groupBlocked;
    const filtersPassed = Boolean(work.pages.at(-1)?.filterAudit?.ok);
    const groupResult = { groupId: work.group.id, brand: work.group.brand, modelKeys: work.modelKeys,
      outcome: groupBlocked ? "blocked" : work.filterOnly ? filtersPassed ? "filters_passed" : "filters_failed" : groupCoverageComplete ? "completed" : "partial",
      ...(work.filterOnly ? { filterStatus: filtersPassed ? "passed" : "failed", filterAudit: work.pages.at(-1)?.filterAudit ?? null } : {}),
      pagesChecked: work.pages.length, listingsSeen: work.pages.reduce((sum, item) => sum + item.listings.length, 0),
      uniqueListings: work.uniqueListings.size, detailListingsScheduled: work.inspectionTasks.length, detailConcurrency,
      cappedModelKeys: [...work.cappedModels],
      detailsCompleted: (detailResults ?? []).filter((item) => item?.status === "ok").length };
    runSummary.searchGroups.push(groupResult);
    sourceBlocked ||= work.wasBlocked();
    for (const model of work.group.models) {
      const modelErrors = [...work.errors, ...work.errorsByModel.get(model.key)];
      const modelPages = work.pages.map((resultPage) => ({ ...resultPage,
        listings: resultPage.listings.filter((listing) => listingMatchesModel(listing, model)) }));
      const normalized = normalizeRunResult({ runId, sourceId: options.sourceId, sourceName: sourceConfig.name,
        startedAt: work.groupStartedAt, model, query: { make: work.group.brand, model: model.model, modelGroup: work.group.models.map((item) => item.model),
          applied: work.runContext.filtersApplied ?? {}, filterAudits: work.runContext.filterAudits,
          filterRetry: work.runContext.filterRetry ?? null, filterPlan: work.runContext.filterPlan, url: work.runContext.queryUrl ?? sourceConfig.searchUrl },
        pages: modelPages, candidates: work.candidatesByModel.get(model.key), errors: modelErrors, blocked: groupBlocked });
      const modelResult = { modelKey: model.key, outcome: normalized.outcome, pagesChecked: normalized.coverage.pagesChecked,
        listingsSeen: normalized.coverage.listingsSeen, listingsOpened: normalized.coverage.listingsOpened,
        offersQualified: normalized.coverage.offersQualified, coverageComplete: normalized.coverage.coverageComplete };
      runSummary.results.push(modelResult);
      runSummary.errors.push(...modelErrors.map((error) => ({ modelKey: model.key, ...error })));
      const resultPath = path.join(resultsDir, `${options.sourceId}--${model.key}.json`);
      await timings.measure("artifact_write_result", { sourceId: options.sourceId, modelKey: model.key, artifact: path.basename(resultPath) },
        () => writeFile(resultPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8"));
    }
    await persistTimings(timings, runDir);
  };

  for (const group of groups) {
    if (sourceBlocked || sourceUnavailable || !context) break;
    const modelKeys = group.models.map((model) => model.key);
    const errors = [];
    const pages = [];
    const groupStartedAt = new Date().toISOString();
    let page;
    let responseCapture;
    let blocked = false;
    let currentPageStatus = null;
    let pageCaptureMark = 0;
    let currentListingPageNumber = 1;
    const recordedDenialKeys = new Set();
    const groupTaskMetadata = { sourceId: options.sourceId, groupId: group.id, modelKeys };
    const recordNonCriticalDenials = (responses, context) => {
      for (const item of responses) {
        if (!isAccessDenied(item.status) || isRequiredDataDenial(adapter, item, context)) continue;
        const key = [context.phase, context.pageNumber ?? "", context.modelKeys?.join(",") ?? "",
          item.status, item.method ?? "", item.resourceType ?? "", item.url].join("|");
        if (recordedDenialKeys.has(key)) continue;
        recordedDenialKeys.add(key);
        runSummary.networkWarnings.push({ sourceId: options.sourceId, ...context, status: item.status,
          method: item.method ?? null, resourceType: item.resourceType ?? null,
          contentType: item.contentType ?? null, url: item.url });
      }
    };
    const runContext = { searchSubmitted: false, filterAudits: [], filterRetryAttempted: false,
      filterReadyTimeoutMs: defaults.filterReadyTimeoutMs ?? 3000,
      resultReadyTimeoutMs: defaults.resultReadyTimeoutMs ?? 8000, adapterOptions, urlFilters };
    runContext.filterPlan = await timings.measure("filter_plan_prepare", groupTaskMetadata,
      async () => adapter.prepareFilterPlan?.(group, runContext.adapterOptions) ?? null);

    try {
      page = await timings.measure("search_page_create", groupTaskMetadata, () => context.newPage());
      page.setDefaultNavigationTimeout(30000);
      page.setDefaultTimeout(10000);
      let lastNavigationStatus = null;
      page.on("response", (item) => {
        try {
          const request = item.request();
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) lastNavigationStatus = item.status();
        } catch { /* Ignore responses from detached frames. */ }
      });
      responseCapture = attachResponseCapture(page, { origin, timings, phase: "listing",
        shouldCaptureResponse: adapter.shouldCaptureResponse?.bind(adapter),
        shouldCaptureResponseBody: adapter.shouldCaptureResponseBody?.bind(adapter),
        maxResponseBytes: defaults.maxResponseBytes ?? 2097152, maxRunResponseBytes: defaults.maxRunResponseBytes ?? 20971520 });
      let searchUrl = sourceConfig.searchUrl;
      if (urlFilters) {
        if (!adapter.buildFilteredSearchUrl) throw new Error(`Adapter ${options.sourceId} nie obsługuje filtrów w URL.`);
        const built = adapter.buildFilteredSearchUrl(group, runContext.filterPlan, sourceConfig.searchUrl);
        searchUrl = built.url;
        runContext.filtersApplied = built.filtersApplied;
        runContext.filterPlan = built.filterPlan;
        runContext.queryUrl = searchUrl;
        if (!allowed(searchUrl)) throw Object.assign(new Error("Adres wyszukiwania z filtrami jest poza zakresem dozwolonym przez robots.txt."), { blocked: true });
      }
      const checkAccess = async () => {
        if (sourceBlocked) throw Object.assign(new Error("Poprzednia karta wykryła blokadę portalu; zatrzymano dalsze odczyty."), { blocked: true });
        await responseCapture.flush();
        if (isAccessDenied(lastNavigationStatus)) {
          throw Object.assign(new Error(`Nawigacja strony zwróciła HTTP ${lastNavigationStatus} pod adresem ${page.url()}; dalsze odczyty zatrzymano.`), { blocked: true });
        }
        const responseContext = { phase: "listing", pageNumber: currentListingPageNumber, modelKeys };
        const responses = responseCapture.since(pageCaptureMark);
        recordNonCriticalDenials(responses, responseContext);
        const deniedResponse = responses.find((item) => isAccessDenied(item.status) &&
          isRequiredDataDenial(adapter, item, responseContext));
        if (deniedResponse) {
          throw Object.assign(new Error(`Wymagane żądanie danych zwróciło HTTP ${deniedResponse.status}: ${deniedResponse.url}; dalsze odczyty zatrzymano.`), { blocked: true });
        }
        if (await pageHasChallenge(page)) {
          throw Object.assign(new Error("Strona wyświetliła zabezpieczenie lub challenge; dalsze odczyty zatrzymano."), { blocked: true });
        }
      };
      const reapplyFiltersFromCleanPage = async (reason) => {
        runContext.filterRetryAttempted = true;
        runContext.filterRetry = { attempt: 1, reason, startedAt: new Date().toISOString() };
        if (!allowed(sourceConfig.searchUrl)) {
          throw Object.assign(new Error("Ponowne ustawienie filtrów jest poza zakresem dozwolonym przez robots.txt."), { blocked: true });
        }
        const retryResponse = await timings.measure("filter_retry_navigation", { ...groupTaskMetadata, url: sourceConfig.searchUrl },
          () => page.goto(sourceConfig.searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 }));
        currentPageStatus = retryResponse?.status() ?? null;
        await responseCapture.flush();
        if (isAccessDenied(currentPageStatus)) {
          throw Object.assign(new Error(`Portal zwrócił HTTP ${currentPageStatus} przy ponownej próbie ustawienia filtrów; zatrzymano bez dalszych prób.`), { blocked: true });
        }
        await checkAccess();
        pageCaptureMark = responseCapture.mark();
        if (adapter.chooseNecessaryCookies) {
          const observedChoice = await timings.measure("cookie_choice_recheck", groupTaskMetadata,
            () => adapter.chooseNecessaryCookies(page, { waitForPrompt: false }));
          if (observedChoice !== "not_present") cookieChoiceForContext = observedChoice;
          runContext.cookieChoice = cookieChoiceForContext;
        }
        await timings.measure("filter_retry_apply", groupTaskMetadata,
          () => adapter.applyFilters(page, group, timings, runContext));
        runContext.queryUrl = page.url();
        runContext.filterRetry.completedAt = new Date().toISOString();
        await checkAccess();
      };

      pageCaptureMark = responseCapture.mark();
      const response = await timings.measure("search_navigation", { ...groupTaskMetadata, url: searchUrl, mode: urlFilters ? "url" : "ui" },
        () => page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 }));
      currentPageStatus = response?.status() ?? null;
      await responseCapture.flush();
      if (isAccessDenied(currentPageStatus)) throw Object.assign(new Error(`Portal zwrócił HTTP ${currentPageStatus}; zatrzymano bez ponowienia.`), { blocked: true });
      await checkAccess();

      if (cookieChoiceForContext === undefined) {
        cookieChoiceForContext = await timings.measure("cookie_choice", groupTaskMetadata, () => adapter.chooseNecessaryCookies(page));
      } else {
        const observedChoice = await timings.measure("cookie_choice_recheck", groupTaskMetadata,
          () => adapter.chooseNecessaryCookies(page, { waitForPrompt: false }));
        if (observedChoice !== "not_present") cookieChoiceForContext = observedChoice;
      }
      runContext.cookieChoice = cookieChoiceForContext;
      if (!urlFilters) pageCaptureMark = responseCapture.mark();
      Object.assign(runContext, { checkAccess });
      runContext.waitForAppliedFilters = async (timeoutMs = 2500) => {
        const captured = () => responseCapture.since(pageCaptureMark).some((item) => {
          if (!adapter.findListingResponse?.([item], 1)) return false;
          return Boolean(adapter.auditListingRequest?.([{ url: item.url }], group.models,
            runContext.filtersApplied ?? {}, 1, page.url())?.ok);
        });
        await responseCapture.flush();
        if (captured()) return true;
        const response = await page.waitForResponse((item) => {
          const url = item.url();
          if (!adapter.findListingResponse?.([{ url }], 1)) return false;
          return Boolean(adapter.auditListingRequest?.([{ url }], group.models,
            runContext.filtersApplied ?? {}, 1, page.url())?.ok);
        }, { timeout: timeoutMs }).catch(() => null);
        if (!response) return false;
        await responseCapture.flush();
        return captured();
      };
      runContext.waitForAnyListingPage = async (timeoutMs = 1500) => {
        const captured = () => responseCapture.since(pageCaptureMark).some((item) =>
          Boolean(adapter.findListingResponse?.([item], 1)));
        await responseCapture.flush();
        if (captured()) return true;
        if (!adapter.waitForListingResponse) return false;
        const response = await adapter.waitForListingResponse(page, 1, timeoutMs);
        if (!response) return false;
        await responseCapture.flush();
        return captured();
      };
      try {
        if (urlFilters) {
          runContext.queryUrl = page.url();
          const initialListingLoaded = await timings.measure("url_filter_initial_listing_wait", groupTaskMetadata, () =>
            adapter.waitForListingPage ? adapter.waitForListingPage(page, 1, 1500) : runContext.waitForAnyListingPage(1500));
          if (!initialListingLoaded) {
            await timings.measure("url_filter_submit", groupTaskMetadata,
              () => adapter.submitUrlFilters(page, runContext));
          }
          await timings.measure("url_filter_results_wait", groupTaskMetadata, () => adapter.waitForAppliedFiltersOnPage
            ? adapter.waitForAppliedFiltersOnPage(page, group.models, runContext.filtersApplied ?? {}, runContext.resultReadyTimeoutMs)
            : runContext.waitForAppliedFilters(runContext.resultReadyTimeoutMs));
        } else {
          await adapter.applyFilters(page, group, timings, runContext);
        }
      } catch (error) {
        if (!error?.retryableFilterSetup || !adapter.retryFilterSetupOnce || runContext.filterRetryAttempted) throw error;
        runContext.filterRepairMissing = error.filterAudit?.missing ?? [];
        await reapplyFiltersFromCleanPage(`filter_setup_timeout: ${String(error?.message ?? error).split("\n")[0]}`);
      }
      runContext.queryUrl = page.url();
      await checkAccess();

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        if (sourceBlocked) throw Object.assign(new Error("Poprzednia karta wykryła blokadę portalu; zatrzymano dalsze odczyty."), { blocked: true });
        currentListingPageNumber = pageIndex + 1;
        if (pageIndex > 0) {
          const previous = pages.at(-1);
          const action = previous?.nextAction;
          if (!action) break;
          if (action.kind === "unsupported") {
            errors.push({ url: page.url(), error: action.reason ?? "Nie można bezpiecznie ustalić adresu następnej strony." });
            break;
          }
          if (!allowed(action.url)) {
            errors.push({ url: action.url, error: "Następna strona jest poza zakresem dozwolonym przez robots.txt." });
            break;
          }
          pageCaptureMark = responseCapture.mark();
          const nextResponse = await timings.measure("pagination_navigation", { ...groupTaskMetadata, page: pageIndex + 1, url: action.url, kind: action.kind },
            () => adapter.navigateNextPage(page, action));
          if (action.kind === "url") currentPageStatus = nextResponse?.status() ?? null;
          else currentPageStatus = nextResponse?.status() ?? null;
          await responseCapture.flush();
          if (isAccessDenied(currentPageStatus)) {
            throw Object.assign(new Error(`Portal zwrócił HTTP ${currentPageStatus} przy pobieraniu strony ${pageIndex + 1}; zatrzymano bez ponowienia.`), { blocked: true });
          }
          if (action.kind === "button" && !nextResponse) {
            throw new Error(`Nie przechwycono odpowiedzi strony ${pageIndex + 1} po użyciu przycisku następnej strony.`);
          }
          const landed = new URL(page.url());
          if (landed.origin !== origin || (landed.searchParams.has("page") && Number(landed.searchParams.get("page")) !== pageIndex + 1)) {
            throw new Error(`Paginacja nie otworzyła oczekiwanej strony ${pageIndex + 1}: ${page.url()}`);
          }
        }

        const resultWaitMetadata = { ...groupTaskMetadata, page: pageIndex + 1 };
        const resultWaitStartedAt = Date.now();
        let resultsReady = false;
        try {
          if (pageIndex === 0 && runContext.firstListingResponsePromise) {
            resultsReady = Boolean(await runContext.firstListingResponsePromise);
          } else {
            resultsReady = Boolean(adapter.findListingResponse?.(responseCapture.since(pageCaptureMark), pageIndex + 1));
            if (!resultsReady && adapter.waitForListingPage) {
              resultsReady = Boolean(await adapter.waitForListingPage(page, pageIndex + 1, runContext.resultReadyTimeoutMs));
            } else if (!resultsReady && adapter.waitForListingResponse) {
              resultsReady = Boolean(await adapter.waitForListingResponse(page, pageIndex + 1, runContext.resultReadyTimeoutMs));
            } else if (!resultsReady && !adapter.waitForListingResponse) {
              await page.waitForSelector(adapter.listingSelector, { state: "attached", timeout: runContext.resultReadyTimeoutMs });
              resultsReady = true;
            }
          }
          await responseCapture.flush();
          resultsReady ||= Boolean(adapter.findListingResponse?.(responseCapture.since(pageCaptureMark), pageIndex + 1));
          timings.record("result_wait", Date.now() - resultWaitStartedAt, resultsReady ? "ok" : "timeout", resultWaitMetadata);
        } catch (error) {
          timings.record("result_wait", Date.now() - resultWaitStartedAt, "error", {
            ...resultWaitMetadata, error: String(error?.message ?? error).split("\n")[0].slice(0, 300) });
          throw error;
        }
        await checkAccess();
        let filterAudit = null;
        const pageData = await timings.measure("result_list_extract", { ...groupTaskMetadata, page: pageIndex + 1 }, async () => {
          const apiResponses = responseCapture.since(pageCaptureMark);
          filterAudit = adapter.auditListingPage
            ? await adapter.auditListingPage(page, group.models, runContext.filtersApplied ?? {}, pageIndex + 1, page.url())
            : adapter.auditListingRequest?.(apiResponses, group.models, runContext.filtersApplied ?? {}, pageIndex + 1, page.url()) ?? null;
          if (filterAudit) {
            runContext.filterAudits.push(filterAudit);
          }
          if (filterAudit && !filterAudit.ok) return [];
          const listingResponse = filterAudit?.requestUrl
            ? [...apiResponses].reverse().find((item) => item.url === filterAudit.requestUrl) : null;
          const apiListings = !filterOnly && adapter.extractApiListings
            ? adapter.extractApiListings(listingResponse ? [listingResponse] : []) : [];
          const visibleListings = filterOnly ? [] : await adapter.extractListings(page);
          return normalizeSourceListings(options.sourceId, mergeListingSources(apiListings, visibleListings))
            .map((listing) => ({ ...listing, searchFilterAudit: filterAudit }));
        });
        if (filterAudit && !filterAudit.ok) {
          if (pageIndex === 0 && !urlFilters && !runContext.filterRetryAttempted && adapter.retryFilterSetupOnce) {
            runContext.filterRepairMissing = [...filterAudit.missing];
            await reapplyFiltersFromCleanPage(`filter_audit_missing: ${filterAudit.missing.join(", ")}`);
            pageIndex = -1;
            continue;
          }
          errors.push({ url: page.url(), error: `Portal nie potwierdził filtrów na stronie ${pageIndex + 1}: ${filterAudit.missing.join(", ")}.` });
        }
        const pageApiResponses = responseCapture.since(pageCaptureMark).map((item) => ({ ...item }));
        const nextAction = await timings.measure("pagination_discovery", { ...groupTaskMetadata, page: pageIndex + 1 },
          () => adapter.nextPageAction ? adapter.nextPageAction(page) : null);
        pages.push({ url: page.url(), status: currentPageStatus, listings: pageData, nextUrl: nextAction?.url ?? null,
          nextAction, filterAudit, apiResponses: pageApiResponses });
        pageCaptureMark = responseCapture.mark();
        if (filterOnly) break;
        if (filterAudit && !filterAudit.ok) break;
      }
    } catch (error) {
      const message = String(error?.message ?? error).split("\n")[0].slice(0, 300);
      errors.push({ url: page?.url() || sourceConfig.searchUrl, error: message });
      blocked ||= Boolean(error?.blocked) || /HTTP (?:401|403|429)|ERR_BLOCKED|ERR_CERT_/i.test(message);
      sourceBlocked ||= blocked;
    } finally {
      await responseCapture?.flush();
      await page?.close().catch(() => {});
    }

    const uniqueListings = new Map();
    for (const resultPage of pages) {
      for (const listing of resultPage.listings) uniqueListings.set(listing.url, mergeListing(uniqueListings.get(listing.url), listing));
    }
    const listingsByModel = new Map();
    const cappedModels = new Set();
    for (const model of group.models) {
      const matches = [...uniqueListings.values()].filter((listing) => listingMatchesModel(listing, model));
      if (hasMaxCardsPerModel && matches.length > maxCardsPerModel) cappedModels.add(model.key);
      listingsByModel.set(model.key, hasMaxCardsPerModel ? matches.slice(0, maxCardsPerModel) : matches);
    }
    const listingModels = new Map();
    for (const model of group.models) {
      for (const listing of listingsByModel.get(model.key) ?? []) {
        const existing = listingModels.get(listing.url) ?? { listing, models: [] };
        existing.models.push(model);
        listingModels.set(listing.url, existing);
      }
    }

    const inspectionTasks = [...listingModels.values()].filter(({ listing }) => listing.searchFilterAudit?.ok !== false && allowed(listing.url));
    for (const listing of uniqueListings.values()) {
      if (listingModels.has(listing.url) && !allowed(listing.url)) {
        errors.push({ url: listing.url, error: "Karta jest poza zakresem dozwolonym przez robots.txt; pominięto." });
      }
    }
    const candidatesByModel = new Map(group.models.map((model) => [model.key, []]));
    const errorsByModel = new Map(group.models.map((model) => [model.key, []]));
    for (const modelKey of cappedModels) {
      errorsByModel.get(modelKey).push({ url: runContext.queryUrl ?? sourceConfig.searchUrl,
        error: `Limit kart (${maxCardsPerModel}) osiągnięty; lista zawiera więcej pasujących ofert, więc pokrycie modelu jest częściowe.` });
    }
    if (pendingGroupWork) {
      await pendingGroupWork.detailPromise;
      await finalizeGroupWork(pendingGroupWork);
      pendingGroupWork = null;
    }

    const detailStartedAt = Date.now();
    const detailPromise = sourceBlocked || blocked ? Promise.resolve([]) : mapWithConcurrency(inspectionTasks, detailConcurrency, async ({ listing, models: matchedModels }) => {
      if (sourceBlocked || blocked) return null;
      let detailPage;
      let detailCapture;
      const matchedKeys = matchedModels.map((model) => model.key);
      const metadata = { sourceId: options.sourceId, modelKeys: matchedKeys, url: listing.url };
      try {
        detailPage = await timings.measure("detail_page_create", metadata, () => context.newPage());
        detailPage.setDefaultNavigationTimeout(30000);
        detailPage.setDefaultTimeout(10000);
        if (adapter.routeDetailResources) {
          await timings.measure("detail_resource_routing", metadata,
            () => adapter.routeDetailResources(detailPage, { phase: "detail", sourceId: options.sourceId }));
        }
        let navigationStatus = null;
        detailPage.on("response", (item) => {
          try {
            const request = item.request();
            if (request.isNavigationRequest() && request.frame() === detailPage.mainFrame()) navigationStatus = item.status();
          } catch { /* Ignore responses from detached frames. */ }
        });
        detailCapture = attachResponseCapture(detailPage, { origin, timings, phase: "detail",
          shouldCaptureResponse: adapter.shouldCaptureResponse?.bind(adapter),
          shouldCaptureResponseBody: adapter.shouldCaptureResponseBody?.bind(adapter),
          maxResponseBytes: defaults.maxResponseBytes ?? 2097152, maxRunResponseBytes: defaults.maxRunResponseBytes ?? 20971520 });
        const responseMark = detailCapture.mark();
        const detailResponse = await timings.measure("listing_navigation", metadata,
          () => detailPage.goto(listing.url, { waitUntil: "domcontentloaded", timeout: 30000 }));
        const detailStatus = detailResponse?.status() ?? null;
        if (isAccessDenied(detailStatus) || isAccessDenied(navigationStatus)) {
          sourceBlocked = true;
          throw Object.assign(new Error(`Portal zwrócił HTTP ${detailStatus ?? navigationStatus}; dalsze karty zatrzymano bez ponawiania.`), { blocked: true });
        }
        if (await pageHasChallenge(detailPage)) {
          sourceBlocked = true;
          throw Object.assign(new Error("Karta wyświetliła zabezpieczenie; dalsze odczyty zatrzymano."), { blocked: true });
        }
        const detailWaitStartedAt = Date.now();
        try {
          const detailReady = adapter.waitForDetailReady
            ? await adapter.waitForDetailReady(detailPage, defaults.detailReadyTimeoutMs ?? 5000)
            : await detailPage.waitForSelector("h1", { state: "attached", timeout: defaults.detailReadyTimeoutMs ?? 5000 })
              .then(() => true).catch((error) => {
                if (error?.name === "TimeoutError") return false;
                throw error;
              });
          timings.record("listing_detail_wait", Date.now() - detailWaitStartedAt, detailReady ? "ok" : "timeout", metadata);
        } catch (error) {
          timings.record("listing_detail_wait", Date.now() - detailWaitStartedAt, "error", {
            ...metadata, error: String(error?.message ?? error).split("\n")[0].slice(0, 300) });
          throw error;
        }
        await detailCapture.flush();
        const detailResponseContext = { phase: "detail", modelKeys: matchedKeys };
        const detailResponsesCaptured = detailCapture.all();
        recordNonCriticalDenials(detailResponsesCaptured, detailResponseContext);
        const deniedResponse = detailResponsesCaptured.find((item) => isAccessDenied(item.status) &&
          isRequiredDataDenial(adapter, item, detailResponseContext));
        if (deniedResponse) {
          sourceBlocked = true;
          throw Object.assign(new Error(`Wymagane żądanie danych karty zwróciło HTTP ${deniedResponse.status}: ${deniedResponse.url}; dalsze karty zatrzymano bez ponawiania.`), { blocked: true });
        }
        if (await pageHasChallenge(detailPage)) {
          sourceBlocked = true;
          throw Object.assign(new Error("Karta wyświetliła zabezpieczenie; dalsze odczyty zatrzymano."), { blocked: true });
        }
        const detail = normalizeSourceDetail(options.sourceId,
          await timings.measure("listing_detail_extract", metadata, () => adapter.extractDetail(detailPage)));
        const detailResponses = detailCapture.since(responseMark);
        const detailEvidence = extractDetailEvidence(detail.bodyText);
        const card = { ...detail, salePanel: detail.salePanel ?? detailEvidence.salePanel,
          fields: { ...detailEvidence.fields, ...apiFields(detailResponses), ...detail.fields } };
        const classificationCard = { ...card,
          bodyText: card.bodyText.replace(/odwiedź nasze pozostałe aukcje/gi, "pozostałe oferty sprzedawcy") };
        const inspected = [];
        for (const model of matchedModels) {
          const engineAliases = engineAliasesByModel.get(model.key) ?? [];
          const task = profileForModel(model, options.sourceId, engineAliases);
          const extraction = extractCandidateFields({ sourceId: options.sourceId, listing, detail: classificationCard,
            engineAliases, requiredFields: model.fieldPolicy?.required });
          const conditionAssessment = assessVehicleCondition({ sourceId: options.sourceId, listing, detail: classificationCard });
          const fallbackFields = classifierFallbackFields(extraction);
          const cardWithExtractedFields = { ...classificationCard,
            sourceFields: { ...classificationCard.sourceFields, ...fallbackFields } };
          let classification = await timings.measure("listing_classification", { ...metadata, modelKey: model.key },
            async () => classifyGenericCard(listing, cardWithExtractedFields, task, new Date().toISOString()));
          classification = applyListingApiPrice(classification, listing);
          if (classification.status === "available" && listing.searchFilterAudit && !listing.searchFilterAudit.ok) {
            classification = { status: "unverified", note: `Nie potwierdzono filtrów portalu: ${listing.searchFilterAudit.missing.join(", ")}.` };
          }
          if (conditionAssessment.isDamaged === true) {
            const evidence = conditionAssessment.evidence?.value;
            classification = { status: "rejected", note: `Wykryto informację o uszkodzeniu pojazdu${evidence ? `: „${evidence}”` : "."}` };
          }
          classification = requireConfiguredCriteria(classification, model, extraction);
          const candidate = { url: listing.url, title: listing.title, detailStatus, detail, extraction, conditionAssessment,
            listingEvidence: { ...extractVisibleFields(`${listing.visibleText ?? ""}\n${detail.bodyText}`),
              displayedPriceText: card.salePanel?.price ?? detailEvidence.visibleFields.displayedPriceText,
              ...(Number.isFinite(listing.apiPriceAmount) ? { apiPriceAmount: listing.apiPriceAmount } : {}) },
            listingMatch: { modelKey: model.key, matchedBy: "exact_model_token_in_listing" },
            sourcePayload: {
              [options.sourceId]: {
                listingFields: listing.sourceFields,
                detailFields: detail.sourceFields,
                listingEvidence: listing.sourceEvidence,
                detailEvidence: detail.sourceEvidence,
              },
            },
            apiResponses: detailResponses, classification };
          candidatesByModel.get(model.key).push(candidate);
          inspected.push({ modelKey: model.key, status: classification.status });
        }
        return { url: listing.url, status: "ok", models: inspected };
      } catch (error) {
        const message = String(error?.message ?? error).split("\n")[0].slice(0, 300);
        if (error?.blocked) sourceBlocked = true;
        for (const model of matchedModels) errorsByModel.get(model.key).push({ url: listing.url, error: message });
        timings.record("listing_processing", 0, error?.blocked ? "blocked" : "error", metadata);
        return { url: listing.url, status: error?.blocked ? "blocked" : "error", error: message };
      } finally {
        await detailCapture?.flush();
        await detailPage?.close().catch(() => {});
      }
    }, () => sourceBlocked || blocked);
    pendingGroupWork = { group, modelKeys, groupStartedAt, groupTaskMetadata, pages, errors, blocked,
      runContext, filterOnly, uniqueListings, inspectionTasks, cappedModels, candidatesByModel, errorsByModel,
      detailStartedAt, detailPromise, wasBlocked: () => blocked };
  }

  if (pendingGroupWork) await finalizeGroupWork(pendingGroupWork);

  if (browser) await timings.measure("browser_close", { sourceId: options.sourceId }, () => browser.close());
  runSummary.completedAt = new Date().toISOString();
  if (sourceBlocked) runSummary.sourceStatus = "blocked";
  if (sourceBlocked) runSummary.outcome = "blocked";
  else if (sourceUnavailable) runSummary.outcome = "unavailable";
  else if (filterOnly) {
    runSummary.outcome = runSummary.searchGroups.length > 0 && runSummary.searchGroups.every((group) => group.filterStatus === "passed")
      ? "completed" : "partial";
  } else {
    runSummary.outcome = runSummary.errors.length || runSummary.results.some((result) => result.outcome === "partial")
      ? "partial" : "completed";
  }
  runSummary.timings = timings.report().stageTotals;
  await timings.measure("artifact_write_run_summary", { artifact: "run.json" }, () =>
    writeFile(path.join(runDir, "run.json"), `${JSON.stringify(runSummary, null, 2)}\n`, "utf8"));
  await persistTimings(timings, runDir);
  return { runDir, runSummary, timings: timings.report() };
}
