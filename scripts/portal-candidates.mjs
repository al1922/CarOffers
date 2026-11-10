#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, "node_modules", ".cache", "ms-playwright");
const { chromium } = await import("playwright");

const HELP = `Usage:
  python -B scripts/car-search.py claim --run <run-id> --worker <worker-id> |
    npm run search:portal -- --claim-stdin [--max-pages <n>]

Captures rendered result snippets through the portal's visible search UI.
It is a candidate-stage adapter: it does not open listing cards, assert
availability, finish the task, or import offers. Unclear page structures remain
partial. It never retries or bypasses access controls.
`;

function parseArgs(argv) {
  const options = { claimStdin: false, maxPages: 2, inspectOneCard: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--claim-stdin") options.claimStdin = true;
    else if (arg === "--max-pages") options.maxPages = Number(argv[++i]);
    else if (arg === "--inspect-one-card") options.inspectOneCard = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.help && !options.claimStdin) throw new Error("Provide --claim-stdin with one claimed task JSON");
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 20) {
    throw new Error("--max-pages must be an integer between 1 and 20");
  }
  return options;
}

async function readStdinJson() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pl-PL");
}

function listingOriginAllowed(value, searchUrl) {
  try {
    const url = new URL(value);
    const base = new URL(searchUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const baseHost = base.hostname.toLowerCase().replace(/^www\./, "");
    return url.protocol === "https:" && (host === baseHost || host.endsWith(`.${baseHost}`));
  } catch { return false; }
}

async function maybeSearch(page, task, query, adapter) {
  if (!adapter) return { submitted: false, reason: "Brak zweryfikowanego selektora wyszukiwania dla tego portalu." };
  try {
    if (adapter.makeInput && adapter.modelInput) {
      const make = task.searchProfile.queryPlan?.manualFilters?.make;
      const model = task.searchProfile.queryPlan?.manualFilters?.model;
      if (!make || !model) return { submitted: false, reason: "Profil portalu wymaga marki i modelu z zamrożonego queryPlan." };
      const makeBox = page.locator(adapter.makeInput).filter({ visible: true }).first();
      const modelBox = page.locator(adapter.modelInput).filter({ visible: true }).first();
      if (await makeBox.count() === 0 || await modelBox.count() === 0) return { submitted: false, reason: "Nie znaleziono widocznych pól marki i modelu." };
      await makeBox.fill(make, { timeout: 2500 });
      await makeBox.press("Enter", { timeout: 2500 });
      await modelBox.fill(model, { timeout: 2500 });
      await modelBox.press("Enter", { timeout: 2500 });
    } else {
      const searchBox = page.locator(adapter.queryInput).filter({ visible: true }).first();
      if (await searchBox.count() === 0) return { submitted: false, reason: "Nie znaleziono widocznego pola z profilem portalu." };
      await searchBox.fill(query, { timeout: 2500 });
      if (adapter.submitSelector) {
        const submit = page.locator(adapter.submitSelector).filter({ visible: true }).first();
        if (await submit.count() === 0) return { submitted: false, reason: "Pole wypełniono, ale nie znaleziono widocznego przycisku wyszukiwania." };
        await submit.click({ timeout: 2500 });
      } else {
        await searchBox.press("Enter", { timeout: 2500 });
      }
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(900);
    return { submitted: true };
  } catch (error) {
    return { submitted: false, reason: String(error?.message ?? error).split("\n")[0].slice(0, 220) };
  }
}

async function captureVisibleListings(page, searchUrl) {
  return page.evaluate((baseUrl) => {
    const anchors = [...document.querySelectorAll("a[href]")];
    const collected = [];
    const seen = new Set();
    for (const anchor of anchors) {
      const url = anchor.href;
      const title = (anchor.innerText ?? anchor.getAttribute("aria-label") ?? "").trim().replace(/\s+/g, " ");
      if (!url.startsWith("https://") || !title || title.length < 8 || seen.has(url)) continue;
      let card = anchor.closest("article, [data-testid*=offer], [data-testid*=listing], [class*=offer-card], [class*=listing-card], [class*=result-card], [class*=vehicle-card]");
      if (!card) {
        let parent = anchor.parentElement;
        for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) {
          const candidateText = (parent.innerText ?? "").replace(/\s+/g, " ").trim();
          if (candidateText.length >= 35 && candidateText.length <= 2500 &&
              /\b(?:19|20)\d{2}\b/.test(candidateText) && /(?:zł|PLN|km)/i.test(candidateText)) {
            card = parent;
            break;
          }
        }
      }
      if (!card) continue;
      const visibleText = (card.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 1200);
      if (!visibleText || visibleText.length < 35) continue;
      seen.add(url);
      collected.push({ title: title.slice(0, 240), url, visibleText });
      if (collected.length >= 200) break;
    }
    return collected;
  }, searchUrl);
}

async function dismissOptionalCookiePrompt(page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (!/cookies?|ciasteczk|consent|zgod[ay]/i.test(bodyText)) return false;
  const decline = page.getByRole("button", { name: /^(deny|reject all|reject optional|only necessary|necessary only|odrzuć|odrzuć wszystkie|nie akceptuję|nie zgadzam|tylko niezbędne)$/i }).first();
  if (!await decline.isVisible().catch(() => false)) return false;
  await decline.click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(350);
  return true;
}

async function waitForVisibleListings(page) {
  await page.waitForFunction(() => {
    const anchors = [...document.querySelectorAll("a[href]")];
    for (const anchor of anchors) {
      const title = (anchor.innerText ?? anchor.getAttribute("aria-label") ?? "").trim();
      if (title.length < 8 || !anchor.href.startsWith("https://")) continue;
      let parent = anchor;
      for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) {
        const text = (parent.innerText ?? "").replace(/\s+/g, " ").trim();
        if (text.length >= 35 && text.length <= 2500 && /\b(?:19|20)\d{2}\b/.test(text) && /(?:zł|PLN|km)/i.test(text)) return true;
      }
    }
    return false;
  }, null, { timeout: 1200, polling: 100 }).catch(() => {});
}

