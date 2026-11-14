import { normalizeText } from "../portal-screening.mjs";

export function groupModelsByMake(models) {
  const groups = new Map();
  for (const model of models) {
    const makeKey = normalizeText(model.brand).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || model.key;
    const group = groups.get(makeKey) ?? { id: makeKey, brand: model.brand, models: [] };
    group.models.push(model);
    groups.set(makeKey, group);
  }
  return [...groups.values()];
}

export function listingMatchesModel(listing, model) {
  const normalized = (value) => normalizeText(value).replace(/[^a-z0-9]+/g, " ").trim();
  const text = ` ${normalized(`${listing.title ?? ""} ${listing.visibleText ?? ""}`)} `;
  const brand = normalized(model.brand);
  const name = normalized(model.model);
  if (!name || !text.includes(` ${brand} `)) return false;
  if (/^\d+$/.test(name)) return text.includes(` ${brand} ${name} `);
  return text.includes(` ${name} `);
}
