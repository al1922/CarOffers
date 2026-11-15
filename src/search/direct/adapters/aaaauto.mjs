const ORIGIN = "https://www.aaaauto.pl";

const BODY_SLUGS = {
  wagon: "kombi",
  combi: "kombi",
  sedan: "sedan",
  hatchback: "hatchback",
  suv: "suv",
  crossover: "crossover",
  minivan: "minivan",
};

const BODY_CODES = {
  kombi: "wagon",
  wagon: "wagon",
  sedan: "sedan",
  hatchback: "hatchback",
  suv: "suv",
  crossover: "crossover",
  minivan: "minivan",
};

function slug(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizedBody(value) {
  return String(value ?? "").toLowerCase().trim();
}

function prepareFilterPlan(group, profile = {}) {
  if (group.models.length !== 1) throw new Error("AAA AUTO wymaga osobnego adresu URL dla każdego modelu.");
  const model = group.models[0];
  const mapping = profile.modelMappings?.[model.key] ?? {};
  const requirements = model.requirements ?? {};
  const purchase = requirements.purchase ?? {};
  const mileage = requirements.mileage ?? {};
  const requestedBodies = [...new Set((model.bodies ?? []).map(normalizedBody).filter(Boolean))];
  const body = requestedBodies.length === 1 ? requestedBodies[0] : null;
  const bodyFilterOmitted = mapping.omitBodyInUrl === true;
  const bodySlug = body && !bodyFilterOmitted ? profile.bodySlugs?.[body] ?? BODY_SLUGS[body] ?? null : null;
  const yearMin = requirements.yearMin ?? model.searchYears?.min;
  const maxAdvertisedPricePln = purchase.maxAdvertisedPricePln ?? purchase.maxPriceGrossPln;
  const mileageMaxKm = mileage.hardMaxKm ?? mileage.preferredMaxKm;
  const omittedFilters = [];
  if (String(model.generation ?? "").trim()) omittedFilters.push({
    filter: "generation",
    modelKey: model.key,
    reason: "AAA AUTO nie ujawniło w publicznym filtrze URL potwierdzonego filtra generacji; generację sprawdza się w JSON karty oferty.",
  });
  if (requestedBodies.length && (!bodySlug || bodyFilterOmitted)) omittedFilters.push({
    filter: "body",
    modelKey: model.key,
    reason: bodyFilterOmitted
      ? "Ścieżka URL nadwozia nie została potwierdzona dla tego modelu AAA AUTO; typ trzeba potwierdzić w JSON karty."
      : "Profil modelu ma kilka nadwozi albo nie ma potwierdzonej ścieżki AAA AUTO; typ nadwozia trzeba potwierdzić w JSON karty.",
  });
  const filtersApplied = { make: model.brand, models: [model.model] };
  if (Number.isFinite(yearMin)) filtersApplied.yearMin = yearMin;
  if (Number.isFinite(maxAdvertisedPricePln)) filtersApplied.maxAdvertisedPricePln = maxAdvertisedPricePln;
  if (Number.isFinite(mileageMaxKm)) filtersApplied.mileageMaxKm = mileageMaxKm;
  if (bodySlug) filtersApplied.body = BODY_CODES[bodySlug] ?? body;
  return {
    modelKey: model.key,
    makeSlug: mapping.makeSlug ?? slug(model.brand),
    modelSlug: mapping.modelSlug ?? slug(model.model),
    bodySlug,
    requestedBodies,
    yearMin: Number.isFinite(yearMin) ? yearMin : null,
    maxAdvertisedPricePln: Number.isFinite(maxAdvertisedPricePln) ? maxAdvertisedPricePln : null,
    mileageMaxKm: Number.isFinite(mileageMaxKm) ? mileageMaxKm : null,
    filtersApplied,
    omittedFilters,
    profile,
  };
}

function buildFilteredSearchUrl(group, plan, baseUrl) {
  const url = new URL(baseUrl);
  const segments = ["pojazdy-uzywane", plan.makeSlug, plan.modelSlug, plan.bodySlug,
    plan.yearMin === null ? null : String(plan.yearMin)].filter(Boolean);
  url.pathname = `/${segments.join("/")}`;
  url.search = "";
  if (plan.maxAdvertisedPricePln !== null) url.searchParams.set("priceTo", String(plan.maxAdvertisedPricePln));
  if (plan.mileageMaxKm !== null) url.searchParams.set("mileageTo", String(plan.mileageMaxKm));
  return { url: url.href, filtersApplied: plan.filtersApplied, filterPlan: plan };
}

function readListingState() {
  const node = document.querySelector("script#ng-state[type='application/json']");
  if (!node) return { present: false };
  try {
    const state = JSON.parse(node.textContent || "{}");
    const response = state["car-list"];
    const request = state["car-list-request"];
    const message = response?.message;
    const scalar = (value) => {
      if (typeof value === "string" || typeof value === "number") return String(value).trim();
      if (!value || typeof value !== "object") return "";
      for (const key of ["name", "title", "value", "displayValue", "text", "code"]) {
        const result = scalar(value[key]);
        if (result) return result;
      }
      return "";
    };
    const locationFor = (record) => {
      const location = record?.location ?? record?.seller?.location ?? record?.dealer?.location ?? {};
      const address = record?.address ?? record?.seller?.address ?? record?.dealer?.address ?? location?.address ?? {};
      const result = {
        city: scalar(location.city ?? location.addressLocality ?? address.city ?? address.addressLocality ?? record?.city),
        voivodeship: scalar(location.voivodeship ?? location.region ?? location.addressRegion ??
          address.voivodeship ?? address.region ?? address.addressRegion ?? record?.voivodeship),
        countryCode: scalar(location.countryCode ?? address.countryCode ?? address.addressCountry ?? record?.countryCode),
        postalCode: scalar(location.postalCode ?? address.postalCode ?? record?.postalCode),
        latitude: scalar(location.latitude ?? address.latitude ?? record?.latitude),
        longitude: scalar(location.longitude ?? address.longitude ?? record?.longitude),
      };
      return Object.values(result).some(Boolean) ? result : null;
    };
    const explicitDate = (record, names) => {
      for (const name of names) if (record?.[name] !== undefined && record[name] !== null && record[name] !== "") return record[name];
      return null;
    };
    const photoUrls = (value) => {
      const items = Array.isArray(value) ? value : value == null ? [] : [value];
      return [...new Set(items.map((photo) => typeof photo === "string" ? photo :
        photo?.url ?? photo?.src ?? photo?.contentUrl ?? photo?.thumbnailUrl)
        .filter((url) => typeof url === "string" && /^https:\/\//i.test(url)))].slice(0, 12);
    };
    const items = Array.isArray(message?.items) ? message.items.map((item) => ({
      id: item.id,
      title: item.displayTitle ?? "",
      makeSlug: item.make?.slug ?? "",
      makeTitle: item.make?.title ?? "",
      modelSlug: item.model?.slug ?? "",
      modelTitle: item.model?.title ?? "",
      modelGeneration: item.model?.generation ?? null,
      productionYear: item.productionYear ?? null,
      mileage: item.mileage ?? null,
      mileageUnit: item.mileageUnit ?? "km",
      bodySlug: item.body?.slug ?? "",
      bodyTitle: item.body?.title ?? "",
      bodyCode: item.body?.id ?? "",
      vin: item.body?.vin ?? null,
      fuelTitle: item.fuel?.title ?? "",
      alternativeFuelTitle: item.alternativeFuel?.title ?? "",
      engineTitle: item.engine?.title ?? "",
      engineSize: item.engine?.engineSize ?? null,
      enginePowerHp: item.engine?.powerHp ?? item.engine?.powerPS ?? item.engine?.systemPowerPS ?? null,
      enginePowerKw: item.engine?.performanceKW ?? item.engine?.powerKw ?? item.engine?.powerKW ?? null,
      gearboxTitle: item.gearbox?.title ?? "",
      priceCash: item.price?.cash ?? null,
      priceBasis: item.price?.priceBasis ?? item.price?.basis ?? null,
      priceCurrency: item.price?.currency ?? item.price?.currencyCode ?? null,
      saleType: item.saleType ?? item.transactionType ?? item.price?.saleType ?? null,
      sellerType: item.seller?.type ?? item.sellerType ?? null,
      sellerName: scalar(item.seller?.name ?? item.dealer?.name ?? item.sellerName ?? item.dealerName) || null,
      lpgInstalled: typeof item.lpgInstalled === "boolean" ? item.lpgInstalled : null,
      location: locationFor(item),
      publicationDate: explicitDate(item, ["publicationDate", "datePublished", "datePosted", "publishedAt", "publishedDate"]),
      firstRegistrationDate: explicitDate(item, ["firstRegistrationDate", "first_registration_date", "dateFirstRegistered"]),
      isSold: typeof item.isSold === "boolean" ? item.isSold : null,
      countryRegion: item.countryRegion ?? item.originCountry ?? null,
      webHeadline: item.webHeadline ?? "",
      photos: photoUrls(item.photos?.default ?? item.photos),
    })) : null;
    return {
      present: true,
      code: response?.code ?? null,
      items,
      pagination: message?.pagination ?? null,
      request: request ? { page: request.page ?? null, data: request.data ?? {} } : null,
    };
  } catch {
    return { present: true, invalidJson: true };
  }
}

function priceAmount(value) {
  const text = String(value ?? "").trim();
  return /^\d+(?:[.,]\d{1,2})?$/.test(text) ? Number(text.replace(",", ".")) : null;
}

function listingFromItem(item, origin) {
  const id = Number(item.id);
  if (!Number.isSafeInteger(id) || !item.makeSlug || !item.modelSlug) return null;
  const url = new URL(`/detail/${encodeURIComponent(item.makeSlug)}/${encodeURIComponent(item.modelSlug)}/${id}`, origin).href;
  const price = priceAmount(item.priceCash);
  const text = [item.title, item.productionYear,
    item.mileage !== null && item.mileage !== undefined && item.mileage !== "" && Number.isFinite(Number(item.mileage)) ? `${item.mileage} km` : null,
    item.bodyTitle, item.fuelTitle, item.alternativeFuelTitle, item.engineTitle, item.gearboxTitle,
    Number.isFinite(price) ? `${price} zł` : null, item.webHeadline].filter(Boolean).join(" | ");
  return {
    url,
    title: item.title,
    visibleText: text,
    apiVisibleText: text,
    apiPriceAmount: Number.isFinite(price) && price > 0 ? price : null,
    apiEvidence: { captured: true, channel: "embedded_ng_state", recordId: id,
      fields: ["price.cash", "productionYear", "mileage", "body", "fuel", "engine", "gearbox"] },
    sourceFields: {
      recordId: id,
      listingId: String(id),
      makeSlug: item.makeSlug,
      brand: item.makeTitle,
      modelSlug: item.modelSlug,
      model: item.modelTitle,
      modelGeneration: item.modelGeneration,
      productionYear: item.productionYear,
      mileage: item.mileage,
      mileageUnit: item.mileageUnit || "km",
      bodySlug: item.bodySlug,
      bodyCode: item.bodyCode,
      bodyType: item.bodyTitle,
      fuelType: [item.fuelTitle, item.alternativeFuelTitle].filter(Boolean).join(" + "),
      alternativeFuelTitle: item.alternativeFuelTitle,
      engine: item.engineTitle,
      engineCapacity: item.engineSize !== null && item.engineSize !== undefined && item.engineSize !== "" && Number.isFinite(Number(item.engineSize)) && Number(item.engineSize) > 0
        ? `${item.engineSize} cm³` : null,
      enginePower: item.enginePowerHp !== null && item.enginePowerHp !== undefined && item.enginePowerHp !== "" && Number.isFinite(Number(item.enginePowerHp)) && Number(item.enginePowerHp) > 0
        ? `${item.enginePowerHp} KM` : item.enginePowerKw !== null && item.enginePowerKw !== undefined && item.enginePowerKw !== "" && Number.isFinite(Number(item.enginePowerKw)) && Number(item.enginePowerKw) > 0
          ? `${item.enginePowerKw} kW` : null,
      transmission: item.gearboxTitle,
      vin: item.vin,
      price: price,
      priceCash: item.priceCash,
      priceCurrency: item.priceCurrency,
      priceBasis: item.priceBasis,
      saleType: item.saleType,
      sellerType: item.sellerType,
      sellerName: item.sellerName,
      lpgInstalled: item.lpgInstalled,
      location: item.location,
      publicationDate: item.publicationDate,
      firstRegistrationDate: item.firstRegistrationDate,
      availability: item.isSold === true ? "OutOfStock" : item.isSold === false ? "InStock" : null,
      photos: item.photos,
    },
  };
}

function detailFromState() {
  const stateNode = document.querySelector("script#ng-state[type='application/json']");
  if (!stateNode) return { present: false };
  try {
    const state = JSON.parse(stateNode.textContent || "{}");
    const entry = Object.entries(state).find(([key]) => /^detail-\d+-/.test(key))?.[1];
    const car = entry?.car;
    if (!car || typeof car !== "object") return { present: true, missingCar: true };
    const title = document.querySelector("h1")?.textContent?.trim() || car.displayTitle || document.title;
    const parsePrice = (value) => {
      const text = String(value ?? "").trim();
      return /^\d+(?:[.,]\d{1,2})?$/.test(text) ? Number(text.replace(",", ".")) : null;
    };
    const add = (fields, label, value) => {
      const text = String(value ?? "").replace(/\s+/g, " ").trim();
      if (text && !fields[label]) fields[label] = text;
    };
    const numeric = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
      ? Number(value) : null;
    const scalar = (value) => {
      if (typeof value === "string" || typeof value === "number") return String(value).trim();
      if (!value || typeof value !== "object") return "";
      for (const key of ["name", "title", "value", "displayValue", "text", "code"]) {
        const result = scalar(value[key]);
        if (result) return result;
      }
      return "";
    };
    const locationFor = (record) => {
      const location = record?.location ?? record?.seller?.location ?? record?.dealer?.location ?? {};
      const address = record?.address ?? record?.seller?.address ?? record?.dealer?.address ?? location?.address ?? {};
      const result = {
        city: scalar(location.city ?? location.addressLocality ?? address.city ?? address.addressLocality ?? record?.city),
        voivodeship: scalar(location.voivodeship ?? location.region ?? location.addressRegion ??
          address.voivodeship ?? address.region ?? address.addressRegion ?? record?.voivodeship),
        countryCode: scalar(location.countryCode ?? address.countryCode ?? address.addressCountry ?? record?.countryCode),
        postalCode: scalar(location.postalCode ?? address.postalCode ?? record?.postalCode),
        latitude: scalar(location.latitude ?? address.latitude ?? record?.latitude),
        longitude: scalar(location.longitude ?? address.longitude ?? record?.longitude),
      };
      return Object.values(result).some(Boolean) ? result : null;
    };
    const explicitDate = (record, names) => {
      for (const name of names) if (record?.[name] !== undefined && record[name] !== null && record[name] !== "") return record[name];
      return null;
    };
    const cash = parsePrice(car.price?.cash);
    const rawEnginePowerHp = numeric(car.engine?.powerHp ?? car.engine?.powerPS ?? car.engine?.systemPowerPS);
    const rawEnginePowerKw = numeric(car.engine?.performanceKW ?? car.engine?.powerKw ?? car.engine?.powerKW ?? car.engine?.systemPowerKw);
    const enginePowerHp = rawEnginePowerHp !== null && rawEnginePowerHp > 0 ? rawEnginePowerHp : null;
    const enginePowerKw = rawEnginePowerKw !== null && rawEnginePowerKw > 0 ? rawEnginePowerKw : null;
    const engineDescription = [car.engine?.title,
      enginePowerHp === null ? null : `${enginePowerHp} KM`,
      enginePowerKw === null ? null : `${enginePowerKw} kW`].filter(Boolean).join(" ");
    const fuelTitle = [car.fuel?.title, car.alternativeFuel?.title].filter(Boolean).join(" + ");
    const location = locationFor(car);
    const publicationDate = explicitDate(car, ["publicationDate", "datePublished", "datePosted", "publishedAt", "publishedDate"]);
    const firstRegistrationDate = explicitDate(car, ["firstRegistrationDate", "first_registration_date", "dateFirstRegistered"]);
    const rawCarPhotos = Array.isArray(car.photos?.default) ? car.photos.default :
      car.photos?.default == null ? [] : [car.photos.default];
    const carPhotos = [...new Set([...rawCarPhotos.map((photo) => typeof photo === "string" ? photo :
      photo?.url ?? photo?.src ?? photo?.contentUrl ?? photo?.thumbnailUrl), ...[...document.images]
      .filter((image) => image.getClientRects().length && image.naturalWidth > 100 && image.naturalHeight > 70)
      .map((image) => image.currentSrc || image.src)])].filter((url) => typeof url === "string" && /^https:\/\//i.test(url)).slice(0, 12);
    const fields = {};
    add(fields, "Marka", car.make?.title);
    add(fields, "Model", car.model?.title);
    add(fields, "Generacja", car.model?.generation);
    add(fields, "Rok produkcji", car.productionYear);
    add(fields, "Przebieg", car.mileage !== null && car.mileage !== undefined && car.mileage !== "" && Number.isFinite(Number(car.mileage))
      ? `${car.mileage} km` : null);
    add(fields, "Cena brutto", Number.isFinite(cash) ? `${cash} zł` : null);
    add(fields, "Nadwozie", car.body?.title);
    add(fields, "Skrzynia biegów", car.gearbox?.title);
    add(fields, "Rodzaj paliwa", fuelTitle);
    add(fields, "Silnik", car.engine?.title);
    add(fields, "Pojemność silnika", numeric(car.engine?.engineSize) === null || numeric(car.engine?.engineSize) <= 0
      ? null : `${car.engine.engineSize} cm³`);
    add(fields, "Moc", enginePowerHp !== null ? `${enginePowerHp} KM` :
      enginePowerKw !== null ? `${enginePowerKw} kW` : null);
    add(fields, "Kolor", car.body?.externalColor?.title);
    add(fields, "VIN", car.body?.vin);
    const graph = JSON.parse(document.querySelector("script#jsonld[type='application/ld+json']")?.textContent || "{}")["@graph"] ?? [];
    const structuredData = [{
      "@type": ["Product", "Car"],
      name: title,
      brand: car.make?.title ?? "",
      model: car.model?.title ?? "",
      productionDate: car.productionYear == null ? "" : String(car.productionYear),
      mileageFromOdometer: Number(car.mileage) || null,
      mileageUnit: "KMT",
      bodyType: car.body?.title ?? "",
      vehicleTransmission: car.gearbox?.title ?? "",
      fuelType: fuelTitle,
      vehicleEngine: engineDescription,
      vehicleIdentificationNumber: car.body?.vin ?? "",
      offers: [{ price: cash, priceCurrency: "PLN",
        ...(car.isSold === true ? { availability: "https://schema.org/OutOfStock" } :
          car.isSold === false ? { availability: "https://schema.org/InStock" } : {}) }],
      sourceJsonLdTypes: graph.map((item) => item?.["@type"] ?? null),
    }];
    const ctas = [...document.querySelectorAll("a[href^='tel:'], a, button")]
      .filter((node) => node.getClientRects().length)
      .map((node) => node.innerText?.trim() || node.getAttribute("aria-label")?.trim() || "")
      .filter((text) => /kontakt|telefon|wiadomo|sprzedawc|zadzwo|umówienie spotkania/i.test(text))
      .slice(0, 20);
    return {
      present: true,
      id: Number(car.id),
      title,
      bodyText: (document.body?.innerText ?? "").trim().slice(0, 30000),
      fields,
      structuredData,
      ctas,
      photos: carPhotos,
      sourceFields: {
        recordId: car.id == null ? null : String(car.id),
        listingId: car.id == null ? null : String(car.id),
        brand: scalar(car.make?.title),
        model: scalar(car.model?.title),
        modelGeneration: scalar(car.model?.generation) || null,
        productionYear: numeric(car.productionYear),
        mileage: numeric(car.mileage),
        mileageUnit: "km",
        price: cash,
        priceCash: cash,
        priceCurrency: scalar(car.price?.currency ?? car.price?.currencyCode) || null,
        priceBasis: scalar(car.price?.priceBasis ?? car.price?.basis) || null,
        priceLabel: scalar(car.price?.label) || null,
        saleType: scalar(car.saleType ?? car.transactionType ?? car.price?.saleType) || null,
        sellerType: scalar(car.seller?.type ?? car.sellerType) || null,
        sellerName: scalar(car.seller?.name ?? car.dealer?.name ?? car.sellerName ?? car.dealerName) || null,
        offerType: scalar(car.offerType ?? car.seller?.type ?? car.sellerType) || null,
        lpgInstalled: typeof car.lpgInstalled === "boolean" ? car.lpgInstalled : null,
        bodyType: scalar(car.body?.title),
        transmission: scalar(car.gearbox?.title),
        fuelType: fuelTitle,
        engine: engineDescription,
        engineCapacity: numeric(car.engine?.engineSize) === null || numeric(car.engine?.engineSize) <= 0
          ? null : `${car.engine.engineSize} cm³`,
        enginePower: enginePowerHp !== null ? `${enginePowerHp} KM` : enginePowerKw !== null ? `${enginePowerKw} kW` : null,
        vin: scalar(car.body?.vin) || null,
        location,
        publicationDate,
        firstRegistrationDate,
        availability: car.isSold === true ? "OutOfStock" : car.isSold === false ? "InStock" : null,
        photos: carPhotos,
      },
      isSold: typeof car.isSold === "boolean" ? car.isSold : null,
      cash,
      stateKey: Object.keys(state).find((key) => /^detail-\d+-/.test(key)) ?? null,
      jsonSource: "script#ng-state (detail car)",
    };
  } catch {
    return { present: true, invalidJson: true };
  }
}

export const aaaautoAdapter = {
  id: "aaaauto",
  sourceName: "AAA AUTO",
  listingSelector: "script#ng-state[type='application/json']",

  prepareFilterPlan,
  buildFilteredSearchUrl,

  shouldCaptureResponse(url) {
    try { return new URL(url).origin === ORIGIN; } catch { return false; }
  },

  async chooseNecessaryCookies(page, { waitForPrompt = true } = {}) {
    const choice = page.getByRole("button", { name: /tylko niezb[eę]dne|akceptuj niezb[eę]dne/i }).filter({ visible: true });
    if (waitForPrompt) await choice.waitFor({ state: "visible", timeout: 1200 }).catch(() => {});
    if (await choice.count() === 1) {
      await choice.click({ timeout: 4000, noWaitAfter: true });
      return "necessary_only";
    }
    return "not_present";
  },

  async waitForListingPage(page, pageNumber = 1, timeoutMs = 8000) {
    try {
      await page.waitForFunction((expectedPage) => {
        const node = document.querySelector("script#ng-state[type='application/json']");
        if (!node) return false;
        try {
          const state = JSON.parse(node.textContent || "{}");
          const list = state["car-list"];
          const request = state["car-list-request"];
          return list?.code === 200 && Array.isArray(list.message?.items) && Number(request?.page ?? 1) === expectedPage;
        } catch { return false; }
      }, pageNumber, { timeout: timeoutMs });
      return true;
    } catch (error) {
      if (error?.name === "TimeoutError") return false;
      throw error;
    }
  },

  async submitUrlFilters(page, runContext) {
    const ready = await this.waitForListingPage(page, 1, runContext.resultReadyTimeoutMs ?? 8000);
    if (!ready) throw new Error("AAA AUTO nie udostępniło danych listy w JSON #ng-state po otwarciu URL z filtrami.");
  },

  async waitForAppliedFiltersOnPage(page, models, appliedFilters, timeoutMs = 8000) {
    if (!await this.waitForListingPage(page, 1, timeoutMs)) return false;
    return (await this.auditListingPage(page, models, appliedFilters, 1, page.url())).ok;
  },

  async auditListingPage(page, models, appliedFilters, pageNumber, pageUrl = "") {
    const snapshot = await page.evaluate(readListingState);
    const missing = [];
    const model = models[0];
    if (!snapshot.present || snapshot.invalidJson || snapshot.code !== 200 || !Array.isArray(snapshot.items)) {
      return { ok: false, page: pageNumber, missing: ["valid car-list JSON in #ng-state"], requestUrl: null,
        source: "embedded_ng_state", totalItems: null };
    }
    const request = snapshot.request;
    const data = request?.data ?? {};
    if (!request || Number(request.page) !== pageNumber) missing.push("page");
    if (!Array.isArray(data.makeModelId) || data.makeModelId.length === 0) missing.push("model");
    if (Number.isFinite(appliedFilters.yearMin) && Number(data.yearFrom) !== appliedFilters.yearMin) missing.push("yearMin");
    if (Number.isFinite(appliedFilters.maxAdvertisedPricePln) && Number(data.priceTo) !== appliedFilters.maxAdvertisedPricePln) missing.push("maxAdvertisedPricePln");
    if (Number.isFinite(appliedFilters.mileageMaxKm) && Number(data.mileageTo) !== appliedFilters.mileageMaxKm) missing.push("mileageMaxKm");
    if (appliedFilters.body && (!Array.isArray(data.bodyTypeId) || data.bodyTypeId.length === 0)) missing.push("body");

    const pathSegments = (() => { try { return new URL(pageUrl).pathname.split("/").filter(Boolean); } catch { return []; } })();
    if (pathSegments[0] !== "pojazdy-uzywane" || pathSegments[1] !== slug(model.brand) ||
        pathSegments[2] !== slug(model.model)) missing.push("model_url");
    const expectedBodySlug = appliedFilters.body ? BODY_SLUGS[normalizedBody(appliedFilters.body)] : null;
    if (expectedBodySlug && !pathSegments.includes(expectedBodySlug)) missing.push("body_url");
    if (Number.isFinite(appliedFilters.yearMin) && !pathSegments.includes(String(appliedFilters.yearMin))) missing.push("year_url");

    const wrongModelItems = snapshot.items.filter((item) => item.makeSlug !== slug(model.brand) || item.modelSlug !== slug(model.model));
    if (wrongModelItems.length) missing.push("result_model_mismatch");
    if (appliedFilters.body) {
      const expectedBody = BODY_CODES[normalizedBody(appliedFilters.body)] ?? normalizedBody(appliedFilters.body);
      if (snapshot.items.some((item) => item.bodySlug && (BODY_CODES[item.bodySlug] ?? item.bodySlug) !== expectedBody)) {
        missing.push("result_body_mismatch");
      }
    }
    return {
      ok: missing.length === 0,
      page: pageNumber,
      missing,
      requestUrl: null,
      source: "embedded_ng_state",
      responseCode: snapshot.code,
      requestPage: request?.page ?? null,
      requestData: data,
      itemsOnPage: snapshot.items.length,
      totalItems: snapshot.pagination?.totalItems ?? null,
      totalPages: snapshot.pagination?.totalPages ?? null,
      hasMore: Boolean(snapshot.pagination?.hasMore),
    };
  },

  async extractListings(page) {
    const snapshot = await page.evaluate(readListingState);
    if (!snapshot.present || snapshot.invalidJson || snapshot.code !== 200 || !Array.isArray(snapshot.items)) {
      throw new Error("Nie udało się odczytać listy AAA AUTO z JSON #ng-state.");
    }
    return snapshot.items.filter((item) => !item.isSold).map((item) => listingFromItem(item, page.url()))
      .filter(Boolean);
  },

  async nextPageAction(page) {
    const snapshot = await page.evaluate(readListingState);
    if (!snapshot.pagination?.hasMore) return null;
    const target = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll("a[href]")].filter((node) => node.getClientRects().length)
        .filter((node) => /nast[eę]pn|kolejn|next/i.test(`${node.getAttribute("aria-label") ?? ""} ${node.innerText ?? ""}`));
      const href = candidates.map((node) => node.href).find((value) => {
        try { const url = new URL(value); return url.protocol === "https:" && url.origin === location.origin; } catch { return false; }
      });
      return href ?? null;
    });
    if (target) return { kind: "url", url: target };
    return { kind: "unsupported", url: null, reason: "AAA AUTO zgłasza kolejne strony, ale nie udostępniło widocznego adresu następnej strony." };
  },

  async navigateNextPage(page, action) {
    if (action.kind !== "url") return null;
    return page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  },

  async waitForDetailReady(page, timeoutMs = 5000) {
    try {
      await page.waitForFunction(() => {
        const node = document.querySelector("script#ng-state[type='application/json']");
        if (!node) return false;
        try {
          const state = JSON.parse(node.textContent || "{}");
          return Object.keys(state).some((key) => /^detail-\d+-/.test(key) && state[key]?.car?.id);
        } catch { return false; }
      }, null, { timeout: timeoutMs });
      return true;
    } catch (error) {
      if (error?.name === "TimeoutError") return false;
      throw error;
    }
  },

  async extractDetail(page) {
    const detail = await page.evaluate(detailFromState);
    if (!detail.present || detail.invalidJson || detail.missingCar || !detail.id) {
      throw new Error("Karta AAA AUTO nie zawiera danych auta w JSON #ng-state.");
    }
    const expectedId = Number(new URL(page.url()).pathname.match(/\/(\d+)\/?$/)?.[1]);
    if (Number.isSafeInteger(expectedId) && expectedId !== detail.id) {
      throw new Error(`JSON karty AAA AUTO zwrócił identyfikator ${detail.id}, oczekiwano ${expectedId}.`);
    }
    return {
      title: detail.title,
      bodyText: detail.bodyText,
      fields: detail.fields,
      structuredData: detail.structuredData,
      ctas: detail.ctas,
      photos: detail.photos,
      sourceFields: detail.sourceFields,
      salePanel: Number.isFinite(detail.cash) ? { price: `${detail.cash} zł`, terms: "Cena brutto" } : null,
      sourceEvidence: { jsonSource: detail.jsonSource, stateKey: detail.stateKey, recordId: detail.id,
        isSold: detail.isSold, fields: Object.keys(detail.fields) },
    };
  },
};
