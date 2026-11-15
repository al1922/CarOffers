import { normalizeText } from "../search/shared/portal-screening.mjs";

const COMMON_SOURCE_KEYS = new Set([
  "title", "productionyear", "modelyear", "year", "price", "priceamount", "pricecash",
  "pricegross", "grossprice", "advertisedprice", "pricebasis", "mileage", "mileagekm", "mileagefromodometer",
  "odometer", "mileageunit", "engine", "vehicleengine", "enginedescription", "enginevariant", "enginecapacity",
  "enginesize", "enginepower", "enginepowerhp", "enginepowerkw", "horsepower", "power", "vin",
  "vehicleidentificationnumber", "firstregistrationdate", "datefirstregistered", "firstregistration", "transmission",
  "vehicletransmission", "gearbox", "body", "bodytype", "fuel", "fueltype", "fueltitle", "lpginstalled",
  "location", "photos", "camerastatus", "recordid", "listingid", "id",
]);

const SENSITIVE_OR_TECHNICAL_KEY = /(?:session|cookie|token|authorization|password|secret|phone|telephone|mobile|email|contact|request|response|header)/i;
const EVIDENCE_METHODS = new Set(["structured_field", "label_value", "text_rule", "ai", "manual"]);
const FACT_VALUE_MAP = {
  price: "price",
  year: "year",
  mileage: "mileage",
  engine: "engine",
  engineVariant: "engineVariant",
  vin: "vin",
  firstRegistrationDate: "firstRegistrationDate",
  transmission: "transmission",
  body: "body",
  fuel: "fuel",
};
const REQUIRED_FIELD_ALIASES = {
  pricePln: "price", productionYear: "year", modelYear: "year", mileageKm: "mileage",
  vehicleTransmission: "transmission", gearbox: "transmission", bodyType: "body", fuelType: "fuel",
  firstRegistration: "firstRegistrationDate",
};

function key(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, "");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function usable(value) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function sanitize(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.trim().slice(0, 2000) || undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((item) => sanitize(item, depth + 1)).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).slice(0, 100)
    .filter(([field]) => !SENSITIVE_OR_TECHNICAL_KEY.test(field))
    .map(([field, item]) => [field, sanitize(item, depth + 1)])
    .filter(([, item]) => item !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function sourceExtensions(candidate, sourceId) {
  const payload = candidate?.sourcePayload?.[sourceId];
  if (!isRecord(payload)) return undefined;
  const extension = {};
  for (const area of ["listingFields", "detailFields"]) {
    const fields = payload[area];
    if (!isRecord(fields)) continue;
    const retained = {};
    for (const [field, value] of Object.entries(fields)) {
      if (COMMON_SOURCE_KEYS.has(key(field)) || SENSITIVE_OR_TECHNICAL_KEY.test(field)) continue;
      const safeValue = sanitize(value);
      if (usable(safeValue)) retained[field] = safeValue;
    }
    if (Object.keys(retained).length) extension[area === "listingFields" ? "listing" : "detail"] = retained;
  }
  return Object.keys(extension).length ? extension : undefined;
}

function fieldEvidence(candidate, offer) {
  const extraction = candidate?.extraction;
  if (!isRecord(extraction?.fieldEvidence)) return undefined;
  const evidence = {};
  for (const [field, value] of Object.entries(extraction.fieldEvidence)) {
    const offerField = FACT_VALUE_MAP[field];
    if (!offerField || !usable(offer[offerField]) || !Array.isArray(value)) continue;
    const entries = value.filter((item) => isRecord(item) && typeof item.source === "string" && item.source.trim() &&
      typeof item.sourcePath === "string" && item.sourcePath.trim() && EVIDENCE_METHODS.has(item.method))
      .slice(0, 12).map((item) => ({
        source: item.source.trim().slice(0, 120),
        sourcePath: item.sourcePath.trim().slice(0, 500),
        method: item.method,
        ...(typeof item.excerpt === "string" && item.excerpt.trim() ? { excerpt: item.excerpt.trim().slice(0, 2000) } : {}),
      })).filter((item) => item.method !== "ai" || item.excerpt);
    if (entries.length) evidence[offerField] = entries;
  }
  return Object.keys(evidence).length ? evidence : undefined;
}

export function mapCandidateToOffer(candidate, sourceId) {
  const offer = candidate?.classification?.offer;
  if (!isRecord(offer)) return { offer: null };
  const facts = isRecord(candidate.extraction?.facts) ? candidate.extraction.facts : {};
  const mappedOffer = { ...offer, details: isRecord(offer.details) ? { ...offer.details } : offer.details };
  for (const [fact, target] of Object.entries(FACT_VALUE_MAP)) {
    if (usable(facts[fact])) mappedOffer[target] = facts[fact];
  }
  if (!usable(mappedOffer.bodyCode) && usable(mappedOffer.body)) mappedOffer.bodyCode = mappedOffer.body;
  if (!usable(mappedOffer.transmissionCode) && ["automatic", "manual"].includes(mappedOffer.transmission)) {
    mappedOffer.transmissionCode = mappedOffer.transmission;
  }
  return {
    offer: mappedOffer,
    sourceExtensions: sourceExtensions(candidate, sourceId),
    fieldEvidence: fieldEvidence(candidate, mappedOffer),
  };
}

export function hasUnresolvedRequiredFields(candidate, model) {
  const extraction = candidate?.extraction;
  if (!isRecord(extraction)) return false;
  const required = (model?.fieldPolicy?.required ?? ["price", "year", "mileage", "engineVariant"])
    .map((field) => REQUIRED_FIELD_ALIASES[field] ?? field);
  const unresolved = new Set(Array.isArray(extraction.unresolvedRequired) ? extraction.unresolvedRequired : []);
  return required.some((field) => unresolved.has(field) || usable(extraction.conflicts?.[field]) ||
    !usable(extraction.facts?.[field]));
}
