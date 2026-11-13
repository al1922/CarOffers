#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCardReader, createHtmlCardReader, navigationForVerification, screenListing, verifyListings } from "./sprzedajemy-verify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, "node_modules", ".cache", "ms-playwright");
const { chromium } = await import("playwright");
const HELP = `Usage:
  node scripts/sprzedajemy-search.mjs --model-key <active-model-key> [--model-key <key> ...]
       [--max-pages <n>]
  python -B scripts/car-search.py claim ... | node scripts/sprzedajemy-search.mjs --claim-stdin
       [--verify] [--max-pages <n>] [--max-cards <n>] [--card-reader html|browser]

For routine portal searches, use the shared entry point: npm run search:portal -- --claim-stdin.
Builds make/model result URLs only from visible category links on Sprzedajemy,
then captures visible result cards and follows the visible "Następna" link.
With --claim-stdin it uses the claimed task's frozen search profile. By default
it emits a list snapshot. With --verify it screens and checks cards and emits
a standard worker result on stdout. HTML is the default card reader, with a
browser fallback. The caller controls validation and import.
`;

function parseArgs(argv) {
  const options = { modelKeys: [], maxPages: null, maxCards: null, claimStdin: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--model-key") options.modelKeys.push(argv[++i]);
    else if (arg === "--max-pages") options.maxPages = Number(argv[++i]);
    else if (arg === "--max-cards") options.maxCards = Number(argv[++i]);
    else if (arg === "--card-reader") {
      options.cardReader = argv[++i];
      if (!["html", "browser"].includes(options.cardReader)) throw new Error("--card-reader expects html or browser");
    }
    else if (arg === "--claim-stdin") options.claimStdin = true;
    else if (arg === "--verify") options.verify = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.help) return options;
  if (options.claimStdin === Boolean(options.modelKeys.length) || options.modelKeys.some((key) => !key)) {
    throw new Error("Provide either --claim-stdin or one or more --model-key options");
  }
  if ((options.verify && !options.claimStdin) || (options.maxCards !== null && !options.verify)) {
    throw new Error("--verify requires --claim-stdin; --max-cards requires --verify");
  }
  if (options.cardReader && !options.verify) throw new Error("--card-reader requires --verify");
  options.cardReader ??= "html";
  options.maxPages ??= options.verify ? 100 : 1;
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 100) {
    throw new Error("--max-pages must be an integer between 1 and 100");
  }
  if (options.maxCards !== null && (!Number.isSafeInteger(options.maxCards) || options.maxCards < 1)) {
    throw new Error("--max-cards must be a positive integer");
  }
  options.modelKeys = [...new Set(options.modelKeys)];
  return options;
}

const normalizeLabel = (label) => String(label ?? "")
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .replace(/\s*\(\s*[\d\s.,]+\s*\)\s*$/, "")
  .toLocaleLowerCase("pl-PL")
  .replace(/[^a-z0-9]/g, "");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
}

async function readClaimFromStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

async function readContinuationResult(task) {
  const runId = task.runId ?? "";
  const continuation = task.continuation ?? {};
  const sourceTaskId = continuation.sourceTaskId ?? "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(runId) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(sourceTaskId)) {
    throw new Error("Continuation is missing a valid runId or sourceTaskId");
  }
  const base = new URL(task.searchProfile?.searchUrl ?? "");
  const next = new URL(continuation.nextUrl ?? "");
  if (next.protocol !== "https:" || next.origin !== base.origin) {
    throw new Error("Continuation URL must use HTTPS on the configured portal origin");
  }
  const previous = task.workerContinuationSourceResult ?? await readJson(`runs/${runId}/results/${sourceTaskId}.json`);
  const saved = (previous.coverage?.searchResults ?? []).find((page) => page &&
    (page.queryId ?? "unfiltered") === continuation.queryId && page.nextUrl === continuation.nextUrl);
  if (previous.taskId !== sourceTaskId || previous.outcome !== "partial" || !saved ||
      saved.nextUrlAllowed === false || saved.paginationComplete === true) {
    throw new Error("Saved partial result does not contain this resumable nextUrl");
  }
  const denied = (previous.errors ?? []).some((entry) => entry?.url === continuation.nextUrl &&
    /403|429|captcha|robots?\.txt|access denied|forbidden|challenge|niedozwol/i.test(entry.error ?? ""));
  if (denied) {
    throw new Error("Saved nextUrl was explicitly denied; it will not be retried");
  }
  return previous;
}

