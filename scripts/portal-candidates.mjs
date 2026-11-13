#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { portalNavigationPolicy } from "./portal-robots.mjs";
import { classifyGenericCard } from "./portal-card-classifier.mjs";
import { explicitModelMismatch, extractVisibleFields, modelNameMatches, normalizeText, screeningFailure } from "./portal-screening.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCESS_CHALLENGE = /access denied|robot check|captcha|verify you are human|too many requests|dostęp został zablokowany|oh noes/i;
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, "node_modules", ".cache", "ms-playwright");
const { chromium } = await import("playwright");

const HELP = `Usage:
  python -B scripts/car-search.py claim --run <run-id> --worker <worker-id> |
    npm run search:portal -- --claim-stdin [--max-pages <n>] [--verify-cards] [--max-cards <n>]

Captures rendered result snippets through the portal's visible search UI.
By default it does not open listing cards. With --verify-cards it opens screened
candidate cards and records rendered fields/structured metadata. It creates an
offer candidate only when the model matches and the card shows InStock or an
active seller contact. It never imports offers. Unclear structures remain
partial; access controls are never retried or bypassed.
`;

function parseArgs(argv) {
  const options = { claimStdin: false, maxPages: 2, inspectOneCard: false, verifyCards: false, maxCards: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--claim-stdin") options.claimStdin = true;
    else if (arg === "--max-pages") options.maxPages = Number(argv[++i]);
    else if (arg === "--inspect-one-card") options.inspectOneCard = true;
    else if (arg === "--verify-cards") options.verifyCards = true;
    else if (arg === "--max-cards") options.maxCards = Number(argv[++i]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.help && !options.claimStdin) throw new Error("Provide --claim-stdin with one claimed task JSON");
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 20) {
    throw new Error("--max-pages must be an integer between 1 and 20");
  }
  if (!Number.isInteger(options.maxCards) || options.maxCards < 1 || options.maxCards > 200) {
    throw new Error("--max-cards must be an integer between 1 and 200");
  }
  return options;
}

async function readStdinJson() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

