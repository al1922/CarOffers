import { loadData } from "./assets/data.mjs?v=41";
import { offerCard } from "./assets/views.mjs?v=46";

const $ = (selector) => document.querySelector(selector);
const state = {
  data: null,
  query: "",
  modelKey: "",
  yearMin: null,
  yearMax: null,
  priceMin: null,
  priceMax: null,
  mileageMin: null,
  mileageMax: null,
  sort: "newest",
};

const THEME_KEY = "caroffers-theme";
try {
  const savedTheme = localStorage.getItem(THEME_KEY);
  document.documentElement.dataset.theme = savedTheme === "light" ? "light" : "dark";
} catch {
  document.documentElement.dataset.theme = "dark";
}

function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === "dark";
  const button = $("#theme-toggle");
  button.textContent = dark ? "☀" : "☾";
  button.setAttribute("aria-label", dark ? "Przełącz na jasny motyw" : "Przełącz na ciemny motyw");
  button.setAttribute("aria-pressed", String(dark));
  button.title = dark ? "Przełącz na jasny motyw" : "Przełącz na ciemny motyw";
}

function filterNumber(selector) {
  const input = $(selector);
  const raw = input.value.trim();
  if (!raw) return null;
  if (!input.validity.valid) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function textFor(offer) {
  return [offer.modelName, offer.title, offer.engine, offer.engineVariant, offer.vin,
    offer.firstRegistrationDate, offer.transmission, offer.body, offer.location?.city, offer.location?.voivodeship,
    ...(offer.sourceListings ?? []).map((listing) => listing.sourceName)].filter(Boolean).join(" ").toLocaleLowerCase("pl");
}

function matches(offer) {
  if (state.modelKey && offer.modelKey !== state.modelKey) return false;
  if (state.query && !textFor(offer).includes(state.query.toLocaleLowerCase("pl"))) return false;
  for (const [field, minimum, maximum] of [
    ["year", state.yearMin, state.yearMax],
    ["price", state.priceMin, state.priceMax],
    ["mileage", state.mileageMin, state.mileageMax],
  ]) {
    if (minimum === null && maximum === null) continue;
    if (!Number.isFinite(offer[field])) return false;
    if (minimum !== null && offer[field] < minimum) return false;
    if (maximum !== null && offer[field] > maximum) return false;
  }
  return true;
}

function sortOffers(offers) {
  const sorted = [...offers];
  const numeric = (field, direction) => sorted.sort((a, b) => direction * ((a[field] ?? Infinity) - (b[field] ?? Infinity)));
  if (state.sort === "price-asc") return numeric("price", 1);
  if (state.sort === "price-desc") return numeric("price", -1);
  if (state.sort === "year-desc") return numeric("year", -1);
  if (state.sort === "mileage-asc") return numeric("mileage", 1);
  return sorted.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}

function render() {
  const all = state.data.offers.filter(matches);
  const visible = sortOffers(all);
  $("#result-count").textContent = `${visible.length} ${visible.length === 1 ? "oferta" : "ofert"}`;
  $("#offer-list").replaceChildren(...visible.map((offer) => offerCard(offer)));
  $("#model-empty-state").hidden = visible.length > 0;
  const errors = state.data.models.filter((model) => model.loadError).map((model) => `${model.name}: ${model.loadErrorText}`);
  const notice = $("#notice");
  notice.hidden = errors.length === 0;
  notice.textContent = errors.length ? `Nie udało się wczytać danych modeli: ${errors.join(" · ")}` : "";
}

function fillModelFilter(models) {
  const filter = $("#model-filter");
  filter.replaceChildren(new Option("Wszystkie modele", ""));
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.key;
    option.textContent = `${model.name} (${model.count ?? 0})`;
    filter.append(option);
  }
  filter.value = models.some((model) => model.key === state.modelKey) ? state.modelKey : "";
  if (!filter.value) state.modelKey = "";
}

async function reload() {
  $("#result-count").textContent = "Wczytywanie ofert…";
  $("#notice").hidden = true;
  try {
    state.data = await loadData();
    fillModelFilter(state.data.models);
    render();
  } catch (error) {
    $("#result-count").textContent = "Nie udało się wczytać ofert";
    $("#notice").hidden = false;
    $("#notice").textContent = error.message;
  }
}

$("#search-input").addEventListener("input", (event) => { state.query = event.target.value.trim(); if (state.data) render(); });
$("#model-filter").addEventListener("change", (event) => { state.modelKey = event.target.value; if (state.data) render(); });
$("#sort-filter").addEventListener("change", (event) => { state.sort = event.target.value; if (state.data) render(); });
for (const [id, key] of [
  ["year-min", "yearMin"], ["year-max", "yearMax"],
  ["price-min", "priceMin"], ["price-max", "priceMax"],
  ["mileage-min", "mileageMin"], ["mileage-max", "mileageMax"],
]) {
  $(`#${id}`).addEventListener("input", () => {
    state[key] = filterNumber(`#${id}`);
    if (state.data) render();
  });
}
$("#clear-filters").addEventListener("click", () => {
  for (const selector of ["#search-input", "#model-filter", "#year-min", "#year-max", "#price-min", "#price-max", "#mileage-min", "#mileage-max"]) {
    $(selector).value = "";
  }
  state.query = "";
  state.modelKey = "";
  state.yearMin = null;
  state.yearMax = null;
  state.priceMin = null;
  state.priceMax = null;
  state.mileageMin = null;
  state.mileageMax = null;
  if (state.data) render();
});
$("#reload-data").addEventListener("click", reload);
$("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* motyw nadal działa w tej karcie */ }
  updateThemeButton();
});

updateThemeButton();
await reload();
