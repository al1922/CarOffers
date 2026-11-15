import { isClearlyNonVehicleTitle, modelNameMatches, normalizeText } from "./portal-screening.mjs";

const FACT_DATE_KEYS = ["publicationDate", "datePublished", "datePosted", "publishedAt", "publishedDate"];

function normalizedField(fields, patterns) {
  const entry = Object.entries(fields ?? {}).find(([key]) => patterns.some((pattern) =>
    pattern.test(normalizeText(key).replace(/[^a-z0-9]/g, ""))));
  return entry ? { label: entry[0], value: entry[1] } : null;
}

function numericValue(value) {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function yearValue(value) {
  const match = String(value ?? "").match(/\b(?:18|19|20|21)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function scalarText(value, depth = 0) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (depth > 3 || value == null) return "";
  if (Array.isArray(value)) return value.map((item) => scalarText(item, depth + 1)).filter(Boolean).join(" ");
  if (typeof value !== "object") return "";
  for (const key of ["value", "displayValue", "text", "name", "title", "label", "code"]) {
    const text = scalarText(value[key], depth + 1);
    if (text) return text;
  }
  return "";
}

function firstText(...values) {
  return values.map((value) => scalarText(value)).find(Boolean) ?? "";
}

function moneyValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value ?? "").match(/-?\d[\d\s\u00a0.,]*/);
  if (!match) return null;
  let raw = match[0].replace(/[\s\u00a0]/g, "");
  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    raw = comma > dot ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  } else if (comma >= 0) {
    raw = /,\d{1,2}$/.test(raw) ? raw.replace(",", ".") : raw.replace(/,/g, "");
  } else if (dot >= 0 && !/\.\d{1,2}$/.test(raw)) raw = raw.replace(/\./g, "");
  const amount = Number(raw);
  return Number.isFinite(amount) ? amount : null;
}

