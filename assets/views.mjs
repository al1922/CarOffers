import { bodyNames, kilometers, money, numberFormat, safeURL } from "./core.mjs";

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = String(text);
  return element;
}

function isPresent(value) {
  if (value === null || value === undefined || value === "") return false;
  return !Array.isArray(value) || value.length > 0;
}

const DEFAULT_FIELD_POLICY = {
  required: ["price", "year", "mileage", "engineVariant"],
  semiRequired: ["vin", "firstRegistrationDate", "transmission", "body"],
  optional: ["location", "photos", "cameraStatus", "fuel", "engineCapacity", "enginePower"],
};
const FIELD_LABELS = {
  price: "Cena",
  year: "Rok produkcji",
  mileage: "Przebieg",
  engineVariant: "Silnik",
  vin: "VIN",
  firstRegistrationDate: "Pierwsza rejestracja",
  transmission: "Skrzynia biegów",
  body: "Nadwozie",
  location: "Lokalizacja",
  photos: "Zdjęcia",
  cameraStatus: "Kamera",
  fuel: "Paliwo",
  engineCapacity: "Pojemność skokowa",
  enginePower: "Moc",
  lpgInstalled: "Instalacja LPG",
};
const FUEL_LABELS = {
  petrol: "Benzyna",
  benzyna: "Benzyna",
  gasoline: "Benzyna",
  diesel: "Diesel",
  hybrid: "Hybryda",
  "plug in hybrid": "Hybryda plug-in",
  "plugin hybrid": "Hybryda plug-in",
  "mild hybrid": "Miękka hybryda",
  electric: "Elektryczny",
  electricity: "Elektryczny",
  lpg: "LPG",
  "petrol + lpg": "Benzyna + LPG",
  "benzyna + lpg": "Benzyna + LPG",
  "petrol lpg": "Benzyna + LPG",
  cng: "CNG",
  "petrol + cng": "Benzyna + CNG",
  "benzyna + cng": "Benzyna + CNG",
  hydrogen: "Wodór",
  ethanol: "Etanol",
};

function fieldPolicy(offer) {
  return offer.fieldPolicy ?? DEFAULT_FIELD_POLICY;
}

function fieldValue(offer, key) {
  switch (key) {
    case "engineVariant": return offer.engine || offer.engineVariant;
    case "body": return offer.bodyCode ? bodyNames[offer.bodyCode] ?? offer.bodyCode : offer.body;
    case "transmission": return offer.transmission ?? offer.transmissionCode;
    case "location": return locationText(offer.location);
    case "photos": return offer.photos;
    default: return offer[key];
  }
}

