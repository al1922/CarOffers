import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { browserNavigationPolicy } from "./robots-policy.mjs";
import { classifyGenericCard } from "../portal-card-classifier.mjs";
import { extractVisibleFields, normalizeText } from "../portal-screening.mjs";
import { otomotoAdapter } from "./adapters/otomoto.mjs";
import { aaaautoAdapter } from "./adapters/aaaauto.mjs";
import { spoticarAdapter } from "./adapters/spoticar.mjs";
import { attachResponseCapture } from "./response-capture.mjs";
import { normalizeRunResult } from "./result-normalizer.mjs";
import { groupModelsByMake, listingMatchesModel } from "./model-groups.mjs";
import { mapWithConcurrency } from "./parallel.mjs";
import { StageTimings } from "./timings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTERS = new Map([[otomotoAdapter.id, otomotoAdapter], [aaaautoAdapter.id, aaaautoAdapter],
  [spoticarAdapter.id, spoticarAdapter]]);
const CHALLENGE = /access denied|robot check|captcha|verify you are human|too many requests|dostęp został zablokowany|oh noes/i;
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, "node_modules", ".cache", "ms-playwright");

function isAccessDenied(status) {
  return [401, 403, 429].includes(status);
}

function isRequiredDataDenial(adapter, response, context) {
  return adapter.isRequiredDataResponse?.(response, context) === true;
}

function compactEngineText(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, "");
}

function engineTokens(value) {
  return normalizeText(value).toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [];
}

function engineLabelFitsVariant(label, variant) {
  const variantPrefix = String(variant).replace(/-\d+$/, "");
  const labelKey = compactEngineText(label);
  const prefixKey = compactEngineText(variantPrefix);
  if (!labelKey) return false;
  if (prefixKey.startsWith(labelKey) || labelKey.startsWith(prefixKey)) return true;
  const labelTokens = engineTokens(label);
  const variantTokens = engineTokens(variantPrefix);
  const displacement = variantTokens.find((token) => /^\d+\.\d+$/.test(token));
  return Boolean(displacement && labelTokens.includes(displacement) &&
    labelTokens.some((token) => /[a-z]/.test(token) && variantTokens.includes(token)));
}

function engineAliasesForModel(model, knowledge) {
  const variants = model.allowedEngineVariants ?? [];
  const claimsByVariant = new Map(variants.map((variant) => [variant, []]));
  const visit = (variant, value, targetPower) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(variant, item, targetPower);
      return;
    }
    if (!value || typeof value !== "object") return;
    const label = value.label ?? value.name ?? value.variant;
    const reportedPower = Number(value.powerPS ?? value.systemPowerPS);
    if (typeof label === "string" && Number.isFinite(targetPower) && reportedPower === targetPower &&
        engineLabelFitsVariant(label, variant)) {
      claimsByVariant.get(variant)?.push({ label, powerKw: Number(value.powerKw ?? value.systemPowerKw) });
    }
    for (const nested of Object.values(value)) visit(variant, nested, targetPower);
  };
  for (const claim of knowledge?.claims ?? []) {
    if (claim.topic !== "engine") continue;
    for (const variant of variants) {
      const match = String(variant).match(/-(\d+)$/);
      visit(variant, claim.value, match ? Number(match[1]) : Number.NaN);
    }
  }

  const aliasOwners = new Map();
  const addOwner = (alias, variant) => {
    const key = compactEngineText(alias);
    if (!key) return;
    const owners = aliasOwners.get(key) ?? new Set();
    owners.add(variant);
    aliasOwners.set(key, owners);
  };
  for (const variant of variants) {
    for (const { label } of claimsByVariant.get(variant) ?? []) addOwner(label, variant);
    const prefix = String(variant).replace(/-\d+$/, "").replace(/-(?:ea)?\d+$/i, "").replace(/-/g, " ");
    addOwner(prefix, variant);
  }

  return variants.map((variant) => {
    const match = String(variant).match(/-(\d+)$/);
    const power = match ? Number(match[1]) : null;
    const aliases = [];
    const add = (alias) => {
      if (alias && !aliases.some((existing) => compactEngineText(existing) === compactEngineText(alias))) aliases.push(alias);
    };
    for (const { label, powerKw } of claimsByVariant.get(variant) ?? []) {
      add(`${label} ${power} KM`);
      const kw = Number.isFinite(powerKw) ? powerKw : power === null ? null : Math.round(power * 0.73549875);
      if (kw !== null) add(`${label} ${kw} kW`);
      if (aliasOwners.get(compactEngineText(label))?.size === 1) add(label);
    }
    const prefix = String(variant).replace(/-\d+$/, "").replace(/-(?:ea)?\d+$/i, "").replace(/-/g, " ");
    if (aliasOwners.get(compactEngineText(prefix))?.size === 1) add(prefix);
    if (power !== null) add(`${prefix} ${power} KM`);
    return { engineVariant: variant, aliases };
  });
}

