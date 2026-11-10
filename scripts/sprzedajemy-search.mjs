#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, "node_modules", ".cache", "ms-playwright");
const { chromium } = await import("playwright");
const HELP = `Usage:
  npm run search:sprzedajemy -- --model-key <active-model-key> [--model-key <key> ...]
       [--max-pages <n>]
  python -B scripts/car-search.py claim ... | npm run search:sprzedajemy -- --claim-stdin

Builds make/model result URLs only from visible category links on Sprzedajemy,
then captures visible result cards and follows the visible "Następna" link.
With --claim-stdin it uses the claimed task's frozen search profile. Output is a
candidate snapshot, not a verified search result or import file. It does not
open listing cards, log in, or bypass access controls.
`;

function parseArgs(argv) {
  const options = { modelKeys: [], maxPages: 1, claimStdin: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--model-key") options.modelKeys.push(argv[++i]);
    else if (arg === "--max-pages") options.maxPages = Number(argv[++i]);
    else if (arg === "--claim-stdin") options.claimStdin = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.help) return options;
  if (options.claimStdin === Boolean(options.modelKeys.length) || options.modelKeys.some((key) => !key)) {
    throw new Error("Provide either --claim-stdin or one or more --model-key options");
  }
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 100) {
    throw new Error("--max-pages must be an integer between 1 and 100");
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

async function resolveModelUrls(page, source, models) {
  const categoryRoot = new URL(source.searchUrl).origin + "/motoryzacja/samochody-osobowe";
  await page.goto(source.searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
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
    await page.goto(brandUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
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
    const title = article.querySelector("h2.title")?.innerText?.trim() || anchor.innerText.trim();
    return [{
      title,
      url: anchor.href,
      visibleText: (article.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 1200),
    }];
  }));
}

async function nextResultsPageUrl(page, currentUrl) {
  const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")]
    .map((anchor) => ({ text: (anchor.innerText ?? "").trim(), url: anchor.href })));
  const next = links.find((link) => normalizeLabel(link.text) === "nastepna");
  if (!next) return null;
  const nextUrl = new URL(next.url, currentUrl);
  const current = new URL(currentUrl);
  if (nextUrl.origin !== current.origin || nextUrl.pathname !== current.pathname) return null;
  return nextUrl.href;
}

function paginationUrlIsValid(candidate, currentUrl) {
  if (!candidate) return false;
  try {
    const next = new URL(candidate, currentUrl);
    const current = new URL(currentUrl);
    return next.protocol === "https:" && next.origin === current.origin && next.pathname === current.pathname;
  } catch { return false; }
}

async function searchModel(page, model, searchUrl, maxPages, sharedCache = {}) {
  const pages = [];
  const seenPageUrls = new Set();
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
    if (seenPageUrls.has(currentUrl)) break;
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
          duplicateOfEarlierPage,
          reusedFromTaskId: listing.taskId ?? cachedPage.taskId ?? null,
        };
      });
      pages.push({
        url: currentUrl,
        checkedAt: cachedPage.checkedAt ?? null,
        status: null,
        pageNumber,
        fromSharedCache: true,
        listings: pageListings,
        nextUrl: paginationUrlIsValid(cachedPage.nextUrl, currentUrl) ? cachedPage.nextUrl : null,
      });
      if (!paginationUrlIsValid(cachedPage.nextUrl, currentUrl)) {
        remaining = "Wykorzystano stronę z sharedResultsCache, ale jej migawka nie zawiera bezpiecznego nextUrl; dalszej paginacji nie odtworzono.";
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
      response = await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (error) {
      return {
        modelKey: model.key,
        modelName: model.name,
        searchUrl,
        outcome: "partial",
        coverage: makeCoverage(pages, "Nie udało się odczytać pełnego zakresu; nie traktuj tego jako braku ofert."),
        error: String(error?.message ?? error).slice(0, 500),
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
        remaining: "Dostęp zablokowany; brak danych nie oznacza braku ofert.",
      };
    }
    const listings = await captureVisibleListings(page);
    const pageListings = listings.filter((listing) => /^https:\/\//i.test(listing.url)).map((listing) => {
      const duplicateOfEarlierPage = seenListingUrls.has(listing.url);
      seenListingUrls.add(listing.url);
      return { ...listing, duplicateOfEarlierPage };
    });
    const nextUrl = await nextResultsPageUrl(page, currentUrl);
    pages.push({
      url: page.url(),
      checkedAt,
      status,
      pageNumber,
      fromSharedCache: false,
      listings: pageListings,
      nextUrl,
    });
    if (!nextUrl || seenPageUrls.has(nextUrl)) break;
    if (pageNumber === maxPages) {
      remaining = `Pominięto dalsze strony po limicie ${maxPages}; dostępny kolejny URL: ${nextUrl}`;
      break;
    }
    currentUrl = nextUrl;
  }

  const scopeNote = "Migawka ścieżki marki/modelu. Nie sprawdzano kart ani filtrów rocznika, ceny, przebiegu, nadwozia i silników; nie wykonano osobnych zapytań dla aliasów silnika z queryPlan.";
  remaining = remaining ? `${remaining}. ${scopeNote}` : scopeNote;
  return {
    modelKey: model.key,
    modelName: model.name,
    searchUrl,
    outcome: "partial",
    coverage: makeCoverage(pages, remaining),
    uniqueListingCount: seenListingUrls.size,
    remaining,
  };
}

function makeCoverage(pages, remaining) {
  return {
    searchUrls: pages.map((page) => page.url),
    pagesChecked: pages.length,
    remaining,
    searchResults: pages.map(({ url, checkedAt, listings, nextUrl, fromSharedCache }) => ({
      url, checkedAt, listings, ...(nextUrl ? { nextUrl } : {}), ...(fromSharedCache ? { fromSharedCache } : {}),
    })),
    listingUrlsChecked: [],
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
    let sharedResultsCache = {};
    if (options.claimStdin) {
      const task = await readClaimFromStdin();
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
      const resolvedUrls = await resolveModelUrls(page, source, models);
      const modelResults = [];
      for (const model of models) {
        modelResults.push(await searchModel(page, model, resolvedUrls.get(model.key), options.maxPages, sharedResultsCache));
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
