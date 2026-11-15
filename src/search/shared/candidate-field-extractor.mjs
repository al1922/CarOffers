import { extractVisibleFields, normalizeText } from "./portal-screening.mjs";
import { FIRST_REGISTRATION_DATE_PATTERN, parseDateOrYear } from "./date-parsing.mjs";

const FIELD_ALIASES = {
  price: ["price", "priceamount", "pricecash", "pricegross", "grossprice", "advertisedprice", "cenabrutto", "cena", "cenazakupu", "cenacalkowita"],
  year: ["productionyear", "productiondate", "vehiclemodeldate", "modelyear", "year", "rokprodukcji", "rok"],
  mileage: ["mileage", "mileagekm", "mileagefromodometer", "odometer", "przebieg"],
  engine: ["engine", "vehicleengine", "enginedescription", "enginetitle", "silnik", "wersjasilnika"],
  engineVariant: ["enginevariant", "wariantsilnika"],
  vin: ["vin", "vehicleidentificationnumber"],
  firstRegistrationDate: ["firstregistrationdate", "datefirstregistered", "firstregistration", "datarejestracji", "pierwszarejestracja"],
  transmission: ["transmission", "vehicletransmission", "gearbox", "skrzyniabiegow"],
  body: ["body", "bodytype", "nadwozie", "typnadwozia"],
  fuel: ["fuel", "fueltype", "fueltitle", "rodzajpaliwa", "paliwo"],
};

const REQUIRED_ALIASES = {
  price: "price",
  pricePln: "price",
  year: "year",
  productionYear: "year",
  modelYear: "year",
  mileage: "mileage",
  mileageKm: "mileage",
  engineVariant: "engineVariant",
  vehicleTransmission: "transmission",
  gearbox: "transmission",
  bodyType: "body",
  fuelType: "fuel",
  firstRegistration: "firstRegistrationDate",
};

function key(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, "");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(value, depth = 0) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (depth > 4 || value == null) return "";
  if (Array.isArray(value)) return value.map((item) => scalar(item, depth + 1)).filter(Boolean).join(" ");
  if (!isRecord(value)) return "";
  for (const name of ["value", "displayValue", "text", "name", "title", "label", "code"]) {
    const text = scalar(value[name], depth + 1);
    if (text) return text;
  }
  return "";
}

function fieldValue(name, value) {
  if (isRecord(value)) {
    if (name === "price") return scalar(value.value ?? value.amount?.value ?? value.amount ?? value.displayValue ?? value.text);
    if (name === "mileage") return [scalar(value.value ?? value.amount), scalar(value.unitText ?? value.unitCode ?? value.unit)].filter(Boolean).join(" ");
    if (name === "year") return scalar(value.value ?? value.date ?? value.displayValue ?? value.text);
  }
  return scalar(value);
}

function numberValue(value) {
  let text = String(value ?? "").replace(/\s|\u00a0/g, "").replace(/[^\d,.-]/g, "");
  if (!text) return null;
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) text = comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  else if (comma >= 0) text = /,\d{1,2}$/.test(text) ? text.replace(",", ".") : text.replace(/,/g, "");
  else if (dot >= 0 && !/\.\d{1,2}$/.test(text)) text = text.replace(/\./g, "");
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFact(name, raw) {
  const text = scalar(raw);
  if (!text) return null;
  if (name === "year") {
    const match = text.match(/\b(?:18|19|20|21)\d{2}\b/);
    return match ? Number(match[0]) : null;
  }
  if (name === "mileage") {
    const amount = numberValue(text);
    if (amount === null) return null;
    return /mile|\bmi\b/i.test(text) ? Math.round(amount * 1.609344) : Math.round(amount);
  }
  if (name === "price") return numberValue(text);
  if (name === "vin") return text.toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/)?.[0] ?? null;
  if (name === "engineVariant") return text.trim();
  if (name === "body") {
    const normalized = normalizeText(text);
    if (/kombi|combi|wagon|estate/.test(normalized)) return "wagon";
    if (/sedan|saloon/.test(normalized)) return "sedan";
    if (/hatchback|hatch/.test(normalized)) return "hatchback";
    if (/suv/.test(normalized)) return "suv";
    if (/crossover/.test(normalized)) return "crossover";
    if (/minivan|minibus/.test(normalized)) return "minivan";
    return text;
  }
  if (name === "transmission") {
    const normalized = normalizeText(text);
    if (/automat|automatic|dsg|cvt|tiptronic|xtronic/.test(normalized)) return "automatic";
    if (/manual|mechanic|mechani/.test(normalized)) return "manual";
    return text;
  }
  if (name === "fuel") {
    const normalized = normalizeText(text);
    if (/benzyna.*lpg|petrol.*lpg|lpg.*benzyna|lpg.*petrol/.test(normalized)) return "petrol + lpg";
    if (/benzyna|petrol/.test(normalized)) return "petrol";
    if (/diesel/.test(normalized)) return "diesel";
    if (/hybryd|hybrid/.test(normalized)) return "hybrid";
    if (/elektry|electric/.test(normalized)) return "electric";
    if (/\blpg\b|gaz/.test(normalized)) return "lpg";
    return text;
  }
  if (name === "firstRegistrationDate") return parseDateOrYear(text);
  return text;
}