async function visibleCategoryLinks(page, baseUrl) {
  return page.evaluate((prefix) => [...document.querySelectorAll("a[href]")]
    .map((anchor) => ({ text: (anchor.innerText ?? "").trim(), url: anchor.href }))
    .filter((link) => {
      try {
        const parsed = new URL(link.url);
        return parsed.origin === location.origin && parsed.pathname.startsWith(prefix) && link.text;
      } catch { return false; }
    }), new URL(baseUrl).pathname.replace(/\/$/, "") + "/");
}

async function resolveModelUrls(page, source, models, navigate) {
  const categoryRoot = new URL(source.searchUrl).origin + "/motoryzacja/samochody-osobowe";
  await navigate(source.searchUrl);
  const rootLinks = await visibleCategoryLinks(page, categoryRoot);
  const brandUrls = new Map();
  for (const model of models) {
    if (brandUrls.has(model.brand)) continue;
    const brandMatches = [...new Set(rootLinks
      .filter((link) => normalizeLabel(link.text) === normalizeLabel(model.brand))
      .map((link) => link.url))];
    if (brandMatches.length !== 1) {
      throw new Error(`Could not uniquely resolve visible brand category for ${model.brand}`);
    }
    brandUrls.set(model.brand, brandMatches[0]);
  }

  const modelLinksByBrand = new Map();
  for (const [brand, brandUrl] of brandUrls) {
    await navigate(brandUrl);
    modelLinksByBrand.set(brand, await visibleCategoryLinks(page, brandUrl));
  }

  const resolved = new Map();
  for (const model of models) {
    const matches = [...new Set((modelLinksByBrand.get(model.brand) ?? [])
      .filter((link) => normalizeLabel(link.text) === normalizeLabel(model.model))
      .map((link) => link.url))];
    if (matches.length !== 1) {
      throw new Error(`Could not uniquely resolve visible ${model.brand} ${model.model} category`);
    }
    resolved.set(model.key, matches[0]);
  }
  return resolved;
}

async function captureVisibleListings(page) {
  return page.evaluate(() => [...document.querySelectorAll("article.element")].flatMap((article) => {
    const anchor = article.querySelector("a.offerLink[href]");
    if (!anchor) return [];
    const title = article.querySelector("h2.title a")?.getAttribute("title")
      ?.replace(/^zobacz szczegóły ogłoszenia\s+/i, "").trim() ||
      article.querySelector("h2.title")?.innerText?.trim() || anchor.innerText.trim();
    return [{
      title,
      url: anchor.href,
      visibleText: (article.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 1200),
    }];
  }));
}

async function nextResultsPageUrl(page, currentUrl) {
  const next = await page.evaluate(() => {
    const rel = document.querySelector("link[rel=next][href], a[rel=next][href]");
    if (rel) return rel.href;
    return [...document.querySelectorAll("a[href]")].find((anchor) =>
      /^następna$/i.test(anchor.innerText.trim()))?.href;
  });
  if (!next) return null;
  return new URL(next, currentUrl).href;
}

function paginationUrlIsValid(candidate, currentUrl) {
  if (!candidate) return false;
  try {
    const next = new URL(candidate, currentUrl);
    const current = new URL(currentUrl);
    return next.protocol === "https:" && next.origin === current.origin && next.pathname === current.pathname;
  } catch { return false; }
}

