function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function filterSetupError(message, retryableFilterSetup = false) {
  return Object.assign(new Error(message), { retryableFilterSetup });
}

function normalizeOptionText(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function stripOptionCount(value) {
  return String(value ?? "").trim().replace(/\s+\(\s*\d[\d\s,.]*\s*\)\s*$/, "");
}

function optionMatches(optionText, expectedText) {
  const option = normalizeOptionText(stripOptionCount(optionText));
  const expected = normalizeOptionText(expectedText);
  if (option === expected) return true;
  const prefix = expected + " ";
  if (!option.startsWith(prefix)) return false;
  const suffix = option.slice(prefix.length);
  return /^\d{4}(?:\s+\d{4})?$/.test(suffix) || /^np(?:\s|$)/.test(suffix);
}

async function clickUnique(locator, label) {
  const count = await locator.count();
  if (count !== 1) throw new Error(`Nie znaleziono jednej widocznej opcji filtra: ${label} (liczba: ${count}).`);
  await locator.click({ timeout: 5000 });
}

async function selectFilterOption(page, value, timeoutMs = 7000) {
  const root = page.getByTestId("filters");
  const options = root.getByRole("option").filter({ visible: true });
  const expected = normalizeOptionText(value);
  try {
    await page.waitForFunction((expectedText) => {
      const normalize = (value) => String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, " ").trim();
      const stripCount = (value) => String(value ?? "").trim().replace(/\s+\(\s*\d[\d\s,.]*\s*\)\s*$/, "");
      const matches = [...document.querySelectorAll('[data-testid="filters"] [role="option"]')]
        .filter((item) => item.getClientRects().length)
        .filter((item) => {
          const option = normalize(stripCount(item.textContent));
          if (option === expectedText) return true;
          const prefix = `${expectedText} `;
          if (!option.startsWith(prefix)) return false;
          const suffix = option.slice(prefix.length);
          return /^\d{4}(?:\s+\d{4})?$/.test(suffix) || /^np(?:\s|$)/.test(suffix);
        });
      return matches.length === 1;
    }, expected, { timeout: timeoutMs });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      const visibleLabels = (await options.allTextContents()).map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
      const labels = visibleLabels.filter((item) => optionMatches(item, value));
      if (labels.length > 1) throw new Error(`Opcja filtra ${value} jest niejednoznaczna (${labels.length} widoczne dopasowania: ${labels.join(" | ")}).`);
      throw filterSetupError(`Opcja filtra ${value} nie pojawiła się jako jednoznaczny wybór w ciągu ${timeoutMs} ms. Widoczne opcje: ${visibleLabels.slice(0, 12).join(" | ") || "(brak)"}.`, true);
    }
    throw error;
  }
  const labels = await options.allTextContents();
  const matches = labels.map((label, index) => ({ label: label.replace(/\s+/g, " ").trim(), index }))
    .filter((item) => optionMatches(item.label, value));
  if (matches.length !== 1) throw new Error(`Opcja filtra ${value} jest niejednoznaczna (${matches.length} widoczne dopasowania).`);
  await options.nth(matches[0].index).click({ timeout: 5000 });
  return matches[0].label;
}

async function fillAutocompleteFilter(page, placeholder, value, candidates = [value], profile = {}) {
  const root = page.getByTestId("filters");
  const input = root.getByPlaceholder(placeholder).filter({ visible: true });
  const fieldReadyTimeoutMs = profile.fieldReadyTimeoutMs ?? 10000;
  try {
    await input.first().waitFor({ state: "visible", timeout: fieldReadyTimeoutMs });
  } catch (error) {
    if (error?.name === "TimeoutError") throw filterSetupError(`Pole ${placeholder} nie pojawiło się w ciągu ${fieldReadyTimeoutMs} ms.`, true);
    throw error;
  }
  const count = await input.count();
  if (count === 0) throw filterSetupError(`Pole ${placeholder} zniknęło przed ustawieniem wartości.`, true);
  if (count !== 1) throw new Error(`Nie znaleziono jednego aktywnego pola ${placeholder} (liczba: ${count}).`);
  try {
    await page.waitForFunction((name) => {
      const panel = document.querySelector('[data-testid="filters"]');
      const field = [...(panel?.querySelectorAll("input") ?? [])].find((item) => item.placeholder === name && item.getClientRects().length);
      return Boolean(field && !field.disabled && field.getAttribute("aria-disabled") !== "true");
    }, placeholder, { timeout: fieldReadyTimeoutMs });
  } catch (error) {
    throw filterSetupError(`Pole ${placeholder} nie zostało aktywowane po zastosowaniu poprzedniego filtra.`, error?.name === "TimeoutError");
  }
  let lastError;
  for (const candidate of [...new Set(candidates.map((item) => String(item).trim()).filter(Boolean))]) {
    await input.fill(candidate);
    try {
      return await selectFilterOption(page, candidate, profile.optionReadyTimeoutMs ?? 7000);
    } catch (error) {
      lastError = error;
      if (!error?.retryableFilterSetup) throw error;
    }
  }
  throw lastError ?? filterSetupError(`Brak wariantu tekstowego dla filtra ${placeholder}: ${value}.`, true);
}