function fieldLabel(key) {
  return FIELD_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function formatFieldValue(key, value) {
  if (key === "price") return money(value);
  if (key === "mileage") return kilometers(value);
  if (key === "cameraStatus") return cameraText(value);
  if (key === "fuel") return fuelText(value);
  if (key === "engineCapacity") return engineCapacityText(value);
  if (key === "enginePower") return enginePowerText(value);
  if (key === "lpgInstalled" && typeof value === "boolean") return value ? "Obecna" : "Brak";
  if (key === "photos" && Array.isArray(value)) return `${value.length} zdjęć`;
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function field(label, value, { semi = false, className = "", formatter = (item) => String(item) } = {}) {
  const missing = !isPresent(value);
  const classes = ["fact"];
  if (semi && missing) classes.push("fact-missing");
  if (className) classes.push(className);
  const row = node("div", classes.join(" "));
  row.append(node("span", "fact-label", label), node("strong", "fact-value", missing ? "-" : formatter(value)));
  return row;
}

function locationText(location) {
  if (typeof location === "string") return location;
  return [location?.city, location?.voivodeship].filter(Boolean).join(", ");
}

function cameraText(value) {
  return ({ installed_confirmed: "Zainstalowana", retrofit_confirmed: "Możliwy montaż", not_installable: "Brak możliwości montażu" })[value] ?? value;
}

function fuelText(value) {
  if (Array.isArray(value)) return value.map(fuelText).join(", ");
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  const key = raw.toLocaleLowerCase("pl-PL").replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return FUEL_LABELS[key] ?? raw;
}

function measurementNumber(value) {
  let text = String(value ?? "").replace(/[\s\u00a0]/g, "").replace(/[^\d,.-]/g, "");
  if (!text) return null;
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) text = comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  else if (comma >= 0) text = /,\d{1,2}$/.test(text) ? text.replace(",", ".") : text.replace(/,/g, "");
  else if (dot >= 0 && !/\.\d{1,2}$/.test(text)) text = text.replace(/\./g, "");
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function engineCapacityText(value) {
  const raw = String(value ?? "").trim();
  const number = measurementNumber(raw);
  if (number === null) return raw;
  const unit = /\b(?:l|litre|liter)\b/i.test(raw) || (number < 30 && /[.,]/.test(raw)) ? "l" : "cm³";
  return `${numberFormat.format(number)} ${unit}`;
}

function enginePowerText(value) {
  const raw = String(value ?? "").trim();
  const number = measurementNumber(raw);
  if (number === null) return raw;
  if (/\bkW\b/i.test(raw) && /\b(?:KM|PS|hp)\b/i.test(raw)) return raw;
  const unit = /\bkW\b/i.test(raw) ? "kW" : "KM";
  return `${numberFormat.format(number)} ${unit}`;
}

function openLink(listing) {
  const url = safeURL(listing?.url);
  if (!url) return null;
  const link = node("a", "button button-primary", "Otwórz ogłoszenie ↗");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function listingPicker(offer) {
  const listings = (offer.sourceListings ?? []).filter((listing) => safeURL(listing.url));
  if (listings.length <= 1) return { element: null, getSelected: () => listings[0] ?? null };
  const select = node("select", "listing-select");
  select.setAttribute("aria-label", "Wybierz portal z ogłoszeniem");
  for (const listing of listings) {
    const option = node("option", "", listing.sourceName);
    option.value = listing.key;
    option.selected = listing.key === offer.primaryListingKey;
    select.append(option);
  }
  const getSelected = () => listings.find((listing) => listing.key === select.value) ?? listings[0];
  return { element: select, getSelected };
}

function factsGrid(offer, compact = false) {
  const policy = fieldPolicy(offer);
  const grid = node("div", compact ? "facts-grid facts-grid-compact" : "facts-grid");
  for (const key of policy.required ?? []) {
    grid.append(field(fieldLabel(key), fieldValue(offer, key), {
      className: key === "price" ? "fact-required fact-price" : "fact-required",
      formatter: (value) => formatFieldValue(key, value),
    }));
  }
  const semiFields = node("div", "facts-grid facts-grid-semi");
  for (const key of policy.semiRequired ?? []) {
    semiFields.append(field(fieldLabel(key), fieldValue(offer, key), {
      semi: true,
      formatter: (value) => formatFieldValue(key, value),
    }));
  }
  if (semiFields.childElementCount) grid.append(semiFields);
  return grid;
}

function optionalFields(offer) {
  const items = [];
  for (const key of fieldPolicy(offer).optional ?? []) {
    if (key === "photos") continue;
    const value = fieldValue(offer, key);
    if (!isPresent(value) || (key === "cameraStatus" && value === "unknown")) continue;
    items.push([fieldLabel(key), formatFieldValue(key, value)]);
  }
  return items;
}

function photoGallery(offer) {
  const photos = fieldPolicy(offer).optional?.includes("photos") && Array.isArray(offer.photos) ? offer.photos : [];
  const urls = photos
    .map((photo) => safeURL(photo))
    .filter(Boolean);
  if (!urls.length) return null;

  const title = offer.title || offer.modelName;
  const gallery = node("div", "offer-gallery");
  gallery.setAttribute("role", "region");
  gallery.setAttribute("aria-label", `Zdjęcia oferty ${title}`);

  const viewport = node("div", "offer-gallery-viewport");
  const image = node("img", "offer-image");
  image.width = 800;
  image.height = 500;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => {
    const failedIndex = urls.indexOf(image.currentSrc || image.src);
    if (failedIndex < 0) return;
    urls.splice(failedIndex, 1);
    if (!urls.length) {
      gallery.remove();
      gallery.closest(".offer-card")?.classList.add("offer-card-no-image");
      return;
    }
    if (failedIndex < current) current -= 1;
    current = Math.min(current, urls.length - 1);
    showPhoto(current);
  });

  let current = 0;
  const counter = node("span", "gallery-counter");
  counter.setAttribute("aria-live", "polite");
  counter.setAttribute("aria-atomic", "true");

  const showPhoto = (index) => {
    current = Math.max(0, Math.min(urls.length - 1, index));
    image.src = urls[current];
    image.alt = `Zdjęcie ${current + 1} z ${urls.length}: ${title}`;
    counter.textContent = `${current + 1} / ${urls.length}`;
    previous.hidden = urls.length < 2;
    next.hidden = urls.length < 2;
    previous.disabled = current === 0;
    next.disabled = current === urls.length - 1;
    previous.setAttribute("aria-label", `Poprzednie zdjęcie, ${current + 1} z ${urls.length}`);
    next.setAttribute("aria-label", `Następne zdjęcie, ${current + 1} z ${urls.length}`);
  };

  const arrowButton = (direction, label) => {
    const button = node("button", `gallery-arrow gallery-${direction}`);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("width", "18");
    icon.setAttribute("height", "18");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    path.setAttribute("d", direction === "previous" ? "M15 18 9 12l6-6" : "M9 18l6-6-6-6");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    icon.append(path);
    button.append(icon);
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.hidden = urls.length < 2;
    return button;
  };

  const previous = arrowButton("previous", "Poprzednie zdjęcie");
  previous.addEventListener("click", () => showPhoto(current - 1));

  const next = arrowButton("next", "Następne zdjęcie");
  next.addEventListener("click", () => showPhoto(current + 1));

  let swipeStart = null;
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    swipeStart = { x: event.clientX, y: event.clientY };
  });
  viewport.addEventListener("pointerup", (event) => {
    if (!swipeStart) return;
    const deltaX = event.clientX - swipeStart.x;
    const deltaY = event.clientY - swipeStart.y;
    swipeStart = null;
    if (urls.length < 2 || Math.abs(deltaX) < 40 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;
    showPhoto(current + (deltaX < 0 ? 1 : -1));
  });
  viewport.addEventListener("pointercancel", () => { swipeStart = null; });

  showPhoto(0);
  viewport.append(image);
  gallery.append(viewport, previous, next);
  if (urls.length > 1) gallery.append(counter);
  return gallery;
}

export function offerCard(offer) {
  const card = node("article", "offer-card");
  const gallery = photoGallery(offer);
  if (gallery) card.append(gallery);
  else card.classList.add("offer-card-no-image");
  const content = node("div", "offer-content");
  const heading = node("div", "offer-heading");
  const title = node("div");
  title.append(node("p", "eyebrow", offer.modelName), node("h2", "offer-title", offer.title || offer.engine || offer.modelName));
  heading.append(title);
  if (offer.hasFieldDiscrepancy) heading.append(node("span", "badge badge-warning", "Rozbieżność pól"));
  content.append(heading, factsGrid(offer, true));

  const optional = optionalFields(offer);
  if (optional.length) {
    const list = node("ul", "optional-list");
    for (const [label, value] of optional) {
      const item = node("li", "optional-item");
      item.append(node("span", "optional-label", label), node("strong", "optional-value", value));
      list.append(item);
    }
    content.append(list);
  }

  const actions = node("div", "offer-actions");
  const picker = listingPicker(offer);
  const selected = picker.getSelected();
  if (picker.element) {
    actions.append(picker.element);
  }
  const directLink = openLink(selected);
  if (directLink) {
    if (picker.element) picker.element.addEventListener("change", () => {
      const chosen = picker.getSelected();
      const next = openLink(chosen);
      if (next) { directLink.href = next.href; directLink.textContent = `Otwórz ${chosen.sourceName} ↗`; }
    });
    actions.append(directLink);
  }
  content.append(actions);
  card.append(content);
  return card;
}
