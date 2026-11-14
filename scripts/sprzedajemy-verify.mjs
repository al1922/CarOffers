import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { portalNavigationPolicy, readError } from "./portal-robots.mjs";
import { isClearlyNonVehicleTitle } from "./portal-screening.mjs";

const fold = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const compact = (value) => fold(value).replace(/[^a-z0-9]/g, "");
const listingNumber = (url) => new URL(url).pathname.match(/-nr(\d+)\/?$/)?.[1];
const numeric = (value) => Number(String(value).replace(/[\s.]/g, ""));
const bodyCodes = new Map([
  ["kombi", "wagon"], ["wagon", "wagon"], ["sedan", "sedan"], ["hatchback", "hatchback"],
  ["suv", "suv"], ["crossover", "crossover"], ["minivan", "minivan"],
]);

export async function navigationForVerification(context, page, sourceUrl) {
  const allowed = await portalNavigationPolicy(context, sourceUrl);
  const check = async (url, response) => {
    const status = response?.status();
    if ([401, 403, 429].includes(status)) {
      throw readError(url, "Portal odmówił dostępu (HTTP " + status + ").", true);
    }
    if (!response?.ok() || !allowed(page.url())) {
      throw readError(url, "Nie odczytano strony" + (status ? " (HTTP " + status + ")." : "."));
    }
    const challenge = await page.evaluate(() =>
      /access denied|verify you are human|captcha|dostęp został zablokowany/i.test(
        document.title + " " + (document.body?.innerText ?? "").slice(0, 350)));
    if (challenge) throw readError(url, "Portal wyświetlił blokadę dostępu.", true);
    return response;
  };
  const navigate = async (url) => {
    if (!allowed(url)) throw readError(url, "Adres spoza dozwolonego zakresu portalu lub robots.txt.", true);
    return check(url, await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }));
  };
  navigate.isAllowed = allowed;
  return navigate;
}

function outsideYear(year, limits) {
  return year < limits.productionYearMin || (limits.productionYearMax != null && year > limits.productionYearMax);
}

function engineCapacities(limits) {
  return limits.engineVariants.map((item) => Number(item.match(/^\d[.]\d(?=-)/)?.[0]));
}

// A bare year can describe first registration, model year or the generation.
export function screenListing(listing, profile) {
  const title = fold(listing.title);
  const { screeningLimits: limits } = profile.candidateScreening;
  const year = title.match(/\brok\s+produkcji\s*[:–-]?\s*((?:19|20)\d{2})\b/)?.[1];
  const mileage = title.match(/\bprzebieg\s*[:–-]?\s*(\d{1,3}(?:[ .]\d{3})+|\d{4,6})\s*km\b/)?.[1];
  const signatures = [...new Set((title.match(/(?<![\w.,])\d[.,]\d\s*(?:cr[\s-]?di|t[\s-]?gdi|dpi|mpi)(?![a-z])/gi) ?? []).map(compact))];
  const engine = signatures.length === 1 ? signatures[0] : null;
  const capacities = engineCapacities(limits);
  const body = bodyCodes.get(title.match(/\b(?:rodzaj|typ)\s+nadwozia\s*:\s*(\w+)/)?.[1]);
  const visibleFields = { ...(year ? { year: Number(year) } : {}),
    ...(mileage ? { mileage: numeric(mileage) } : {}), ...(engine ? { engine } : {}), ...(body ? { body } : {}) };
  const failures = [];
  // Broad make/model queries can surface products whose titles repeat the car model.
  if (isClearlyNonVehicleTitle(title, Number.isFinite(visibleFields.year) && Number.isFinite(visibleFields.mileage))) {
    failures.push("not_a_complete_vehicle_listing");
  }
  if (year && outsideYear(Number(year), limits)) failures.push("year_outside_selection");
  if (mileage && limits.hardMileageKmMax != null && numeric(mileage) > limits.hardMileageKmMax) failures.push("mileage_over_hard_limit");
  if (body && !limits.bodyCodes.includes(body)) failures.push("body_outside_selection");
  if (engine && capacities.every(Number.isFinite) && !capacities.includes(Number(engine.slice(0, 2)) / 10)) {
    failures.push("engine_displacement_outside_selection");
  }
  return { visibleFields, screeningFailures: failures };
}

export function collectCard(page) {
  return page.evaluate(extractCard);
}

