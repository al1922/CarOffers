export const SEMI_REQUIRED_FIELDS = ["vin", "firstRegistrationDate", "transmission", "body"];
export const OPTIONAL_FIELDS = ["location", "photos", "cameraStatus", "fuel"];
export const FACT_FIELDS = [
  "title", "price", "priceBasis", "year", "mileage", "engine", "engineVariant",
  "engineCapacity", "enginePower", "body", "bodyCode", "transmission", "transmissionCode", "vin",
  "firstRegistrationDate", "lpgInstalled", "location", "photos", "cameraStatus", "fuel",
];
const DISCREPANCY_FIELDS = [
  "price", "year", "mileage", "engineVariant", "bodyCode", "transmissionCode", "vin",
  "firstRegistrationDate", "fuel", "lpgInstalled",
];
const DISCREPANCY_POLICY_FIELDS = {
  price: ["price"], year: ["year"], mileage: ["mileage"], engineVariant: ["engineVariant"],
  bodyCode: ["body"], transmissionCode: ["transmission"], vin: ["vin"],
  firstRegistrationDate: ["firstRegistrationDate"], fuel: ["fuel"], lpgInstalled: ["lpgInstalled"],
};
const DEFAULT_FIELD_POLICY = {
  required: ["price", "year", "mileage", "engineVariant"],
  semiRequired: SEMI_REQUIRED_FIELDS,
  optional: OPTIONAL_FIELDS,
};

export function canonicalUrl(value) {
  try {
    const url = new URL(value);
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.href;
  } catch {
    return null;
  }
}

function listingKey(sourceId, url) {
  return `${sourceId}:${canonicalUrl(url) ?? url}`;
}

function usable(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function jsonValue(value) {
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, jsonValue(value[key])]));
  }
  return value;
}

function valueKey(value) {
  return JSON.stringify(jsonValue(value));
}

export function factsFromOffer(offer, checkedAt) {
  const facts = {};
  for (const key of FACT_FIELDS) {
    if (key === "engineCapacity") facts[key] = offer.details?.engineCapacity ?? null;
    else if (key === "enginePower") facts[key] = offer.details?.enginePower ?? null;
    else if (Object.hasOwn(offer, key)) facts[key] = offer[key];
  }
  for (const key of SEMI_REQUIRED_FIELDS) facts[key] ??= null;
  if (typeof facts.vin === "string") facts.vin = facts.vin.trim().toUpperCase() || null;
  facts.title = String(facts.title ?? offer.title ?? "").trim();
  facts.lastReadAt = checkedAt;
  if (facts.cameraStatus === "unknown") facts.cameraStatus = null;
  if (!Array.isArray(facts.photos) || !facts.photos.length) delete facts.photos;
  for (const key of OPTIONAL_FIELDS) if (facts[key] === null || facts[key] === undefined || facts[key] === "") delete facts[key];
  return facts;
}

export function listingFromOffer(offer, sourceId, sourceName, url, checkedAt, { sourceExtensions, fieldEvidence } = {}) {
  const safe = canonicalUrl(url);
  if (!safe) throw new Error(`Nieprawidłowy URL ogłoszenia: ${url}`);
  const exactUrl = (offer.urls ?? []).find((item) => canonicalUrl(item.url) === safe);
  const listing = {
    key: listingKey(sourceId, safe),
    sourceId,
    sourceName,
    sourceListingId: (offer.listingIds ?? [])[0] ?? null,
    url: safe,
    lastCheckedAt: checkedAt,
    facts: factsFromOffer({ ...offer, title: offer.title ?? exactUrl?.label }, checkedAt),
  };
  if (sourceExtensions && Object.keys(sourceExtensions).length) {
    listing.sourceExtensions = { [sourceId]: sourceExtensions };
  }
  if (fieldEvidence && Object.keys(fieldEvidence).length) listing.fieldEvidence = fieldEvidence;
  return listing;
}

