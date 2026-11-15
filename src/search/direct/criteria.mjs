import { normalizeText } from "../shared/portal-screening.mjs";

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

export function engineAliasesForModel(model, knowledge) {
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
  for (const claim of knowledge?.engineClaims ?? []) {
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

export function profileForModel(model, sourceId, engineAliases = []) {
  const requirements = model.requirements ?? {};
  const purchase = requirements.purchase ?? {};
  const mileage = requirements.mileage ?? {};
  const bodyCodes = (model.bodies ?? []).map((body) => ({ wagon: "wagon", combi: "wagon", sedan: "sedan",
    hatchback: "hatchback", suv: "suv", crossover: "crossover", minivan: "minivan" })[String(body).toLowerCase()] ?? body);
  const screeningLimits = {
    minimumAdvertisedPricePln: purchase.minimumAdvertisedPricePln ?? 0,
    productionYearMin: requirements.yearMin ?? model.searchYears?.min ?? 1900,
    productionYearMax: requirements.yearMax ?? model.searchYears?.max ?? 2100,
    hardMileageKmMax: mileage.hardMaxKm ?? Number.MAX_SAFE_INTEGER,
    bodyCodes,
    auctionsAllowed: purchase.auctionsAllowed ?? false,
  };
  return {
    modelKey: model.key,
    searchProfile: {
      queryPlan: { nativeFilters: { make: model.brand, model: model.model }, manualFilters: { make: model.brand, model: model.model },
        engineAliases },
      sourceMapping: model.sourceMappings?.[sourceId] ?? {},
      candidateScreening: { screeningLimits },
    },
  };
}

export function requireConfiguredCriteria(classification, model, extraction = null) {
  if (classification.status === "closed" || classification.status === "rejected") return classification;
  const requirements = model.requirements ?? {};
  const purchase = requirements.purchase ?? {};
  const mileage = requirements.mileage ?? {};
  const yearMin = requirements.yearMin ?? model.searchYears?.min ?? null;
  const yearMax = requirements.yearMax ?? model.searchYears?.max ?? null;
  const allowedEngines = model.allowedEngineVariants ?? [];
  const requiredAliases = { pricePln: "price", productionYear: "year", modelYear: "year", mileageKm: "mileage",
    vehicleTransmission: "transmission", gearbox: "transmission", bodyType: "body", fuelType: "fuel",
    firstRegistration: "firstRegistrationDate" };
  const required = new Set((model.fieldPolicy?.required ?? ["price", "year", "mileage", "engineVariant"])
    .map((field) => requiredAliases[field] ?? field));
  const unresolved = (extraction?.unresolvedRequired ?? []).filter((field) => required.has(field));
  if (unresolved.length) {
    const labels = { price: "cena", year: "rocznik", mileage: "przebieg", engineVariant: "wariant silnika" };
    const reasons = unresolved.map((field) => {
      const values = extraction?.conflicts?.[field];
      const label = labels[field] ?? field;
      return values?.length ? `${label}: sprzeczne odczyty (${values.join(" / ")})` : `${label}: brak potwierdzonej wartości`;
    });
    return { status: "rejected", note: `Po sprawdzeniu pól adaptera, karty, JSON-LD i tekstu ogłoszenia nie można potwierdzić wymaganych danych: ${reasons.join("; ")}.` };
  }
  const extractedFacts = extraction?.facts ?? {};
  const offer = { ...(classification.offer ?? {}) };
  for (const field of ["price", "year", "mileage", "engineVariant"]) {
    if (extractedFacts[field] !== undefined && !extraction?.conflicts?.[field]) offer[field] = extractedFacts[field];
  }
  const fail = (field, note) => ({ status: "rejected", note: `Brak spełnionego wymaganego pola ${field}: ${note}` });

  if (required.has("price")) {
    if (!Number.isFinite(offer.price)) return fail("cena", "nie odczytano kwoty.");
    const minimum = purchase.minimumAdvertisedPricePln;
    const maximum = purchase.maxAdvertisedPricePln ?? purchase.maxPriceGrossPln;
    if (Number.isFinite(minimum) && offer.price < minimum) return fail("cena", "jest poniżej minimum modelu.");
    if (Number.isFinite(maximum) && offer.price > maximum) return fail("cena", "przekracza maksimum modelu.");
  }
  if (required.has("year")) {
    if (!Number.isInteger(offer.year)) return fail("rocznik", "nie odczytano roku produkcji.");
    if (Number.isFinite(yearMin) && offer.year < yearMin) return fail("rocznik", "jest poniżej minimum modelu.");
    if (Number.isFinite(yearMax) && offer.year > yearMax) return fail("rocznik", "przekracza maksimum modelu.");
  }
  if (required.has("mileage")) {
    if (!Number.isFinite(offer.mileage)) return fail("przebieg", "nie odczytano przebiegu.");
    const maximum = mileage.hardMaxKm;
    if (Number.isFinite(maximum) && offer.mileage > maximum) return fail("przebieg", "przekracza limit modelu.");
  }
  if (required.has("engineVariant")) {
    if (!offer.engineVariant || !allowedEngines.includes(offer.engineVariant)) {
      return fail("silnik", "nie potwierdzono jednego dozwolonego wariantu.");
    }
  }
  const supported = new Set(["price", "year", "mileage", "engineVariant"]);
  for (const field of required) {
    if (supported.has(field)) continue;
    const value = extractedFacts[field] ?? offer[field] ??
      (field === "fuel" ? offer.details?.fuelType : undefined);
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
      return fail(field, "nie odczytano wartości.");
    }
  }
  return classification.status === "available" && classification.offer
    ? { ...classification, offer }
    : classification;
}
