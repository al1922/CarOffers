// Pure search-result screening helpers shared by the generic portal adapter.
export function normalizeText(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pl-PL");
}

export function extractVisibleFields(text, sourceId) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  const productionYear = value.match(/(?:rok produkcji|produkcja)\s*[:\-]?\s*((?:19|20)\d{2})/i)?.[1];
  const firstRegistration = value.match(/(?:pierwsza rejestracja|data pierwszej rejestracji|rok rejestracji)\s*[:\-]?\s*((?:19|20)\d{2})/i)?.[1];
  const mileageMatch = value.match(/\b(?:przebieg\s*[:\-]?\s*)?(\d{1,3}(?:[\s\u00a0.,]\d{3})+|\d{4,6})\s*km\b/i);
  const pricePattern = /(?:\d{1,3}(?:[\s\u00a0.,]\d{3})+|\d{4,7})\s*(?:zł|PLN)/i;
  const priceMatch = sourceId === "automarket"
    ? value.split(/\bZakup:\s*/i)[1]?.match(new RegExp(`^${pricePattern.source}`, "i"))
    : value.match(pricePattern);
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

export function screeningFailure(listing, task) {
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

export function modelNameMatches(listing, task) {
  const plan = task.searchProfile.queryPlan ?? {};
  const model = String(plan.nativeFilters?.model ?? plan.manualFilters?.model ?? "").toLocaleLowerCase("pl-PL");
  const brand = String(plan.nativeFilters?.make ?? plan.manualFilters?.make ?? "").toLocaleLowerCase("pl-PL");
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

export function explicitModelMismatch(listing, task, knownModels) {
  const plan = task.searchProfile.queryPlan ?? {};
  const targetMake = plan.nativeFilters?.make ?? plan.manualFilters?.make ?? "";
  const targetModel = plan.nativeFilters?.model ?? plan.manualFilters?.model ?? "";
  if (!targetMake || !targetModel) return false;
  const text = normalizeText(`${listing.title} ${listing.visibleText}`).replace(/[^a-z0-9]+/g, " ").trim();
  const targetModelKey = normalizeText(targetModel).replace(/[^a-z0-9]+/g, " ").trim();
  const makeAliases = { volkswagen: ["volkswagen", "vw"], skoda: ["skoda", "škoda"] };
  const targetMakeAliases = (makeAliases[normalizeText(targetMake)] ?? [targetMake]).map((value) =>
    normalizeText(value).replace(/[^a-z0-9]+/g, " ").trim());
  const visibleMakes = new Set(knownModels.map((model) => model.brand).filter(Boolean).map((brand) =>
    normalizeText(brand).replace(/[^a-z0-9]+/g, " ").trim()).filter((brand) => brand && text.includes(brand)));
  if (visibleMakes.size && !targetMakeAliases.some((alias) => text.includes(alias))) return true;
  if (!targetMakeAliases.some((alias) => text.includes(alias))) return false;
  const sameMake = knownModels.filter((model) => normalizeText(model.brand) === normalizeText(targetMake));
  const otherModel = sameMake.map((model) => ({ key: normalizeText(model.model).replace(/[^a-z0-9]+/g, " ").trim(), name: model.model }))
    .filter((model) => model.key && model.key !== targetModelKey && text.includes(model.key))
    .sort((left, right) => right.key.length - left.key.length)[0];
  return Boolean(otherModel && !text.includes(targetModelKey));
}