export function createOfferGroup(offer, listing, modelKey, createdAt = listing.lastCheckedAt) {
  const vin = /^[A-HJ-NPR-Z0-9]{17}$/i.test(String(offer.vin ?? "")) ? offer.vin.toUpperCase() : null;
  const identityKey = vin ? `vin:${vin}` : listing.key;
  return {
    id: identityKey,
    identityKey,
    modelKey,
    primaryListingKey: listing.key,
    firstSeenAt: createdAt,
    lastUpdatedAt: createdAt,
    listings: [listing],
  };
}

export function upsertListing(group, incomingListing, checkedAt) {
  const listings = [...(group.listings ?? [])];
  const index = listings.findIndex((listing) => listing.key === incomingListing.key);
  if (index < 0) listings.push(incomingListing);
  else listings[index] = incomingListing;
  return { ...group, listings, lastUpdatedAt: checkedAt };
}

export function projectOfferGroup(group, model) {
  const fieldPolicy = model?.fields ?? DEFAULT_FIELD_POLICY;
  const listings = [...(group.listings ?? [])];
  const primaryIndex = listings.findIndex((listing) => listing.key === group.primaryListingKey);
  const ordered = primaryIndex > 0
    ? [listings[primaryIndex], ...listings.filter((_, index) => index !== primaryIndex)]
    : listings;
  const fields = [...new Set([...FACT_FIELDS, ...SEMI_REQUIRED_FIELDS])];
  const facts = {};
  for (const field of fields) {
    const candidate = ordered.find((listing) => usable(listing.facts?.[field]));
    if (candidate) facts[field] = candidate.facts[field];
    else if (SEMI_REQUIRED_FIELDS.includes(field)) facts[field] = null;
  }
  const visibleFields = new Set([
    ...(fieldPolicy.required ?? []),
    ...(fieldPolicy.semiRequired ?? []),
    ...(fieldPolicy.optional ?? []),
  ]);
  const discrepancyFields = DISCREPANCY_FIELDS.filter((field) =>
    DISCREPANCY_POLICY_FIELDS[field]?.some((policyField) => visibleFields.has(policyField))
  ).filter((field) => {
    const values = new Set(ordered.map((listing) => listing.facts?.[field])
      .filter(usable).map((value) => valueKey(field === "vin" ? String(value).toUpperCase() : value)));
    return values.size > 1;
  });
  const links = ordered.map((listing) => ({
    url: listing.url,
    sourceId: listing.sourceId,
    sourceName: listing.sourceName,
    label: listing.sourceName,
  }));
  const modelName = model?.name ?? group.modelKey;
  return {
    ...facts,
    id: group.id,
    modelKey: group.modelKey,
    modelName,
    key: `${group.modelKey}|${group.id}`,
    firstSeenAt: group.firstSeenAt ?? null,
    updatedAt: group.lastUpdatedAt ?? null,
    urls: links,
    sourceListings: ordered,
    primarySourceId: ordered[0]?.sourceId ?? null,
    primaryListingKey: group.primaryListingKey,
    fieldPolicy,
    discrepancyFields,
    hasFieldDiscrepancy: discrepancyFields.length > 0,
    missingSemiRequired: (fieldPolicy.semiRequired ?? SEMI_REQUIRED_FIELDS)
      .filter((field) => !usable(facts[field])),
  };
}

