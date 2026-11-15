import { projectOfferGroup } from "../src/offers/records.mjs";

async function json(relativePath) {
  const response = await fetch(new URL(`../${relativePath}`, import.meta.url), { cache: "no-store" });
  if (!response.ok) throw new Error(`${relativePath} (HTTP ${response.status})`);
  return response.json();
}

export async function loadData() {
  const index = await json("models.json");
  const models = (index.models ?? []).filter((model) =>
    /^[a-z0-9-]+$/.test(model.key) && model.file === `offers/${model.key}.json`);
  if (!models.length) throw new Error("Brak aktywnych modeli w models.json.");

  const results = await Promise.all(models.map(async (model) => {
    try {
      const data = await json(model.file);
      if (data.schemaVersion !== 3 || data.model?.key !== model.key || !Array.isArray(data.offers)) {
        throw new Error("Nieobsługiwany format danych ofert. Uruchom migrację ofert w projekcie.");
      }
      model.count = data.offers.length;
      model.updatedAt = data.updatedAt ?? null;
      return data.offers.map((group) => projectOfferGroup(group, model));
    } catch (error) {
      model.loadError = true;
      model.loadErrorText = error.message;
      return [];
    }
  }));

  return { models, offers: results.flat(), generatedAt: index.generatedAt ?? null };
}
