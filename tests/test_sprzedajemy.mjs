import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyCard, createCardReader, createHtmlCardReader, screenListing, verifyListings } from "../scripts/sprzedajemy-verify.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const url = "https://sprzedajemy.pl/test-nr999999999";
const checkedAt = "2026-11-10T10:00:00Z";
const profile = {
  brands: ["Hyundai"],
  candidateScreening: { screeningLimits: { productionYearMin: 2018, productionYearMax: 2023,
    basePurchaseGrossPlnMax: 55000, engineVariants: ["1.5-dpi-110"], bodyCodes: ["wagon"] } },
  queryPlan: {
    manualFilters: { model: "i30" },
    engineAliases: [{ engineVariant: "1.5-dpi-110", aliases: ["1.5 DPi 110 KM"] }],
  },
};
const card = {
  title: "Hyundai i30 1.5 DPi", number: "999999999", contact: true, priceText: "950 zł / mies.", structuredPrice: 950,
  description: "Cena gotówkowa: 49 500 zł brutto.",
  fields: { Marka: "Hyundai", Model: "i30", "Rok produkcji": "2021", "Rodzaj nadwozia": "Kombi",
    "Pojemność silnika": "1498 cm³", Moc: "81 kW" },
  photos: [], city: "Zabrze", region: "śląskie",
};

test("gross price and kW can be verified without using the monthly amount", () => {
  const { offer } = classifyCard(card, url, profile, checkedAt);
  assert.equal(offer.price, 49500);
  assert.equal(offer.priceBasis, "gross_total");
  assert.equal(offer.engineVariant, "1.5-dpi-110");
  assert.equal(offer.saleType, "fixed_price");
});

test("list screening skips explicit spare parts but keeps ambiguous vehicle titles", () => {
  const screen = (title) => screenListing({ title }, profile).screeningFailures;
  assert.ok(screen("Hyundai i30 III PDE listwa listwy pionowe szyby czołowej").includes("not_a_complete_vehicle_listing"));
  assert.deepEqual(screen("Hyundai i30 1.5 DPi 110 KM 2021"), []);
  assert.deepEqual(screen("Hyundai i30 1.4 benzyna zadbany"), []);
});

test("a monthly installment and contradictory power remain unknown", () => {
  const { offer } = classifyCard({
    ...card, title: "Hyundai i30 1.5 DPi 110 KM", description: "", fields: { ...card.fields, Moc: "81 KM" },
  }, url, profile, checkedAt);
  assert.equal(offer.price, undefined);
  assert.equal(offer.priceBasis, undefined);
  assert.equal(offer.engineVariant, undefined);
});

function snapshot() {
  return { outcome: "complete", coverage: { remaining: "", searchUrls: ["https://sprzedajemy.pl/test"],
    pagesChecked: 1, listingUrlsChecked: [], searchResults: [{ listings: [{ url, title: "Hyundai i30" }] }] } };
}

test("cached card is assessed with the current task profile and original timestamp", async () => {
  const sharedResultsCache = { cardReads: [{ url, checkedAt, card }] };
  const navigate = () => assert.fail("cached card should not be opened again");
  const result = await verifyListings({ root, task: { id: "sample", searchProfile: profile, sharedResultsCache },
    snapshot: snapshot(), navigate, maxCards: null, listMs: 0 });
  assert.equal(result.offers[0].observation.checkedAt, checkedAt);
  assert.equal(result.diagnostics.reusedCards, 1);
  const differentProfile = {
    ...profile, candidateScreening: { screeningLimits: { ...profile.candidateScreening.screeningLimits, bodyCodes: ["sedan"] } },
  };
  const changed = await verifyListings({ root, task: { id: "sample", searchProfile: differentProfile, sharedResultsCache },
    snapshot: snapshot(), navigate, maxCards: null, listMs: 0 });
  assert.equal(changed.diagnostics.checks[0].status, "rejected");
});

test("a failed card stays unresolved and a legacy attempted URL is read", async () => {
  const legacy = await verifyListings({ root, task: { id: "sample", searchProfile: profile,
    sharedResultsCache: { listingUrlsChecked: [url] } }, snapshot: snapshot(),
  navigate: async () => {}, page: { evaluate: async () => card }, maxCards: null, listMs: 0 });
  assert.equal(legacy.diagnostics.openedCards, 1);
  assert.equal(legacy.coverage.cardReads.length, 1);
  const failure = await verifyListings({ root, task: { id: "sample", searchProfile: profile,
    sharedResultsCache: { cardReads: [{ url, checkedAt, error: "HTTP 403" }] } }, snapshot: snapshot(),
  navigate: () => assert.fail("cached failure should remain visible"), maxCards: null, listMs: 0 });
  assert.equal(failure.outcome, "partial");
  assert.equal(failure.errors[0].error, "HTTP 403");
});

test("HTML fallback only opens the browser after an incomplete card, never after HTTP 429", async () => {
  let opened = 0;
  const navigate = async () => { opened += 1; };
  const page = { evaluate: async () => card };
  const incomplete = createCardReader(navigate, page, async () => null);
  assert.deepEqual(await incomplete(url), { card, method: "fallback" });
  const context = { request: { get: async () => ({ status: () => 429, dispose: async () => {} }) } };
  const blocked = createCardReader(navigate, page, createHtmlCardReader(context, page, () => true));
  await assert.rejects(blocked(url), { blocked: true });
  assert.equal(opened, 1);
});