async function searchModel(page, model, searchUrl, maxPages, sharedCache, navigate, profile, queryId, priorPages = []) {
  const pages = [];
  const seenPageUrls = new Set(priorPages.filter((item) => item?.queryId === queryId).map((item) => item.url));
  const seenListingUrls = new Set();
  const cachedPageMap = new Map((sharedCache.checkedSearchPages ?? [])
    .filter((entry) => entry?.url)
    .map((entry) => [entry.url, entry]));
  const cachedListingsByPage = new Map();
  for (const listing of sharedCache.visibleListings ?? []) {
    if (!listing?.pageUrl || !listing?.url) continue;
    const bucket = cachedListingsByPage.get(listing.pageUrl) ?? [];
    bucket.push(listing);
    cachedListingsByPage.set(listing.pageUrl, bucket);
  }
  let currentUrl = searchUrl;
  let remaining = "";
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    if (seenPageUrls.has(currentUrl)) {
      remaining = "Paginacja wskazuje ponownie odwiedzoną stronę.";
      break;
    }
    if (profile && !navigate.isAllowed(currentUrl)) {
      return { modelKey: model.key, modelName: model.name, searchUrl,
        outcome: pages.length ? "partial" : "blocked",
        coverage: makeCoverage(pages, "Adres strony niedozwolony przez robots.txt; dalsza nawigacja zatrzymana."),
        error: "Adres strony niedozwolony przez robots.txt; dalsza nawigacja zatrzymana.",
        errorUrl: currentUrl, stopCards: true,
        remaining: "Adres strony niedozwolony przez robots.txt; dalsza nawigacja zatrzymana." };
    }
    seenPageUrls.add(currentUrl);
    const cacheCandidate = cachedPageMap.get(currentUrl);
    const cachedPage = cacheCandidate?.listingsComplete === true ? cacheCandidate : null;
    if (cachedPage) {
      const cachedListings = cachedListingsByPage.get(currentUrl) ?? [];
      const pageListings = cachedListings.filter((listing) => /^https:\/\//i.test(listing.url)).map((listing) => {
        const duplicateOfEarlierPage = seenListingUrls.has(listing.url);
        seenListingUrls.add(listing.url);
        return {
          title: listing.title ?? "",
          url: listing.url,
          visibleText: listing.visibleText ?? listing.snippet ?? "",
          ...(listing.visibleFields ? { visibleFields: listing.visibleFields } : {}),
          duplicateOfEarlierPage,
          reusedFromTaskId: listing.taskId ?? cachedPage.taskId ?? null,
        };
      });
      const cachedNextAllowed = paginationUrlIsValid(cachedPage.nextUrl, currentUrl) &&
        cachedPage.nextUrlAllowed !== false && (!profile || navigate.isAllowed(cachedPage.nextUrl));
      pages.push({
        url: currentUrl,
        checkedAt: cachedPage.checkedAt ?? null,
        status: null,
        pageNumber,
        fromSharedCache: true,
        listings: pageListings,
        queryId,
        paginationComplete: cachedPage.paginationComplete === true,
        nextUrl: paginationUrlIsValid(cachedPage.nextUrl, currentUrl) ? cachedPage.nextUrl : null,
        ...(cachedPage.nextUrl ? { nextUrlAllowed: cachedNextAllowed } : {}),
      });
      if (!cachedNextAllowed) {
        if (!cachedPage.paginationComplete) {
          remaining = cachedPage.nextUrl
            ? "Następny URL z cache jest niedozwolony lub niezgodny z paginacją; dalsza nawigacja zatrzymana."
            : "Wykorzystano migawkę bez potwierdzenia końca paginacji.";
        }
        break;
      }
      currentUrl = new URL(cachedPage.nextUrl, currentUrl).href;
      if (pageNumber === maxPages) {
        remaining = `Pominięto dalsze strony po limicie ${maxPages}; dostępny kolejny URL: ${currentUrl}`;
      }
      continue;
    }
    let response;
    try {
      response = await navigate(currentUrl);
      if (profile && new URL(page.url()).pathname !== new URL(currentUrl).pathname) {
        throw new Error("Portal przekierował poza oczekiwaną ścieżkę wyników.");
      }
    } catch (error) {
      return {
        modelKey: model.key,
        modelName: model.name,
        searchUrl,
        outcome: error.blocked && pages.length === 0 ? "blocked" : "partial",
        coverage: makeCoverage(pages, "Nie udało się odczytać pełnego zakresu; nie traktuj tego jako braku ofert."),
        error: String(error?.message ?? error).slice(0, 500),
        errorUrl: currentUrl,
        stopCards: Boolean(error.blocked) || /ERR_CERT_|ERR_NAME_NOT_RESOLVED/i.test(error.message),
        remaining: "Nie udało się odczytać pełnego zakresu; nie traktuj tego jako braku ofert.",
      };
    }
    const status = response?.status() ?? null;
    const checkedAt = new Date().toISOString();
    if (status === 401 || status === 403 || status === 429) {
      return {
        modelKey: model.key,
        modelName: model.name,
        searchUrl,
        outcome: "blocked",
        coverage: makeCoverage(pages, "Dostęp zablokowany; brak danych nie oznacza braku ofert."),
        error: `Portal returned HTTP ${status}; no retry or bypass attempted.`,
        errorUrl: currentUrl,
        remaining: "Dostęp zablokowany; brak danych nie oznacza braku ofert.",
      };
    }
    const listings = await captureVisibleListings(page);
    const pageListings = listings.filter((listing) => /^https:\/\//i.test(listing.url) && listing.title).map((listing) => {
      const duplicateOfEarlierPage = seenListingUrls.has(listing.url);
      seenListingUrls.add(listing.url);
      return { ...listing, duplicateOfEarlierPage, ...(profile ? screenListing(listing, profile) : {}) };
    });
    let nextUrl;
    let nextUrlAllowed = null;
    try {
      nextUrl = await nextResultsPageUrl(page, page.url());
      if (nextUrl && !paginationUrlIsValid(nextUrl, page.url())) {
        nextUrlAllowed = false;
        remaining = "Nie rozpoznano ścieżki następnej strony.";
      } else if (nextUrl && profile && !navigate.isAllowed(nextUrl)) {
        nextUrlAllowed = false;
        remaining = "Adres następnej strony jest niedozwolony przez robots.txt lub prowadzi poza portal.";
      } else if (nextUrl) {
        nextUrlAllowed = true;
      }
    } catch (error) {
      remaining = error.message;
    }
    const empty = profile && !pageListings.length && await page.locator("#layPublicOfferListWrp").first()
      .innerText({ timeout: 1500 }).then((text) =>
        /(?:nie znaleziono|brak)\s+(?:(?:żadnych|pasujących)\s+)*(?:ogłoszeń|ofert|wyników)/i.test(text))
      .catch(() => false);
    if (profile && !pageListings.length && !empty) remaining ||= "Brak rozpoznanej listy lub komunikatu o braku ogłoszeń.";
    pages.push({
      url: page.url(),
      checkedAt,
      status,
      pageNumber,
      fromSharedCache: false,
      listings: pageListings,
      nextUrl,
      ...(nextUrl ? { nextUrlAllowed } : {}),
      queryId,
      paginationComplete: !remaining && !nextUrl && Boolean(pageListings.length || empty),
    });
    if (!nextUrl || remaining) break;
    if (pageNumber === maxPages) {
      remaining = `Pominięto dalsze strony po limicie ${maxPages}; dostępny kolejny URL: ${nextUrl}`;
      break;
    }
    currentUrl = nextUrl;
  }

  if (!profile) {
    const note = "Migawka ścieżki marki/modelu. Nie sprawdzano kart ani osobnych zapytań z queryPlan.";
    remaining = [remaining, note].filter(Boolean).join(" ");
  }
  return {
    modelKey: model.key,
    modelName: model.name,
    searchUrl,
    outcome: remaining ? "partial" : "complete",
    coverage: makeCoverage(pages, remaining),
    uniqueListingCount: seenListingUrls.size,
    remaining,
  };
}