function excerpt(text, index = 0, length = 180) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= 240) return value.slice(0, 240);
  const start = Math.max(0, Math.min(index - 70, value.length - 240));
  return value.slice(start, start + 240);
}

function engineMatches(text, engineAliases) {
  const normalized = key(text);
  const matches = [];
  for (const item of engineAliases ?? []) {
    for (const alias of item.aliases ?? []) {
      const aliasKey = key(alias);
      if (aliasKey && normalized.includes(aliasKey)) {
        matches.push({ engineVariant: item.engineVariant, engine: alias, alias });
        break;
      }
    }
  }
  return matches;
}

export function extractCandidateFields({ sourceId, listing, detail, engineAliases = [], requiredFields } = {}) {
  const candidates = Object.fromEntries(Object.keys(FIELD_ALIASES).map((name) => [name, []]));
  const add = (name, raw, sourcePath, method, text = "", priority = 50) => {
    if (!candidates[name]) return;
    const value = normalizeFact(name, raw);
    if (value === null || value === "") return;
    if (name === "engineVariant" && engineAliases.length &&
        !engineAliases.some((item) => item.engineVariant === value)) {
      const matches = [...new Map(engineMatches(value, engineAliases)
        .map((match) => [match.engineVariant, match])).values()];
      if (matches.length !== 1) return;
      const match = matches[0];
      add("engineVariant", match.engineVariant, sourcePath, "text_rule", text || String(raw), priority);
      add("engine", match.engine, sourcePath, "text_rule", text || String(raw), Math.max(0, priority - 1));
      return;
    }
    const dedupe = `${String(value)}|${sourcePath}`;
    if (candidates[name].some((candidate) => candidate.dedupe === dedupe)) return;
    candidates[name].push({ value, priority, dedupe, evidence: {
      source: sourceId,
      sourcePath,
      method,
      ...(text ? { excerpt: excerpt(text) } : {}),
    } });
  };

  const readObject = (object, basePath, priority, { kind = "source", currency = "" } = {}) => {
    const sourceCurrency = scalar(object?.priceCurrency ?? object?.currency ?? object?.price?.currency ?? currency);
    for (const [label, raw] of Object.entries(isRecord(object) ? object : {})) {
      const normalizedLabel = key(label);
      for (const [name, aliases] of Object.entries(FIELD_ALIASES)) {
        if (!aliases.includes(normalizedLabel)) continue;
        if (name === "price" && sourceCurrency && normalizeText(sourceCurrency) !== "pln") continue;
        if (name === "price" && kind === "structured" && normalizeText(sourceCurrency) !== "pln") continue;
        const value = fieldValue(name, raw);
        const unit = name === "mileage" && isRecord(object) ? object.mileageUnit ?? object.odometerUnit : null;
        const combined = unit && !/\b(?:km|mi)\b/i.test(value) ? `${value} ${scalar(unit)}` : value;
        const valuePriority = kind === "source" && name === "price" ? priority + 10
          : kind === "structured" && name !== "price" ? priority + 5 : priority;
        add(name, combined, `${basePath}.${label}`, "structured_field", `${label}: ${combined}`, valuePriority);
      }
    }
  };

  const readStructured = (value, basePath, depth = 0, inheritedCurrency = "") => {
    if (depth > 9 || value == null) return;
    if (Array.isArray(value)) {
      value.slice(0, 100).forEach((item, index) => readStructured(item, `${basePath}[${index}]`, depth + 1, inheritedCurrency));
      return;
    }
    if (!isRecord(value)) return;
    const currency = scalar(value.priceCurrency ?? value.currency ?? value.price?.currency ?? inheritedCurrency);
    readObject(value, basePath, 25, { kind: "structured", currency });
    for (const [name, nested] of Object.entries(value)) {
      if (isRecord(nested) || Array.isArray(nested)) readStructured(nested, `${basePath}.${name}`, depth + 1, currency);
    }
  };

  const detailFields = isRecord(detail?.fields) ? detail.fields : {};
  const fieldCurrency = scalar(Object.entries(detailFields).find(([label]) => ["pricecurrency", "currency"].includes(key(label)))?.[1]);
  for (const [label, raw] of Object.entries(detailFields)) {
    const normalizedLabel = key(label);
    const isMachineKey = Object.values(FIELD_ALIASES).some((aliases) => aliases.includes(normalizedLabel));
    for (const [name, aliases] of Object.entries(FIELD_ALIASES)) {
      if (!aliases.includes(normalizedLabel)) continue;
      if (name === "price" && fieldCurrency && normalizeText(fieldCurrency) !== "pln") continue;
      const value = fieldValue(name, raw);
      const method = isMachineKey ? "structured_field" : "label_value";
      add(name, value, `detail.fields[${JSON.stringify(label)}]`, method, `${label}: ${value}`, 10);
    }
  }

  // Adapter projections are source-specific decoded values. Detail values take precedence over list values.
  readObject(detail?.sourceFields, `sourcePayload.${sourceId}.detailFields`, 20);
  readObject(listing?.sourceFields, `sourcePayload.${sourceId}.listingFields`, 25);
  const listingCurrency = scalar(listing?.sourceFields?.priceCurrency ?? listing?.sourceFields?.currency ??
    listing?.sourceFields?.price?.currency);
  if (Number.isFinite(listing?.apiPriceAmount) && listing.apiPriceAmount > 0 &&
      (!listingCurrency || normalizeText(listingCurrency) === "pln")) {
    add("price", listing.apiPriceAmount,
      listing.apiEvidence?.pricePath ?? "listing.apiPriceAmount", "structured_field", String(listing.apiPriceAmount), 30);
  }

  const structured = Array.isArray(detail?.structuredData) ? detail.structuredData : detail?.structuredData ? [detail.structuredData] : [];
  structured.forEach((item, index) => readStructured(item, `detail.structuredData[${index}]`));

  if (detail?.salePanel?.price) {
    add("price", detail.salePanel.price, "detail.salePanel.price", "label_value", detail.salePanel.price, 5);
  }

  const textSources = [
    ["listing.title", listing?.title],
    ["listing.visibleText", listing?.visibleText],
    ["detail.title", detail?.title],
    ["detail.bodyText", detail?.bodyText],
  ].filter(([, value]) => typeof value === "string" && value.trim());
  const textRules = [
    ["year", /(?:rok produkcji|produkcja|rocznik)\s*[:\-]?\s*((?:18|19|20|21)\d{2})/i],
    ["mileage", /(?:przebieg|mileage)\s*[:\-]?\s*([\d\s\u00a0.,]+\s*(?:km|mi|miles?))/i],
    ["price", /(?:cena|price)\s*[:\-]?\s*([\d\s\u00a0.,]+\s*(?:zł|PLN))/i],
    ["firstRegistrationDate", FIRST_REGISTRATION_DATE_PATTERN],
    ["vin", /\b[A-HJ-NPR-Z0-9]{17}\b/i],
    ["body", /(?:typ nadwozia|nadwozie)\s*[:\-]?\s*(kombi|combi|wagon|sedan|hatchback|suv|crossover|minivan)/i],
    ["transmission", /(?:skrzynia biegów|skrzynia|transmission)\s*[:\-]?\s*(manualna|manual|automatyczna|automatic|dsg|cvt|tiptronic|xtronic)/i],
    ["fuel", /(?:rodzaj paliwa|paliwo|fuel)\s*[:\-]?\s*(benzyna|petrol|diesel|lpg|hybryda|hybrid|elektryczny|electric)/i],
  ];
  for (const [path, text] of textSources) {
    for (const [name, pattern] of textRules) {
      const match = pattern.exec(text);
      if (match) add(name, match[1] ?? match[0], path, "text_rule", excerpt(text, match.index), 40);
    }
    for (const match of engineMatches(text, engineAliases)) {
      add("engineVariant", match.engineVariant, path, "text_rule", match.alias, 40);
      add("engine", match.engine, path, "text_rule", match.alias, 40);
    }
  }

  for (const engine of [...candidates.engine]) {
    for (const match of engineMatches(engine.value, engineAliases)) {
      add("engineVariant", match.engineVariant, engine.evidence.sourcePath, engine.evidence.method,
        engine.evidence.excerpt ?? String(engine.value), engine.priority);
      // Portal version slugs often append the trim (for example, "Intro Edition")
      // to the engine name. Keep the matched model-specific engine alias as the
      // canonical display value instead of letting that raw slug win by priority.
      add("engine", match.engine, engine.evidence.sourcePath, "text_rule",
        engine.evidence.excerpt ?? String(engine.value), Math.max(0, engine.priority - 1));
    }
  }

  // The existing shared classifier also understands these aliases; retain its fallback parser as a last evidence source.
  const visible = extractVisibleFields(`${listing?.title ?? ""}\n${listing?.visibleText ?? ""}\n${detail?.title ?? ""}\n${detail?.bodyText ?? ""}`);
  if (visible.productionYear) add("year", visible.productionYear, "listing/detail text (label parser)", "text_rule", String(visible.productionYear), 45);
  if (visible.mileageKm !== null) add("mileage", visible.mileageKm, "listing/detail text (km parser)", "text_rule", `${visible.mileageKm} km`, 45);

  const facts = {};
  const fieldEvidence = {};
  const conflicts = {};
  for (const [name, values] of Object.entries(candidates)) {
    values.sort((left, right) => left.priority - right.priority);
    if (!values.length) continue;
    facts[name] = values[0].value;
    fieldEvidence[name] = values.slice(0, 8).map((candidate) => candidate.evidence);
    const distinct = [...new Map(values.map((candidate) => [String(candidate.value), candidate.value])).values()];
    if (distinct.length > 1) conflicts[name] = distinct;
  }

  const required = Array.isArray(requiredFields) ? requiredFields : ["price", "year", "mileage", "engineVariant"];
  const canonicalRequired = required.map((field) => REQUIRED_ALIASES[field] ?? field);
  const missingRequired = canonicalRequired.filter((field) => facts[field] === undefined);
  const unresolvedRequired = canonicalRequired.filter((field) => facts[field] === undefined || conflicts[field]);
  return {
    facts,
    fieldEvidence,
    conflicts,
    missingRequired,
    unresolvedRequired,
    searchedSources: [
      `sourcePayload.${sourceId}.listingFields`, `sourcePayload.${sourceId}.detailFields`, "detail.fields",
      "detail.structuredData", "listing.title", "listing.visibleText", "detail.title", "detail.bodyText",
    ],
  };
}

export function classifierFallbackFields(extraction) {
  const facts = extraction?.facts ?? {};
  const conflicts = extraction?.conflicts ?? {};
  const mappings = [
    ["price", "price"], ["productionYear", "year"], ["mileage", "mileage"], ["engine", "engine"],
    ["engineVariant", "engineVariant"], ["vin", "vin"], ["firstRegistrationDate", "firstRegistrationDate"],
    ["transmission", "transmission"], ["bodyType", "body"], ["fuelType", "fuel"],
  ];
  return Object.fromEntries(mappings
    .filter(([, field]) => !conflicts[field] && !(field === "engine" && conflicts.engineVariant))
    .map(([target, field]) => [target, facts[field]])
    .filter(([, value]) => value !== undefined && value !== null && value !== ""));
}