function extractCard(html) {
  const rendered = typeof html !== "string";
  const template = document.createElement("template");
  if (!rendered) template.innerHTML = html;
  const root = rendered ? document : template.content;
  const textOf = (node) => (rendered ? node?.innerText : node?.textContent)?.trim();
  const value = (selector) => textOf(root.querySelector(selector)) || "";
  const meta = (property) => root.querySelector('meta[property="' + property + '"]')?.content || "";
  const title = value("h1");
  const fields = Object.fromEntries([...root.querySelectorAll("li.item")]
    .map((item) => [textOf(item.querySelector(":scope > span")), textOf(item.querySelector(":scope > strong"))])
    .filter(([label, field]) => label && field && field !== "-"));
  let structuredPrice = null;
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent);
      if (data["@type"] === "Product" && data.name?.trim() === title && data.offers?.priceCurrency === "PLN") {
        structuredPrice = data.offers.price;
      }
    } catch { /* Malformed metadata does not replace the visible card. */ }
  }
  if (!rendered) root.querySelectorAll("script, style, template, noscript, [hidden]").forEach((node) => node.remove());
  const text = rendered ? document.body?.innerText ?? "" : root.textContent ?? "";
  if (!rendered && /access denied|verify you are human|captcha|dostęp został zablokowany/i.test(
    value("title") + " " + text.trim().slice(0, 350))) return { blocked: true };
  return {
    title, fields,
    contact: Boolean(root.querySelector([
      'spr-webc-offer-details-button-phone[button-disabled-as-json="false"]',
      'spr-webc-offer-details-button-message.askUserBtn[button-disabled-as-json="false"]',
    ].join(", "))),
    contactChecked: true,
    statusText: text.split(/\n/).map((line) => line.trim()).find((line) =>
      /^(?:(?:to )?ogłoszenie (?:jest )?(?:nieaktualne|zostało (?:usunięte|zakończone))|sprzedane)[.!]?$/i.test(line)),
    number: text.match(/Nr ogłoszenia:\s*(\d+)/i)?.[1],
    priceText: value(".priceWrpWithLabel"), structuredPrice,
    description: value(".offerDescription"),
    city: value("a.locationName[data-details]").replace(/,\s*$/, "") || meta("og:locality"),
    region: value(".province a") || meta("og:region"),
    photos: [...new Set([...root.querySelectorAll("img.js-gallerySlide[src]")]
      .filter((image) => !image.closest(".slick-cloned"))
      .map((image) => image.getAttribute("src")).filter((src) => src?.startsWith("https://")))].slice(0, 12),
  };
}

export function createHtmlCardReader(context, parserPage, isAllowed) {
  return async (url) => {
    if (!isAllowed(url)) throw readError(url, "Adres karty jest niedozwolony przez robots.txt lub prowadzi poza portal.", true);
    const response = await context.request.get(url, {
      timeout: 30000, maxRedirects: 0, headers: { accept: "text/html,application/xhtml+xml" },
    });
    try {
      const status = response.status();
      if ([401, 403, 429].includes(status)) throw readError(url, "Portal odmówił dostępu (HTTP " + status + ").", true);
      if (status >= 300 && status < 400) {
        const location = response.headers().location;
        if (location && !isAllowed(new URL(location, url).href)) {
          throw readError(url, "Portal przekierował do niedozwolonego adresu.", true);
        }
        return null;
      }
      if (!response.ok()) throw readError(url, "Nie odczytano strony (HTTP " + status + ").");
      if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers()["content-type"] ?? "")) return null;
      const card = await parserPage.evaluate(extractCard, await response.text());
      if (card.blocked) throw readError(url, "Portal wyświetlił blokadę dostępu.", true);
      // Only the complete, ordinary card layout qualifies. Inactive,
      // incomplete and dynamically rendered cards use the browser.
      if (!card.title || card.number !== listingNumber(url) || !card.contact ||
          !card.fields.Marka || !card.fields.Model || !card.priceText ||
          !card.description || !card.city || !card.region || !card.photos.length) return null;
      return card;
    } finally {
      await response.dispose();
    }
  };
}

export function createCardReader(navigate, page, readHtml) {
  return async (url) => {
    if (readHtml) {
      const card = await readHtml(url);
      if (card) return { card, method: "html" };
    }
    await navigate(url);
    return { card: await collectCard(page), method: readHtml ? "fallback" : "browser" };
  };
}

export function stopCardReads(error) {
  return Boolean(error.blocked) ||
    /ERR_CERT_|CERT_|certificate|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(error.message);
}