function profileForModel(model, sourceId, engineAliases = []) {
  const requirements = model.requirements ?? {};
  const purchase = requirements.purchase ?? {};
  const mileage = requirements.mileage ?? {};
  const bodyCodes = (model.bodies ?? []).map((body) => ({ wagon: "wagon", combi: "wagon", sedan: "sedan",
    hatchback: "hatchback", suv: "suv", crossover: "crossover", minivan: "minivan" })[String(body).toLowerCase()] ?? body);
  const screeningLimits = {
    minimumAdvertisedPricePln: purchase.minimumAdvertisedPricePln ?? 0,
    basePurchaseGrossPlnMax: purchase.maxPriceGrossPln ?? Number.MAX_SAFE_INTEGER,
    productionYearMin: requirements.yearMin ?? model.searchYears?.min ?? 1900,
    productionYearMax: requirements.yearMax ?? model.searchYears?.max ?? 2100,
    hardMileageKmMax: mileage.hardMaxKm ?? Number.MAX_SAFE_INTEGER,
    bodyCodes,
    auctionsAllowed: purchase.auctionsAllowed ?? false,
  };
  return {
    sourceId,
    modelKey: model.key,
    searchProfile: {
      searchUrl: "",
      queryPlan: { nativeFilters: { make: model.brand, model: model.model }, manualFilters: { make: model.brand, model: model.model },
        engineAliases },
      candidateScreening: { screeningLimits },
    },
  };
}

function normalizedBodyCode(value) {
  const body = normalizeText(value);
  if (body.includes("kombi") || body.includes("wagon")) return "wagon";
  if (body.includes("sedan")) return "sedan";
  if (body.includes("hatchback")) return "hatchback";
  if (body.includes("suv")) return "suv";
  if (body.includes("crossover")) return "crossover";
  if (body.includes("minivan") || body.includes("minibus")) return "minivan";
  return null;
}

function validateModelBody(classification, model, appliedFilters, bodyAliases = {}, observedBody = "") {
  if (classification.status !== "available") return classification;
  const expected = (model.bodies ?? []).map((body) => ({ wagon: "wagon", combi: "wagon", sedan: "sedan", hatchback: "hatchback",
    suv: "suv", crossover: "crossover", minivan: "minivan" })[String(body).toLowerCase()] ?? String(body).toLowerCase());
  if (!expected.length) return classification;
  const sourceBody = classification.offer?.bodyCode ?? normalizedBodyCode(observedBody);
  const actual = bodyAliases[model.key]?.[sourceBody] ?? sourceBody;
  if (actual && !expected.includes(actual)) {
    return { status: "rejected", note: `Nadwozie z karty (${actual}) nie odpowiada wymaganiu modelu (${expected.join(", ")}).` };
  }
  const appliedBody = ({ kombi: "wagon", wagon: "wagon", sedan: "sedan", hatchback: "hatchback", suv: "suv",
    crossover: "crossover", minivan: "minivan" })[String(appliedFilters?.body ?? "").toLowerCase()];
  if (!actual && !expected.includes(appliedBody)) {
    return { status: "unverified", note: "Nie udało się potwierdzić wymaganego typu nadwozia na karcie ani w zastosowanym filtrze wyszukiwania." };
  }
  if (actual && classification.offer?.bodyCode !== actual) {
    classification = { ...classification, offer: { ...classification.offer, bodyCode: actual } };
  }
  return classification;
}