export function upsertOfferFromSearch(groups, offer, { model, sourceId, sourceName, url, checkedAt, sourceExtensions, fieldEvidence }) {
  const incoming = listingFromOffer({ ...offer, urls: [{ url }] }, sourceId, sourceName, url, checkedAt,
    { sourceExtensions, fieldEvidence });
  const vin = /^[A-HJ-NPR-Z0-9]{17}$/i.test(String(offer.vin ?? "")) ? offer.vin.toUpperCase() : null;
  const listingIndex = groups.findIndex((group) => group.listings?.some((listing) => listing.key === incoming.key));
  const vinIndex = vin ? groups.findIndex((group) => group.identityKey === `vin:${vin}`) : -1;
  let index = listingIndex >= 0 ? listingIndex : vinIndex;
  if (listingIndex >= 0 && vinIndex >= 0 && listingIndex !== vinIndex) {
    const listingGroup = groups[listingIndex];
    const vinGroup = groups[vinIndex];
    const olderIsListingGroup = Date.parse(listingGroup.firstSeenAt) <= Date.parse(vinGroup.firstSeenAt);
    const primaryGroup = olderIsListingGroup ? listingGroup : vinGroup;
    const otherGroup = olderIsListingGroup ? vinGroup : listingGroup;
    const merged = { ...primaryGroup, id: `vin:${vin}`, identityKey: `vin:${vin}`,
      listings: [...primaryGroup.listings, ...otherGroup.listings.filter((item) => !primaryGroup.listings.some((existing) => existing.key === item.key))] };
    const firstIndex = Math.min(listingIndex, vinIndex);
    const secondIndex = Math.max(listingIndex, vinIndex);
    groups.splice(secondIndex, 1);
    groups.splice(firstIndex, 1, merged);
    index = firstIndex;
  }
  if (index >= 0) {
    const existing = groups[index];
    const next = upsertListing(existing, incoming, checkedAt);
    if (vin && next.identityKey !== `vin:${vin}`) {
      next.id = `vin:${vin}`;
      next.identityKey = `vin:${vin}`;
    }
    groups[index] = next;
    return { groups, action: "updated", offer: next };
  }
  const created = createOfferGroup(offer, incoming, model.key, checkedAt);
  groups.push(created);
  return { groups, action: "added", offer: created };
}

export function removeInactiveListing(group, listingKeyToRemove) {
  const listings = (group.listings ?? []).filter((listing) => listing.key !== listingKeyToRemove);
  if (!listings.length) return null;
  const primaryStillActive = listings.some((listing) => listing.key === group.primaryListingKey);
  return {
    ...group,
    listings,
    primaryListingKey: primaryStillActive ? group.primaryListingKey : listings[0].key,
  };
}

export function passesRequiredCriteria(offer, model) {
  const criteria = model.criteria ?? {};
  const maximumAdvertisedPricePln = criteria.maximumAdvertisedPricePln ?? criteria.maximumGrossPricePln;
  const requirements = model.requirements ?? {
    purchase: {
      minimumAdvertisedPricePln: criteria.minimumPricePln,
      maxAdvertisedPricePln: maximumAdvertisedPricePln,
    },
    yearMin: criteria.yearMin,
    yearMax: criteria.yearMax,
    mileage: { hardMaxKm: criteria.maximumMileageKm },
  };
  const purchase = requirements.purchase ?? {};
  const mileage = requirements.mileage ?? {};
  const minPrice = purchase.minimumAdvertisedPricePln;
  const maxPrice = purchase.maxAdvertisedPricePln ?? purchase.maxPriceGrossPln;
  const minYear = requirements.yearMin ?? model.searchYears?.min;
  const maxYear = requirements.yearMax ?? model.searchYears?.max;
  const maxMileage = mileage.hardMaxKm;
  const engines = model.allowedEngineVariants ?? criteria.engineVariants ?? [];
  return Number.isFinite(offer.price) &&
    (!Number.isFinite(minPrice) || offer.price >= minPrice) &&
    (!Number.isFinite(maxPrice) || offer.price <= maxPrice) &&
    Number.isInteger(offer.year) &&
    (!Number.isFinite(minYear) || offer.year >= minYear) &&
    (!Number.isFinite(maxYear) || offer.year <= maxYear) &&
    Number.isFinite(offer.mileage) &&
    (!Number.isFinite(maxMileage) || offer.mileage <= maxMileage) &&
    typeof offer.engineVariant === "string" && engines.includes(offer.engineVariant);
}
