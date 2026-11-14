import { isClearlyNonVehicleTitle, modelNameMatches, normalizeText } from "./portal-screening.mjs";

function normalizedField(fields, patterns) {
  const entry = Object.entries(fields ?? {}).find(([key]) => patterns.some((pattern) =>
    pattern.test(normalizeText(key).replace(/[^a-z0-9]/g, ""))));
  return entry ? { label: entry[0], value: entry[1] } : null;
}

function numericValue(value) {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

export function classifyGenericCard(listing, card, task, checkedAt) {
  const body = `${card.title} ${card.bodyText}`;
  const closed = /\b(?:sprzedane|sprzedany|ogłoszenie nieaktualne|oferta nieaktualna|pojazd niedostępny|oferta zakończona|zarezerwowane)\b/i.test(body);
  if (closed) return { status: "closed", note: "Karta zawiera informację o zakończeniu lub niedostępności oferty." };
  const structured = card.structuredData ?? [];
  const structuredVehicle = structured.find((item) => item.name && normalizeText(card.title).includes(normalizeText(item.name))) ??
    (structured.length === 1 ? structured[0] : null);
  const yearEvidence = normalizedField(card.fields, [/rokprodukcji/, /^productiondate$/, /^productionyear$/])?.value ??
    structuredVehicle?.productionDate;
  const mileageEvidence = normalizedField(card.fields, [/przebieg/, /^mileagefromodometer$/, /^mileage$/])?.value ??
    (structuredVehicle?.mileageFromOdometer != null ? String(structuredVehicle.mileageFromOdometer) : "");
  if (isClearlyNonVehicleTitle(card.title || listing.title,
    /\b(?:19|20)\d{2}\b/.test(String(yearEvidence ?? "")) && numericValue(mileageEvidence) !== null)) {
    return { status: "rejected", note: "Tytuł wskazuje część lub akcesorium, nie kompletny samochód." };
  }
  const inStock = (structuredVehicle?.offers ?? []).some((offer) => /(?:^|\/)InStock$/i.test(String(offer.availability ?? "")));
  const activeContact = (card.ctas ?? []).length > 0;
  if (!inStock && !activeContact) return { status: "unverified", note: "Karta nie ujawnia jednoznacznego sygnału aktywnej sprzedaży." };
  const modelMatches = modelNameMatches({ title: [card.title, structuredVehicle?.name,
    structuredVehicle?.brand, structuredVehicle?.model].filter(Boolean).join(" "), visibleText: "" }, task);
  if (!modelMatches) return { status: "unverified", note: "Nie potwierdzono marki i modelu na karcie." };

  const yearField = normalizedField(card.fields, [/rokprodukcji/, /^productiondate$/, /^productionyear$/]);
  const mileageField = normalizedField(card.fields, [/przebieg/, /^mileagefromodometer$/, /^mileage$/]);
  const priceField = normalizedField(card.fields, [/cenabrutto/, /^cenazakupu$/, /^cenacalkowita$/, /^totalprice$/, /^pricegross$/]);
  const structuredPriceValues = [...new Set((structuredVehicle?.offers ?? [])
    .filter((offer) => String(offer.priceCurrency ?? "").toUpperCase() === "PLN" && Number(offer.price) > 0)
    .map((offer) => Number(offer.price)))];
  const yearMatch = yearField?.value.match(/\b(?:19|20)\d{2}\b/) ?? String(structuredVehicle?.productionDate ?? "").match(/\b(?:19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : null;
  const structuredMileage = /^(?:KMT|KM|KILOMETER|KILOMETRE)$/i.test(String(structuredVehicle?.mileageUnit ?? ""))
    ? numericValue(structuredVehicle?.mileageFromOdometer) : null;
  const mileage = numericValue(mileageField?.value.match(/[\d\s.,]+/)?.[0]) ?? structuredMileage;
  const priceText = String(card.salePanel?.price || priceField?.value || "");
  const amountMatch = priceText.match(/(\d[\d\s\u00a0.,]*\d|\d+)\s*(?:zł|pln)?/i);
  const price = amountMatch ? numericValue(amountMatch[1]) : structuredPriceValues.length === 1 ? structuredPriceValues[0] : null;
  const explicitlyNet = /netto|\bnet\b/i.test(priceText);
  const priceLabel = card.salePanel?.price ? card.salePanel.terms : priceField?.label;
  const gross = Boolean(amountMatch) && /brutto|gross/i.test([priceLabel, priceText].join(" ")) &&
    !explicitlyNet && !/rat[ayę]|miesi|finansowan|leasing/i.test(`${priceField?.label ?? ""} ${priceText}`) &&
    (task.sourceId !== "automarket" || /zakup|gotówk/i.test(`${priceField?.label ?? ""} ${priceText}`)) &&
    !/(?:wyłącznie|tylko|pod warunkiem).{0,40}(?:finansowan|leasing|kredyt)/i.test(body);
  const limits = task.searchProfile.candidateScreening?.screeningLimits ?? {};
  if (year !== null && (year < limits.productionYearMin || year > limits.productionYearMax)) return { status: "rejected", note: "Rok produkcji z karty jest poza zakresem." };
  if (mileage !== null && mileage > limits.hardMileageKmMax) return { status: "rejected", note: "Przebieg z karty przekracza limit." };
  const auctionText = task.sourceId === "allegro-lokalnie" ? (card.salePanel?.terms ?? "") : body;
  if (card.salePanel?.auctionAction || /aukcj|licytacj|auction/i.test(auctionText)) return { status: "rejected", note: "Karta zawiera sygnał aukcyjnego trybu sprzedaży." };
  if (gross && price !== null && price > limits.basePurchaseGrossPlnMax) return { status: "price_review", note: "Cena brutto przekracza limit i wymaga decyzji użytkownika." };

  const fieldPairs = [["year", year], ["mileage", mileage], ["price", price], ["priceBasis", gross ? "gross_total" : null]];
  const evidenceFields = fieldPairs.filter(([, value]) => value !== null && value !== undefined).map(([key]) => key);
  const lpgField = normalizedField(card.fields, [/fueltype/, /^paliwo$/, /^rodzajpaliwa$/]);
  const fuelText = `${lpgField?.value ?? ""} ${structuredVehicle?.fuelType ?? ""}`.trim();
  const lpgMention = /benzyna\s*\+\s*lpg|^lpg$|^gaz$/i.test(fuelText) ||
    /(?:benzyna\s*\+\s*lpg|lpg (?:zamontowane|zainstalowane|założone)|(?:posiada|z) instalacj[ęa] lpg)/i.test(body);
  const explicitNoLpg = /bez (?:instalacji )?lpg|lpg nie (?:ma|było montowane)/i.test(body);
  const lpgInstalled = lpgMention === explicitNoLpg ? null : lpgMention;
  const locationField = normalizedField(card.fields, [/lokalizacja/, /^miasto$/, /^location$/, /^addresslocality$/]);
  const city = locationField?.value.match(/^([^,(]+?)(?:\s*[,|(].*)?$/)?.[1]?.trim() || null;
  const regionField = normalizedField(card.fields, [/wojewodztwo/, /^addressregion$/]);
  const regionText = regionField?.value ?? locationField?.value.match(/[,(]\s*([^,)]+)\)?\s*$/)?.[1] ?? "";
  const regionNames = new Map([["dolnoslaskie", "Dolnośląskie"], ["kujawsko-pomorskie", "Kujawsko-Pomorskie"],
    ["lubelskie", "Lubelskie"], ["lubuskie", "Lubuskie"], ["lodzkie", "Łódzkie"], ["malopolskie", "Małopolskie"],
    ["mazowieckie", "Mazowieckie"], ["opolskie", "Opolskie"], ["podkarpackie", "Podkarpackie"],
    ["podlaskie", "Podlaskie"], ["pomorskie", "Pomorskie"], ["slaskie", "Śląskie"],
    ["swietokrzyskie", "Świętokrzyskie"], ["warminsko-mazurskie", "Warmińsko-Mazurskie"],
    ["wielkopolskie", "Wielkopolskie"], ["zachodniopomorskie", "Zachodniopomorskie"]]);
  const regionKey = normalizeText(regionText).replace(/[^a-z-]/g, "");
  const voivodeship = [...regionNames].find(([key]) => regionKey.includes(key))?.[1] ?? null;
  const vinField = normalizedField(card.fields, [/^vin$/, /^vehicleidentificationnumber$/]);
  const rawVin = vinField?.value.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i)?.[0] ?? structuredVehicle?.vin;
  const vin = String(rawVin ?? "").toUpperCase();
  const validVin = /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
  const engineField = normalizedField(card.fields, [/^silnik$/, /^wersjasilnika$/, /^engine$/]);
  const engineText = `${card.title} ${engineField?.value ?? ""} ${structuredVehicle?.vehicleEngine ?? ""}`;
  const engineKey = (value) => normalizeText(value).replace(/[^a-z0-9]/g, "");
  const engineMatches = new Set();
  for (const item of task.searchProfile.queryPlan?.engineAliases ?? []) {
    if ((item.aliases ?? []).some((alias) => engineKey(engineText).includes(engineKey(alias)))) engineMatches.add(item.engineVariant);
  }
  const engineVariant = engineMatches.size === 1 ? [...engineMatches][0] : null;
  const bodyField = normalizedField(card.fields, [/nadwozie/, /^bodytype$/]);
  const bodyRaw = normalizeText(bodyField?.value ?? structuredVehicle?.bodyType ?? "");
  const bodyCode = bodyRaw.includes("kombi") || bodyRaw.includes("wagon") ? "wagon"
    : bodyRaw.includes("sedan") ? "sedan" : bodyRaw.includes("hatchback") ? "hatchback"
      : bodyRaw.includes("suv") ? "suv" : bodyRaw.includes("crossover") ? "crossover"
        : bodyRaw.includes("minivan") || bodyRaw.includes("minibus") ? "minivan" : null;
  const transmissionField = normalizedField(card.fields, [/skrzyniabiegow/, /^transmission$/]);
  const transmissionText = normalizeText(transmissionField?.value ?? structuredVehicle?.vehicleTransmission ?? "");
  const transmissionCode = /automat|automatic|dsg|cvt|tiptronic|xtronic/.test(transmissionText) ? "automatic"
    : /manual/.test(transmissionText) ? "manual" : null;
  const sellerField = normalizedField(card.fields, [/sprzedawca/, /^seller$/]);
  const sellerText = normalizeText(sellerField?.value ?? "");
  const offerType = /prywatn/.test(sellerText) ? "private" : /dealer|firma|firmow|company/.test(sellerText) ? "company" : "unknown";
  const offer = {
    id: validVin ? `vin:${vin}` : `url:${listing.url}`, modelKey: task.modelKey,
    title: card.title || listing.title, urls: [{ url: listing.url }],
    ...(price !== null ? { price, priceBasis: gross ? "gross_total" : "unknown" } : {}),
    ...(year !== null ? { year } : {}), ...(mileage !== null ? { mileage } : {}),
    ...(bodyCode ? { bodyCode } : {}), ...(engineVariant ? { engineVariant } : {}), ...(transmissionCode ? { transmissionCode } : {}),
    ...(validVin ? { vin } : {}), offerType, saleType: gross && price !== null ? "fixed_price" : null, lpgInstalled,
    ...(card.photos?.length ? { photos: card.photos.slice(0, 12) } : {}),
    location: city && voivodeship ? { status: "available", countryCode: "PL", city, voivodeship,
      precision: "city", source: "listing", checkedAt: checkedAt.slice(0, 10) }
      : { status: "not_provided", ...(city ? { countryCode: "PL", city } : {}) },
    observation: { url: listing.url, checkedAt, availability: "available",
      note: inStock ? "Dane pojazdu na karcie zawierają status InStock." : `W treści karty widoczny przycisk kontaktu: ${(card.ctas ?? []).join(", ")}.`,
      evidence: [{ kind: "seller", url: listing.url, checkedAt,
        fields: [...new Set(["title", ...(gross && price !== null ? ["saleType"] : []), ...evidenceFields, ...(validVin ? ["vin"] : []),
          ...(engineVariant ? ["engineVariant"] : []), ...(bodyCode ? ["bodyCode"] : []), ...(transmissionCode ? ["transmissionCode"] : []),
          ...(lpgInstalled !== null ? ["lpgInstalled"] : []), ...(city ? ["location"] : []),
          ...(offerType !== "unknown" ? ["offerType"] : [])])],
        note: "Odczytano wartości z renderowanej karty portalu; brakujące pola pozostają nieznane." }] },
  };
  return { status: "available", offer };
}