function engineFromCard(card, profile) {
  const engineText = [card.title, card.fields.Silnik, card.fields["Wersja silnika"]].filter(Boolean).join(" ");
  const powers = [...[card.fields.Moc, card.fields["Moc silnika"], engineText].filter(Boolean).join(" ")
    .matchAll(/\b(\d{2,3}(?:[,.]\d+)?)\s*(KM|PS|kW)\b/gi)]
    .map(([, value, unit]) => Number(value.replace(",", ".")) * (unit.toLowerCase() === "kw" ? 1.35962 : 1));
  if (!powers.length) return null;
  const capacity = card.fields["Pojemność silnika"]?.match(/^([\d\s]+)\s*cm[³3]$/i)?.[1];
  const matching = profile.queryPlan.engineAliases.filter(({ engineVariant, aliases }) => {
    const power = Number(engineVariant.match(/-(\d+)$/)?.[1]);
    const litres = Number(engineVariant.match(/^\d[.]\d(?=-)/)?.[0]);
    if (powers.some((candidate) => Math.round(candidate) !== power) ||
        (capacity && Number.isFinite(litres) && Math.round(numeric(capacity) / 100) / 10 !== litres)) return false;
    return aliases.some((alias) => {
      const words = alias.replace(/\s+\d+\s*km$/i, "").toLowerCase().match(/[a-z]+|\d+/g) ?? [];
      if (words.length < 2) return false;
      const signature = new RegExp("\\b" + words.join("[\\s.,-]*") + "\\b", "i");
      return signature.test(engineText);
    });
  });
  return matching.length === 1 ? matching[0].engineVariant : null;
}

const amountPattern = "(\\d{1,3}(?:[ .\\u00a0\\u202f]\\d{3})+|\\d+)(?:[,.](\\d{2}))?\\s*(?:zł|pln)";
const visiblePricePattern = new RegExp("^" + amountPattern + "$", "i");
const describedPricePattern = new RegExp("\\bcena (?:gotówkowa|zakupu)\\s*[:–-]?\\s*" + amountPattern + "\\s+brutto\\b", "gi");
const fromAmount = (match) => numeric(match[1]) + Number(match[2] ?? 0) / 100;

function purchasePrice(card, terms) {
  const visible = card.priceText.match(visiblePricePattern);
  const amount = visible ? fromAmount(visible) : Number(card.structuredPrice);
  const monthly = /(?:netto|\/\s*mies|\bmiesięcznie\b)/i.test(card.priceText);
  if (!monthly && amount > 0) return { price: amount, quote: null };
  const described = [...terms.matchAll(describedPricePattern)].filter((match) => fromAmount(match) > 0);
  const prices = new Set(described.map(fromAmount));
  return prices.size === 1 ? { price: fromAmount(described[0]), quote: described[0][0] } : { price: null, quote: null };
}

