"use strict";
// Publiczna strona statyczna: bez GitHub API, kont i lokalnych statusów.
const $ = selector => document.querySelector(selector);
const tabs = $('#modelTabs');
const cards = $('#cards');
const requirements = $('#modelRequirements');
const corollaRequirements = requirements.innerHTML;
const heading = $('#modelTitle');
const count = $('#count');
const empty = $('#empty');
let models = [];
let selectedModel = '';
const cache = new Map();

function validModel(model) {
  return model && typeof model.key === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(model.key)
    && typeof model.name === 'string' && model.name.trim();
}
function offerCard(offer) {
  const wrapper = document.createElement('div');
  // Pliki JSON są zarządzane przez właściciela repozytorium; HTML ofert jest zaufaną treścią repo.
  wrapper.innerHTML = typeof offer.html === 'string' ? offer.html : '';
  const card = wrapper.querySelector('.car-card');
  if (card) {
    card.dataset.offerId = offer.id || '';
    return card;
  }
  const fallback = document.createElement('article');
  fallback.className = 'car-card';
  const h = document.createElement('h3');
  h.textContent = offer.title || 'Oferta samochodu';
  fallback.append(h);
  for (const link of Array.isArray(offer.urls) ? offer.urls : []) {
    if (!/^https:\/\//i.test(link.url || '')) continue;
    const a = document.createElement('a');
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'link-button';
    a.textContent = link.label || 'Zobacz ogłoszenie';
    fallback.append(a);
  }
  return fallback;
}
function renderTabs() {
  tabs.replaceChildren();
  for (const model of models) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-tab';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'cards');
    button.setAttribute('aria-selected', String(model.key === selectedModel));
    button.textContent = model.name;
    button.addEventListener('click', () => {
      location.hash = encodeURIComponent(model.key);
      selectModel(model.key);
    });
    tabs.append(button);
  }
}
async function loadOffers(model) {
  if (cache.has(model.key)) return cache.get(model.key);
  const response = await fetch('./' + model.file, {cache:'no-store'});
  if (!response.ok) throw new Error('Nie udało się pobrać ofert: ' + model.file);
  const data = await response.json();
  if (!Array.isArray(data.offers)) throw new Error('Nieprawidłowa tablica ofert w ' + model.file);
  cache.set(model.key, data.offers);
  return data.offers;
}
async function selectModel(key) {
  const model = models.find(item => item.key === key);
  if (!model) return;
  selectedModel = key;
  renderTabs();
  heading.textContent = model.name;
  document.title = model.name + ' — oferty samochodów';
  requirements.innerHTML = model.requirements === 'corolla' ? corollaRequirements : '';
  cards.replaceChildren();
  count.textContent = 'Ładowanie…';
  empty.hidden = true;
  try {
    const offers = await loadOffers(model);
    if (selectedModel !== key) return;
    const fragment = document.createDocumentFragment();
    for (const offer of offers) fragment.append(offerCard(offer));
    cards.replaceChildren(fragment);
    count.textContent = offers.length + (offers.length === 1 ? ' oferta' : ' ofert');
    empty.hidden = offers.length !== 0;
    empty.textContent = 'Brak ofert tego modelu.';
  } catch (error) {
    if (selectedModel !== key) return;
    count.textContent = '';
    empty.hidden = false;
    empty.textContent = error.message;
    console.error(error);
  }
}
async function init() {
  try {
    const response = await fetch('./models.json', {cache:'no-store'});
    if (!response.ok) throw new Error('Nie udało się pobrać indeksu modeli.');
    const data = await response.json();
    if (!Array.isArray(data.models)) throw new Error('Nieprawidłowy indeks modeli.');
    models = data.models.filter(validModel);
    if (!models.length) throw new Error('Brak modeli w katalogu offers/.');
    const key = decodeURIComponent(location.hash.slice(1));
    await selectModel(models.some(model => model.key === key) ? key : models[0].key);
  } catch (error) {
    empty.hidden = false;
    empty.textContent = error.message;
    console.error(error);
  }
}
window.addEventListener('hashchange', () => {
  const key = decodeURIComponent(location.hash.slice(1));
  if (models.some(model => model.key === key) && key !== selectedModel) selectModel(key);
});
init();