async function fillVisibleFilter(page, label, value, timeoutMs = 3000, { keyboard = false } = {}) {
  const input = page.getByTestId("filters").getByPlaceholder(label).filter({ visible: true });
  try {
    await input.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    if (error?.name === "TimeoutError") throw filterSetupError(`Pole ${label} nie pojawiło się w ciągu ${timeoutMs} ms.`, true);
    throw error;
  }
  const count = await input.count();
  if (count === 0) throw filterSetupError(`Pole filtra ${label} zniknęło przed ustawieniem wartości.`, true);
  if (count !== 1) throw new Error(`Nie znaleziono jednego aktywnego pola filtra ${label} (liczba: ${count}).`);
  try {
    await page.waitForFunction((name) => {
      const panel = document.querySelector('[data-testid="filters"]');
      const field = [...(panel?.querySelectorAll("input") ?? [])].find((item) => item.placeholder === name && item.getClientRects().length);
      return Boolean(field && !field.disabled && field.getAttribute("aria-disabled") !== "true");
    }, label, { timeout: timeoutMs });
  } catch (error) {
    if (error?.name === "TimeoutError") throw filterSetupError(`Pole ${label} nie zostało aktywowane w ciągu ${timeoutMs} ms.`, true);
    throw error;
  }
  if (keyboard) {
    await input.focus();
    await input.press("Control+A");
    await input.pressSequentially(String(value), { delay: 35 });
  } else {
    await input.fill(String(value));
  }
  await input.press("Tab");
}

async function waitForNumericFilterValues(page, filters, timeoutMs) {
  if (!filters.length) return true;
  const expected = filters.map(({ label, value }) => ({ label, value: String(value).replace(/\D/g, "") }));
  try {
    await page.waitForFunction((items) => {
      const panel = document.querySelector('[data-testid="filters"]');
      return items.every(({ label, value }) => {
        const fields = [...(panel?.querySelectorAll("input") ?? [])]
          .filter((item) => item.placeholder === label && item.getClientRects().length);
        if (fields.length !== 1 || fields[0].disabled || fields[0].getAttribute("aria-disabled") === "true") return false;
        return fields[0].value.replace(/\D/g, "") === value && document.activeElement !== fields[0];
      });
    }, expected, { timeout: timeoutMs });
    return true;
  } catch (error) {
    if (error?.name === "TimeoutError") return false;
    throw error;
  }
}

async function measureNumericFilterPoll(timings, stage, metadata, page, filters, timeoutMs) {
  const startedAt = Date.now();
  try {
    const ready = await waitForNumericFilterValues(page, filters, timeoutMs);
    timings.record(stage, Date.now() - startedAt, ready ? "ok" : "timeout", metadata);
    return ready;
  } catch (error) {
    timings.record(stage, Date.now() - startedAt, "error", {
      ...metadata, error: String(error?.message ?? error).split("\n")[0].slice(0, 300) });
    throw error;
  }
}

async function measureFilterRequestWait(timings, stage, metadata, waitPromise) {
  const started = Date.now();
  try {
    const applied = await waitPromise;
    timings.record(stage, Date.now() - started, applied ? "ok" : "timeout", metadata);
    return applied;
  } catch (error) {
    timings.record(stage, Date.now() - started, "error", {
      ...metadata, error: String(error?.message ?? error).split("\n")[0].slice(0, 300) });
    throw error;
  }
}

async function applySelectedFilters(page, runContext, { waitForListingResponse = false, requireListingResponse = false } = {}) {
  const searchButton = page.getByTestId("filters").getByRole("button", { name: /^search$/i }).filter({ visible: true });
  try {
    await searchButton.first().waitFor({ state: "visible", timeout: 6000 });
  } catch (error) {
    if (error?.name === "TimeoutError") throw filterSetupError("Przycisk wyszukiwania nie pojawił się w ciągu 6000 ms.", true);
    throw error;
  }
  const count = await searchButton.count();
  if (count === 0) throw filterSetupError("Przycisk wyszukiwania zniknął przed wysłaniem filtrów.", true);
  if (count !== 1) throw new Error(`Nie znaleziono przycisku zastosowania filtrów OTOMOTO (liczba: ${count}).`);
  if (requireListingResponse) runContext.lastFilterRequestAudit = null;
  const listingResponsePromise = waitForListingResponse ? runContext.waitForListingResponse?.(requireListingResponse) : null;
  await searchButton.click({ timeout: 6000, noWaitAfter: true });
  if (listingResponsePromise) {
    const listingResponse = await listingResponsePromise;
    if (!listingResponse && requireListingResponse) {
      const error = filterSetupError("Po zastosowaniu filtrów OTOMOTO nie wysłało żądania listy ofert z kompletem wymaganych filtrów w wyznaczonym czasie.", true);
      error.filterAudit = runContext.lastFilterRequestAudit ?? null;
      throw error;
    }
    if (listingResponse && requireListingResponse) runContext.firstListingResponsePromise = Promise.resolve(listingResponse);
  }
  runContext.searchSubmitted = true;
  await runContext.checkAccess?.();
}