function dateValue(value) {
  const text = scalarText(value);
  let match = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (match) {
    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 &&
      date.getUTCDate() === Number(day) ? `${year}-${month}-${day}` : null;
  }
  match = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (!match) return null;
  const [, dayText, monthText, yearText] = match;
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  return date.getUTCFullYear() === Number(yearText) && date.getUTCMonth() === Number(monthText) - 1 &&
    date.getUTCDate() === Number(dayText) ? `${yearText}-${monthText.padStart(2, "0")}-${dayText.padStart(2, "0")}` : null;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasFactValue(value) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function mergeLocation(left, right) {
  const result = {};
  for (const value of [left, right]) {
    if (typeof value === "string" && value.trim()) result.label = value.trim();
    else for (const [key, item] of Object.entries(plainObject(value))) {
      if (hasFactValue(item)) result[key] = item;
    }
  }
  return result;
}

function sourceDataFor(listing, card) {
  const listingData = plainObject(listing?.sourceFields ?? listing?.sourceData);
  const detailData = plainObject(card?.sourceFields ?? card?.sourceData);
  const merged = {};
  for (const source of [listingData, detailData]) {
    for (const [key, value] of Object.entries(source)) {
      if (key === "location") continue;
      if (key === "photos") continue;
      if (hasFactValue(value)) merged[key] = value;
    }
  }
  const photos = [...new Set([
    ...(Array.isArray(detailData.photos) ? detailData.photos : []),
    ...(Array.isArray(card?.photos) ? card.photos : []),
    ...(Array.isArray(listingData.photos) ? listingData.photos : []),
    ...(Array.isArray(listing?.photos) ? listing.photos : []),
  ].filter((url) => typeof url === "string" && /^https:\/\//i.test(url)))].slice(0, 12);
  const location = mergeLocation(listingData.location, detailData.location);
  return { ...merged, ...(Object.keys(location).length ? { location } : {}), photos };
}

function structuredOffers(vehicle) {
  const offers = vehicle?.offers;
  return Array.isArray(offers) ? offers : offers ? [offers] : [];
}

function structuredAddress(vehicle) {
  const offer = structuredOffers(vehicle)[0] ?? {};
  const sellers = [vehicle?.seller, offer.seller].flatMap((item) => Array.isArray(item) ? item : [item]);
  return [vehicle?.address, ...sellers.map((item) => item?.address)]
    .find((item) => Object.keys(plainObject(item)).length) ?? {};
}

function structuredSeller(vehicle) {
  const offer = structuredOffers(vehicle)[0] ?? {};
  const sellers = [vehicle?.seller, offer.seller].flatMap((item) => Array.isArray(item) ? item : [item]);
  return sellers.map(plainObject).find((item) => Object.keys(item).length) ?? {};
}

function structuredPhotoUrls(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => typeof item === "string" ? item :
    firstText(item?.contentUrl, item?.url, item?.thumbnailUrl))
    .filter((url) => /^https:\/\//i.test(url));
}

const POLISH_REGIONS = [
  ["dolnoslaskie", "Dolnośląskie"], ["kujawsko-pomorskie", "Kujawsko-Pomorskie"],
  ["lubelskie", "Lubelskie"], ["lubuskie", "Lubuskie"], ["lodzkie", "Łódzkie"],
  ["malopolskie", "Małopolskie"], ["mazowieckie", "Mazowieckie"], ["opolskie", "Opolskie"],
  ["podkarpackie", "Podkarpackie"], ["podlaskie", "Podlaskie"], ["pomorskie", "Pomorskie"],
  ["slaskie", "Śląskie"], ["swietokrzyskie", "Świętokrzyskie"],
  ["warminsko-mazurskie", "Warmińsko-Mazurskie"], ["wielkopolskie", "Wielkopolskie"],
  ["zachodniopomorskie", "Zachodniopomorskie"],
];

function locationFrom(sourceData, fields, structuredVehicle, checkedAt) {
  const location = plainObject(sourceData.location);
  const address = structuredAddress(structuredVehicle);
  const locationField = normalizedField(fields, [/lokalizacja/, /^miasto$/, /^city$/, /^location$/, /^addresslocality$/]);
  const regionField = normalizedField(fields, [/wojewodztwo/, /^region$/, /^addressregion$/]);
  const countryField = normalizedField(fields, [/^countrycode$/, /^addresscountry$/, /^country$/]);
  const postalCodeField = normalizedField(fields, [/^postalcode$/, /^postcode$/]);
  const latitudeField = normalizedField(fields, [/^latitude$/, /^lat$/]);
  const longitudeField = normalizedField(fields, [/^longitude$/, /^lng$/, /^lon$/]);
  const locationText = firstText(locationField?.value, location.label, location.text, sourceData.locationText,
    typeof sourceData.location === "string" ? sourceData.location : "");
  const locationParts = locationText.split(/[,|(]/).map((item) => item.replace(/\)/g, "").trim()).filter(Boolean);
  const splitCity = locationParts[0] ?? "";
  const regionParts = locationParts.slice(1).filter((part) => !/^(?:pl|polska|poland)$/i.test(part));
  const splitRegion = regionParts.find((part) => {
    const normalized = normalizeText(part).replace(/wojewodztwo|woj\.?/g, "").trim();
    return POLISH_REGIONS.some(([key]) => normalized.includes(key));
  }) ?? regionParts[0] ?? "";
  const textCountry = locationParts.find((part) => /^(?:pl|polska|poland)$/i.test(part)) ?? "";
  const city = firstText(location.city, location.addressLocality, location.locality, location.name,
    sourceData.city, address.addressLocality, address.city, splitCity);
  const regionText = firstText(location.voivodeship, location.addressRegion, location.region, location.regionName,
    location.province, location.state,
    sourceData.voivodeship, sourceData.region, address.addressRegion, regionField?.value, splitRegion);
  const normalizedRegion = normalizeText(regionText).replace(/wojewodztwo|woj\.?/g, "").trim();
  const mappedVoivodeship = POLISH_REGIONS.find(([key]) => normalizedRegion.includes(key))?.[1] ?? null;
  const countryText = normalizeText(firstText(location.countryCode, location.addressCountry, location.country,
    sourceData.countryCode, sourceData.addressCountry, address.addressCountry, countryField?.value, textCountry));
  const countryCodeValue = firstText(location.countryCode, location.addressCountry, sourceData.countryCode,
    sourceData.addressCountry, address.addressCountry, countryField?.value, textCountry);
  const countryCode = /^[a-z]{2}$/i.test(countryCodeValue)
    ? countryCodeValue.toUpperCase()
    : ["polska", "poland"].includes(countryText) ? "PL" : mappedVoivodeship ? "PL" : null;
  const voivodeship = mappedVoivodeship ?? (countryCode === "PL" ? regionText || null : null);
  const postalCode = firstText(location.postalCode, address.postalCode, sourceData.postalCode, postalCodeField?.value);
  const coordinate = (value) => {
    const number = Number(value);
    return value !== null && value !== undefined && value !== "" && Number.isFinite(number) ? number : null;
  };
  const latitude = coordinate(location.latitude ?? address.latitude ?? sourceData.latitude ?? latitudeField?.value);
  const longitude = coordinate(location.longitude ?? address.longitude ?? sourceData.longitude ?? longitudeField?.value);
  if (city && voivodeship && countryCode) {
    return { status: "available", countryCode, city, voivodeship, precision: "city", source: "listing",
      ...(postalCode ? { postalCode } : {}), ...(latitude !== null ? { latitude } : {}),
      ...(longitude !== null ? { longitude } : {}), checkedAt: checkedAt.slice(0, 10) };
  }
  return { status: "not_provided", ...(countryCode ? { countryCode } : {}), ...(city ? { city } : {}),
    ...(voivodeship ? { voivodeship } : {}), ...(postalCode ? { postalCode } : {}),
    ...(latitude !== null ? { latitude } : {}), ...(longitude !== null ? { longitude } : {}) };
}

function normalizedBody(value, aliases = {}) {
  const body = normalizeText(value);
  const mapped = Object.entries(aliases).find(([alias]) => body === normalizeText(alias) || body.includes(normalizeText(alias)))?.[1];
  if (mapped) return normalizedBody(mapped);
  if (body.includes("kombi") || body.includes("combi") || body.includes("wagon") || body.includes("estate")) return "wagon";
  if (body.includes("sedan")) return "sedan";
  if (body.includes("hatchback") || body.includes("hatch")) return "hatchback";
  if (body.includes("suv")) return "suv";
  if (body.includes("crossover")) return "crossover";
  if (body.includes("minivan") || body.includes("minibus")) return "minivan";
  return null;
}

function normalizeOfferType(value) {
  const type = normalizeText(value);
  if (/leasing|lease|zwrot/.test(type)) return "leasing_return";
  if (/prywat|private|individual|person/.test(type)) return "private";
  if (/dealer|firma|company|business|komis|organization|organisation/.test(type)) return "company";
  if (/unknown|nieznany/.test(type)) return "unknown";
  return null;
}

function explicitBoolean(value) {
  if (typeof value === "boolean") return value;
  const text = normalizeText(scalarText(value));
  if (/^(?:true|yes|tak|1|installed|zamontowany|zainstalowany)$/.test(text)) return true;
  if (/^(?:false|no|nie|0|not installed|brak)$/.test(text)) return false;
  return null;
}

function normalizeSaleType(value) {
  const type = normalizeText(value);
  if (/aukcj|auction|licytac/.test(type)) return "auction";
  if (/fixed|stala cena|kup teraz|buy now/.test(type)) return "fixed_price";
  return null;
}

export function classifyGenericCard(listing, card, task, checkedAt) {
  const sourceData = sourceDataFor(listing, card);
  const body = `${card.title} ${card.bodyText}`;
  const availabilityField = normalizedField(card.fields, [/^availability$/, /^status$/]);
  const soldField = normalizedField(card.fields, [/^issold$/, /^sold$/]);
  const sourceAvailability = normalizeText(firstText(sourceData.availability, availabilityField?.value));
  const sold = explicitBoolean(sourceData.isSold) ?? explicitBoolean(soldField?.value);
  const closed = sold === true || /outofstock|sold|sprzedan/.test(sourceAvailability) ||
    /\b(?:sprzedane|sprzedany|ogłoszenie nieaktualne|oferta nieaktualna|pojazd niedostępny|oferta zakończona|zarezerwowane)\b/i.test(body);
  if (closed) return { status: "closed", note: "Karta zawiera informację o zakończeniu lub niedostępności oferty." };
  const structured = Array.isArray(card.structuredData) ? card.structuredData : card.structuredData ? [card.structuredData] : [];
  const structuredVehicle = structured.find((item) => item?.name && normalizeText(card.title).includes(normalizeText(item.name))) ??
    structured.find((item) => {
      const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
      return types.some((type) => /^(?:Vehicle|Car|Product)$/i.test(String(type)));
    }) ??
    (structured.length === 1 ? structured[0] : null);
  const structuredOffer = structuredOffers(structuredVehicle)[0] ?? {};
  const sellerData = structuredSeller(structuredVehicle);
  const yearEvidence = normalizedField(card.fields, [/rokprodukcji/, /^productiondate$/, /^productionyear$/, /^year$/])?.value ??
    sourceData.productionYear ?? sourceData.year ?? structuredVehicle?.productionDate ?? structuredVehicle?.vehicleModelDate;
  const mileageEvidence = normalizedField(card.fields, [/przebieg/, /^mileagefromodometer$/, /^mileage$/, /^odometer$/])?.value ??
    sourceData.mileage ?? sourceData.mileageKm ?? sourceData.mileageFromOdometer ??
    (structuredVehicle?.mileageFromOdometer != null ? scalarText(structuredVehicle.mileageFromOdometer) : "");
  if (isClearlyNonVehicleTitle(card.title || listing.title,
    yearValue(yearEvidence) !== null && numericValue(scalarText(mileageEvidence)) !== null)) {
    return { status: "rejected", note: "Tytuł wskazuje część lub akcesorium, nie kompletny samochód." };
  }
  const inStock = structuredOffers(structuredVehicle).some((offer) => /(?:^|\/)InStock$/i.test(String(offer.availability ?? ""))) ||
    /instock|available/.test(sourceAvailability);
  const activeContact = (card.ctas ?? []).length > 0;
  if (!inStock && !activeContact) return { status: "unverified", note: "Karta nie ujawnia jednoznacznego sygnału aktywnej sprzedaży." };
  const modelMatches = modelNameMatches({ title: [card.title, structuredVehicle?.name,
    structuredVehicle?.brand?.name, structuredVehicle?.brand, structuredVehicle?.model?.name,
    structuredVehicle?.model, sourceData.brand, sourceData.model].filter(Boolean).join(" "), visibleText: "" }, task);
  if (!modelMatches) return { status: "unverified", note: "Nie potwierdzono marki i modelu na karcie." };

  const yearField = normalizedField(card.fields, [/rokprodukcji/, /^productiondate$/, /^productionyear$/, /^year$/]);
  const mileageField = normalizedField(card.fields, [/przebieg/, /^mileagefromodometer$/, /^mileage$/, /^odometer$/]);
  const priceField = normalizedField(card.fields, [/cenabrutto/, /^cenazakupu$/, /^cenacalkowita$/, /^totalprice$/,
    /^pricegross$/, /^price$/]);
  const priceBasisField = normalizedField(card.fields, [/^pricebasis$/, /^pricetype$/]);
  const priceCurrencyField = normalizedField(card.fields, [/^pricecurrency$/, /^currency$/]);
  const priceBasisText = firstText(sourceData.priceBasis, priceBasisField?.value, structuredOffer.priceBasis,
    structuredOffer.priceSpecification?.priceType);
  const offerPrice = (offer) => moneyValue(offer.price?.value ?? offer.price?.amount?.value ?? offer.price);
  const structuredPriceValues = [...new Set(structuredOffers(structuredVehicle)
    .filter((offer) => normalizeText(firstText(offer.priceCurrency, offer.price?.currency, sourceData.priceCurrency,
      priceCurrencyField?.value)) === "pln" && offerPrice(offer) > 0)
    .map(offerPrice))];
  const year = yearValue(yearField?.value ?? sourceData.productionYear ?? sourceData.year ??
    structuredVehicle?.productionDate ?? structuredVehicle?.vehicleModelDate);
  const rawMileage = mileageField?.value ?? sourceData.mileage ?? sourceData.mileageKm ?? sourceData.mileageFromOdometer ??
    structuredVehicle?.mileageFromOdometer?.value ?? structuredVehicle?.mileageFromOdometer;
  const mileageUnitField = normalizedField(card.fields, [/^mileageunit$/, /^odometerunit$/]);
  const mileageUnit = normalizeText(firstText(sourceData.mileageUnit, mileageUnitField?.value, structuredVehicle?.mileageUnit,
    structuredVehicle?.mileageFromOdometer?.unitText, structuredVehicle?.mileageFromOdometer?.unitCode));
  const mileageValue = numericValue(scalarText(rawMileage));
  const mileage = mileageValue === null ? null : /mile|mi\b/.test(mileageUnit)
    ? Math.round(mileageValue * 1.609344) : mileageValue;
  const priceText = String(card.salePanel?.price || priceField?.value || "");
  const amountMatch = priceText.match(/(\d[\d\s\u00a0.,]*\d|\d+)\s*(?:zł|pln)?/i);
  const structuredPrice = structuredPriceValues.length === 1 ? structuredPriceValues[0] : null;
  const rawSourcePrice = sourceData.price?.value ?? sourceData.price?.amount?.value ?? sourceData.price ??
    sourceData.priceCash ?? sourceData.apiPriceAmount ?? listing.apiPriceAmount;
  const price = moneyValue(amountMatch?.[1]) ?? structuredPrice ?? moneyValue(rawSourcePrice);
  const priceLabel = firstText(card.salePanel?.terms, priceField?.label, sourceData.priceLabel,
    structuredOffer.priceSpecification?.description);
  const priceInfoText = normalizeText([priceLabel, priceText, sourceData.priceBasis, sourceData.priceType,
    priceBasisField?.value, structuredOffer.priceBasis, structuredOffer.priceSpecification?.priceType].filter(Boolean).join(" "));
  const explicitlyNet = /netto|\bnet\b/.test(priceInfoText);
  const explicitlyGross = /brutto|\bgross\b/.test(priceInfoText);
  const sourcePriceBasis = normalizeText(priceBasisText);
  const gross = !explicitlyNet && (sourcePriceBasis === "gross_total" || sourcePriceBasis === "gross" || explicitlyGross ||
    (Boolean(amountMatch) && !/rat[ayę]|miesi|finansowan|leasing/i.test(`${priceLabel} ${priceText}`) &&
      !/(?:wyłącznie|tylko|pod warunkiem).{0,40}(?:finansowan|leasing|kredyt)/i.test(body)));
  const priceBasis = price === null ? null : gross ? "gross_total" : explicitlyNet || sourcePriceBasis === "net" ? "net" : "unknown";
  const saleTypeField = normalizedField(card.fields, [/^saletype$/, /^transactiontype$/]);
  const explicitSaleType = normalizeSaleType(firstText(sourceData.saleType, sourceData.transactionType, saleTypeField?.value,
    structuredOffer.saleType, structuredOffer.priceSpecification?.priceType));
  const auctionText = `${card.salePanel?.terms ?? ""} ${body}`;
  if (explicitSaleType === "auction" || card.salePanel?.auctionAction || /aukcj|licytacj|auction/i.test(auctionText)) {
    return { status: "rejected", note: "Karta zawiera sygnał aukcyjnego trybu sprzedaży." };
  }
  const fuelField = normalizedField(card.fields, [/fueltype/, /^paliwo$/, /^typpaliwa$/, /^rodzajpaliwa$/]);
  const fuelText = firstText(fuelField?.value, sourceData.fuelType, sourceData.fuel, sourceData.fuelTitle,
    sourceData.alternativeFuelTitle, structuredVehicle?.fuelType);
  const lpgMention = /benzyna\s*(?:\+|i|\/)?\s*lpg|\blpg\b|^gaz$/i.test(fuelText) ||
    /(?:benzyna\s*\+\s*lpg|lpg (?:zamontowane|zainstalowane|założone)|(?:posiada|z) instalacj[ęa] lpg)/i.test(body);
  const explicitNoLpg = /bez (?:instalacji )?lpg|lpg nie (?:ma|było montowane)/i.test(body);
  const lpgField = normalizedField(card.fields, [/^lpginstalled$/, /^instalacjalpg$/, /^lpg$/]);
  const sourceLpgInstalled = explicitBoolean(sourceData.lpgInstalled) ?? explicitBoolean(structuredVehicle?.lpgInstalled) ??
    explicitBoolean(lpgField?.value);
  const lpgInstalled = typeof sourceLpgInstalled === "boolean" ? sourceLpgInstalled
    : lpgMention === explicitNoLpg ? null : lpgMention;
  const location = locationFrom(sourceData, card.fields, structuredVehicle, checkedAt);
  const bodyField = normalizedField(card.fields, [/nadwozie/, /^bodytype$/]);
  const bodyTextValue = firstText(bodyField?.value, sourceData.bodyType, sourceData.body, sourceData.bodyTitle,
    sourceData.bodyCode, structuredVehicle?.bodyType);
  const bodyCode = normalizedBody(bodyTextValue, task.searchProfile?.sourceMapping?.bodyAliases);
  const transmissionField = normalizedField(card.fields, [/skrzyniabiegow/, /^transmission$/, /^gearbox$/]);
  const transmissionText = firstText(transmissionField?.value, sourceData.transmission, sourceData.gearboxTitle,
    sourceData.gearbox, structuredVehicle?.vehicleTransmission);
  const transmissionNormalized = normalizeText(transmissionText);
  const transmissionCode = sourceData.transmissionCode === "manual" || sourceData.transmissionCode === "automatic"
    ? sourceData.transmissionCode
    : /automat|automatic|dsg|cvt|tiptronic|xtronic/.test(transmissionNormalized) ? "automatic"
      : /manual|mechanic|mechani/.test(transmissionNormalized) ? "manual" : null;
  const engineField = normalizedField(card.fields, [/^silnik$/, /^wersjasilnika$/, /^engine$/, /^vehicleengine$/]);
  const structuredEngineValue = structuredVehicle?.vehicleEngine ?? structuredVehicle?.engine;
  const structuredEngine = Array.isArray(structuredEngineValue) ? structuredEngineValue[0] : structuredEngineValue;
  const engineText = firstText(engineField?.value, sourceData.engine, sourceData.engineTitle, sourceData.engineDescription,
    sourceData.engineVariant, structuredEngine);
  const engineAliases = task.searchProfile.queryPlan?.engineAliases ?? [];
  const directEngineVariant = firstText(sourceData.engineVariant);
  const engineMatches = new Set();
  if (engineAliases.some((item) => item.engineVariant === directEngineVariant)) engineMatches.add(directEngineVariant);
  else {
    const engineKey = (value) => normalizeText(value).replace(/[^a-z0-9]/g, "");
    for (const item of engineAliases) {
      if ((item.aliases ?? []).some((alias) => engineKey(engineText).includes(engineKey(alias)))) engineMatches.add(item.engineVariant);
    }
  }
  const engineVariant = engineMatches.size === 1 ? [...engineMatches][0] : null;
  const vinField = normalizedField(card.fields, [/^vin$/, /^vehicleidentificationnumber$/]);
  const rawVin = firstText(vinField?.value, sourceData.vin, structuredVehicle?.vin,
    structuredVehicle?.vehicleIdentificationNumber).match(/\b[A-HJ-NPR-Z0-9]{17}\b/i)?.[0];
  const vin = String(rawVin ?? "").toUpperCase();
  const validVin = /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
  const sellerField = normalizedField(card.fields, [/^sprzedawca$/, /^seller$/, /^sellertype$/]);
  const sellerNameField = normalizedField(card.fields, [/^nazwasprzedawcy$/, /^sellername$/, /^dealername$/]);
  const sellerText = firstText(sellerField?.value, sourceData.sellerType, sourceData.sellerCategory);
  const sellerIdentityField = sellerField && normalizeText(sellerField.label).replace(/[^a-z0-9]/g, "") !== "sellertype"
    ? sellerField.value : "";
  const offerType = normalizeOfferType(firstText(sourceData.offerType, sellerText,
    sellerData.businessType, sellerData.sellerType, sellerData.type)) ?? "unknown";
  const saleType = explicitSaleType ?? normalizeSaleType(structuredOffers(structuredVehicle)[0]?.saleType) ??
    (gross && price !== null ? "fixed_price" : null);
  const publicationField = normalizedField(card.fields, FACT_DATE_KEYS.map((key) => new RegExp(`^${key}$`, "i")));
  const publicationDate = dateValue(firstText(sourceData.publicationDate, sourceData.datePublished, sourceData.datePosted,
    sourceData.publishedAt, sourceData.publishedDate, publicationField?.value,
    structuredVehicle?.publicationDate, structuredVehicle?.datePublished, structuredVehicle?.datePosted));
  const firstRegistrationDate = dateValue(firstText(sourceData.firstRegistrationDate,
    normalizedField(card.fields, [/^firstregistrationdate$/, /^datefirstregistered$/, /^datarejestracji$/])?.value,
    structuredVehicle?.firstRegistrationDate, structuredVehicle?.dateFirstRegistered));
  const measurementText = (value) => {
    if (value && typeof value === "object") {
      return [scalarText(value.value ?? value.amount), scalarText(value.unitText ?? value.unitCode ?? value.unit ?? value.unitCodeValue)]
        .filter(Boolean).join(" ");
    }
    return scalarText(value);
  };
  const engineCapacityField = normalizedField(card.fields, [/^pojemnosc(?:silnika)?$/, /^enginecapacity$/, /^enginesize$/, /^enginedisplacement$/]);
  const enginePowerField = normalizedField(card.fields, [/^moc(?:silnika)?$/, /^enginepower$/, /^horsepower$/, /^power$/]);
  const engineCapacity = firstText(sourceData.engineCapacity, sourceData.engineSize, engineCapacityField?.value,
    measurementText(structuredEngine?.engineDisplacement ?? structuredEngine?.engineCapacity ?? structuredVehicle?.engineDisplacement));
  const enginePower = firstText(sourceData.enginePower, sourceData.enginePowerHp, sourceData.enginePowerKw, enginePowerField?.value,
    measurementText(structuredEngine?.enginePower ?? structuredEngine?.power ?? structuredVehicle?.enginePower));
  const generation = firstText(sourceData.modelGeneration, sourceData.generation,
    normalizedField(card.fields, [/^generacja$/, /^generation$/])?.value,
    structuredVehicle?.model?.generation, structuredVehicle?.generation);
  const details = Object.fromEntries(Object.entries({
    fuelType: fuelText,
    engineCapacity,
    enginePower,
    generation,
    firstRegistrationDate: firstRegistrationDate ?? "",
    priceCurrency: firstText(sourceData.priceCurrency, priceCurrencyField?.value, structuredOffer.priceCurrency,
      structuredOffer.price?.currency),
    sellerType: firstText(sourceData.sellerType, sellerField?.value, sellerData.businessType, sellerData.sellerType, sellerData.type),
  }).filter(([, value]) => value));
  const photos = [...new Set([...sourceData.photos, ...structuredPhotoUrls(structuredVehicle?.image)])].slice(0, 12);
  const recordId = firstText(sourceData.listingId, sourceData.recordId, sourceData.id,
    listing.sourceFields?.listingId, listing.sourceFields?.recordId, listing.sourceData?.listingId,
    listing.sourceData?.recordId, structuredVehicle?.identifier, structuredVehicle?.sku);
  const listingIds = recordId && /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/.test(recordId) ? [recordId] : [];
  const sellerName = firstText(sourceData.sellerName, sourceData.dealerName,
    typeof sourceData.seller === "string" ? sourceData.seller : sourceData.seller?.name,
    sellerNameField?.value, sellerData.name, sellerIdentityField);
  const evidenceFields = [
    "title", ...(price !== null ? ["price"] : []), ...(year !== null ? ["year"] : []),
    ...(mileage !== null ? ["mileage"] : []), ...(priceBasis && priceBasis !== "unknown" ? ["priceBasis"] : []),
    ...(validVin ? ["vin"] : []), ...(engineText ? ["engine"] : []), ...(engineVariant ? ["engineVariant"] : []),
    ...(bodyTextValue ? ["body"] : []), ...(bodyCode ? ["bodyCode"] : []),
    ...(transmissionText ? ["transmission"] : []), ...(transmissionCode ? ["transmissionCode"] : []),
    ...(fuelText ? ["fuelType"] : []), ...(lpgInstalled !== null ? ["lpgInstalled"] : []),
    ...(saleType ? ["saleType"] : []), ...(location.city ? ["location"] : []),
    ...(publicationDate ? ["publicationDate"] : []), ...(firstRegistrationDate ? ["firstRegistrationDate"] : []),
    ...(offerType !== "unknown" ? ["offerType"] : []),
  ];
  const offer = {
    id: validVin ? `vin:${vin}` : `url:${listing.url}`, modelKey: task.modelKey,
    title: card.title || listing.title, urls: [{ url: listing.url }],
    ...(listingIds.length ? { listingIds } : {}),
    ...(price !== null ? { price, ...(priceBasis !== "unknown" ? { priceBasis } : {}) } : {}), ...(priceLabel ? { priceLabel } : {}),
    ...(year !== null ? { year } : {}), ...(mileage !== null ? { mileage } : {}),
    ...(bodyTextValue ? { body: bodyTextValue } : {}), ...(bodyCode ? { bodyCode } : {}),
    ...(engineText ? { engine: engineText } : {}), ...(engineVariant ? { engineVariant } : {}),
    ...(transmissionText ? { transmission: transmissionText } : {}), ...(transmissionCode ? { transmissionCode } : {}),
    ...(validVin ? { vin } : {}), ...(publicationDate ? { publicationDate } : {}),
    ...(firstRegistrationDate ? { firstRegistrationDate } : {}), ...(sellerName ? { seller: sellerName } : {}),
    ...(Object.keys(details).length ? { details } : {}), ...(photos.length ? { photos } : {}),
    ...(offerType !== "unknown" ? { offerType } : {}), saleType, lpgInstalled, location,
    observation: { url: listing.url, checkedAt, availability: "available",
      note: inStock ? "Dane pojazdu na karcie zawierają status InStock." : `W treści karty widoczny przycisk kontaktu: ${(card.ctas ?? []).join(", ")}.`,
      evidence: [{ kind: "seller", url: listing.url, checkedAt,
        fields: [...new Set(evidenceFields)],
        note: "Odczytano dostępne wartości z danych JSON i renderowanej karty; brakujące pola pozostają nieznane." }] },
  };
  return { status: "available", offer };
}