function validateAaaAutoGenerationAndEngine(classification, model, detail, listing) {
  if (classification.status !== "available") return classification;
  const expectedGeneration = String(model.generation ?? "").trim();
  if (expectedGeneration) {
    const actualGeneration = String(detail.fields?.["Generacja"] ?? listing.sourceData?.modelGeneration ?? "").trim();
    if (!actualGeneration) return { status: "unverified", note: "Karta AAA AUTO nie ujawniła generacji wymaganej dla modelu." };
    const actualTokens = engineTokens(actualGeneration);
    if (!actualTokens.includes(expectedGeneration.toLowerCase())) {
      return { status: "rejected", note: `Generacja z karty (${actualGeneration}) nie odpowiada wymaganej generacji (${expectedGeneration}).` };
    }
  }
  const allowedVariants = model.allowedEngineVariants ?? [];
  if (!allowedVariants.length) return { status: "unverified", note: "Model nie ma skonfigurowanej listy dozwolonych wariantów silnika." };
  const actualVariant = classification.offer?.engineVariant;
  if (!actualVariant) return { status: "unverified", note: "Nie potwierdzono dozwolonego wariantu silnika w danych karty AAA AUTO." };
  if (!allowedVariants.includes(actualVariant)) {
    return { status: "rejected", note: `Wariant silnika (${actualVariant}) nie znajduje się na skonfigurowanej liście.` };
  }
  return classification;
}

function validateSpoticarGenerationAndEngine(classification, model, detail, listing) {
  if (classification.status !== "available") return classification;
  const expectedGeneration = String(model.generation ?? "").trim();
  if (expectedGeneration) {
    const actualGeneration = String(detail.fields?.["Generacja"] ?? listing.sourceData?.modelGeneration ?? "").trim();
    if (!actualGeneration) return { status: "unverified", note: "Karta SPOTICAR nie ujawniła generacji wymaganej dla modelu." };
    const actualTokens = engineTokens(actualGeneration);
    if (!actualTokens.includes(expectedGeneration.toLowerCase())) {
      return { status: "rejected", note: `Generacja z karty (${actualGeneration}) nie odpowiada wymaganej generacji (${expectedGeneration}).` };
    }
  }
  const allowedVariants = model.allowedEngineVariants ?? [];
  if (!allowedVariants.length) return { status: "unverified", note: "Model nie ma skonfigurowanej listy dozwolonych wariantów silnika." };
  const actualVariant = classification.offer?.engineVariant;
  if (!actualVariant) return { status: "unverified", note: "Nie potwierdzono dozwolonego wariantu silnika w danych karty SPOTICAR." };
  if (!allowedVariants.includes(actualVariant)) {
    return { status: "rejected", note: `Wariant silnika (${actualVariant}) nie znajduje się na skonfigurowanej liście.` };
  }
  return classification;
}

function apiFields(responses) {
  const fields = {};
  const wanted = /^(?:publicationdate|datepublished|dateposted|publishedat|publisheddate|firstregistrationdate|datefirstregistered|productiondate|productionyear|year|modelgeneration|generation|mileagefromodometer|mileage|mileageunit|odometer|price|pricegross|grossprice|pricebasis|pricetype|pricecurrency|currency|vin|fuel|fueltitle|alternativefueltitle|fuel[_-]?type|fueltype|vehicle[_-]?transmission|vehicletransmission|transmission|gearbox|body[_-]?type|bodytype|bodycode|engine|vehicleengine|enginedisplacement|enginesize|enginecapacity|enginepower|enginepowerhp|enginepowerkw|horsepower|power|address|addresslocality|addressregion|addresscountry|countrycode|postalcode|postcode|latitude|longitude|lat|lng|lon|location|city|region|voivodeship|seller|sellername|sellertype|saletype|transactiontype|offertype|availability|status|issold|sold|lpginstalled)$/i;
  const fieldText = (value, depth = 0) => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return "";
    const raw = value.value ?? value.displayValue ?? value.text ?? value.amount?.value ?? value.amount ??
      value.name ?? value.title ?? value.label ?? value.code;
    const text = fieldText(raw, depth + 1);
    const unit = value.unitText ?? value.unitCode ?? value.unit ?? value.currency ?? value.priceCurrency;
    return [text, fieldText(unit, depth + 1)].filter(Boolean).join(" ");
  };
  const visit = (value, depth = 0) => {
    if (depth > 7 || value == null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) visit(item, depth + 1); return; }
    const label = value.label ?? value.key ?? value.name;
    const fieldValue = value.value ?? value.displayValue ?? value.text;
    if (typeof label === "string" && fieldText(fieldValue)) fields[label] ??= fieldText(fieldValue);
    for (const [key, item] of Object.entries(value)) {
      if (wanted.test(key.replace(/[^a-z0-9]/gi, "")) && fieldText(item)) fields[key] ??= fieldText(item);
      else if (item && typeof item === "object") visit(item, depth + 1);
    }
  };
  for (const response of responses) if (response.jsonSummary) visit(response.jsonSummary);
  return fields;
}