function makeCoverage(pages, remaining) {
  return {
    searchUrls: [...new Set(pages.map((page) => page.url))],
    pagesChecked: pages.length,
    remaining,
    searchResults: pages.map(({ url, checkedAt, listings, nextUrl, nextUrlAllowed, fromSharedCache, queryId, paginationComplete }) => ({
      url, checkedAt, listings, ...(nextUrl ? { nextUrl } : {}), ...(nextUrl ? { nextUrlAllowed } : {}), ...(fromSharedCache ? { fromSharedCache } : {}),
      ...(queryId ? { queryId, paginationComplete } : {}),
    })),
    listingUrlsChecked: [],
  };
}

async function searchPlan(page, model, searchUrl, maxPages, cache, navigate, profile, task, continuationResult) {
  if (task?.continuation && continuationResult) {
    const continuation = task.continuation;
    const previousPages = continuationResult.coverage?.searchResults ?? [];
    const current = navigate.isAllowed(continuation.nextUrl)
      ? await searchModel(page, model, continuation.nextUrl, maxPages, cache, navigate, profile, continuation.queryId, previousPages)
      : { outcome: "blocked", remaining: "Zapisany adres kontynuacji jest niedozwolony przez robots.txt.",
          error: "Adres kontynuacji niedozwolony przez robots.txt.", errorUrl: continuation.nextUrl,
          coverage: makeCoverage([], "Adres kontynuacji niedozwolony przez robots.txt.") };
    const newPages = current.coverage?.searchResults ?? [];
    const pages = [...previousPages, ...newPages];
    const queryIds = [...new Set(["category", ...(profile.queryPlan?.textQueries ?? []).map((query) => query.id),
      ...pages.map((item) => item.queryId).filter(Boolean)])];
    const queryChecks = queryIds.map((queryId) => {
      const queryPages = pages.filter((item) => (item.queryId ?? "category") === queryId);
      const last = queryPages.at(-1);
      const complete = Boolean(last?.paginationComplete === true);
      const remaining = complete ? "" : last?.nextUrlAllowed === false
        ? "Następny adres jest niedozwolony przez robots.txt."
        : last?.nextUrl ? `Pozostał kolejny URL: ${last.nextUrl}`
          : "Nie ma dowodu pełnego zakończenia zapytania.";
      return { queryId, outcome: complete ? "complete" : queryId === continuation.queryId ? current.outcome : "partial",
        remaining, pages: queryPages.length, complete };
    });
    const remaining = queryChecks.filter((item) => !item.complete)
      .map((item) => `${item.queryId}: ${item.remaining}`).join(" ");
    const errors = [...(continuationResult.errors ?? []), ...(current.error
      ? [{ url: current.errorUrl ?? continuation.nextUrl, error: current.error }] : [])];
    return { searchUrl, coverage: makeCoverage(pages, remaining), queryChecks,
      outcome: current.outcome === "blocked" ? "blocked" : remaining ? "partial" : "complete",
      stopCards: Boolean(current.stopCards), errors };
  }
  const results = [await searchModel(page, model, searchUrl, maxPages, cache, navigate, profile, "category")];
  const queries = profile.queryPlan.textQueries;
  for (const query of queries) {
    const previous = results.at(-1);
    if (previous.stopCards || previous.outcome === "blocked" || previous.outcome === "not_run") {
      results.push({ queryId: query.id, outcome: "not_run", remaining: "Wcześniejsza blokada ścieżki wyszukiwania." });
      continue;
    }
    // The portal publishes /temat links and uses this encoding for its public
    // description search. Navigation still checks the portal's robots.txt.
    const phrase = encodeURIComponent(query.text).replace(/%20/g, "+");
    const url = new URL("/temat/" + phrase, searchUrl).href;
    const result = await searchModel(page, model, url, maxPages, cache, navigate, profile, query.id);
    results.push({ ...result, queryId: query.id });
  }
  const pages = results.flatMap((result) => result.coverage?.searchResults ?? []);
  const queryChecks = results.map(({ queryId = "category", outcome, remaining, coverage }) =>
    ({ queryId, outcome, remaining, pages: coverage?.pagesChecked ?? 0 }));
  const remaining = queryChecks.filter((item) => item.remaining).map((item) => item.queryId + ": " + item.remaining).join(" ");
  return {
    searchUrl, coverage: makeCoverage(pages, remaining), queryChecks,
    outcome: results[0].outcome === "blocked" ? "blocked" : remaining ? "partial" : "complete",
    stopCards: results.some((item) => item.stopCards),
    errors: results.filter((item) => item.error).map((item) => ({ url: item.errorUrl ?? searchUrl, error: item.error })),
  };
}

