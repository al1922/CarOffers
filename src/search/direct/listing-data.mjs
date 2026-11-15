import { extractVisibleFields } from "../shared/portal-screening.mjs";

export function apiFields(responses) {
  const fields = {};
  const wanted = /^(?:publicationdate|datepublished|dateposted|publishedat|publisheddate|firstregistrationdate|datefirstregistered|productiondate|productionyear|year|modelgeneration|generation|mileagefromodometer|mileage|mileageunit|odometer|price|pricegross|grossprice|pricebasis|pricetype|pricecurrency|currency|vin|fuel|fueltitle|alternativefueltitle|fuel[_-]?type|fueltype|vehicle[_-]?transmission|vehicletransmission|transmission|gearbox|body[_-]?type|bodytype|bodycode|engine|vehicleengine|enginedisplacement|enginesize|enginecapacity|enginepower|enginepowerhp|enginepowerkw|horsepower|power|address|addresslocality|addressregion|addresscountry|countrycode|postalcode|postcode|latitude|longitude|lat|lng|lon|location|city|region|voivodeship|seller|sellername|sellertype|saletype|transactiontype|offertype|vehiclecondition|carcondition|condition|damagestatus|vehicledamagestatus|cardamagestatus|damaged|isdamaged|vehicleisdamaged|cardamaged|carisdamaged|hasdamage|hasdamages|damage|stanpojazdu|stantechniczny|uszkodzony|uszkodzenia|availability|status|issold|sold|lpginstalled)$/i;
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

export function applyListingApiPrice(classification, listing) {
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
          note: listing.apiEvidence?.priceEvidenceNote ?? "Cenę odczytano ze strukturalnych danych listy; podstawa ceny pozostaje niepotwierdzona.",
        } : item),
      },
    },
  };
}

export function extractDetailEvidence(text) {
  const bodyText = String(text ?? "");
  const visible = extractVisibleFields(bodyText);
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

export function mergeListing(target, item) {
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
    ...((target?.sourceFields || item?.sourceFields || target?.sourceData || item?.sourceData) ? {
      sourceFields: mergeSourceFields(target?.sourceFields ?? target?.sourceData, item?.sourceFields ?? item?.sourceData),
    } : {}),
  };
}

function hasSourceFact(value) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function mergeSourceFields(...sources) {
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

export function mergeListingSources(apiListings, visibleListings) {
  const merged = new Map();
  for (const listing of apiListings) merged.set(listing.url, mergeListing(merged.get(listing.url), { ...listing, apiVisibleText: listing.visibleText }));
  for (const listing of visibleListings) merged.set(listing.url, mergeListing(merged.get(listing.url), listing));
  return [...merged.values()];
}