export function classifyCard(card, url, profile, checkedAt) {
  const limits = profile.candidateScreening.screeningLimits;
  const number = listingNumber(url);
  if (number && card.number === number && card.statusText) return { status: "closed", note: card.statusText };
  if (!number || card.number !== number || !card.title) {
    return { status: "unverified", note: "Karta nie potwierdza tożsamości ogłoszenia." };
  }
  const fields = card.fields;
  const expectedModel = profile.queryPlan.nativeFilters?.model ?? profile.queryPlan.manualFilters?.model;
  if (!fields.Marka || !fields.Model) return { status: "unverified", note: "Brak marki lub modelu w parametrach karty." };
  if (compact(fields.Marka) !== compact(profile.brands[0]) || compact(fields.Model) !== compact(expectedModel)) {
    return { status: "rejected", note: "Marka lub model z karty jest poza zakresem." };
  }
  const year = /^\d{4}$/.test(fields["Rok produkcji"] ?? "") ? Number(fields["Rok produkcji"]) : null;
  const mileage = fields.Przebieg?.match(/^([\d\s.]+)\s*km$/i)?.[1];
  const mileageKm = mileage === undefined ? null : numeric(mileage);
  const bodyCode = bodyCodes.get(fold(fields["Rodzaj nadwozia"]));
  const capacity = fields["Pojemność silnika"]?.match(/^([\d\s]+)\s*cm[³3]$/i)?.[1];
  const allowedCapacities = engineCapacities(limits);
  const engineOutside = capacity && allowedCapacities.every(Number.isFinite) &&
    !allowedCapacities.includes(Math.round(numeric(capacity) / 100) / 10);
  if ((year !== null && outsideYear(year, limits)) ||
      (mileageKm !== null && limits.hardMileageKmMax != null && mileageKm > limits.hardMileageKmMax) ||
      (bodyCode && !limits.bodyCodes.includes(bodyCode)) || engineOutside) {
    return { status: "rejected", note: "Rocznik, przebieg, nadwozie lub pojemność z karty są poza zakresem." };
  }
  const terms = fold(card.title + " " + card.description);
  if (/\b(?:sprzedaż (?:wyłącznie )?w drodze licytacji|sprzedaż wyłącznie na aukcji|cena wywoławcza)\b/u.test(terms)) {
    return { status: "rejected", note: "Opis wskazuje aukcyjny tryb sprzedaży." };
  }
  const { price, quote } = purchasePrice(card, terms);
  if (!card.contact) {
    return { status: "unverified", note: "Karta nie potwierdza aktywnej sprzedaży." };
  }
  if (price !== null && price > limits.basePurchaseGrossPlnMax) {
    return { status: "price_review", note: "Cena z karty przekracza limit. Wymaga sprawdzenia warunków i ewentualnej zgody.",
      price, ...(quote ? { quote } : {}) };
  }
  if (Boolean(card.city) !== Boolean(card.region)) {
    return { status: "unverified", note: "Karta podaje niepełną lokalizację." };
  }
  const engineVariant = engineFromCard(card, profile);
  const transmissionCode = { manualna: "manual", automatyczna: "automatic" }[fold(fields["Skrzynia biegów"])];
  const fuelLpg = /\blpg\b/i.test(fields.Paliwo ?? "");
  const explicitLpg = fuelLpg || /\bbenzyna\s*\+\s*lpg\b/.test(terms);
  const noLpg = /\b(?:bez (?:instalacji )?lpg|lpg nie było montowane)\b/.test(terms);
  const lpgInstalled = explicitLpg === noLpg ? null : explicitLpg;
  const vin = fields.VIN?.toUpperCase();
  const listingId = "sprzedajemy:" + number;
  const offer = {
    id: "listing:" + listingId, title: card.title, urls: [{ url }], listingIds: [listingId],
    ...(price !== null ? { price } : {}), ...(year !== null ? { year } : {}),
    ...(price !== null ? { priceBasis: "gross_total" } : {}),
    ...(mileageKm !== null ? { mileage: mileageKm } : {}), ...(bodyCode ? { bodyCode } : {}),
    ...(engineVariant ? { engineVariant } : {}), ...(transmissionCode ? { transmissionCode } : {}),
    ...(/^[A-HJ-NPR-Z0-9]{17}$/.test(vin ?? "") ? { vin } : {}),
    saleType: price !== null ? "fixed_price" : null, lpgInstalled,
    ...(card.photos.length ? { photos: card.photos } : {}),
    location: card.city ? { status: "available", countryCode: "PL", city: card.city,
      voivodeship: fold(card.region) } : { status: "not_provided" },
  };
  const evidenceFields = ["price", "priceBasis", "year", "mileage", "bodyCode", "engineVariant", "transmissionCode", "vin", "saleType", "lpgInstalled"]
    .filter((key) => offer[key] != null);
  if (card.city) evidenceFields.push("location");
  offer.observation = { url, checkedAt, availability: "available",
    note: "Odczytano kartę z aktywnym kontaktem i pasującym numerem. " +
      (quote ? "Warunki zakupu z opisu: „" + quote + "”." : "Warunki ceny i tryb sprzedaży wymagają potwierdzenia.") +
      (lpgInstalled ? " Dokumenty instalacji LPG i zbiornika wymagają sprawdzenia." : ""),
    evidence: evidenceFields.length ? [{ kind: "seller", url, checkedAt, fields: evidenceFields,
      note: "Dane z karty sprzedawcy." }] : [],
  };
  return { status: "available", offer };
}

function identityKey(url) {
  const parsed = new URL(url);
  const id = /^sprzedajemy\.pl$/i.test(parsed.hostname.replace(/^www\./i, "")) && listingNumber(url);
  return id ? "sprzedajemy:" + id : parsed.origin + parsed.pathname.replace(/\/$/, "") + parsed.search;
}