async function loadContinuationResult(task) {
  const continuation = task.continuation;
  const runId = task.runId ?? "";
  const sourceTaskId = continuation?.sourceTaskId ?? "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(runId) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(sourceTaskId)) {
    throw new Error("Continuation is missing a valid runId or sourceTaskId");
  }
  const sourceUrl = task.searchProfile?.searchUrl;
  const nextUrl = continuation?.nextUrl;
  let base;
  let target;
  try { base = new URL(sourceUrl); target = new URL(nextUrl); }
  catch { throw new Error("Continuation URL is not a valid absolute URL"); }
  if (target.protocol !== "https:" || target.origin !== base.origin) {
    throw new Error("Continuation URL must use HTTPS on the configured portal origin");
  }
  const resultPath = path.resolve(ROOT, "runs", runId, "results", `${sourceTaskId}.json`);
  if (path.dirname(resultPath) !== path.resolve(ROOT, "runs", runId, "results")) {
    throw new Error("Continuation result path escaped the run results directory");
  }
  const previous = task.workerContinuationSourceResult ?? JSON.parse(await readFile(resultPath, "utf8"));
  const previousPages = previous.coverage?.searchResults ?? [];
  const savedPage = previousPages.find((page) => page &&
    (page.queryId ?? "unfiltered") === continuation.queryId && page.nextUrl === nextUrl);
  if (previous.taskId !== sourceTaskId || previous.outcome !== "partial" || !savedPage ||
      savedPage.nextUrlAllowed === false || savedPage.paginationComplete === true) {
    throw new Error("Saved partial result does not contain this resumable nextUrl");
  }
  const denied = (previous.errors ?? []).some((entry) => entry?.url === nextUrl &&
    /403|429|captcha|robots?\.txt|access denied|forbidden|challenge|niedozwol/i.test(entry.error ?? ""));
  if (denied) {
    throw new Error("Saved nextUrl was explicitly denied; it will not be retried");
  }
  return previous;
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
  if (!adapter || adapter.mode === "existing_results") return { submitted: false, reason: "Portal używa już widocznej listy wyników; nie zmieniano filtrów." };
  try {
    const initialUrl = page.url();
    const plan = task.searchProfile.queryPlan;
    const make = plan?.nativeFilters?.make ?? plan?.manualFilters?.make;
    const model = plan?.nativeFilters?.model ?? plan?.manualFilters?.model;
    if (adapter.mode === "olx_category") {
      if (!make || !model) throw new Error("Brak marki lub modelu w zadaniu OLX.");
      const base = new URL(initialUrl);
      const brandLinks = await page.locator('a[href]').filter({ visible: true }).evaluateAll((links) =>
        links.map((link) => ({ url: link.href, label: link.innerText.trim().replace(/\s+[\d\s\u00a0]+$/, "") })));
      const prefix = base.pathname.replace(/\/?$/, "/");
      const matching = [...new Set(brandLinks.filter((link) => {
        const target = new URL(link.url);
        const suffix = target.pathname.slice(prefix.length).replace(/\/$/, "");
        return target.origin === base.origin && target.pathname.startsWith(prefix) && /^[\w-]+$/.test(suffix) &&
          normalizeText(link.label) === normalizeText(make);
      }).map((link) => link.url))];
      if (matching.length !== 1) throw new Error("Brak jednoznacznego linku marki OLX.");
      const response = await page.goto(matching[0], { waitUntil: "domcontentloaded", timeout: 25000 });
      if (!response?.ok()) return { submitted: false, reason: "Nie udało się odczytać kategorii marki OLX." };
      const categoryUrl = page.url();
      const control = page.getByRole("combobox", { name: "Model", exact: true });
      await control.click({ timeout: 5000 });
      await page.getByRole("option", { name: model, exact: true }).click({ timeout: 5000 });
      await control.press("Tab", { timeout: 5000 });
      await page.getByRole("button", { name: "Szukaj", exact: true }).click({ timeout: 5000 });
      await page.waitForURL((url) => url.href !== categoryUrl, { timeout: 8000 });
      return { submitted: true };
    }
    if (adapter.mode === "autoplac_dialog") {
      if (!make || !model) throw new Error("Brak marki lub modelu w zadaniu Autoplac.");
      for (const [label, value] of [["Marka", make], ["Model", model]]) {
        const previousUrl = page.url();
        await page.getByRole("button", { name: label, exact: true }).click({ timeout: 5000 });
        const dialog = page.getByRole("dialog");
        const choices = dialog.getByRole("checkbox", { name: value, exact: true });
        const values = await choices.evaluateAll((nodes) => nodes.map((node) => node.value));
        if (!values.length || new Set(values).size !== 1) throw new Error("Niejednoznaczna opcja " + label);
        await choices.first().check({ timeout: 5000 });
        await dialog.getByRole("button", { name: "Zatwierdź", exact: true }).click({ timeout: 5000 });
        await dialog.waitFor({ state: "hidden", timeout: 8000 });
        await page.waitForURL((url) => url.href !== previousUrl, { timeout: 8000 });
      }
      return { submitted: true };
    }
    const initialCards = await captureVisibleListings(page, task.searchProfile.searchUrl);
    if (adapter.mode === "catalog_model") {
      const model = task.searchProfile.queryPlan?.nativeFilters?.model ?? task.searchProfile.queryPlan?.manualFilters?.model;
      const label = adapter.modelLabels[task.modelKey] ?? model;
      if (!label) throw new Error("Brak nazwy modelu katalogowego w zadaniu.");
      await page.getByRole("button", { name: new RegExp(adapter.openFilters) }).click({ timeout: 3500 });
      const dialog = page.getByRole("dialog", { name: adapter.dialogName, exact: true });
      await dialog.getByRole("combobox", { name: new RegExp(adapter.modelControl) }).click({ timeout: 3500 });
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const choice = page.getByRole("option", { name: new RegExp(`^${escaped}(?: \\(\\d+\\))?$`, "i") });
      await choice.click({ timeout: 3500 });
      await choice.press("Escape", { timeout: 3500 });
      await dialog.getByRole("button", { name: new RegExp(adapter.showResults) }).click({ timeout: 8000 });
      await page.waitForURL((url) => url.href !== initialUrl, { timeout: 8000 });
      return { submitted: true };
    }
    if (adapter.mode === "checkbox_model") {
      const plan = task.searchProfile.queryPlan;
      const model = plan?.nativeFilters?.model ?? plan?.manualFilters?.model;
      if (!model) throw new Error("Brak modelu w zamrożonym zadaniu.");
      await page.getByRole("button", { name: adapter.openFilters, exact: true }).click({ timeout: 3500 });
      const checkbox = page.getByRole("checkbox", { name: model, exact: true }).and(page.locator(adapter.modelCheckbox));
      await checkbox.check({ timeout: 3500 });
      await page.waitForURL((url) => url.href !== initialUrl, { timeout: 8000 });
      return { submitted: true };
    }
    if (adapter.mode === "dialog_make_model") {
      const plan = task.searchProfile.queryPlan;
      const dialog = page.getByRole("dialog").filter({ has: page.getByRole("group", { name: adapter.filterGroup, exact: true }) });
      for (const [key, label] of Object.entries(adapter.controls)) {
        const value = plan?.nativeFilters?.[key] ?? plan?.manualFilters?.[key];
        if (!value) throw new Error(`Brak wartości filtra ${key} w zadaniu.`);
        await dialog.getByRole("button", { name: label, exact: true }).click({ timeout: 3500 });
        const choices = dialog.locator("label").filter({ visible: true });
        const labels = await choices.evaluateAll((nodes) => nodes.map((node) => ({
          text: node.innerText.split("\n")[0].trim(), value: node.control?.value,
        })));
        const matches = labels.map((item, index) => ({ ...item, index }))
          .filter((item) => item.value && normalizeText(item.text) === normalizeText(value));
        if (new Set(matches.map((item) => item.value)).size !== 1) {
          throw new Error(`Nie znaleziono jednoznacznej opcji filtra ${key} dla ${value}.`);
        }
        await choices.nth(matches[0].index).click({ timeout: 3500 });
        await dialog.getByRole("button", { name: adapter.confirmChoice, exact: true }).click({ timeout: 3500 });
      }
      await dialog.getByRole("button", { name: new RegExp(adapter.showResults) }).click({ timeout: 3500 });
      await page.waitForURL((url) => url.href !== initialUrl, { timeout: 8000 });
      return { submitted: true };
    }
    if (adapter.mode === "native_select") {
      const select = page.locator(adapter.modelSelect).filter({ visible: true }).first();
      if (await select.count() === 0) return { submitted: false, reason: "Nie znaleziono widocznego filtra modelu." };
      const wanted = normalizeText(task.searchProfile.queryPlan?.nativeFilters?.model ?? task.searchProfile.queryPlan?.manualFilters?.model ?? "");
      const options = await select.locator("option", {}).evaluateAll((items) => items.map((item) => ({ label: (item.label || item.textContent || "").trim(), value: item.value })));
      const matches = options.filter((item) => item.value && normalizeText(item.label) === wanted);
      const partial = options.filter((item) => item.value && wanted && normalizeText(item.label).includes(wanted));
      const selected = matches.length === 1 ? matches[0] : matches.length === 0 && partial.length === 1 ? partial[0] : null;
      if (!selected) return { submitted: false, reason: "Nie znaleziono jednoznacznej opcji modelu; pozostawiono listę wyników." };
      await select.selectOption(selected.value, { timeout: 2500 });
      await applyPortalFields(page, task, adapter);
      await waitForVisibleListings(page);
      const currentCards = await captureVisibleListings(page, task.searchProfile.searchUrl);
      const fingerprint = (cards) => cards.map(({ url, title }) => url + "\n" + title).join("\n");
      return { submitted: currentCards.length > 0 && (page.url() !== initialUrl || fingerprint(initialCards) !== fingerprint(currentCards)),
        reason: "Filtr modelu wybrano z widocznej listy opcji." };
    }
    if (adapter.mode === "suggestion_brand_model") {
      const plan = task.searchProfile.queryPlan;
      const make = plan?.nativeFilters?.make ?? plan?.manualFilters?.make;
      const model = plan?.nativeFilters?.model ?? plan?.manualFilters?.model;
      if (!make || !model) return { submitted: false, reason: "Brak marki lub modelu w zamrożonym queryPlan." };
      const searchBox = page.locator(adapter.queryInput).filter({ visible: true }).first();
      if (await searchBox.count() === 0) return { submitted: false, reason: "Nie znaleziono widocznego pola wyszukiwarki marki." };
      const chooseExact = async (value) => {
        const exact = page.getByRole("button", { name: value, exact: true }).filter({ visible: true });
        if (await exact.count() !== 1) return false;
        await exact.click({ timeout: 2500 });
        return true;
      };
      await searchBox.fill(make, { timeout: 2500 });
      if (!await chooseExact(make)) return { submitted: false, reason: "Brak jednoznacznej sugestii marki; pozostawiono wyniki bez zmian." };
      const modelBox = page.locator(adapter.queryInput).filter({ visible: true }).first();
      if (await modelBox.count() === 0) return { submitted: false, reason: "Wybór marki nie udostępnił pola modelu." };
      await modelBox.fill(model, { timeout: 2500 });
      if (!await chooseExact(model)) return { submitted: false, reason: "Brak jednoznacznej sugestii modelu; pozostawiono wyniki bez zmian." };
      await waitForVisibleListings(page);
      const currentCards = await captureVisibleListings(page, task.searchProfile.searchUrl);
      const fingerprint = (cards) => cards.map(({ url, title }) => url + "\n" + title).join("\n");
      return { submitted: currentCards.length > 0 && (page.url() !== initialUrl || fingerprint(initialCards) !== fingerprint(currentCards)),
        reason: "Wybrano jednoznaczne sugestie marki i modelu." };
    }
    if (adapter.makeInput && adapter.modelInput) {
      const plan = task.searchProfile.queryPlan;
      const make = plan?.nativeFilters?.make ?? plan?.manualFilters?.make;
      const model = plan?.nativeFilters?.model ?? plan?.manualFilters?.model;
      if (!make || !model) return { submitted: false, reason: "Profil portalu wymaga marki i modelu z zamrożonego queryPlan." };
      const makeBox = page.locator(adapter.makeInput).filter({ visible: true }).first();
      const modelBox = page.locator(adapter.modelInput).filter({ visible: true }).first();
      if (await makeBox.count() === 0 || await modelBox.count() === 0) return { submitted: false, reason: "Nie znaleziono widocznych pól marki i modelu." };
      await makeBox.fill(make, { timeout: 2500 });
      await makeBox.press("Enter", { timeout: 2500 });
      await modelBox.fill(model, { timeout: 2500 });
      await applyPortalFields(page, task, adapter);
      await modelBox.press("Enter", { timeout: 2500 });
    } else {
      const searchBox = page.locator(adapter.queryInput).filter({ visible: true }).first();
      if (await searchBox.count() === 0) return { submitted: false, reason: "Nie znaleziono widocznego pola z profilem portalu." };
      await searchBox.fill(query, { timeout: 2500 });
      await applyPortalFields(page, task, adapter);
      if (adapter.submitSelector) {
        const submit = page.locator(adapter.submitSelector).filter({ visible: true }).first();
        if (await submit.count() === 0) return { submitted: false, reason: "Pole wypełniono, ale nie znaleziono widocznego przycisku wyszukiwania." };
        await submit.click({ timeout: 2500 });
      } else {
        await searchBox.press("Enter", { timeout: 2500 });
      }
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    if (page.url() === initialUrl && initialCards.length) {
      await page.waitForFunction(({ initialUrl, urls }) =>
        location.href !== initialUrl || [...document.querySelectorAll("article a[href]")].some((item) =>
          item.closest("article") && item.innerText.trim().length >= 8 && !urls.includes(item.href)),
      { initialUrl, urls: initialCards.map(({ url }) => url) }, { timeout: 1200 }).catch(() => {});
    }
    await waitForVisibleListings(page);
    if (page.url() === initialUrl) {
      const currentCards = await captureVisibleListings(page, task.searchProfile.searchUrl);
      const fingerprint = (cards) => cards.map(({ url, title }) => url + "\n" + title).join("\n");
      if (fingerprint(initialCards) === fingerprint(currentCards)) {
        return { submitted: false, reason: "Po użyciu formularza nie potwierdzono zmiany listy." };
      }
    }
    return { submitted: true };
  } catch (error) {
    return { submitted: false, reason: String(error?.message ?? error).slice(0, 1200) };
  }
}

