import { listingMatchesModel } from "../model-groups.mjs";

const ORIGIN = "https://www.spoticar.pl";
const SEARCH_PATH = "/znajdz-uzywany-samochod";

function slug(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function prepareFilterPlan(group, profile = {}) {
  if (group.models.length !== 1) throw new Error("SPOTICAR wymaga osobnego URL-a dla każdego modelu.");
  const model = group.models[0];
  const requirements = model.requirements ?? {};
  const purchase = requirements.purchase ?? {};
  const mileage = requirements.mileage ?? {};
  const yearMin = requirements.yearMin ?? model.searchYears?.min;
  const maxPriceGrossPln = purchase.maxPriceGrossPln;
  const mileageMaxKm = mileage.hardMaxKm ?? mileage.preferredMaxKm;
  const filtersApplied = { make: model.brand, models: [model.model] };
  const omittedFilters = [
    { filter: "generation", modelKey: model.key, reason: "Wartość filtra generacji nie jest potwierdzona dla tego modelu; nie dokładam niezweryfikowanego parametru URL." },
    { filter: "body", modelKey: model.key, reason: "Wartość filtra nadwozia nie jest potwierdzona dla tego modelu; nadwozie weryfikuję na karcie." },
    { filter: "yearMin", modelKey: model.key, reason: "Schemat URL filtra rocznika nie został potwierdzony; rocznik sprawdza klasyfikator karty." },
    { filter: "maxPriceGrossPln", modelKey: model.key, reason: "Schemat URL filtra ceny nie został potwierdzony; cenę sprawdza klasyfikator karty." },
    { filter: "mileageMaxKm", modelKey: model.key, reason: "Schemat URL filtra przebiegu nie został potwierdzony; przebieg sprawdza klasyfikator karty." },
  ];
  return {
    modelKey: model.key,
    makeValue: slug(model.brand),
    modelValue: slug(model.model),
    yearMin: Number.isFinite(yearMin) ? yearMin : null,
    maxPriceGrossPln: Number.isFinite(maxPriceGrossPln) ? maxPriceGrossPln : null,
    mileageMaxKm: Number.isFinite(mileageMaxKm) ? mileageMaxKm : null,
    filtersApplied,
    omittedFilters,
    profile,
  };
}

function buildFilteredSearchUrl(group, plan, baseUrl) {
  if (group.models.length !== 1) throw new Error("Tryb URL SPOTICAR wymaga osobnego adresu dla każdego modelu.");
  const url = new URL(baseUrl);
  url.pathname = SEARCH_PATH;
  url.search = "?page=1&filters[0][brand]=" + encodeURIComponent(plan.makeValue) +
    "&filters[1][model]=" + encodeURIComponent(plan.modelValue);
  return { url: url.href, filtersApplied: plan.filtersApplied, filterPlan: plan };
}

function readListingState() {
  const pageOrigin = globalThis.location.origin;
  const detailPathPrefix = "/znajdz-uzywany-samochod/";
  const numberValue = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const raw = String(value).trim().replace(/[\s\u00a0]/g, "").replace(/[^\d,.-]/g, "");
    if (!raw) return null;
    const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(raw)
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const nodes = [];
  const addNodes = (value) => {
    if (Array.isArray(value)) {
      nodes.push(...value.filter((item) => item && typeof item === "object"));
      return;
    }
    if (value && typeof value === "object") {
      if (Array.isArray(value["@graph"])) nodes.push(...value["@graph"].filter((item) => item && typeof item === "object"));
      else nodes.push(value);
    }
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { addNodes(JSON.parse(script.textContent || "null")); } catch { /* Skip malformed structured data. */ }
  }
  const itemList = nodes.find((item) => {
    const type = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
    return type.includes("ItemList") && Array.isArray(item.itemListElement);
  });
  if (!itemList) return { present: false, items: [] };

  const imageUrls = (value) => {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values.map((item) => typeof item === "string" ? item : item?.contentUrl ?? item?.url ?? item?.thumbnailUrl)
      .filter((item) => typeof item === "string" && /^https:\/\//i.test(item)))].slice(0, 12);
  };
  const mileageFromText = (text) => {
    const pattern = /(\d[\d\s\u00a0.,]*)\s*km\b/gi;
    for (const match of String(text ?? "").matchAll(pattern)) {
      const prefix = String(text).slice(0, match.index).trimEnd();
      if (/l\s*\/\s*$/i.test(prefix)) continue;
      const amount = Number(match[1].replace(/[\s\u00a0.,]/g, ""));
      if (Number.isFinite(amount)) return amount;
    }
    return null;
  };
  const rejectedUrlSamples = [];
  const rawEntries = itemList.itemListElement;
  const items = rawEntries.map((entry) => {
    const item = entry?.item && typeof entry.item === "object" ? entry.item : entry;
    const rawUrl = item?.url ?? entry?.url;
    let url = null;
    let rejectionReason = rawUrl ? "unsupported_url" : "missing_url";
    try {
      const resolved = new URL(rawUrl, pageOrigin);
      if (resolved.origin !== pageOrigin) rejectionReason = "different_origin";
      else if (!resolved.pathname.startsWith(detailPathPrefix)) rejectionReason = "unexpected_path";
      else url = resolved.href;
    } catch (error) {
      rejectionReason = `${error?.name ?? "Error"}: ${error?.message ?? error}`.slice(0, 180);
    }
    if (!url) {
      if (rejectedUrlSamples.length < 5) rejectedUrlSamples.push({
        reason: rejectionReason,
        rawUrl: typeof rawUrl === "string" ? rawUrl.slice(0, 500) : rawUrl == null ? null : typeof rawUrl,
        title: String(item?.name ?? item?.headline ?? "").trim().slice(0, 180),
      });
      return null;
    }
    const title = String(item?.name ?? item?.headline ?? "").trim();
    const brand = typeof item?.brand === "string" ? item.brand : item?.brand?.name ?? "";
    const description = String(item?.description ?? "").replace(/\s+/g, " ").trim();
    const offers = Array.isArray(item?.offers) ? item.offers[0] : item?.offers ?? {};
    const price = numberValue(offers?.price ?? item?.price);
    const fuel = typeof item?.fuelType === "string" ? item.fuelType : item?.fuelType?.name ?? "";
    const transmission = typeof item?.vehicleTransmission === "string"
      ? item.vehicleTransmission : item?.vehicleTransmission?.name ?? "";
    const rawGeneration = item?.model?.generation ?? item?.generation ?? null;
    const modelGeneration = typeof rawGeneration === "string" || typeof rawGeneration === "number"
      ? String(rawGeneration) : rawGeneration?.name ?? null;
    const mileageValue = item?.mileageFromOdometer?.value ?? item?.mileageFromOdometer;
    const mileage = numberValue(mileageValue) ?? mileageFromText(description);
    const yearText = item?.productionDate ?? item?.vehicleModelDate ?? item?.productionYear ?? "";
    const yearMatch = String(yearText).match(/\b(?:19|20)\d{2}\b/);
    const engine = typeof item?.vehicleEngine === "string" ? item.vehicleEngine : item?.vehicleEngine?.name ?? "";
    const engineObject = item?.vehicleEngine && typeof item.vehicleEngine === "object" ? item.vehicleEngine : {};
    const address = item?.address ?? item?.seller?.address ?? offers?.seller?.address ?? item?.location ?? {};
    const publicationDate = item?.publicationDate ?? item?.datePublished ?? item?.datePosted ?? item?.publishedAt ?? item?.publishedDate ?? null;
    const firstRegistrationDate = item?.firstRegistrationDate ?? item?.first_registration_date ?? item?.dateFirstRegistered ?? null;
    const sellerType = item?.sellerType ?? item?.seller?.sellerType ?? item?.seller?.businessType ?? null;
    const priceSpecification = Array.isArray(offers?.priceSpecification) ? offers.priceSpecification[0] : offers?.priceSpecification ?? {};
    const priceBasis = item?.priceBasis ?? offers?.priceBasis ?? priceSpecification?.priceType ?? null;
    const location = {
      city: address?.addressLocality ?? address?.city ?? null,
      voivodeship: address?.addressRegion ?? address?.voivodeship ?? address?.region ?? null,
      countryCode: address?.addressCountry?.name ?? address?.addressCountry ?? address?.countryCode ?? null,
      postalCode: address?.postalCode ?? null,
      latitude: address?.geo?.latitude ?? address?.latitude ?? null,
      longitude: address?.geo?.longitude ?? address?.longitude ?? null,
    };
    const imageList = imageUrls(item?.image);
    const visibleText = [title, brand, description, fuel, transmission,
      mileage === null ? "" : `${mileage} km`, yearMatch?.[0] ?? "",
      price === null ? "" : `${price} PLN`, engine].filter(Boolean).join(" | ");
    const id = url.match(/-(\d+)\/?$/)?.[1] ?? null;
    return {
      url,
      title,
      visibleText,
      apiVisibleText: visibleText,
      ...(price !== null && price > 0 ? { apiPriceAmount: price } : {}),
      ...(imageList.length ? { photos: imageList } : {}),
      apiEvidence: { captured: true, channel: "embedded_jsonld", recordId: id,
        ...(price !== null ? { priceEvidenceNote: "Cenę odczytano z JSON-LD listy SPOTICAR; podstawa brutto/netto pozostaje niepotwierdzona." } : {}),
        fields: ["name", "brand", "description", "fuelType", "offers.price", "image"] },
      sourceData: { recordId: id, brand, name: title, description: description.slice(0, 2000),
        model: typeof item?.model === "string" ? item.model : item?.model?.name ?? null,
        modelGeneration,
        productionYear: yearMatch ? Number(yearMatch[0]) : null,
        mileage, mileageUnit: item?.mileageFromOdometer?.unitText ?? item?.mileageFromOdometer?.unitCode ?? "km",
        fuel, fuelType: fuel, transmission, bodyType: item?.bodyType ?? null, engine,
        engineCapacity: engineObject.engineDisplacement ?? engineObject.engineCapacity ?? item?.engineDisplacement ?? null,
        enginePower: engineObject.enginePower ?? engineObject.power ?? item?.enginePower ?? null,
        vin: item?.vehicleIdentificationNumber ?? item?.vin ?? null,
        location: Object.values(location).some(Boolean) ? location : null,
        publicationDate, firstRegistrationDate, saleType: item?.saleType ?? offers?.saleType ?? null,
        sellerType, sellerName: item?.seller?.name ?? (typeof item?.seller === "string" ? item.seller : null) ??
          item?.sellerName ?? item?.dealer?.name ?? null,
        offerType: item?.offerType ?? sellerType,
        lpgInstalled: typeof item?.lpgInstalled === "boolean" ? item.lpgInstalled : null,
        priceBasis, priceLabel: priceSpecification?.description ?? null,
        price,
        priceCurrency: offers?.priceCurrency ?? null, availability: offers?.availability ?? null,
        photos: imageList },
    };
  }).filter(Boolean);
  return { present: true, items, rawItemCount: rawEntries.length, rejectedUrlSamples,
    numberOfItems: itemList.numberOfItems ?? items.length };
}

export const spoticarAdapter = {
  id: "spoticar",
  sourceName: "SPOTICAR Polska",
  listingSelector: 'script[type="application/ld+json"]',

  prepareFilterPlan,
  buildFilteredSearchUrl,

  isRequiredDataResponse() {
    // Listing and card data are read from the HTML/JSON-LD; XHR/Fetch is optional enrichment.
    return false;
  },

  shouldCaptureResponse(url) {
    try { return new URL(url).origin === ORIGIN; } catch { return false; }
  },

  async chooseNecessaryCookies(page, { waitForPrompt = true } = {}) {
    const choice = page.getByRole("button", { name: /tylko niezb[eę]dne|odrzuć wszystkie|reject all|only necessary/i })
      .filter({ visible: true });
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
        const urlPage = Number(new URL(location.href).searchParams.get("page") ?? 1);
        if (urlPage !== expectedPage) return false;
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const parsed = JSON.parse(script.textContent || "null");
            const nodes = Array.isArray(parsed) ? parsed : parsed?.["@graph"] ?? [parsed];
            if (nodes.some((item) => {
              const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
              return types.includes("ItemList") && Array.isArray(item?.itemListElement);
            })) return true;
          } catch { /* Wait for a valid JSON-LD block. */ }
        }
        return false;
      }, pageNumber, { timeout: timeoutMs });
      return true;
    } catch (error) {
      if (error?.name === "TimeoutError") return false;
      throw error;
    }
  },

  async submitUrlFilters(page, runContext) {
    const ready = await this.waitForListingPage(page, 1, runContext.resultReadyTimeoutMs ?? 8000);
    if (!ready) throw new Error("SPOTICAR nie udostępnił JSON-LD listy po otwarciu URL-a z filtrami.");
  },

  async waitForAppliedFiltersOnPage(page, models, appliedFilters, timeoutMs = 8000) {
    if (!await this.waitForListingPage(page, 1, timeoutMs)) return false;
    return (await this.auditListingPage(page, models, appliedFilters, 1, page.url())).ok;
  },

  async auditListingPage(page, models, appliedFilters, pageNumber, pageUrl = "") {
    const snapshot = await page.evaluate(readListingState);
    const missing = [];
    const model = models[0];
    let url = null;
    try { url = new URL(pageUrl); } catch { missing.push("valid_search_url"); }
    if (!snapshot.present || !Array.isArray(snapshot.items)) missing.push("valid_itemlist_jsonld");
    if (url) {
      if (url.origin !== ORIGIN || url.pathname !== SEARCH_PATH) missing.push("search_url_scope");
      if (Number(url.searchParams.get("page") ?? 1) !== pageNumber) missing.push("page");
      if (url.searchParams.get("filters[0][brand]") !== slug(model.brand)) missing.push("brand");
      if (url.searchParams.get("filters[1][model]") !== slug(model.model)) missing.push("model");
    }
    const wrongModelItems = (snapshot.items ?? []).filter((item) =>
      !listingMatchesModel(item, model));
    if (wrongModelItems.length) missing.push("result_model_mismatch");
    return {
      ok: missing.length === 0,
      page: pageNumber,
      missing,
      requestUrl: pageUrl || null,
      source: "embedded_jsonld_and_filtered_url",
      filters: { make: url?.searchParams.get("filters[0][brand]") ?? null,
        model: url?.searchParams.get("filters[1][model]") ?? null },
      itemsOnPage: snapshot.items?.length ?? null,
      rawItemsOnPage: snapshot.rawItemCount ?? null,
      rejectedUrlSamples: snapshot.rejectedUrlSamples ?? [],
      numberOfItems: snapshot.numberOfItems ?? null,
      resultsTotal: await page.evaluate(() => {
        const text = document.body?.innerText ?? "";
        const match = text.match(/\(([\d\s\u00a0.]+)\s+wynik(?:i|ów)\s+wyszukiwania\)/i);
        return match ? Number(match[1].replace(/[\s\u00a0.]/g, "")) : null;
      }),
    };
  },

  async extractListings(page) {
    const snapshot = await page.evaluate(readListingState);
    if (!snapshot.present || !Array.isArray(snapshot.items)) {
      throw new Error("Nie udało się odczytać listy SPOTICAR z JSON-LD ItemList.");
    }
    return snapshot.items;
  },

  async nextPageAction(page) {
    const button = page.locator("#see-more-results, .see-more-button").filter({ visible: true }).first();
    if (await button.count() === 0 || !await button.isEnabled()) return null;
    const current = new URL(page.url());
    const currentPage = Number(current.searchParams.get("page") ?? 1);
    const nextPage = Number.isFinite(currentPage) ? currentPage + 1 : 2;
    if (/[?&]page=\d+/.test(current.search)) {
      current.search = current.search.replace(/([?&]page=)\d+/, "$1" + nextPage);
    } else {
      current.search += (current.search ? "&" : "?") + "page=" + nextPage;
    }
    return { kind: "url", url: current.href, pageNumber: nextPage };
  },

  async navigateNextPage(page, action) {
    if (action.kind !== "url") return null;
    return page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  },

  async waitForDetailReady(page, timeoutMs = 5000) {
    try {
      await page.waitForFunction(() => Boolean(document.querySelector("h1")?.textContent?.trim()) &&
        Boolean(document.querySelector("#characteristics-panel-collapse, .product-right-sidebar")) &&
        Boolean(document.body?.innerText?.trim()), null, { timeout: timeoutMs });
      return true;
    } catch (error) {
      if (error?.name === "TimeoutError") return false;
      throw error;
    }
  },

  async extractDetail(page) {
    return page.evaluate(() => {
      const bodyText = (document.body?.innerText ?? "").trim().slice(0, 30000);
      const title = document.querySelector("h1")?.innerText?.trim() || document.title;
      const fields = {};
      const add = (label, value) => {
        const key = String(label ?? "").replace(/\s+/g, " ").trim();
        const text = String(value ?? "").replace(/\s+/g, " ").trim();
        if (key && text && key.length < 120 && text.length < 600 && !fields[key]) fields[key] = text;
      };
      for (const row of document.querySelectorAll("#characteristics-panel-collapse .characteristic-content-element")) {
        if (!row.getClientRects().length) continue;
        add(row.querySelector(".key-point-label")?.innerText, row.querySelector(".key-point-value")?.innerText);
      }
      if (fields["Typ paliwa"] && !fields["Rodzaj paliwa"]) fields["Rodzaj paliwa"] = fields["Typ paliwa"];
      const rightPanel = document.querySelector(".product-right-sidebar");
      const price = [...(rightPanel?.querySelectorAll("*") ?? [])]
        .filter((node) => !node.children.length && node.getClientRects().length)
        .map((node) => node.innerText?.trim() ?? "")
        .find((text) => /\d[\d\s\u00a0.,]*\s*(?:PLN|zł)\b/i.test(text)) ?? null;
      const ctas = [...document.querySelectorAll("a[href],button")]
        .filter((node) => node.getClientRects().length)
        .map((node) => node.innerText?.trim() || node.getAttribute("aria-label")?.trim() || "")
        .filter((text) => /kontakt|telefon|wiadomo|sprzedawc|zadzwo|poproś o ofertę/i.test(text))
        .slice(0, 20);
      const pagePhotos = [...new Set([...document.querySelectorAll("#psa-carousel-container img, .psa-carousel-container img")]
        .filter((image) => image.getClientRects().length && image.naturalWidth > 100 && image.naturalHeight > 70)
        .map((image) => image.currentSrc || image.src)
        .filter((url) => /^https:\/\//i.test(url)))].slice(0, 12);
      const ldNodes = [];
      const addNodes = (value) => {
        if (Array.isArray(value)) { for (const item of value) addNodes(item); return; }
        if (value && typeof value === "object") {
          if (Array.isArray(value["@graph"])) for (const item of value["@graph"]) addNodes(item);
          else ldNodes.push(value);
        }
      };
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { addNodes(JSON.parse(script.textContent || "null")); } catch { /* Ignore malformed JSON-LD. */ }
      }
      const vehicle = ldNodes.find((item) => {
        const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
        return types.some((type) => /^(?:Car|Vehicle|Product)$/i.test(String(type))) &&
          (!item.name || String(item.name).toLowerCase() === title.toLowerCase());
      }) ?? null;
      const scalar = (value) => {
        if (typeof value === "string" || typeof value === "number") return String(value).trim();
        if (!value || typeof value !== "object") return "";
        for (const key of ["value", "displayValue", "text", "name", "title", "label", "code"]) {
          const result = scalar(value[key]);
          if (result) return result;
        }
        return "";
      };
      const measurement = (value) => value && typeof value === "object"
        ? [scalar(value.value ?? value.amount), scalar(value.unitText ?? value.unitCode ?? value.unit)].filter(Boolean).join(" ")
        : scalar(value);
      const structuredOffers = Array.isArray(vehicle?.offers) ? vehicle.offers : vehicle?.offers ? [vehicle.offers] : [];
      const structuredOffer = structuredOffers[0] ?? {};
      const seller = [vehicle?.seller, structuredOffer.seller].flatMap((item) => Array.isArray(item) ? item : [item])
        .find((item) => typeof item === "string" ? Boolean(item.trim()) :
          item && typeof item === "object" && Object.keys(item).length) ?? {};
      const address = vehicle?.address ?? seller?.address ?? vehicle?.location?.address ?? vehicle?.location ?? {};
      const location = {
        city: scalar(address.addressLocality ?? address.city),
        voivodeship: scalar(address.addressRegion ?? address.voivodeship ?? address.region),
        countryCode: scalar(address.addressCountry?.name ?? address.addressCountry ?? address.countryCode),
        postalCode: scalar(address.postalCode),
        latitude: scalar(address.geo?.latitude ?? address.latitude),
        longitude: scalar(address.geo?.longitude ?? address.longitude),
      };
      const publicationDate = vehicle?.publicationDate ?? vehicle?.datePublished ?? vehicle?.datePosted ??
        vehicle?.publishedAt ?? vehicle?.publishedDate ?? null;
      const firstRegistrationDate = vehicle?.firstRegistrationDate ?? vehicle?.first_registration_date ?? vehicle?.dateFirstRegistered ?? null;
      const jsonImages = Array.isArray(vehicle?.image) ? vehicle.image : vehicle?.image ? [vehicle.image] : [];
      const photos = [...new Set([...pagePhotos, ...jsonImages.map((item) => typeof item === "string" ? item : item?.contentUrl ?? item?.url)
        .filter((url) => typeof url === "string" && /^https:\/\//i.test(url))])].slice(0, 12);
      if (!fields["Lokalizacja"]) {
        const address = document.querySelector("#pdv-panel-collapse #gtm-pdv-address-event")?.innerText?.trim();
        const city = address?.match(/\b\d{2}-\d{3}\s+([^,\n]+)\s*$/)?.[1]?.trim();
        if (city) add("Miasto", city);
      }
      const amount = price ? Number(price.replace(/[^\d]/g, "")) : null;
      const detailVehicle = vehicle ?? {};
      const model = typeof detailVehicle.model === "string" ? detailVehicle.model : detailVehicle.model?.name ?? "";
      const brand = typeof detailVehicle.brand === "string" ? detailVehicle.brand : detailVehicle.brand?.name ?? "";
      const structuredPrice = Number(structuredOffer.price ?? detailVehicle.price);
      const visibleYear = Object.entries(fields).find(([key]) => /rokprodukcji|productionyear/i.test(key))?.[1];
      const visibleMileage = Object.entries(fields).find(([key]) => /przebieg|mileage/i.test(key))?.[1];
      const visibleFuel = fields["Rodzaj paliwa"] ?? fields["Typ paliwa"] ?? "";
      const visibleTransmission = Object.entries(fields).find(([key]) => /skrzyniabiegow|transmission/i.test(key))?.[1] ?? "";
      const visibleBody = Object.entries(fields).find(([key]) => /nadwozie|bodytype/i.test(key))?.[1] ?? "";
      const detailLocation = Object.values(location).some(Boolean) ? location :
        fields.Miasto ? { city: fields.Miasto } : null;
      const listingId = location.pathname.match(/-(\d+)\/?$/)?.[1] ?? null;
      return {
        title,
        bodyText,
        fields,
        structuredData: vehicle ? [vehicle] : [],
        ctas,
        photos,
        sourceData: {
          ...(listingId ? { listingId, recordId: listingId } : {}),
          brand, model,
          modelGeneration: scalar(detailVehicle.model?.generation ?? detailVehicle.generation) || null,
          productionYear: Number(String(detailVehicle.productionDate ?? detailVehicle.vehicleModelDate ??
            detailVehicle.productionYear ?? visibleYear ?? "").match(/\b(?:19|20)\d{2}\b/)?.[0]) || null,
          mileage: Number(String(detailVehicle.mileageFromOdometer?.value ?? detailVehicle.mileageFromOdometer ?? visibleMileage ?? "").replace(/[^\d]/g, "")) || null,
          mileageUnit: scalar(detailVehicle.mileageFromOdometer?.unitText ?? detailVehicle.mileageFromOdometer?.unitCode) || "km",
          fuelType: scalar(detailVehicle.fuelType) || visibleFuel,
          transmission: scalar(detailVehicle.vehicleTransmission) || visibleTransmission,
          bodyType: scalar(detailVehicle.bodyType) || visibleBody,
          engine: scalar(detailVehicle.vehicleEngine),
          engineCapacity: measurement(detailVehicle.vehicleEngine?.engineDisplacement ?? detailVehicle.engineDisplacement),
          enginePower: measurement(detailVehicle.vehicleEngine?.enginePower ?? detailVehicle.enginePower),
          vin: scalar(detailVehicle.vehicleIdentificationNumber ?? detailVehicle.vin) || null,
          price: Number.isFinite(structuredPrice) && structuredPrice > 0 ? structuredPrice : amount,
          priceCurrency: structuredOffer.priceCurrency ?? null,
          priceBasis: detailVehicle.priceBasis ?? structuredOffer.priceBasis ?? null,
          priceLabel: structuredOffer.priceSpecification?.description ?? null,
          saleType: detailVehicle.saleType ?? structuredOffer.saleType ?? null,
          sellerType: detailVehicle.sellerType ?? seller?.sellerType ?? seller?.businessType ?? null,
          sellerName: scalar(seller?.name ?? detailVehicle.sellerName ?? detailVehicle.dealer?.name ??
            (typeof seller === "string" ? seller : null)) || null,
          offerType: detailVehicle.offerType ?? seller?.sellerType ?? null,
          lpgInstalled: typeof detailVehicle.lpgInstalled === "boolean" ? detailVehicle.lpgInstalled : null,
          location: detailLocation,
          publicationDate, firstRegistrationDate,
          availability: structuredOffer.availability ?? null,
          photos,
        },
        ...(price ? { salePanel: { price, terms: "Cena" } } : {}),
        ...(Number.isFinite(amount) && amount > 0 ? { visiblePriceAmount: amount } : {}),
      };
    });
  },
};