async function nextPage(page, currentUrl) {
  const link = page.locator('a[rel="next"], a[aria-label*="następ" i], a:has-text("Następna"), a:has-text("Dalej")').first();
  if (await link.count() === 0 || !await link.isVisible().catch(() => false)) return null;
  const href = await link.getAttribute("href").catch(() => null);
  if (!href) return null;
  try {
    const next = new URL(href, currentUrl);
    const current = new URL(currentUrl);
    return next.protocol === "https:" && next.origin === current.origin ? next.href : null;
  } catch { return null; }
}

async function captureQuery(page, task, query, maxPages, state, adapter) {
  const queryStarted = Date.now();
  const currentListings = (await captureVisibleListings(page, task.searchProfile.searchUrl))
    .filter((listing) => listingOriginAllowed(listing.url, task.searchProfile.searchUrl));
  let submitted = currentListings.length
    ? { submitted: false, reason: "Użyto już widocznych wyników strony; pominięto ponowne zapytanie." }
    : await maybeSearch(page, task, query.text, adapter);
  state.metrics.queryActionMs += Date.now() - queryStarted;
  if (!submitted.submitted) state.notes.push(`${query.id}: ${submitted.reason}`);
  const queryStatus = state.lastDocumentStatus ?? state.baseStatus;
  if ([401, 403, 429].includes(queryStatus)) {
    state.blocked = true;
    state.errors.push({ url: page.url(), error: `Portal returned HTTP ${queryStatus}; no retry or bypass attempted.` });
    return;
  }
  let url = page.url();
  const visited = new Set();
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    if (visited.has(url)) break;
    visited.add(url);
    const response = pageNo === 1 ? null : await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => null);
    const status = response?.status() ?? state.lastDocumentStatus ?? state.baseStatus;
    if ([401, 403, 429].includes(status)) {
      state.blocked = true;
      state.errors.push({ url, error: `Portal returned HTTP ${status}; no retry or bypass attempted.` });
      return;
    }
    await page.waitForTimeout(350);
    const checkedAt = new Date().toISOString();
    const extractionStarted = Date.now();
    const listings = (await captureVisibleListings(page, task.searchProfile.searchUrl))
      .filter((listing) => listingOriginAllowed(listing.url, task.searchProfile.searchUrl))
      .map((listing) => ({ ...listing, visibleFields: extractVisibleFields(listing.visibleText) }));
    state.metrics.extractionMs += Date.now() - extractionStarted;
    state.metrics.candidates += listings.length;
    const nextUrl = await nextPage(page, url);
    state.pages.push({ url: page.url(), checkedAt, queryId: query.id, listings, nextUrl,
      querySubmitted: submitted.submitted, queryNote: submitted.reason ?? null });
    for (const listing of listings) {
      const duplicate = state.listingUrls.has(listing.url);
      state.listingUrls.add(listing.url);
      if (duplicate) listing.duplicateAcrossQueries = true;
    }
    if (!nextUrl || visited.has(nextUrl)) break;
    if (pageNo === maxPages) {
      state.notes.push(`${query.id}: zatrzymano po limicie ${maxPages}; pozostał kolejny URL ${nextUrl}`);
      break;
    }
    url = nextUrl;
  }
}