function applyListingApiPrice(classification, listing) {
  const amount = listing?.apiPriceAmount;
  if (classification.status !== "available" || !classification.offer || !Number.isFinite(amount) || amount <= 0 ||
      classification.offer.price !== undefined) return classification;
  const offer = classification.offer;
  const evidence = offer.observation?.evidence ?? [];
  return {
    ...classification,
    offer: {
      ...offer,
      price: amount,
      priceBasis: "unknown",
      observation: {
        ...offer.observation,
        evidence: evidence.map((item, index) => index === 0 ? {
          ...item,
          fields: [...new Set([...(item.fields ?? []), "price"])],
          note: listing.apiEvidence?.priceEvidenceNote ?? "Cenę odczytano z JSON listy OTOMOTO (price.amount.value); podstawa ceny pozostaje niepotwierdzona.",
        } : item),
      },
    },
  };
}

function rejectBelowMinimumAdvertisedPrice(classification, model) {
  if (classification.status !== "available" || !classification.offer) return classification;
  const minimum = model.requirements?.purchase?.minimumAdvertisedPricePln;
  const price = classification.offer.price;
  if (!Number.isFinite(minimum) || !Number.isFinite(price) || price >= minimum) return classification;
  return { status: "rejected", note: `Widoczna cena ogłoszenia jest poniżej minimum ${minimum} zł.` };
}

function extractDetailEvidence(text, sourceId) {
  const bodyText = String(text ?? "");
  const visible = extractVisibleFields(bodyText, sourceId);
  const priceMatch = bodyText.match(/(?:Używany|Nowy)\s*[·•][^\r\n]{0,120}\r?\n+\s*(\d[\d\s\u00a0.,]*)\s*\r?\n+\s*(PLN|zł)\b/i);
  const bodyMatch = bodyText.match(/\b(Kombi|Sedan|Hatchback|SUV|Crossover|Minivan)\s*[\r\n]+\s*Typ nadwozia\b/i);
  const transmissionMatch = bodyText.match(/\b(Manualna|Automatyczna)\s*[\r\n]+\s*Skrzynia biegów\b/i);
  const fuelMatch = bodyText.match(/\b(Benzyna|Diesel|Elektryczny|LPG|Hybryda)\s*[\r\n]+\s*Rodzaj paliwa\b/i);
  const fields = {};
  if (visible.productionYear) fields["Rok produkcji"] = String(visible.productionYear);
  if (visible.mileageKm !== null) fields["Przebieg"] = `${visible.mileageKm} km`;
  if (bodyMatch) fields.Nadwozie = bodyMatch[1];
  if (transmissionMatch) fields["Skrzynia biegów"] = transmissionMatch[1];
  if (fuelMatch) fields["Rodzaj paliwa"] = fuelMatch[1];
  const displayedPriceText = priceMatch ? `${priceMatch[1].replace(/\s+/g, " ").trim()} ${priceMatch[2]}` : null;
  return { fields, salePanel: displayedPriceText ? { price: displayedPriceText, terms: "Cena" } : null,
    visibleFields: { ...visible, displayedPriceText } };
}

async function pageHasChallenge(page) {
  const text = `${await page.title().catch(() => "")}\n${await page.locator("body").innerText().catch(() => "")}`;
  return CHALLENGE.test(text);
}