function modelGroupFilterValues(models) {
  const requirements = models.map((model) => model.requirements ?? {});
  const finiteValues = (values) => values.filter(Number.isFinite);
  const priceValues = requirements.map((item) => item.purchase?.maxPriceGrossPln);
  const yearValues = requirements.map((item, index) => item.yearMin ?? models[index].searchYears?.min);
  const mileageValues = requirements.map((item) => item.mileage?.hardMaxKm ?? item.mileage?.preferredMaxKm);
  // A group-level bound must not exclude a model whose own bound is unspecified.
  const maxPriceGrossPln = priceValues.every(Number.isFinite) ? finiteValues(priceValues) : [];
  const yearMin = yearValues.every(Number.isFinite) ? finiteValues(yearValues) : [];
  const mileageMaxKm = mileageValues.every(Number.isFinite) ? finiteValues(mileageValues) : [];
  return {
    maxPriceGrossPln: maxPriceGrossPln.length ? Math.max(...maxPriceGrossPln) : null,
    yearMin: yearMin.length ? Math.min(...yearMin) : null,
    mileageMaxKm: mileageMaxKm.length ? Math.max(...mileageMaxKm) : null,
  };
}

function groupedGenerationValues(models, profile = {}) {
  if (models.some((model) => profile.omitGenerationModels?.includes(model.key))) return [];
  if (models.some((model) => !String(model.generation ?? "").trim())) return [];
  const generations = [...new Set(models.map((model) => String(model.generation).trim()))];
  if (generations.length !== 1) return [];
  return models.map((model) => profile.generationOptions?.[model.key] ?? generations[0]).slice(0, 1);
}

function bodyLabel(value) {
  return ({ wagon: "Kombi", sedan: "Sedan", hatchback: "Hatchback", suv: "SUV", crossover: "Crossover", minivan: "Minivan" })[String(value).toLowerCase()] ?? value;
}

function groupedBodyValue(models) {
  const values = models.map((model) => model.bodies ?? []);
  if (values.some((items) => items.length !== 1)) return null;
  const normalized = values.map((items) => String(items[0]).toLowerCase());
  return normalized.every((value) => value === normalized[0]) ? normalized[0] : null;
}

function prepareFilterPlan(group, profile = {}) {
  const commonFilters = modelGroupFilterValues(group.models);
  const brandKey = normalizeOptionText(group.brand).replace(/ /g, "");
  const brandAliases = profile.brandAliases?.[brandKey] ?? [];
  const bodyValue = groupedBodyValue(group.models);
  const modelGenerations = [...new Set(group.models.map((model) => String(model.generation ?? "").trim()).filter(Boolean))];
  const omittedGenerationModels = group.models.filter((model) => profile.omitGenerationModels?.includes(model.key));
  const generations = groupedGenerationValues(group.models, profile);
  return {
    make: { value: group.brand, candidates: [...new Set([...brandAliases, group.brand])] },
    models: group.models.map((model) => ({ key: model.key, value: model.model })),
    generations,
    omittedFilters: [
      ...(modelGenerations.length > 1
        ? [{ filter: "generation", reason: "Wybrane modele mają różne generacje; pominięto wspólny filtr generacji." }] : []),
      ...omittedGenerationModels.map((model) => ({ filter: "generation", modelKey: model.key,
        reason: "Profil źródła pomija generację; filtr roku ogranicza poszukiwaną generację." })),
    ],
    body: bodyValue ? bodyLabel(bodyValue) : null,
    numericFilters: [
      { key: "maxPriceGrossPln", label: "Cena do", value: commonFilters.maxPriceGrossPln },
      { key: "yearMin", label: "Rok od", value: commonFilters.yearMin },
      { key: "mileageMaxKm", label: "Przebieg do", value: commonFilters.mileageMaxKm },
    ].filter((filter) => Number.isFinite(filter.value)),
    profile,
  };
}