function extractVisibleFields(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  const productionYear = value.match(/(?:rok produkcji|produkcja)\s*[:\-]?\s*((?:19|20)\d{2})/i)?.[1];
  const firstRegistration = value.match(/(?:pierwsza rejestracja|data pierwszej rejestracji|rok rejestracji)\s*[:\-]?\s*((?:19|20)\d{2})/i)?.[1];
  const mileageMatch = value.match(/(?:przebieg\s*[:\-]?\s*)?(\d{1,3}(?:[\s\u00a0.,]\d{3})+|\d{4,6})\s*km\b/i);
  const priceMatch = value.match(/(?:\d{1,3}(?:[\s\u00a0.,]\d{3})+|\d{4,7})\s*(?:zł|PLN)/i);
  const yearMentions = [...new Set(value.match(/\b(?:19|20)\d{2}\b/g) ?? [])];
  return {
    productionYear: productionYear ? Number(productionYear) : null,
    firstRegistrationYear: firstRegistration ? Number(firstRegistration) : null,
    yearMentions: yearMentions.map(Number),
    mileageKm: mileageMatch ? Number(mileageMatch[1].replace(/[\s\u00a0.,]/g, "")) : null,
    displayedPriceText: priceMatch?.[0] ?? null,
    priceBasisConfirmed: false,
  };
}

function screeningFailure(listing, task) {
  const screen = task.searchProfile.candidateScreening ?? {};
  const fields = listing.visibleFields ?? {};
  if (Number.isFinite(fields.productionYear) &&
      (fields.productionYear < screen.screeningLimits?.productionYearMin || fields.productionYear > screen.screeningLimits?.productionYearMax)) return "production_year";
  if (Number.isFinite(fields.mileageKm) && fields.mileageKm > (screen.screeningLimits?.hardMileageKmMax ?? Number.POSITIVE_INFINITY)) return "mileage";
  if (screen.screeningLimits?.auctionsAllowed === false && /\b(?:aukcja|licytacja|auction)\b/i.test(listing.visibleText)) return "sale_type";
  const bodies = screen.screeningLimits?.bodyCodes ?? [];
  if (bodies.length === 1) {
    const expected = bodies[0];
    const labelledBody = listing.visibleText.match(/nadwozie\s*[:\-]\s*([a-zżźćńółęąś]+)/i)?.[1]?.toLocaleLowerCase("pl-PL");
    const conflicts = { wagon: ["sedan", "hatchback", "suv", "coupe", "van"], sedan: ["kombi", "wagon", "hatchback", "suv", "coupe"],
      hatchback: ["sedan", "kombi", "wagon", "suv", "coupe"], suv: ["sedan", "kombi", "wagon", "hatchback", "coupe"],
      crossover: ["sedan", "kombi", "wagon", "hatchback", "coupe"], minivan: ["sedan", "kombi", "wagon", "hatchback", "suv"] };
    if (labelledBody && conflicts[expected]?.includes(labelledBody)) return "body";
  }
  return null;
}

function modelNameMatches(listing, task) {
  const model = String(task.searchProfile.queryPlan?.manualFilters?.model ?? "").toLocaleLowerCase("pl-PL");
  const brand = String(task.searchProfile.queryPlan?.manualFilters?.make ?? "").toLocaleLowerCase("pl-PL");
  const text = `${listing.title} ${listing.visibleText}`.toLocaleLowerCase("pl-PL");
  const normalizedText = normalizeText(text).replace(/\s+/g, " ");
  const normalizedModel = normalizeText(model).trim();
  const normalizedBrand = normalizeText(brand).trim();
  if (!normalizedModel || !normalizedText.includes(normalizedModel)) return false;
  const aliases = { volkswagen: ["volkswagen", "vw"], seat: ["seat"], skoda: ["skoda", "škoda"], mazda: ["mazda"] };
  if (!normalizedBrand) return true;
  return (aliases[normalizedBrand] ?? [normalizedBrand]).some((alias) => {
    const normalizedAlias = normalizeText(alias);
    if (/^\d+$/.test(model.trim())) return normalizedText.includes(`${normalizedAlias} ${normalizedModel}`);
    return normalizedText.includes(normalizedAlias);
  });
}

