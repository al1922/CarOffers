import test from "node:test";
import assert from "node:assert/strict";
import {
  projectOfferGroup,
  passesRequiredCriteria,
  upsertOfferFromSearch,
} from "../src/offers/records.mjs";

const model = {
  key: "sample-model",
  criteria: {
    minimumPricePln: 20000,
    maximumGrossPricePln: 50000,
    yearMin: 2019,
    yearMax: null,
    maximumMileageKm: 150000,
    engineVariants: ["1.5-turbo-150"],
  },
  fields: {
    required: ["price", "year", "mileage", "engineVariant"],
    semiRequired: ["vin", "transmission"],
    optional: ["fuel"],
  },
};

function offer(overrides = {}) {
  return {
    title: "Sample car",
    price: 35000,
    priceBasis: "gross_total",
    year: 2020,
    mileage: 90000,
    engine: "1.5 Turbo 150 KM",
    engineVariant: "1.5-turbo-150",
    urls: [],
    ...overrides,
  };
}

function upsert(groups, data, sourceId, url, checkedAt = "2026-11-15T10:00:00.000Z") {
  return upsertOfferFromSearch(groups, data, {
    model,
    sourceId,
    sourceName: sourceId.toUpperCase(),
    url,
    checkedAt,
  });
}

test("merges listings only when both report the same valid VIN", () => {
  const groups = [];
  upsert(groups, offer({ vin: "1HGCM82633A004352" }), "otomoto", "https://www.otomoto.pl/oferta/one");
  upsert(groups, offer({ vin: "1HGCM82633A004352" }), "aaaauto", "https://www.aaaauto.pl/oferta/two");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].listings.length, 2);
  assert.equal(groups[0].identityKey, "vin:1HGCM82633A004352");
});

test("keeps listings without VIN as separate records", () => {
  const groups = [];
  upsert(groups, offer(), "otomoto", "https://www.otomoto.pl/oferta/one");
  upsert(groups, offer(), "aaaauto", "https://www.aaaauto.pl/oferta/two");
  assert.equal(groups.length, 2);
  assert.equal(groups[0].listings.length, 1);
  assert.equal(groups[1].listings.length, 1);
});

test("a full reread replaces old facts and clears fields the source omitted", () => {
  const groups = [];
  const url = "https://www.otomoto.pl/oferta/one";
  upsert(groups, offer({ vin: "1HGCM82633A004352", transmission: "automatic" }), "otomoto", url);
  upsert(groups, offer(), "otomoto", url, "2026-11-15T11:00:00.000Z");
  assert.equal(groups[0].listings[0].facts.vin, null);
  assert.equal(groups[0].listings[0].facts.transmission, null);
  const projected = projectOfferGroup(groups[0], model);
  assert.equal(projected.vin, null);
  assert.equal(projected.transmission, null);
});

test("projects the model field policy and ignores discrepancies in hidden fields", () => {
  const groups = [];
  upsert(groups, offer({ lpgInstalled: true, vin: "1HGCM82633A004352" }), "otomoto", "https://www.otomoto.pl/oferta/one");
  upsert(groups, offer({ lpgInstalled: false, vin: "1HGCM82633A004352" }), "aaaauto", "https://www.aaaauto.pl/oferta/two");
  const projected = projectOfferGroup(groups[0], model);
  assert.deepEqual(projected.fieldPolicy, model.fields);
  assert.equal(projected.hasFieldDiscrepancy, false);
});

test("requires the configured price, year, mileage, engine and gross price basis", () => {
  assert.equal(passesRequiredCriteria(offer(), model), true);
  assert.equal(passesRequiredCriteria(offer({ priceBasis: "unknown" }), model), false);
  assert.equal(passesRequiredCriteria(offer({ mileage: 150001 }), model), false);
  assert.equal(passesRequiredCriteria(offer({ engineVariant: "other" }), model), false);
});