function mergeListing(target, item) {
  const apiText = target?.apiVisibleText ?? target?.visibleText ?? "";
  const itemText = item?.apiVisibleText ?? item?.visibleText ?? "";
  return {
    ...(target ?? {}),
    ...(item ?? {}),
    url: item?.url ?? target?.url,
    title: item?.title || target?.title || "",
    visibleText: [...new Set([apiText, itemText].filter(Boolean))].join("\n").slice(0, 10000),
    apiVisibleText: [...new Set([apiText, itemText].filter((_, index) => index === 0 || item?.apiEvidence))].join("\n").slice(0, 10000) || null,
    apiEvidence: target?.apiEvidence ?? item?.apiEvidence ?? null,
    ...((target?.sourceData || item?.sourceData) ? { sourceData: mergeSourceData(target?.sourceData, item?.sourceData) } : {}),
  };
}

function hasSourceFact(value) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function mergeSourceData(...sources) {
  const result = {};
  const photos = [];
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (key === "photos") {
        if (Array.isArray(value)) photos.push(...value);
      } else if (key === "location") {
        const location = result.location && typeof result.location === "object" && !Array.isArray(result.location)
          ? { ...result.location } : {};
        if (typeof value === "string" && value.trim()) location.label = value.trim();
        else if (value && typeof value === "object" && !Array.isArray(value)) {
          for (const [locationKey, locationValue] of Object.entries(value)) {
            if (hasSourceFact(locationValue)) location[locationKey] = locationValue;
          }
        }
        if (Object.keys(location).length) result.location = location;
      } else if (hasSourceFact(value)) result[key] = value;
    }
  }
  const directPhotos = [...new Set(photos.filter((url) => typeof url === "string" && /^https:\/\//i.test(url)))].slice(0, 12);
  if (directPhotos.length) result.photos = directPhotos;
  return result;
}

function mergeListingSources(apiListings, visibleListings) {
  const merged = new Map();
  for (const listing of apiListings) merged.set(listing.url, mergeListing(merged.get(listing.url), { ...listing, apiVisibleText: listing.visibleText }));
  for (const listing of visibleListings) merged.set(listing.url, mergeListing(merged.get(listing.url), listing));
  return [...merged.values()];
}

async function persistTimings(timings, runDir) {
  const reportPath = path.join(runDir, "timings.json");
  await writeFile(reportPath, `${JSON.stringify(timings.report(), null, 2)}\n`, "utf8");
}

function selectedModels(models, options) {
  const requested = [...new Set(options.modelKeys ?? (options.modelKey ? [options.modelKey] : []))];
  if (!requested.length) return models.filter((model) => model.active);
  const byKey = new Map(models.filter((model) => model.active).map((model) => [model.key, model]));
  const missing = requested.filter((key) => !byKey.has(key));
  if (missing.length) throw new Error(`Nie znaleziono aktywnych modeli: ${missing.join(", ")}.`);
  return requested.map((key) => byKey.get(key));
}

function splitOversizedModelGroups(groups, maxModels = 1) {
  return groups.flatMap((group) => {
    if (group.models.length <= maxModels) return [group];
    const chunks = [];
    for (let offset = 0; offset < group.models.length; offset += maxModels) {
      const models = group.models.slice(offset, offset + maxModels);
      chunks.push({ ...group, id: `${group.id}-${chunks.length + 1}`, models });
    }
    return chunks;
  });
}

export async function runDirectSearch(options) {
  const config = JSON.parse(await readFile(path.join(ROOT, "config", "direct-search.json"), "utf8"));
  const modelsConfig = JSON.parse(await readFile(path.join(ROOT, "config", "search-models.json"), "utf8"));
  const sourceConfig = config.sources?.[options.sourceId];
  const adapter = ADAPTERS.get(options.sourceId);
  if (!sourceConfig?.enabled || !adapter) throw new Error(`Brak aktywnego adaptera direct-search dla źródła ${options.sourceId}.`);

  const models = selectedModels(modelsConfig.models, options);
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
  const maxCardsPerModel = options.maxCards ?? sourceLimits.maxCards ?? defaults.maxCards ?? 20;
  const detailConcurrency = options.detailConcurrency ?? sourceLimits.detailConcurrency ?? defaults.detailConcurrency ?? 3;
  const filterOnly = Boolean(options.filterOnly);
  const urlFilters = Boolean(options.urlFilters);
  const origin = new URL(sourceConfig.searchUrl).origin;
  const runSummary = { schemaVersion: 1, runId, sourceId: options.sourceId, sourceName: adapter.sourceName,
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
    const runContext = { searchSubmitted: false, filterAudits: [], filterRetryAttempted: false,
      filterReadyTimeoutMs: defaults.filterReadyTimeoutMs ?? 3000,
      resultReadyTimeoutMs: defaults.resultReadyTimeoutMs ?? 8000, filterProfile: sourceConfig.filterProfile ?? {}, urlFilters };
    runContext.filterPlan = await timings.measure("filter_plan_prepare", groupTaskMetadata,
      async () => adapter.prepareFilterPlan?.(group, runContext.filterProfile) ?? null);

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
      responseCapture = attachResponseCapture(page, { origin, timings, shouldCaptureResponse: adapter.shouldCaptureResponse?.bind(adapter),
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
      const checkAccess = async () => {
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
          return mergeListingSources(apiListings, visibleListings).map((listing) => ({ ...listing, searchFilterAudit: filterAudit }));
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
      if (["aaaauto", "spoticar"].includes(options.sourceId) && matches.length > maxCardsPerModel) cappedModels.add(model.key);
      listingsByModel.set(model.key, matches.slice(0, maxCardsPerModel));
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
    const detailStartedAt = Date.now();
    const detailResults = await mapWithConcurrency(inspectionTasks, detailConcurrency, async ({ listing, models: matchedModels }) => {
      if (sourceBlocked || blocked) return null;
      let detailPage;
      let detailCapture;
      const matchedKeys = matchedModels.map((model) => model.key);
      const metadata = { sourceId: options.sourceId, modelKeys: matchedKeys, url: listing.url };
      try {
        detailPage = await timings.measure("detail_page_create", metadata, () => context.newPage());
        detailPage.setDefaultNavigationTimeout(30000);
        detailPage.setDefaultTimeout(10000);
        let navigationStatus = null;
        detailPage.on("response", (item) => {
          try {
            const request = item.request();
            if (request.isNavigationRequest() && request.frame() === detailPage.mainFrame()) navigationStatus = item.status();
          } catch { /* Ignore responses from detached frames. */ }
        });
        detailCapture = attachResponseCapture(detailPage, { origin, timings, shouldCaptureResponse: adapter.shouldCaptureResponse?.bind(adapter),
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
        const detail = await timings.measure("listing_detail_extract", metadata, () => adapter.extractDetail(detailPage));
        const detailResponses = detailCapture.since(responseMark);
        const detailEvidence = extractDetailEvidence(detail.bodyText, options.sourceId);
        const card = { ...detail, salePanel: detail.salePanel ?? detailEvidence.salePanel,
          fields: { ...detailEvidence.fields, ...apiFields(detailResponses), ...detail.fields } };
        const classificationCard = { ...card,
          bodyText: card.bodyText.replace(/odwiedź nasze pozostałe aukcje/gi, "pozostałe oferty sprzedawcy") };
        const inspected = [];
        for (const model of matchedModels) {
          const task = profileForModel(model, options.sourceId, engineAliasesByModel.get(model.key) ?? []);
          let classification = await timings.measure("listing_classification", { ...metadata, modelKey: model.key },
            async () => classifyGenericCard(listing, classificationCard, task, new Date().toISOString()));
          classification = applyListingApiPrice(classification, listing);
          classification = rejectBelowMinimumAdvertisedPrice(classification, model);
          if (classification.status === "available" && listing.searchFilterAudit && !listing.searchFilterAudit.ok) {
            classification = { status: "unverified", note: `Nie potwierdzono filtrów portalu: ${listing.searchFilterAudit.missing.join(", ")}.` };
          }
          classification = validateModelBody(classification, model, runContext.filtersApplied,
            ["aaaauto", "spoticar"].includes(options.sourceId) ? runContext.filterProfile.bodyAliases ?? {} : {},
            ["aaaauto", "spoticar"].includes(options.sourceId)
              ? detail.fields?.["Nadwozie"] ?? detail.structuredData?.[0]?.bodyType ?? "" : "");
          if (options.sourceId === "aaaauto") {
            classification = validateAaaAutoGenerationAndEngine(classification, model, detail, listing);
          } else if (options.sourceId === "spoticar") {
            classification = validateSpoticarGenerationAndEngine(classification, model, detail, listing);
          }
          const candidate = { url: listing.url, title: listing.title, detailStatus, detail,
            listingEvidence: { ...extractVisibleFields(`${listing.visibleText ?? ""}\n${detail.bodyText}`, options.sourceId),
              displayedPriceText: card.salePanel?.price ?? detailEvidence.visibleFields.displayedPriceText,
              ...(Number.isFinite(listing.apiPriceAmount) ? { apiPriceAmount: listing.apiPriceAmount } : {}) },
            listingMatch: { modelKey: model.key, matchedBy: "exact_model_token_in_listing" },
            sourceData: {
              ...mergeSourceData(listing.sourceData, detail.sourceData),
            },
            apiResponses: detailResponses, classification };
          candidatesByModel.get(model.key).push(candidate);
          inspected.push({ modelKey: model.key, status: classification.status });
        }
        return { url: listing.url, status: "ok", models: inspected };
      } catch (error) {
        const message = String(error?.message ?? error).split("\n")[0].slice(0, 300);
        for (const model of matchedModels) errorsByModel.get(model.key).push({ url: listing.url, error: message });
        timings.record("listing_processing", 0, error?.blocked ? "blocked" : "error", metadata);
        return { url: listing.url, status: error?.blocked ? "blocked" : "error", error: message };
      } finally {
        await detailCapture?.flush();
        await detailPage?.close().catch(() => {});
      }
    }, () => sourceBlocked || blocked);
    timings.record("parallel_detail_batch", Date.now() - detailStartedAt, sourceBlocked || blocked ? "partial" : "ok",
      { ...groupTaskMetadata, listingsScheduled: inspectionTasks.length, detailConcurrency });

    const groupCoverageComplete = pages.length > 0 && pages.at(-1)?.nextUrl == null &&
      pages.at(-1)?.nextAction?.kind !== "unsupported" && errors.length === 0 && cappedModels.size === 0 && !blocked && !sourceBlocked;
    const filtersPassed = Boolean(pages.at(-1)?.filterAudit?.ok);
    const groupResult = { groupId: group.id, brand: group.brand, modelKeys,
      outcome: blocked || sourceBlocked ? "blocked" : filterOnly ? filtersPassed ? "filters_passed" : "filters_failed" : groupCoverageComplete ? "completed" : "partial",
      ...(filterOnly ? { filterStatus: filtersPassed ? "passed" : "failed", filterAudit: pages.at(-1)?.filterAudit ?? null } : {}),
      pagesChecked: pages.length, listingsSeen: pages.reduce((sum, item) => sum + item.listings.length, 0),
      uniqueListings: uniqueListings.size, detailListingsScheduled: inspectionTasks.length, detailConcurrency,
      cappedModelKeys: [...cappedModels],
      detailsCompleted: (detailResults ?? []).filter((item) => item?.status === "ok").length };
    runSummary.searchGroups.push(groupResult);
    sourceBlocked ||= blocked;
    for (const model of group.models) {
      const modelErrors = [...errors, ...errorsByModel.get(model.key)];
      const modelPages = pages.map((resultPage) => ({ ...resultPage,
        listings: resultPage.listings.filter((listing) => listingMatchesModel(listing, model)) }));
      const normalized = normalizeRunResult({ runId, sourceId: options.sourceId, sourceName: adapter.sourceName,
        startedAt: groupStartedAt, model, query: { make: group.brand, model: model.model, modelGroup: group.models.map((item) => item.model),
          applied: runContext.filtersApplied ?? {}, filterAudits: runContext.filterAudits,
          filterRetry: runContext.filterRetry ?? null, filterPlan: runContext.filterPlan, url: runContext.queryUrl ?? sourceConfig.searchUrl },
        pages: modelPages, candidates: candidatesByModel.get(model.key), errors: modelErrors, blocked: sourceBlocked });
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
  }

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