async function applyPortalFields(page, task, adapter) {
  const limits = task.searchProfile.candidateScreening?.screeningLimits ?? {};
  const fields = adapter.fields ?? {};
  const values = { yearMin: limits.productionYearMin, yearMax: limits.productionYearMax,
    priceMax: task.searchProfile.priceOverLimitRequiresUserApproval || task.searchProfile.candidateScreening?.priceExceptions?.length
      ? null : limits.basePurchaseGrossPlnMax, mileageMax: limits.hardMileageKmMax };
  for (const [key, selector] of Object.entries(fields)) {
    const value = values[key];
    if (value == null) continue;
    const input = page.locator(selector).filter({ visible: true }).first();
    if (await input.count() === 0) continue;
    await input.fill(String(value), { timeout: 1500 }).catch(() => {});
  }
}

async function captureVisibleListings(page, searchUrl, adapter) {
  return page.evaluate(({ listingLink, listingTitle, listingContainer }) => {
    const anchors = [...document.querySelectorAll(listingLink ?? "a[href]")];
    const collected = [];
    const seen = new Set();
    for (const anchor of anchors) {
      const url = anchor.href;
      if (!anchor.getClientRects().length || !url.startsWith("https://") || seen.has(url)) continue;
      let card = anchor.closest(listingContainer ?? "article, [data-testid*=offer], [data-testid*=listing], [class*=offer-card], [class*=listing-card], [class*=result-card], [class*=vehicle-card]");
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
      const title = ((listingTitle && card.querySelector(listingTitle)?.innerText) ||
        anchor.innerText || anchor.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
      if (!title || title.length < 5) continue;
      const visibleText = (card.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 1200);
      if (!visibleText || visibleText.length < 35) continue;
      seen.add(url);
      collected.push({ title: title.slice(0, 240), url, visibleText });
    }
    return collected;
  }, { listingLink: adapter?.listingLink, listingTitle: adapter?.listingTitle, listingContainer: adapter?.listingContainer });
}

async function dismissOptionalCookiePrompt(page) {
  const consent = page.locator("#uniccmp").getByRole("button", { name: "Zgadzam się i kontynuuj", exact: true });
  if (await page.locator("#uniccmp").count()) {
    await consent.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    if (await consent.isVisible().catch(() => false)) {
      await consent.click({ timeout: 3000 });
      return true;
    }
  }
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (!/cookies?|ciasteczk|consent|zgod[ay]/i.test(bodyText)) return false;
  const decline = page.getByRole("button", { name: /^(deny|reject all|reject optional|only necessary|necessary only|odmowa|odrzuć|odrzuć wszystkie|nie akceptuję|nie zgadzam|tylko niezbędne)$/i }).first();
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

async function nextPage(page, currentUrl, adapter) {
  if (adapter?.pageParameter) {
    return page.locator("a[href]").filter({ visible: true }).evaluateAll((links, { currentUrl, parameter }) => {
      const current = new URL(currentUrl);
      const next = Number(current.searchParams.get(parameter) ?? 1) + 1;
      current.searchParams.delete(parameter);
      current.searchParams.sort();
      for (const link of links) {
        const candidate = new URL(link.href);
        if (Number(candidate.searchParams.get(parameter)) !== next) continue;
        candidate.searchParams.delete(parameter);
        candidate.searchParams.sort();
        if (candidate.href === current.href) return link.href;
      }
      return null;
    }, { currentUrl, parameter: adapter.pageParameter });
  }
  const link = page.locator(adapter?.nextLink ?? 'a[rel="next"], a[aria-label*="następ" i], a:text-is("Następna"), a:text-is("Dalej")').filter({ visible: true }).first();
  if (await link.count() === 0 || !await link.isVisible().catch(() => false)) return null;
  const href = await link.getAttribute("href").catch(() => null);
  if (!href) return null;
  try {
    const next = new URL(href, currentUrl);
    const current = new URL(currentUrl);
    return next.protocol === "https:" && next.origin === current.origin ? next.href : null;
  } catch { return null; }
}

async function captureQuery(page, task, query, maxPages, state, adapter, startUrl = null) {
  const queryStarted = Date.now();
  const fieldsOnly = adapter && adapter.mode !== "text_query";
  if (fieldsOnly && state.nativeQueryAttempted) {
    return;
  }
  if (state.pages.length && !adapter) return;
  if (fieldsOnly) state.nativeQueryAttempted = true;
  let denied;
  const guard = async (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !state.allowed(request.url())) {
      denied = request.url();
      await route.abort();
    } else {
      await route.continue();
    }
  };
  if (adapter) await page.route("**/*", guard);
  let submitted;
  try {
    if (startUrl) {
      if (!state.allowed(startUrl)) {
        state.errors.push({ url: startUrl, error: "Adres kontynuacji niedozwolony przez robots.txt lub spoza portalu." });
        state.blocked = true;
        return;
      }
      submitted = { submitted: true, reason: "Kontynuacja od zapisanego nextUrl." };
    } else {
      submitted = await maybeSearch(page, task, query.text, adapter);
    }
  } finally {
    if (adapter) await page.unroute("**/*", guard);
  }
  if (denied || (!startUrl && !state.allowed(page.url()))) {
    state.errors.push({ url: denied ?? page.url(), error: "Formularz wskazał adres niedozwolony przez robots.txt lub spoza portalu." });
    state.blocked = true;
    return;
  }
  state.metrics.queryActionMs += Date.now() - queryStarted;
  if (!submitted.submitted && !startUrl) state.notes.push(`${query.id}: ${submitted.reason}`);
  const queryStatus = state.lastDocumentStatus ?? state.baseStatus;
  if ([401, 403, 429].includes(queryStatus)) {
    state.blocked = true;
    state.errors.push({ url: page.url(), error: `Portal returned HTTP ${queryStatus}; no retry or bypass attempted.` });
    return;
  }
  if (!submitted.submitted && state.pages.length) return;
  let url = startUrl ?? page.url();
  const visited = startUrl
    ? new Set(state.pages.filter((item) => (item.queryId ?? "unfiltered") === query.id).map((item) => item.url))
    : new Set();
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    if (visited.has(url)) break;
    if (!state.allowed(url)) {
      state.errors.push({ url, error: "Adres niedozwolony przez robots.txt lub spoza portalu." });
      state.blocked = true;
      return;
    }
    visited.add(url);
    const response = pageNo === 1 && !startUrl ? null : await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    const status = response?.status() ?? state.lastDocumentStatus ?? state.baseStatus;
    if ([401, 403, 429].includes(status)) {
      state.blocked = true;
      state.errors.push({ url, error: `Portal returned HTTP ${status}; no retry or bypass attempted.` });
      return;
    }
    if (status >= 400) {
      state.errors.push({ url, error: `Strona wyników zwróciła HTTP ${status}.` });
      return;
    }
    const challengeText = await page.evaluate(() => document.title + "\n" + (document.body?.innerText ?? "").slice(0, 600));
    if (ACCESS_CHALLENGE.test(challengeText)) {
      state.blocked = true;
      state.errors.push({ url, error: "Portal wyświetlił blokadę dostępu." });
      return;
    }
    await waitForVisibleListings(page);
    const checkedAt = new Date().toISOString();
    const extractionStarted = Date.now();
    const captured = new Map();
    for (let batch = 1; ; batch += 1) {
      for (const listing of await captureVisibleListings(page, task.searchProfile.searchUrl, adapter)) captured.set(listing.url, listing);
      if (!adapter?.loadMoreButton) break;
      const more = page.locator(adapter.loadMoreButton).filter({ visible: true }).first();
      if (!await more.isEnabled({ timeout: 500 }).catch(() => false)) break;
      if (batch >= maxPages) {
        state.notes.push(`${query.id}: pozostał przycisk wczytania dalszych wyników.`);
        break;
      }
      const previousLinks = await page.locator(adapter.listingLink).count();
      await more.click({ timeout: 3500 });
      const updated = await page.waitForFunction(({ selector, previousLinks }) =>
        document.querySelectorAll(selector).length > previousLinks,
      { selector: adapter.listingLink, previousLinks }, { timeout: 6000 }).then(() => true, () => false);
      if (!updated) {
        state.notes.push(`${query.id}: przycisk nie ujawnił nowej partii kart.`);
        break;
      }
    }
    const listings = [...captured.values()]
      .filter((listing) => listingOriginAllowed(listing.url, task.searchProfile.searchUrl))
      .map((listing) => ({ ...listing, visibleFields: extractVisibleFields(listing.visibleText, task.sourceId),
        ...(task.sourceId === "autoplac" && { portalExclusive: /(?:^|\s)Tylko u nas(?:\s|$)/i.test(listing.visibleText) }) }));
    state.metrics.extractionMs += Date.now() - extractionStarted;
    state.metrics.candidates += listings.length;
    const nextUrl = await nextPage(page, page.url(), adapter);
    const nextUrlAllowed = nextUrl ? state.allowed(nextUrl) : null;
    if (nextUrl && !nextUrlAllowed) state.notes.push(`${query.id}: adres następnej strony jest niedozwolony przez robots.txt lub prowadzi poza portal.`);
    state.pages.push({ url: page.url(), checkedAt,
      queryId: startUrl ? query.id : submitted.submitted ? (fieldsOnly ? "make-model" : query.id) : "unfiltered", listings, nextUrl,
      ...(nextUrl ? { nextUrlAllowed } : {}),
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

async function inspectOneCard(context, task, listings, state) {
  const candidate = listings.find((listing) =>
    state.allowed(listing.url) && modelNameMatches(listing, task) && !screeningFailure(listing, task));
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

function parseStructuredVehicles(html) {
  const values = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const type = node["@type"];
    const types = (Array.isArray(type) ? type : [type]).map((item) => String(item ?? "").toLowerCase());
    if (types.some((item) => ["vehicle", "car", "product", "individualproduct"].includes(item))) {
      values.push({ type: Array.isArray(type) ? type : type ?? null, name: node.name ?? null,
        brand: typeof node.brand === "object" ? node.brand.name ?? null : node.brand ?? null,
        model: node.model ?? null, mileageFromOdometer: node.mileageFromOdometer?.value ?? null,
        mileageUnit: node.mileageFromOdometer?.unitCode ?? node.mileageFromOdometer?.unitText ?? null,
        vehicleModelDate: node.vehicleModelDate ?? null, productionDate: node.productionDate ?? null,
        fuelType: node.fuelType ?? null, bodyType: node.bodyType ?? null,
        vehicleEngine: typeof node.vehicleEngine === "object" ? node.vehicleEngine.name ?? node.vehicleEngine.engineDisplacement?.value ?? null : node.vehicleEngine ?? null,
        vehicleTransmission: node.vehicleTransmission ?? null, vin: node.vehicleIdentificationNumber ?? null,
        offers: node.offers ? (Array.isArray(node.offers) ? node.offers : [node.offers]).map((offer) => ({
          price: offer.price ?? offer.lowPrice ?? null, priceCurrency: offer.priceCurrency ?? null,
          availability: offer.availability ?? null, url: offer.url ?? null,
        })) : [] });
    }
    Object.values(node).forEach(visit);
  };
  for (const match of String(html ?? "").matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'"))); } catch { /* Ignore malformed JSON-LD. */ }
  }
  return values;
}

function listingIdentity(value, sourceId) {
  const url = new URL(value);
  const host = url.hostname.replace(/^www\./, "");
  if (sourceId === "olx" && host === "olx.pl") {
    const id = url.pathname.match(/-(ID[a-z0-9]+)\.html$/i)?.[1];
    if (id) return "olx:" + id;
  }
  if (sourceId === "autoplac" && host === "autoplac.pl" ||
      sourceId === "allegro-lokalnie" && host === "allegrolokalnie.pl") {
    if (url.pathname.startsWith("/oferta/")) return host + url.pathname.replace(/\/$/, "");
  }
  if (sourceId === "automarket" && host === "automarket.pl") {
    const id = url.pathname.match(/^\/oferta\/[^/]+\/[^/]+\/([a-z0-9]+)(?:\/|$)/i)?.[1];
    if (id) return `automarket:${id.toLowerCase()}`;
  }
  url.hash = "";
  return url.href;
}

async function activeListingIdentities(sourceId, task) {
  if (Array.isArray(task?.activeOfferUrls)) {
    return new Set(task.activeOfferUrls.flatMap((url) => {
      try { return [listingIdentity(url, sourceId)]; } catch { return []; }
    }));
  }
  const folder = path.join(ROOT, "offers");
  const names = (await readdir(folder)).filter((name) => name.endsWith(".json"));
  const records = await Promise.all(names.map((name) => readFile(path.join(folder, name), "utf8").then(JSON.parse)));
  return new Set(records.flatMap((doc) => (doc.offers ?? [])
    .flatMap((offer) => (offer.urls ?? []).map(({ url }) => listingIdentity(url, sourceId)))));
}

async function inspectCandidateCards(context, task, listings, state, maxCards, knownModels) {
  const checks = [];
  const offers = [];
  const cachedReads = new Map((task.sharedResultsCache?.cardReads ?? []).map((entry) => [entry.url, entry]));
  const active = await activeListingIdentities(task.sourceId, task);
  const seen = new Set();
  let page;
  let freshReads = 0;
  for (const listing of listings) {
    const identity = listingIdentity(listing.url, task.sourceId);
    if (seen.has(identity) || active.has(identity)) continue;
    seen.add(identity);
    if (screeningFailure(listing, task) || explicitModelMismatch(listing, task, knownModels)) continue;
    if (!listingOriginAllowed(listing.url, task.searchProfile.searchUrl) || !state.allowed(listing.url)) continue;
    const cached = cachedReads.get(listing.url);
    if (cached && cached.checkedAt && (cached.card || cached.error)) {
      state.openedListingUrls.add(listing.url);
      const entry = { ...cached };
      checks.push(entry);
      if (cached.error) {
        if (/403|429|access denied|captcha|blocked/i.test(cached.error)) { state.blocked = true; break; }
        continue;
      }
      const finding = classifyGenericCard(listing, cached.card, task, cached.checkedAt);
      entry.status = finding.status;
      if (finding.note) entry.note = finding.note;
      entry.fromSharedCache = true;
      if (finding.offer) offers.push(finding.offer);
      continue;
    }
    if (freshReads >= maxCards) {
      state.notes.push(`Osiągnięto limit ${maxCards} nowych odczytów kart.`);
      break;
    }
    page ??= await context.newPage();
    freshReads += 1;
    state.openedListingUrls.add(listing.url);
    const checkedAt = new Date().toISOString();
    let deniedUrl = null;
    const guard = async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !state.allowed(request.url())) {
        deniedUrl = request.url();
        await route.abort();
      } else await route.continue();
    };
    try {
      await page.route("**/*", guard);
      const response = await page.goto(listing.url, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForFunction(() => document.querySelector("h1")?.innerText?.trim() || (document.body?.innerText ?? "").trim().length > 200,
        null, { timeout: 5000, polling: 100 }).catch(() => {});
      const rendered = await page.evaluate((sourceId) => {
        const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
        const title = clean(document.querySelector("h1")?.innerText || document.title).slice(0, 250);
        const bodyText = clean(document.body?.innerText).slice(0, 14000);
        const fields = {};
        const put = (label, value) => {
          const key = clean(label).replace(/[:：]+$/, "").slice(0, 90);
          const item = clean(value).slice(0, 260);
          if (key && item && !fields[key]) fields[key] = item;
        };
        for (const node of document.querySelectorAll("dl")) {
          const children = [...node.children];
          for (let i = 0; i < children.length - 1; i += 1) if (/^(DT|TH)$/i.test(children[i].tagName)) put(children[i].innerText, children[i + 1].innerText);
        }
        for (const row of document.querySelectorAll("tr")) {
          const cells = [...row.querySelectorAll("th,td")];
          if (cells.length >= 2) put(cells[0].innerText, cells.slice(1).map((cell) => cell.innerText).join(" "));
        }
        for (const item of document.querySelectorAll("li, [class*=spec], [class*=detail], [class*=attribute]")) {
          const label = item.querySelector(":scope > span:first-child, :scope > dt, :scope > strong:first-child, :scope > b:first-child, :scope > label");
          const value = item.querySelector(":scope > strong:last-child, :scope > dd, :scope > span:last-child, :scope > b:last-child");
          if (label && value && label !== value) put(label.innerText, value.innerText);
        }
        for (const node of document.querySelectorAll("[itemprop]")) {
          const key = node.getAttribute("itemprop");
          const value = node.getAttribute("content") || node.getAttribute("datetime") || node.innerText;
          if (key && value) put(key, value);
        }
        const photos = [...new Set([...document.querySelectorAll('[class*=gallery] img[src], [class*=slider] img[src], [data-testid*=gallery] img[src], [data-testid*=image] img[src]')]
          .filter((node) => node.getClientRects().length > 0)
          .map((node) => node.currentSrc || node.src).filter((url) => /^https:\/\//i.test(url)))].slice(0, 12);
        const ctas = [...document.querySelectorAll("main a, main button, main [role=button], article a, article button")].filter((node) => {
          if (!node.getClientRects().length) return false;
          const text = clean(node.innerText || node.getAttribute("aria-label"));
          return /zadzwoń|telefon|pokaż numer|skontaktuj|umów.{0,12}(jazd|wizyt)|zapytaj o (auto|ofert)|sprawdź dostępność|kup teraz/i.test(text) || /^tel:/i.test(node.getAttribute("href") || "");
        }).map((node) => clean(node.innerText || node.getAttribute("aria-label"))).filter(Boolean).slice(0, 8);
        const visibleText = (selector) => [...document.querySelectorAll(selector)]
          .filter((node) => node.getClientRects().length).map((node) => clean(node.innerText)).find(Boolean) ?? "";
        const salePanel = sourceId === "allegro-lokalnie" ? {
          price: visibleText('[data-testid="offer-overview-card"] .ml-offer-price'),
          terms: visibleText('[data-testid="offer-overview-card"]'),
          auctionAction: [...document.querySelectorAll("main button")].some((node) =>
            node.getClientRects().length && /^(licytuj|weź udział w licytacji)$/i.test(clean(node.innerText))),
        } : sourceId === "autoplac" ? {
          price: visibleText(".offer-info__price-primary"),
          terms: visibleText(".offer-info__price-wrapper"),
        } : null;
        return { title, bodyText, fields, photos, ctas, salePanel };
      }, task.sourceId);
      const { title, bodyText } = rendered;
      const structuredData = parseStructuredVehicles(await page.content().catch(() => ""));
      const status = response?.status() ?? null;
      const blocked = [401, 403, 429].includes(status) || /access denied|robot check|captcha|verify you are human|dostęp został zablokowany/i.test(`${title} ${bodyText.slice(0, 450)}`);
      if (deniedUrl) {
        checks.push({ url: listing.url, checkedAt, error: "Karta przekierowała na adres poza dozwolonym zakresem portalu lub robots.txt." });
        state.blocked = true;
        break;
      }
      if (blocked) {
        checks.push({ url: listing.url, checkedAt, error: `Portal odmówił dostępu lub wyświetlił blokadę (HTTP ${status ?? "challenge"}).` });
        state.blocked = true;
        break;
      }
      if (status >= 400) {
        checks.push({ url: listing.url, checkedAt, error: `Karta zwróciła HTTP ${status}.` });
        continue;
      }
      const card = { ...rendered, structuredData };
      const finding = classifyGenericCard(listing, card, task, checkedAt);
      checks.push({ url: listing.url, checkedAt, card, status: finding.status, ...(finding.note ? { note: finding.note } : {}) });
      if (finding.offer) offers.push(finding.offer);
    } catch (error) {
      checks.push({ url: listing.url, checkedAt, error: String(error?.message ?? error).split("\n")[0].slice(0, 240) });
      if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(String(error?.message ?? error))) { state.dnsFailures += 1; state.dnsFailuresWithoutHttp += 1; break; }
      if (/ERR_CERT_|CERT_/i.test(String(error?.message ?? error))) { state.blocked = true; break; }
    } finally { await page.unroute("**/*", guard).catch(() => {}); }
  }
  await page?.close();
  return { checks, offers };
}

export { classifyGenericCard } from "./portal-card-classifier.mjs";

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
  const [sourcesDoc, adapterConfig, modelConfig] = await Promise.all([
    readFile(path.join(ROOT, "config/sources.json"), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "config/portal-adapters.json"), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "config/search-models.json"), "utf8").then(JSON.parse),
  ]);
  const sources = sourcesDoc.sources;
  const knownModels = modelConfig.models.filter((model) => model.active).map(({ brand, model }) => ({ brand, model }));
  const source = sources.find((item) => item.id === task.sourceId && item.enabled);
  if (!source) throw new Error(`Source ${task.sourceId} is absent or disabled in current source config`);
  const queryPlan = task.searchProfile.queryPlan ?? {};
  const planned = Array.isArray(queryPlan.textQueries) ? queryPlan.textQueries : [];
  const queries = planned.length ? planned : [{ id: "model-body", text: [queryPlan.manualFilters?.make, queryPlan.manualFilters?.model,
    ...(task.searchProfile.bodyAliases ?? [])].filter(Boolean).join(" ") }];
  if (!queries.some((item) => typeof item.text === "string" && item.text.trim())) {
    throw new Error("Frozen task queryPlan has no usable text query");
  }

  const sourceAdapter = adapterConfig.adapters[task.sourceId];
  if (!sourceAdapter) throw new Error(`Missing adapter entry for enabled source ${task.sourceId}`);
  if (sourceAdapter.mode === "blocked") {
    const note = sourceAdapter.note ?? "Portal oznaczono jako niedostępny w ostatnim pilotażu; bez ponownej próby.";
    process.stdout.write(`${JSON.stringify({ taskId: task.id, outcome: "blocked", checkedAt: new Date().toISOString(),
      coverage: { searchUrls: [], pagesChecked: 0, remaining: note, searchResults: [], listingUrlsChecked: [] },
      offers: [], errors: [{ url: task.searchProfile.searchUrl, error: note }] }, null, 2)}\n`);
    return;
  }
  const adapter = sourceAdapter.mode === "dedicated" ? null : sourceAdapter;
  const continuationResult = task.continuation ? await loadContinuationResult(task) : null;
  const cachedPages = !continuationResult && (!adapter || (adapter.mode === "existing_results" && !adapter.loadMoreButton))
    ? cachedCompletePages(task, options.maxPages) : [];
  const useCachedPages = cachedPages.length > 0 && options.verifyCards;
  if (cachedPages.length && !options.verifyCards) {
    emitPartialFromCache(task, cachedPages, options.maxPages);
    return;
  }

  const previousCoverage = continuationResult?.coverage ?? {};
  const previousPages = previousCoverage.searchResults ?? [];
  const state = { pages: continuationResult ? [...previousPages] : useCachedPages ? [...cachedPages] : [],
    listingUrls: new Set(previousPages.flatMap((item) => (item.listings ?? []).map((listing) => listing.url))),
    openedListingUrls: new Set(previousCoverage.listingUrlsChecked ?? []),
    errors: continuationResult ? [...(continuationResult.errors ?? [])] : [], notes: [], blocked: false, dnsFailures: 0, dnsFailuresWithoutHttp: 0, baseStatus: null, lastDocumentStatus: null,
    metrics: { navigationMs: 0, renderWaitMs: 0, queryActionMs: 0, extractionMs: 0, candidates: 0 }, cardPilot: null };
  const taskStartedAt = Date.now();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    if (task.sourceId === "autoplac") {
      const consent = page.locator("#uniccmp").getByRole("button", { name: "Zgadzam się i kontynuuj", exact: true });
      await page.addLocatorHandler(consent, async () => {
        await consent.click({ timeout: 3000 });
      });
    }
    page.on("response", (response) => {
      if (response.request().resourceType() === "document") state.lastDocumentStatus = response.status();
    });
    try {
      state.allowed = await portalNavigationPolicy(context, task.searchProfile.searchUrl);
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !state.allowed(request.url())) {
          state.blocked = true;
          state.errors.push({ url: request.url(), error: "Nawigacja poza zakresem portalu lub robots.txt." });
          await route.abort();
        } else await route.continue();
      });
      const initialUrl = continuationResult ? task.continuation.nextUrl : task.searchProfile.searchUrl;
      if (!state.allowed(initialUrl)) {
        throw Object.assign(new Error("Adres wyszukiwania lub kontynuacji niedozwolony przez robots.txt."), { blocked: true, url: initialUrl });
      }
      if (continuationResult) {
        state.notes.push(`Kontynuacja ${task.continuation.queryId} od zapisanego nextUrl bez ponownego otwierania wcześniejszych stron wyników.`);
      } else if (useCachedPages) {
        state.baseStatus = 200;
        for (const cachedPage of cachedPages) if (!state.allowed(cachedPage.url)) {
          state.blocked = true;
          state.errors.push({ url: cachedPage.url, error: "Adres strony cache niedozwolony przez portal lub robots.txt." });
        }
        state.notes.push(`Ponownie użyto ${cachedPages.length} stron wyników kompletnych z sharedResultsCache; nie odczytywano ich ponownie.`);
      } else {
        const navigationStarted = Date.now();
        if (!continuationResult) {
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
        }
      }
    } catch (error) {
      state.errors.push({ url: error.url ?? task.searchProfile.searchUrl, error: String(error?.message ?? error).split("\n")[0].slice(0, 300) });
      const message = String(error?.message ?? error);
      if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(message)) { state.dnsFailures += 1; state.dnsFailuresWithoutHttp += 1; }
      state.blocked = Boolean(error.blocked) || /403|429|ERR_CERT_|ERR_BLOCKED/i.test(message);
    }
    if ([401, 403, 429].includes(state.baseStatus)) {
      state.blocked = true;
      state.errors.push({ url: task.searchProfile.searchUrl, error: `Portal returned HTTP ${state.baseStatus}; no retry or bypass attempted.` });
    } else if (!useCachedPages && (state.baseStatus !== null || continuationResult) && !state.blocked) {
      const queriesToRun = continuationResult
        ? [queries.find((query) => query.id === task.continuation.queryId) ?? { id: task.continuation.queryId, text: "" }]
        : queries;
      for (const query of queriesToRun) {
        try {
          await captureQuery(page, task, query, options.maxPages, state, adapter,
            continuationResult ? task.continuation.nextUrl : null);
          if (state.blocked) break;
        } catch (error) {
          state.errors.push({ url: page.url(), error: String(error?.message ?? error).split("\n")[0].slice(0, 300) });
          const message = String(error?.message ?? error);
          if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
            state.dnsFailures += 1;
            state.dnsFailuresWithoutHttp += 1;
            break;
          }
          if (/ERR_CERT_|ERR_BLOCKED/i.test(message)) {
            state.blocked = true;
            break;
          }
        }
      }
    }

    if (options.inspectOneCard && !state.blocked) {
      const listings = state.pages.flatMap((item) => item.listings ?? []);
      state.cardPilot = await inspectOneCard(context, task, listings, state);
    }

    if (options.verifyCards && !state.blocked) {
      const listings = state.pages.flatMap((item) => item.listings ?? []);
      const result = await inspectCandidateCards(context, task, listings, state, options.maxCards, knownModels);
      state.cardReads = result.checks;
      state.offers = result.offers;
      for (const entry of result.checks.filter((item) => item.error)) state.errors.push({ url: entry.url, error: entry.error });
    }

    const pagesByQuery = new Map();
    for (const page of state.pages) {
      const queryId = page.queryId ?? "unfiltered";
      const pages = pagesByQuery.get(queryId) ?? [];
      pages.push(page);
      pagesByQuery.set(queryId, pages);
    }
    const effectiveQueryIds = adapter?.mode === "text_query"
      ? queries.map((query) => query.id)
      : [adapter && adapter.mode !== "existing_results" ? "make-model" : "unfiltered"];
    const queryCoverage = effectiveQueryIds.map((queryId) => {
      const pages = pagesByQuery.get(queryId) ?? [];
      const lastPage = pages.at(-1);
      const incompleteNote = state.notes.some((note) => note.startsWith(`${queryId}:`));
      const complete = pages.length > 0 && !lastPage.nextUrl && !incompleteNote && !state.blocked;
      return { queryId, pagesChecked: pages.length, complete,
        endReason: complete ? "no_next_page" : incompleteNote ? "reader_limit_or_pagination_issue" : state.blocked ? "blocked" : "query_or_page_missing" };
    });
    const eligibleListingIdentities = new Set();
    const activeIdentities = await activeListingIdentities(task.sourceId, task);
    for (const listing of state.pages.flatMap((item) => item.listings ?? [])) {
      const identity = listingIdentity(listing.url, task.sourceId);
      if (activeIdentities.has(identity) || screeningFailure(listing, task) || explicitModelMismatch(listing, task, knownModels) ||
          !listingOriginAllowed(listing.url, task.searchProfile.searchUrl) || !state.allowed(listing.url)) continue;
      eligibleListingIdentities.add(identity);
    }
    const checkedIdentities = new Set([...state.openedListingUrls].map((url) => listingIdentity(url, task.sourceId)));
    const conclusiveStatuses = new Set(["available", "closed", "rejected"]);
    const conclusiveIdentities = new Set((state.cardReads ?? [])
      .filter((entry) => conclusiveStatuses.has(entry.status))
      .map((entry) => listingIdentity(entry.url, task.sourceId)));
    const cardsComplete = options.verifyCards && [...eligibleListingIdentities].every((identity) => checkedIdentities.has(identity)) &&
      [...eligibleListingIdentities].every((identity) => conclusiveIdentities.has(identity)) &&
      !(state.cardReads ?? []).some((entry) => entry.error);
    const searchComplete = queryCoverage.length > 0 && queryCoverage.every((item) => item.complete) && !state.blocked;
    const complete = searchComplete && cardsComplete && !state.errors.length;
    const outcome = state.blocked && !(state.offers?.length) ? "blocked" : complete
      ? (state.offers?.length ? "complete" : "no_matches") : "partial";
    const remaining = complete ? "" : [
      !searchComplete ? "Nie ukończono wszystkich wymaganych zapytań lub paginacji." : "",
      !options.verifyCards ? "Karty ogłoszeń nie były otwierane; nie można rozstrzygnąć dostępności ani zwrócić no_matches." : "",
      options.verifyCards && !cardsComplete ? `Nie rozstrzygnięto wszystkich ${eligibleListingIdentities.size} kandydatów; błąd dostępu lub niejednoznaczna karta pozostaje do sprawdzenia.` : "",
      ...state.notes,
      ...state.errors.map((entry) => entry.error),
    ].filter(Boolean).join(" ");
    const previousOfferUrls = new Set([...(task.continuation?.priorOfferUrls ?? []),
      ...(continuationResult?.offers ?? []).map((offer) => offer?.observation?.url)].filter(Boolean));
    const previousOfferIds = new Set([...(task.continuation?.priorOfferIds ?? []),
      ...(continuationResult?.offers ?? []).map((offer) => offer?.id)].filter(Boolean));
    const outputOffers = (state.offers ?? []).filter((offer) =>
      !previousOfferUrls.has(offer?.observation?.url) && !previousOfferIds.has(offer?.id));
    const result = {
      taskId: task.id,
      outcome,
      checkedAt: new Date().toISOString(),
      coverage: {
        searchUrls: [...new Set(state.pages.map((item) => item.url))],
        pagesChecked: state.pages.length,
        remaining,
        searchQueries: queryCoverage,
        searchResults: state.pages,
        listingUrlsChecked: [...state.openedListingUrls],
        ...(state.cardReads ? { cardReads: state.cardReads } : {}),
      },
      offers: outputOffers,
      errors: [...new Map(state.errors.map((entry) => [`${entry?.url ?? ""}\u0000${entry?.error ?? String(entry)}`, entry])).values()],
      networkDiagnostics: { dnsFailures: state.dnsFailures, dnsFailuresWithoutHttp: state.dnsFailuresWithoutHttp },
      diagnostics: { ...state.metrics, elapsedMs: Date.now() - taskStartedAt,
        assetBlocking: "disabled_unless_measured_for_source" },
      ...(state.cardPilot ? { cardPilot: state.cardPilot } : {}),
      ...(task.continuation ? { continuation: task.continuation } : {}),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    await context.close();
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(String(error?.stack ?? error) + "\n");
    process.exitCode = 1;
  });
}