async function inspectOneCard(context, task, listings, state) {
  const candidate = listings.find((listing) => modelNameMatches(listing, task) && !screeningFailure(listing, task));
  if (!candidate) return { status: "no_plausible_model_candidate", candidatesSeen: listings.length };
  const page = await context.newPage();
  const started = Date.now();
  try {
    const response = await page.goto(candidate.url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(400);
    const text = await page.locator("body").innerText().catch(() => "");
    state.openedListingUrls.add(candidate.url);
    const signals = {
      displayedPrice: /\d[\d\s.,]*\s*(?:zł|pln)/i.test(text),
      priceTerms: /brutto|cena|rat[ay]|finansowan/i.test(text),
      productionYearLabel: /rok produkcji|produkcja/i.test(text),
      firstRegistrationLabel: /pierwsza rejestracja|data pierwszej rejestracji/i.test(text),
      mileageLabel: /przebieg|\bkm\b/i.test(text),
      engineLabel: /silnik|pojemność|cm³|km\b|kw\b/i.test(text),
      transmissionLabel: /skrzynia|manualna|automatyczna|dsg|cvt/i.test(text),
      bodyLabel: /nadwozie|kombi|wagon|sedan|hatchback|suv/i.test(text),
      lpgMention: /\blpg\b|\bgaz\b/i.test(text),
      saleTypeMention: /aukcja|licytacja|sprzedaż prywatna|dealer|firma/i.test(text),
      cameraMention: /kamera cofania|kamera 360|kamera/i.test(text),
      damageMention: /bezwypadk|uszkodze|kolizj|szkod/i.test(text),
    };
    return { status: response && response.status() < 400 ? "page_read" : "http_error",
      httpStatus: response?.status() ?? null, title: (await page.title().catch(() => "")).slice(0, 180),
      bodyTextChars: text.length, elapsedMs: Date.now() - started, signals };
  } catch (error) {
    state.openedListingUrls.add(candidate.url);
    return { status: "access_error", elapsedMs: Date.now() - started,
      error: String(error?.message ?? error).split("\n")[0].slice(0, 240) };
  } finally { await page.close().catch(() => {}); }
}

function cachedCompletePages(task, maxPages) {
  const cache = task.sharedResultsCache ?? {};
  const pagesByUrl = new Map((cache.checkedSearchPages ?? [])
    .filter((page) => page?.url && page.listingsComplete === true).map((page) => [page.url, page]));
  const baseUrl = task.searchProfile.searchUrl;
  if (!pagesByUrl.has(baseUrl)) return [];
  const listingsByPage = new Map();
  for (const listing of cache.visibleListings ?? []) {
    if (!listing?.pageUrl || !listing.url) continue;
    const group = listingsByPage.get(listing.pageUrl) ?? [];
    group.push({ title: listing.title ?? "", url: listing.url, visibleText: listing.visibleText ?? listing.snippet ?? "" });
    listingsByPage.set(listing.pageUrl, group);
  }
  const pages = [];
  const visited = new Set();
  let url = baseUrl;
  while (pages.length < maxPages && !visited.has(url)) {
    const page = pagesByUrl.get(url);
    if (!page) break;
    visited.add(url);
    pages.push({ url, checkedAt: page.checkedAt ?? null, queryId: "shared-results-cache",
      listings: listingsByPage.get(url) ?? [], ...(page.nextUrl ? { nextUrl: page.nextUrl } : {}), fromSharedCache: true });
    if (!page.nextUrl || !pagesByUrl.has(page.nextUrl)) break;
    url = page.nextUrl;
  }
  return pages;
}

function emitPartialFromCache(task, pages, maxPages) {
  const hasNext = pages.at(-1)?.nextUrl && pages.length >= maxPages;
  const result = {
    taskId: task.id,
    outcome: "partial",
    checkedAt: new Date().toISOString(),
    coverage: {
      searchUrls: pages.map((page) => page.url),
      pagesChecked: pages.length,
      remaining: `Ponownie użyto ${pages.length} kompletnych stron z sharedResultsCache; nie wysłano powtórnego zapytania. Zastosuj candidateScreening osobno dla tego modelu, otwórz pasujące karty i sprawdź dalszy zakres.${hasNext ? ` Kolejna strona cache: ${pages.at(-1).nextUrl}` : ""}`,
      searchResults: pages,
      listingUrlsChecked: [],
    },
    offers: [],
    errors: [],
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n${HELP}`); process.exitCode = 2; return; }
  if (options.help) { process.stdout.write(HELP); return; }

  const task = await readStdinJson();
  if (task.kind !== "search" || task.state !== "running" || !task.worker || !task.searchProfile?.searchUrl) {
    throw new Error("Input must be one running search task printed by a successful claim");
  }
  const sources = JSON.parse(await readFile(path.join(ROOT, "config/sources.json"), "utf8")).sources;
  const adapterConfig = JSON.parse(await readFile(path.join(ROOT, "config/portal-adapters.json"), "utf8"));
  const source = sources.find((item) => item.id === task.sourceId && item.enabled);
  if (!source) throw new Error(`Source ${task.sourceId} is absent or disabled in current source config`);
  const queryPlan = task.searchProfile.queryPlan ?? {};
  const planned = Array.isArray(queryPlan.textQueries) ? queryPlan.textQueries : [];
  const queries = planned.length ? planned : [{ id: "model-body", text: [queryPlan.manualFilters?.make, queryPlan.manualFilters?.model,
    ...(task.searchProfile.bodyAliases ?? [])].filter(Boolean).join(" ") }];
  if (!queries.some((item) => typeof item.text === "string" && item.text.trim())) {
    throw new Error("Frozen task queryPlan has no usable text query");
  }

  const cachedPages = cachedCompletePages(task, options.maxPages);
  if (cachedPages.length) {
    emitPartialFromCache(task, cachedPages, options.maxPages);
    return;
  }

  const state = { pages: [], listingUrls: new Set(), openedListingUrls: new Set(), errors: [], notes: [], blocked: false, baseStatus: null, lastDocumentStatus: null,
    metrics: { navigationMs: 0, renderWaitMs: 0, queryActionMs: 0, extractionMs: 0, candidates: 0 }, cardPilot: null };
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("response", (response) => {
      if (response.request().resourceType() === "document") state.lastDocumentStatus = response.status();
    });
    try {
      const navigationStarted = Date.now();
      const response = await page.goto(task.searchProfile.searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      state.metrics.navigationMs = Date.now() - navigationStarted;
      const renderStarted = Date.now();
      state.baseStatus = response?.status() ?? null;
      await waitForVisibleListings(page);
      await dismissOptionalCookiePrompt(page);
      state.metrics.renderWaitMs = Date.now() - renderStarted;
      const initialText = `${await page.title().catch(() => "")}\n${await page.locator("body").innerText().catch(() => "")}`;
      if (/access denied|robot check|captcha|verify you are human|too many requests|dostęp został zablokowany|oh noes/i.test(initialText)) {
        state.blocked = true;
        state.errors.push({ url: page.url(), error: "Portal rendered an access challenge; no retry or bypass attempted." });
      }
    } catch (error) {
      state.errors.push({ url: task.searchProfile.searchUrl, error: String(error?.message ?? error).split("\n")[0].slice(0, 300) });
      state.blocked = /403|429|ERR_CERT_|ERR_BLOCKED|ERR_NAME_NOT_RESOLVED/i.test(String(error?.message ?? error));
    }
    if ([401, 403, 429].includes(state.baseStatus)) {
      state.blocked = true;
      state.errors.push({ url: task.searchProfile.searchUrl, error: `Portal returned HTTP ${state.baseStatus}; no retry or bypass attempted.` });
    } else if (state.baseStatus !== null && !state.blocked) {
      for (const query of queries) {
        try {
          await captureQuery(page, task, query, options.maxPages, state, adapterConfig.adapters[task.sourceId]);
          if (state.blocked) break;
        } catch (error) {
          state.errors.push({ url: page.url(), error: String(error?.message ?? error).split("\n")[0].slice(0, 300) });
        }
      }
    }

    if (options.inspectOneCard && !state.blocked) {
      const listings = state.pages.flatMap((item) => item.listings ?? []);
      state.cardPilot = await inspectOneCard(context, task, listings, state);
    }

    const remaining = [
      "Kandydaci pochodzą wyłącznie z widocznych kart wyników.",
      "Karty ogłoszeń nie były otwierane; dostępność, cena brutto i wyposażenie nie są potwierdzone.",
      "Jeśli struktura portalu nie ujawniła kart, zakres pozostaje nieprzeszukany.",
      ...state.notes,
    ].join(" ");
    const result = {
      taskId: task.id,
      outcome: state.blocked ? "blocked" : "partial",
      checkedAt: new Date().toISOString(),
      coverage: {
        searchUrls: [...new Set(state.pages.map((item) => item.url))],
        pagesChecked: state.pages.length,
        remaining,
        searchResults: state.pages,
        listingUrlsChecked: [...state.openedListingUrls],
      },
      offers: [],
      errors: state.errors,
      diagnostics: { ...state.metrics, elapsedMs: state.metrics.navigationMs + state.metrics.renderWaitMs + state.metrics.queryActionMs + state.metrics.extractionMs,
        assetBlocking: "disabled_unless_measured_for_source" },
      ...(state.cardPilot ? { cardPilot: state.cardPilot } : {}),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