async function activeIdentities(root, task) {
  const ids = new Set();
  if (Array.isArray(task?.activeOfferUrls)) {
    for (const url of task.activeOfferUrls) {
      try { ids.add(identityKey(url)); } catch { /* Ignore invalid snapshot URLs; local finish remains authoritative. */ }
    }
    for (const id of task.activeListingIds ?? []) if (typeof id === "string") ids.add(id.toLowerCase());
    for (const vin of task.activeVins ?? []) if (typeof vin === "string") ids.add("vin:" + vin.toUpperCase());
    return ids;
  }
  const folder = path.join(root, "offers");
  for (const file of await readdir(folder)) {
    if (!file.endsWith(".json")) continue;
    const records = JSON.parse(await readFile(path.join(folder, file), "utf8")).offers ?? [];
    for (const offer of records) {
      for (const id of offer.listingIds ?? []) ids.add(id.toLowerCase());
      for (const { url } of offer.urls ?? []) ids.add(identityKey(url));
      if (offer.vin) ids.add("vin:" + offer.vin.toUpperCase());
    }
  }
  return ids;
}

export async function verifyListings({ root, task, snapshot, navigate, page, maxCards, listMs,
  readCard = createCardReader(navigate, page) }) {
  const started = performance.now();
  const { coverage } = snapshot;
  const errors = [...(snapshot.errors ?? [])];
  const offers = [];
  const checks = [];
  const ids = await activeIdentities(root, task);
  const cachedReads = new Map((task.sharedResultsCache?.cardReads ?? []).map((entry) => [entry.url, entry]));
  const cardReads = [];
  let openedCards = 0;
  let reusedCards = 0;
  let htmlCards = 0;
  let htmlFallbacks = 0;
  const listings = new Map();
  for (const listing of coverage.searchResults.flatMap((result) => result.listings)) {
    const key = identityKey(listing.url);
    if (!listings.has(key)) listings.set(key, listing);
  }
  let stopped = snapshot.outcome === "blocked" || snapshot.stopCards;
  for (const [key, listing] of listings) {
    if (stopped) break;
    const { url } = listing;
    const { screeningFailures } = screenListing(listing, task.searchProfile);
    if (ids.has(key) || screeningFailures.length) {
      checks.push({ url, status: ids.has(key) ? "already_active" : "screened_out",
        ...(screeningFailures.length ? { screeningFailures } : {}) });
      continue;
    }
    let cached = cachedReads.get(url);
    if (cached?.card && !cached.card.contactChecked &&
        classifyCard(cached.card, url, task.searchProfile, cached.checkedAt).status === "unverified") {
      cached = null;
    }
    if (!cached && maxCards !== null && openedCards >= maxCards) {
      checks.push({ url, status: "card_limit" });
      continue;
    }
    coverage.listingUrlsChecked.push(url);
    let entry = cached;
    try {
      if (cached) {
        reusedCards += 1;
      } else {
        openedCards += 1;
        const { card, method } = await readCard(url);
        if (method === "html") htmlCards += 1;
        if (method === "fallback") htmlFallbacks += 1;
        entry = { url, checkedAt: new Date().toISOString(), card };
      }
    } catch (error) {
      stopped = stopCardReads(error);
      entry = { url, checkedAt: new Date().toISOString(), error: error.message.split("\n")[0] };
    }
    cardReads.push(entry);
    if (entry.error) {
      errors.push({ url, error: entry.error });
      checks.push({ url, status: "access_error", fromSharedCache: Boolean(cached) });
      continue;
    }
    const { offer, ...finding } = classifyCard(entry.card, url, task.searchProfile, entry.checkedAt);
    if (offer?.vin && ids.has("vin:" + offer.vin)) finding.status = "already_active";
    else if (offer) offers.push(offer);
    checks.push({ url, ...finding, fromSharedCache: Boolean(cached) });
  }
  if (stopped || checks.some(({ status, quote }) =>
    ["access_error", "card_limit", "unverified"].includes(status) || (status === "price_review" && !quote))) {
    coverage.remaining = [coverage.remaining, "Część kart pozostała bez odczytu lub rozstrzygnięcia."].filter(Boolean).join(" ");
  }
  coverage.cardReads = cardReads;
  return {
    taskId: task.id, outcome: snapshot.outcome === "blocked" ? "blocked"
      : coverage.remaining ? "partial" : offers.length ? "complete" : "no_matches",
    checkedAt: new Date().toISOString(), coverage, offers, errors,
    diagnostics: { listMs, cardMs: Math.round(performance.now() - started), uniqueListings: listings.size,
      openedCards, reusedCards, htmlCards, htmlFallbacks, queryChecks: snapshot.queryChecks, checks },
  };
}