function portalSlug(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildFilteredSearchUrl(group, plan, baseUrl) {
  if (group.models.length !== 1) throw new Error("Tryb URL OTOMOTO wymaga osobnego adresu dla każdego modelu.");
  const model = group.models[0];
  const url = new URL(baseUrl);
  const rootPath = url.pathname.replace(/\/$/, "");
  const segments = [rootPath, portalSlug(model.brand), portalSlug(model.model)];
  const bodyRoutes = { wagon: "combi", combi: "combi", sedan: "sedan", hatchback: "hatchback",
    suv: "suv", crossover: "crossover", minivan: "minivan" };
  const requestedBody = (model.bodies ?? []).length === 1 ? String(model.bodies[0]).toLowerCase() : null;
  const numeric = Object.fromEntries(plan.numericFilters.map((filter) => [filter.key, filter.value]));
  const profile = plan.profile ?? {};
  const bodyQueryValue = profile.urlBodyValues?.[model.key];
  const bodyOmitted = (profile.urlOmitBodyModels ?? []).includes(model.key);
  const yearUsesQuery = (profile.urlYearQueryModels ?? []).includes(model.key);
  if (requestedBody && bodyRoutes[requestedBody] && !bodyQueryValue && !bodyOmitted) segments.push(`seg-${bodyRoutes[requestedBody]}`);
  if (Number.isFinite(numeric.yearMin) && !yearUsesQuery) segments.push(`od-${numeric.yearMin}`);
  url.pathname = segments.filter(Boolean).join("/");
  url.search = "";

  const generationValue = profile.urlGenerationValues?.[model.key];
  const generationOmitted = (profile.urlOmitGenerationModels ?? []).includes(model.key) ||
    (profile.omitGenerationModels ?? []).includes(model.key);
  const filtersApplied = { make: model.brand, models: [model.model] };
  const omittedFilters = [...(plan.omittedFilters ?? [])];
  if (generationValue && !generationOmitted) {
    url.searchParams.set("search[filter_enum_generation]", generationValue);
    filtersApplied.generation = generationValue;
  } else if (String(model.generation ?? "").trim()) {
    const alreadyOmitted = omittedFilters.some((item) => item.filter === "generation" && item.modelKey === model.key);
    if (!alreadyOmitted) omittedFilters.push({ filter: "generation", modelKey: model.key,
      reason: generationOmitted ? "Profil URL jawnie pomija generację; filtr roku zawęża wyniki." :
        "Brak potwierdzonej wartości generacji w formacie URL OTOMOTO; pozostaje filtr modelu, nadwozia i roku." });
  }
  if (bodyQueryValue) url.searchParams.set("search[filter_enum_body_type]", bodyQueryValue);
  if (yearUsesQuery && Number.isFinite(numeric.yearMin)) {
    url.searchParams.set("search[filter_float_year:from]", String(numeric.yearMin));
  }
  if (requestedBody && bodyRoutes[requestedBody] && !bodyOmitted) filtersApplied.body = plan.body;
  if (bodyOmitted) omittedFilters.push({ filter: "body", modelKey: model.key,
    reason: "Portal nie udostępnia wiarygodnej wartości tego nadwozia; typ zostanie sprawdzony na karcie oferty." });
  if (Number.isFinite(numeric.yearMin)) filtersApplied.yearMin = numeric.yearMin;
  if (Number.isFinite(numeric.mileageMaxKm)) {
    url.searchParams.set("search[filter_float_mileage:to]", String(numeric.mileageMaxKm));
    filtersApplied.mileageMaxKm = numeric.mileageMaxKm;
  }
  if (Number.isFinite(numeric.maxPriceGrossPln)) {
    url.searchParams.set("search[filter_float_price:to]", String(numeric.maxPriceGrossPln));
    filtersApplied.maxPriceGrossPln = numeric.maxPriceGrossPln;
  }
  return { url: url.href, filtersApplied, filterPlan: { ...plan, omittedFilters } };
}

function listingRequestInfo(response) {
  try {
    const url = new URL(response.url);
    let operationName = url.searchParams.get("operationName") ?? response.requestInfo?.operationName ?? "";
    let variables = response.requestInfo ? { page: response.requestInfo.page, filters: response.requestInfo.filters } : {};
    const rawVariables = url.searchParams.get("variables");
    if (rawVariables) variables = JSON.parse(rawVariables);
    if (!operationName && response.request?.postData) {
      try {
        const body = JSON.parse(response.request.postData() ?? "{}");
        operationName = body.operationName ?? "";
        variables = body.variables ?? variables;
      } catch { /* Non-JSON GraphQL request bodies are not listing requests. */ }
    }
    if (operationName !== "listingScreen") return null;
    return { response, url: response.url, page: Number(variables.page ?? 1), filters: variables.filters ?? [] };
  } catch { return null; }
}

function listingResponsePage(response) {
  return listingRequestInfo({ url: response.url(), request: response.request() })?.page ?? null;
}

function auditListingRequest(responses, models, applied, pageNumber, pageUrl = "") {
  const requests = responses.map(listingRequestInfo).filter((item) => item?.page === pageNumber);
  if (!requests.length) return { ok: false, page: pageNumber, missing: ["listingScreen request"], requestUrl: null, filters: [] };
  const routeFilters = [];
  try {
    const pathname = new URL(pageUrl).pathname;
    const yearFromPath = pathname.match(/\/od-(\d{4})(?:\/|$)/)?.[1];
    if (yearFromPath) routeFilters.push({ name: "filter_float_year:from", value: yearFromPath });
    const bodyFromPath = pathname.match(/\/seg-([^/]+)(?:\/|$)/)?.[1];
    const bodyRouteValues = { combi: "combi", sedan: "sedan", hatchback: "hatchback", suv: "suv", crossover: "crossover",
      minivan: "minivan", coupe: "coupe", cabrio: "cabrio" };
    if (bodyRouteValues[bodyFromPath]) routeFilters.push({ name: "filter_enum_body_type", value: bodyRouteValues[bodyFromPath] });
  } catch { /* The listing request audit can still use its GraphQL filters. */ }
  const bodyValue = ({ kombi: "combi", wagon: "combi", sedan: "sedan", hatchback: "hatchback", suv: "suv",
    crossover: "crossover", minivan: "minivan" })[String(applied.body ?? "").toLowerCase()];
  const numericFilters = [
    ["maxPriceGrossPln", "filter_float_price:to"],
    ["yearMin", "filter_float_year:from"],
    ["mileageMaxKm", "filter_float_mileage:to"],
  ];
  const assess = (request) => {
    const missing = [];
    const filters = [...request.filters, ...routeFilters];
    const hasFilter = (name, value) => filters.some((item) => item.name === name &&
      String(item.value).toLowerCase() === String(value).toLowerCase());
    const modelFilters = filters.filter((item) => item.name === "make_model_generation").map((item) => String(item.value).toLowerCase());
    for (const model of models) {
      const modelPrefix = `${portalSlug(model.brand)}|${portalSlug(model.model)}`;
      if (!modelFilters.some((value) => value === modelPrefix || value.startsWith(`${modelPrefix}|`))) missing.push(`model:${model.key}`);
    }
    if (applied.generation && !modelFilters.some((value) => value.includes("|gen-"))) missing.push("generation");
    if (bodyValue && !hasFilter("filter_enum_body_type", bodyValue)) missing.push("body");
    for (const [key, name] of numericFilters) if (Number.isFinite(applied[key]) && !hasFilter(name, applied[key])) missing.push(key);
    return missing;
  };
  const checkedRequests = requests.map((request) => ({ request, missing: assess(request) }));
  const successfulRequest = [...checkedRequests].reverse().find((item) => item.missing.length === 0);
  const bestRequest = checkedRequests.reduce((best, item) => !best || item.missing.length <= best.missing.length ? item : best, null);
  const selected = successfulRequest ?? bestRequest;
  const request = selected.request;
  const missing = selected.missing;
  return { ok: missing.length === 0, page: pageNumber, missing, requestUrl: request.url,
    filters: request.filters.map(({ name, value }) => ({ name, value })),
    ...(routeFilters.length ? { routeEvidence: routeFilters } : {}),
    ...(missing.length ? { requestCandidates: checkedRequests.slice(-8).map((item) => ({ missing: item.missing,
      filters: item.request.filters.map(({ name, value }) => ({ name, value })) })) } : {}) };
}

export const otomotoAdapter = {
  id: "otomoto",
  sourceName: "Otomoto",
  retryFilterSetupOnce: true,
  prepareFilterPlan,
  buildFilteredSearchUrl,
  listingSelector: 'a[href*="/oferta/"]',
  nextPageSelector: 'a[rel="next"], a[aria-label*="Następna"], a[aria-label*="Next"]',

  shouldCaptureResponse(url, request) {
    if (!url.includes("/graphql")) return true;
    let operation = "";
    try { operation = new URL(url).searchParams.get("operationName") ?? ""; } catch { /* Keep URL fallback below. */ }
    if (!operation) {
      try { operation = JSON.parse(request.postData() ?? "{}").operationName ?? ""; } catch { /* Unknown GraphQL operations remain eligible. */ }
    }
    return !/loan.?simulation|financing|categories|taxonomy|representative/i.test(operation);
  },

  async chooseNecessaryCookies(page, { waitForPrompt = true } = {}) {
    const choice = page.getByRole("button", { name: /zezw[oó]l tylko na niezb[eę]dne|tylko niezb[eę]dne|akceptuj niezb[eę]dne/i }).filter({ visible: true });
    if (waitForPrompt) await choice.waitFor({ state: "visible", timeout: 2500 }).catch(() => {});
    if (await choice.count() === 1) {
      await choice.click({ timeout: 5000, noWaitAfter: true });
      await choice.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
      return "necessary_only";
    }
    const blockingOverlay = page.locator(".onetrust-pc-dark-filter");
    if (await blockingOverlay.count()) {
      const dismissed = await page.waitForFunction(() => {
        const overlay = document.querySelector(".onetrust-pc-dark-filter");
        if (!overlay) return true;
        const style = getComputedStyle(overlay);
        return style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none" || Number(style.opacity) === 0;
      }, null, { timeout: 3000 }).then(() => true).catch(() => false);
      if (!dismissed) throw new Error("Zgoda cookies blokuje filtry; nie znaleziono opcji tylko niezbędnych cookies.");
    }
    return "not_present";
  },

  async applyFilters(page, group, timings, runContext) {
    const models = group.models;
    const model = models[0];
    const plan = runContext.filterPlan ?? prepareFilterPlan(group, runContext.filterProfile ?? {});
    const root = page.getByTestId("filters");
    await timings.measure("filter_panel_open", { sourceId: this.id, modelKey: model.key }, async () => {
      const tab = page.getByRole("tab", { name: /^filtruj$/i }).filter({ visible: true });
      try {
        await tab.first().waitFor({ state: "visible", timeout: 5000 });
      } catch (error) {
        if (error?.name === "TimeoutError") throw filterSetupError("Karta filtrów OTOMOTO nie pojawiła się w ciągu 5000 ms.", true);
        throw error;
      }
      if (await tab.count() !== 1) throw new Error("Nie znaleziono karty filtrów OTOMOTO.");
      if (await tab.getAttribute("aria-selected") !== "true") await tab.click({ timeout: 5000 });
      try {
        await root.waitFor({ state: "visible", timeout: 5000 });
      } catch (error) {
        if (error?.name === "TimeoutError") throw filterSetupError("Panel filtrów OTOMOTO nie pojawił się w ciągu 5000 ms.", true);
        throw error;
      }
      const makeInput = root.getByPlaceholder("Marka pojazdu").filter({ visible: true });
      try {
        await makeInput.first().waitFor({ state: "visible", timeout: 3000 });
      } catch (error) {
        if (error?.name === "TimeoutError") throw filterSetupError("Panel filtrów OTOMOTO nie udostępnił pola marki.", true);
        throw error;
      }
      const makeInputCount = await makeInput.count();
      if (makeInputCount === 0) throw filterSetupError("Pole marki zniknęło przed wyborem.", true);
      if (makeInputCount !== 1) {
        throw new Error("Panel filtrów OTOMOTO nie udostępnił pola marki.");
      }
    });

    const metadata = { sourceId: this.id, modelKeys: models.map((item) => item.key), make: group.brand };
    runContext.filtersApplied = { make: group.brand, models: [] };
    const applyFilterStage = async (stage, stageMetadata = metadata) => {
      const listingWait = runContext.waitForAppliedFilters?.(2500);
      await timings.measure(stage, stageMetadata, () => applySelectedFilters(page, runContext));
      if (listingWait) await measureFilterRequestWait(timings, `${stage}_settle`, stageMetadata, listingWait);
    };
    await timings.measure("filter_make_select", { ...metadata, filterValue: group.brand, placeholder: "Marka pojazdu", candidates: plan.make.candidates },
      () => fillAutocompleteFilter(page, "Marka pojazdu", plan.make.value, plan.make.candidates, plan.profile));
    // OTOMOTO keeps dependent autocomplete fields disabled until the current
    // selection is applied. Submit only at these dependency boundaries.
    await applyFilterStage("filter_make_apply", { ...metadata, filterValue: plan.make.value });

    for (const selectedModel of plan.models) {
      await timings.measure("filter_model_select", { ...metadata, modelKey: selectedModel.key, filterValue: selectedModel.value, placeholder: "Model pojazdu" },
        () => fillAutocompleteFilter(page, "Model pojazdu", selectedModel.value, [selectedModel.value], plan.profile));
      runContext.filtersApplied.models.push(selectedModel.value);
    }
    if (plan.models.length) await applyFilterStage("filter_models_apply", { ...metadata, filterValues: plan.models.map((item) => item.value) });

    const generations = plan.generations;
    if (generations.length) {
      for (const generation of generations) {
        await timings.measure("filter_generation_select", { ...metadata, filterValue: generation, placeholder: "Generacja" },
          () => fillAutocompleteFilter(page, "Generacja", generation, [generation], plan.profile));
      }
      runContext.filtersApplied.generation = generations.length === 1 ? generations[0] : generations;
      await applyFilterStage("filter_generation_apply", { ...metadata, filterValues: generations });
    }

    // Apply body once when every selected model has the same single body requirement.
    const sharedBody = plan.body;
    if (sharedBody) {
      await timings.measure("filter_body_select", { ...metadata, filterValue: sharedBody, placeholder: "Typ nadwozia" },
        () => fillAutocompleteFilter(page, "Typ nadwozia", sharedBody, [sharedBody], plan.profile));
      runContext.filtersApplied.body = sharedBody;
      await applyFilterStage("filter_body_apply", { ...metadata, filterValue: sharedBody });
    }

    const numericFilters = plan.numericFilters;
    for (const filter of numericFilters) {
      const filterMetadata = { ...metadata, filter: filter.key, filterValue: filter.value };
      runContext.filtersApplied[filter.key] = filter.value;
      const listingWait = runContext.waitForAppliedFilters?.(2500);
      await timings.measure(`filter_${filter.key}_fill`, filterMetadata,
        () => fillVisibleFilter(page, filter.label, filter.value,
          plan.profile.fieldReadyTimeoutMs ?? runContext.filterReadyTimeoutMs ?? 10000,
          { keyboard: true }));
      if (listingWait) await measureFilterRequestWait(timings, `filter_${filter.key}_settle`, filterMetadata, listingWait);
    }

    const numericValuesReady = await measureNumericFilterPoll(timings, "filter_values_poll",
      { ...metadata, filterCount: numericFilters.length }, page, numericFilters, plan.profile.fieldReadyTimeoutMs ?? runContext.filterReadyTimeoutMs ?? 10000);
    if (!numericValuesReady) {
      for (const filter of numericFilters) {
        await timings.measure(`filter_${filter.key}_refill`, { ...metadata, filter: filter.key, filterValue: filter.value },
          () => fillVisibleFilter(page, filter.label, filter.value,
            plan.profile.fieldReadyTimeoutMs ?? runContext.filterReadyTimeoutMs ?? 10000,
            { keyboard: true }));
      }
      const valuesRecovered = await measureNumericFilterPoll(timings, "filter_values_repoll",
        { ...metadata, filterCount: numericFilters.length }, page, numericFilters, plan.profile.fieldReadyTimeoutMs ?? runContext.filterReadyTimeoutMs ?? 10000);
      if (!valuesRecovered) throw filterSetupError("Pola filtrów liczbowych nie zachowały zadanych wartości po jednej próbie ponownego ustawienia.", true);
    }

    // Numeric controls can trigger listingScreen requests on their own. The
    // runner audits every captured request after this click so a complete
    // request sent just before the click is still accepted.
    const completeListingWait = runContext.waitForAppliedFilters?.(runContext.resultReadyTimeoutMs ?? 8000);
    await timings.measure("filter_submit", metadata, () => applySelectedFilters(page, runContext));
    if (completeListingWait) await measureFilterRequestWait(timings, "filter_submit_settle", metadata, completeListingWait);
  },

  async submitUrlFilters(page, runContext) {
    const root = page.getByTestId("filters");
    if (!await root.isVisible().catch(() => false)) {
      const tab = page.getByRole("tab", { name: /^filtruj$/i }).filter({ visible: true });
      if (await tab.count() === 1 && await tab.getAttribute("aria-selected") !== "true") {
        await tab.click({ timeout: 5000 });
      }
      await root.waitFor({ state: "visible", timeout: 5000 });
    }
    await applySelectedFilters(page, runContext);
  },

  findListingResponse(responses, pageNumber) {
    return [...responses].reverse().find((item) => listingRequestInfo(item)?.page === pageNumber) ?? null;
  },

  async waitForListingResponse(page, pageNumber, timeoutMs = 8000, requestPredicate = null) {
    return page.waitForResponse((response) => listingResponsePage(response) === pageNumber &&
      (!requestPredicate || requestPredicate(response)), { timeout: timeoutMs })
      .catch(() => null);
  },

  async extractListings(page) {
    return page.evaluate((selector) => {
      const isVisible = (node) => Boolean(node.getClientRects().length);
      const seen = new Set();
      const items = [];
      for (const anchor of document.querySelectorAll(selector)) {
        if (!isVisible(anchor)) continue;
        let url;
        try { url = new URL(anchor.href, location.href); } catch { continue; }
        if (url.protocol !== "https:" || !url.pathname.includes("/oferta/")) continue;
        const host = url.hostname.toLowerCase().replace(/^www\./, "");
        if (host !== "otomoto.pl" && !host.endsWith(".otomoto.pl")) continue;
        url.hash = "";
        const href = url.href;
        if (seen.has(href)) continue;
        const container = anchor.closest("article, li, [data-testid*='offer'], [data-testid*='item']") ||
          anchor.parentElement?.parentElement?.parentElement || anchor.parentElement;
        const title = container?.querySelector("h1, h2, h3, [data-testid*='title']")?.textContent?.trim() ||
          anchor.getAttribute("title")?.trim() || anchor.innerText.trim();
        const text = container?.innerText?.trim() || anchor.innerText.trim();
        if (!title || !text) continue;
        seen.add(href);
        items.push({ url: href, title, visibleText: text.slice(0, 5000) });
      }
      return items;
    }, this.listingSelector);
  },

  extractApiListings(responses) {
    const found = new Map();
    const flattenText = (value, rows = [], depth = 0) => {
      if (depth > 5 || value == null) return rows;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 100)) flattenText(item, rows, depth + 1);
      } else if (typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          if (item !== null && ["string", "number", "boolean"].includes(typeof item)) rows.push(`${key}: ${item}`);
          else flattenText(item, rows, depth + 1);
        }
      }
      return rows;
    };
    const visit = (value, depth = 0) => {
      if (depth > 7 || value == null || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const item of value.slice(0, 100)) visit(item, depth + 1); return; }
      const entries = Object.entries(value);
      const target = entries.filter(([key, item]) => /(?:url|href|link)$/i.test(key) && typeof item === "string")
        .map(([, value]) => { try { return new URL(value, "https://www.otomoto.pl"); } catch { return null; } })
        .find((url) => {
          if (!url) return false;
          const host = url.hostname.toLowerCase().replace(/^www\./, "");
          return url.protocol === "https:" && (host === "otomoto.pl" || host.endsWith(".otomoto.pl")) && url.pathname.includes("/oferta/");
        });
      if (target) {
        target.hash = "";
        const title = entries.find(([key, item]) => /^(?:title|headline|subject|offername|advertname)$/i.test(key) && typeof item === "string")?.[1] ??
          entries.find(([key, item]) => key.toLowerCase() === "name" && typeof item === "string")?.[1] ?? "";
        const visibleText = flattenText(value).join("\n").slice(0, 5000);
        const rawPrice = value.price?.amount?.value;
        const priceText = typeof rawPrice === "string" ? rawPrice.trim().replace(/\s/g, "") : "";
        const apiPriceAmount = typeof rawPrice === "number" ? rawPrice
          : /^\d+(?:[.,]\d{1,2})?$/.test(priceText) ? Number(priceText.replace(",", ".")) : null;
        if (title || visibleText) found.set(target.href, { url: target.href, title: title || visibleText.slice(0, 180), visibleText,
          ...(Number.isFinite(apiPriceAmount) && apiPriceAmount > 0 ? { apiPriceAmount } : {}),
          apiEvidence: { captured: true, ...(Number.isFinite(apiPriceAmount) && apiPriceAmount > 0 ? { pricePath: "price.amount.value" } : {}) } });
      }
      for (const [, item] of entries) if (item && typeof item === "object") visit(item, depth + 1);
    };
    const listingScreenResponses = responses.filter((response) => {
      try { return new URL(response.url).searchParams.get("operationName") === "listingScreen"; }
      catch { return false; }
    });
    for (const response of listingScreenResponses.length ? listingScreenResponses : responses) {
      if (response.jsonSummary) visit(response.jsonSummary);
    }
    return [...found.values()];
  },

  auditListingRequest(responses, models, appliedFilters, pageNumber, pageUrl = "") {
    return auditListingRequest(responses, models, appliedFilters, pageNumber, pageUrl);
  },

  async nextPageAction(page) {
    const link = page.locator(this.nextPageSelector).filter({ visible: true }).first();
    if (await link.count()) {
      const href = await link.getAttribute("href");
      if (href) {
        try {
          const target = new URL(href, page.url());
          const current = new URL(page.url());
          if (target.origin === current.origin && target.protocol === "https:") {
            for (const key of current.searchParams.keys()) {
              if (!key.startsWith("search[")) continue;
              const values = current.searchParams.getAll(key);
              target.searchParams.delete(key);
              for (const value of values) target.searchParams.append(key, value);
            }
            return { kind: "url", url: target.href };
          }
        } catch { /* Try the accessible next-page button below. */ }
      }
    }
    const button = page.getByRole("button", { name: /go to next page/i }).filter({ visible: true });
    if (await button.count() !== 1 || await button.isDisabled()) return null;
    const currentUrl = new URL(page.url());
    const currentPage = Number(currentUrl.searchParams.get("page") ?? "1");
    currentUrl.searchParams.set("page", String((Number.isFinite(currentPage) ? currentPage : 1) + 1));
    return { kind: "button", url: currentUrl.href, fromUrl: page.url(), pageNumber: (Number.isFinite(currentPage) ? currentPage : 1) + 1 };
  },

  async navigateNextPage(page, action) {
    if (action.kind === "url") return page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const responsePromise = page.waitForResponse((response) => {
      if (!response.url().includes("/graphql")) return false;
      try {
        const url = new URL(response.url());
        let variables = url.searchParams.get("variables");
        if (!variables) {
          const body = response.request().postData();
          variables = body ? JSON.stringify(JSON.parse(body).variables ?? {}) : null;
        }
        return variables ? Number(JSON.parse(variables).page) === action.pageNumber : false;
      } catch { return false; }
    }, { timeout: 20000 }).catch(() => null);
    const button = page.getByRole("button", { name: /go to next page/i }).filter({ visible: true });
    if (await button.count() !== 1 || await button.isDisabled()) return null;
    await button.click({ timeout: 6000, noWaitAfter: true });
    await page.waitForURL((url) => url.href !== action.fromUrl, { timeout: 15000 }).catch(() => {});
    const response = await responsePromise;
    return response;
  },

  async extractDetail(page) {
    return page.evaluate(() => {
      const bodyText = document.body?.innerText?.trim() ?? "";
      const fields = {};
      const add = (label, value) => {
        const key = String(label ?? "").replace(/\s+/g, " ").trim();
        const text = String(value ?? "").replace(/\s+/g, " ").trim();
        if (key && text && key.length < 120 && text.length < 600 && !fields[key]) fields[key] = text;
      };
      for (const row of document.querySelectorAll("tr")) {
        const cells = [...row.querySelectorAll("th,td")].map((node) => node.innerText.trim()).filter(Boolean);
        if (cells.length >= 2) add(cells[0], cells.slice(1).join(" "));
      }
      for (const node of document.querySelectorAll("dt")) add(node.innerText, node.nextElementSibling?.innerText);
      for (const node of document.querySelectorAll("[data-testid*='parameter'], [data-testid*='detail'], [class*='parameter']")) {
        const children = [...node.children].map((item) => item.innerText.trim()).filter(Boolean);
        if (children.length >= 2) add(children[0], children.slice(1).join(" "));
      }
      let structuredData = [];
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const value = JSON.parse(script.textContent || "null");
          const values = Array.isArray(value) ? value : [value];
          for (const item of values) {
            if (item?.["@graph"]) structuredData.push(...item["@graph"]);
            else if (item && typeof item === "object") structuredData.push(item);
          }
        } catch { /* Invalid JSON-LD is left out of the evidence. */ }
      }
      const ctas = [...document.querySelectorAll("a,button")].filter((node) => node.getClientRects().length)
        .map((node) => node.innerText.trim()).filter((text) => /kontakt|telefon|wiadomo|sprzedawc|zadzwo/i.test(text)).slice(0, 20);
      const photos = [...new Set([...document.images].filter((image) => image.getClientRects().length && image.naturalWidth > 100 && image.naturalHeight > 70)
        .map((image) => image.currentSrc || image.src).filter((url) => /^https:\/\//i.test(url)))].slice(0, 12);
      return { title: document.querySelector("h1")?.innerText?.trim() || document.title, bodyText: bodyText.slice(0, 30000),
        fields, structuredData: structuredData.slice(0, 30), ctas, photos };
    });
  },

  async waitForDetailReady(page, timeoutMs = 5000) {
    try {
      await page.waitForFunction(() => {
        const title = document.querySelector("h1")?.textContent?.trim();
        if (!title) return false;
        const body = document.body?.innerText ?? "";
        const hasPrice = /(?:\d[\d\s\u00a0.,]*\s*(?:zł|PLN)|(?:zł|PLN)\s*\d)/i.test(body);
        const hasSpecs = /(?:rok produkcji|przebieg|pojemność silnika|rodzaj paliwa|moc)\s*:?/i.test(body);
        const hasVehicleData = [...document.querySelectorAll('script[type="application/ld+json"]')]
          .some((script) => /"@type"\s*:\s*"?(?:Vehicle|Car|Product)\b/i.test(script.textContent ?? ""));
        return hasVehicleData || (hasPrice && hasSpecs);
      }, null, { timeout: timeoutMs });
      return true;
    } catch (error) {
      if (error?.name === "TimeoutError") return false;
      throw error;
    }
  },
};