function modelFromClaim(task) {
  if (!task || task.kind !== "search" || task.state !== "running" || !task.worker) {
    throw new Error("--claim-stdin expects the JSON object printed by a successful search claim");
  }
  if (task.sourceId !== "sprzedajemy") {
    throw new Error(`Claim is for ${task.sourceId}; this adapter only supports sprzedajemy`);
  }
  const profile = task.searchProfile;
  const brand = profile?.brands?.[0];
  const query = profile?.queryPlan;
  const modelName = query?.nativeFilters?.model ?? query?.manualFilters?.model;
  if (!task.modelKey || !profile?.searchUrl || !brand || !modelName) {
    throw new Error("Claim is missing modelKey or the frozen searchProfile brand/model/searchUrl");
  }
  return {
    source: { id: task.sourceId, searchUrl: profile.searchUrl },
    model: { key: task.modelKey, name: `${brand} ${modelName}`, brand, model: modelName },
  };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error.message}\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  try {
    let source;
    let models;
    let taskId = null;
    let task;
    let sharedResultsCache = {};
    if (options.claimStdin) {
      task = await readClaimFromStdin();
      const claimed = modelFromClaim(task);
      source = claimed.source;
      models = [claimed.model];
      taskId = task.id;
      sharedResultsCache = task.sharedResultsCache ?? {};
    } else {
      const [sourcesConfig, modelsConfig] = await Promise.all([
        readJson("config/sources.json"),
        readJson("config/search-models.json"),
      ]);
      source = sourcesConfig.sources.find((item) => item.id === "sprzedajemy" && item.enabled);
      const allModels = modelsConfig.models.filter((item) => item.active);
      models = options.modelKeys.map((key) => {
        const model = allModels.find((item) => item.key === key);
        if (!model) throw new Error(`Unknown or inactive model key: ${key}`);
        return model;
      });
      if (!source) throw new Error("Sprzedajemy is not enabled in config/sources.json");
    }

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const started = performance.now();
      let navigate;
      let resolvedUrls;
      let continuationResult = null;
      try {
        navigate = options.verify
          ? await navigationForVerification(context, page, source.searchUrl)
          : (url) => page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (options.verify && task?.continuation) {
          continuationResult = await readContinuationResult(task);
          resolvedUrls = new Map([[models[0].key, task.continuation.nextUrl]]);
        } else {
          resolvedUrls = await resolveModelUrls(page, source, models, navigate);
        }
      } catch (error) {
        if (!options.verify) throw error;
        process.stdout.write(JSON.stringify({
          taskId, checkedAt: new Date().toISOString(), outcome: error.blocked ? "blocked" : "partial",
          coverage: makeCoverage([], "Nie udało się otworzyć kategorii modelu."),
          offers: [], errors: [{ url: error.url ?? source.searchUrl, error: error.message }],
        }, null, 2) + "\n");
        return;
      }
      if (options.verify) {
        const model = models[0];
        const snapshot = await searchPlan(page, model, resolvedUrls.get(model.key), options.maxPages,
          sharedResultsCache, navigate, task.searchProfile, task, continuationResult);
        let htmlReader;
        const readHtml = options.cardReader === "html" ? async (url) => {
          htmlReader ??= createHtmlCardReader(context, await context.newPage(), navigate.isAllowed);
          return htmlReader(url);
        } : undefined;
        const readCard = createCardReader(navigate, page, readHtml);
        const result = await verifyListings({ root: ROOT, task, snapshot, readCard,
          maxCards: options.maxCards, listMs: Math.round(performance.now() - started) });
        if (continuationResult) {
          const priorUrls = new Set([...(task.continuation?.priorOfferUrls ?? []),
            ...(continuationResult.offers ?? []).map((offer) => offer?.observation?.url)].filter(Boolean));
          const priorIds = new Set([...(task.continuation?.priorOfferIds ?? []),
            ...(continuationResult.offers ?? []).map((offer) => offer?.id)].filter(Boolean));
          result.offers = result.offers.filter((offer) => !priorUrls.has(offer?.observation?.url) && !priorIds.has(offer?.id));
          result.continuation = task.continuation;
        }
        result.errors = [...new Map(result.errors.map((entry) =>
          [`${entry?.url ?? ""}\u0000${entry?.error ?? String(entry)}`, entry])).values()];
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }
      const modelResults = [];
      for (const model of models) {
        modelResults.push(await searchModel(page, model, resolvedUrls.get(model.key), options.maxPages,
          sharedResultsCache, navigate, null));
      }
      process.stdout.write(`${JSON.stringify({
        taskId,
        sourceId: source.id,
        generatedAt: new Date().toISOString(),
        disclaimer: "Candidate snapshots only. Visible snippets are not proof of availability or vehicle facts. No cards opened and no offers imported.",
        models: modelResults,
      }, null, 2)}\n`);
      await context.close();
    } finally {
      await browser.close();
    }
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}

main();
