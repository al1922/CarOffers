import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, listModelProfiles, loadSearchConfiguration } from "../config/load-search-config.mjs";

export async function json(filePath) { return JSON.parse(await readFile(filePath, "utf8")); }
export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}
export function keyOk(key) { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key); }

export async function sourceFiles() {
  const directory = path.join(ROOT, "config", "sources");
  return (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
}

export async function syncSiteIndex() {
  const profiles = (await listModelProfiles()).filter((model) => model.active === true);
  const models = profiles.map((model) => ({
    key: model.key,
    name: model.name,
    brand: model.brand,
    model: model.model,
    generation: model.generation ?? "",
    bodies: model.bodies ?? [],
    criteria: model.criteria,
    fields: model.fields,
    file: `offers/${model.key}.json`,
    knowledgeFile: model.knowledgeFile,
  }));
  await writeJson(path.join(ROOT, "models.json"), { version: 2, generatedAt: new Date().toISOString(), models });
  return models.length;
}

export async function validateConfiguration() {
  const profiles = await listModelProfiles();
  const keys = new Set();
  const profileFiles = (await readdir(path.join(ROOT, "config", "models"))).filter((file) => file.endsWith(".json"));
  for (const file of profileFiles) {
    const profile = await json(path.join(ROOT, "config", "models", file));
    if (file !== `${profile.key}.json`) throw new Error(`Nazwa pliku profilu ${file} nie odpowiada kluczowi ${profile.key}.`);
  }
  for (const profile of profiles) {
    if (!keyOk(profile.key) || keys.has(profile.key)) throw new Error(`Nieprawidłowy lub powtórzony klucz modelu: ${profile.key}.`);
    keys.add(profile.key);
    if (!profile.name || !profile.brand || !profile.model) throw new Error(`Model ${profile.key} wymaga name, brand i model.`);
    if (profile.version !== 1 || typeof profile.active !== "boolean") throw new Error(`Model ${profile.key} wymaga wersji profilu 1 i pola active typu boolean.`);
    const criteria = profile.criteria ?? {};
    if (!Array.isArray(criteria.engineVariants) || !criteria.engineVariants.length) throw new Error(`Model ${profile.key} nie ma engineVariants.`);
    for (const field of ["minimumPricePln", "maximumAdvertisedPricePln", "maximumMileageKm"]) {
      if (!Number.isFinite(criteria[field]) || criteria[field] < 0) throw new Error(`Model ${profile.key}: nieprawidłowe criteria.${field}.`);
    }
    if (criteria.minimumPricePln > criteria.maximumAdvertisedPricePln) throw new Error(`Model ${profile.key}: minimumPricePln przekracza maksimum ceny ogłoszenia.`);
    if (new Set(criteria.engineVariants).size !== criteria.engineVariants.length) throw new Error(`Model ${profile.key}: powtórzony wariant silnika.`);
    if (!Number.isInteger(criteria.yearMin) || criteria.yearMin < 1886) throw new Error(`Model ${profile.key}: nieprawidłowe criteria.yearMin.`);
    if (criteria.yearMax !== null && (!Number.isInteger(criteria.yearMax) || criteria.yearMax < criteria.yearMin)) {
      throw new Error(`Model ${profile.key}: nieprawidłowe criteria.yearMax.`);
    }
    if (criteria.allowAuctions !== undefined && typeof criteria.allowAuctions !== "boolean") {
      throw new Error(`Model ${profile.key}: criteria.allowAuctions musi być wartością logiczną.`);
    }
    for (const group of ["required", "semiRequired", "optional"]) {
      if (!Array.isArray(profile.fields?.[group])) throw new Error(`Model ${profile.key}: fields.${group} musi być listą.`);
      if (new Set(profile.fields[group]).size !== profile.fields[group].length ||
          profile.fields[group].some((field) => typeof field !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(field))) {
        throw new Error(`Model ${profile.key}: fields.${group} zawiera powtórzone lub nieprawidłowe pola.`);
      }
    }
    for (const coreField of ["price", "year", "mileage", "engineVariant"]) {
      if (!profile.fields.required.includes(coreField)) throw new Error(`Model ${profile.key}: wymagane jest pole fields.required.${coreField}.`);
    }
    const allFields = [
      ...profile.fields.required,
      ...profile.fields.semiRequired,
      ...profile.fields.optional,
    ];
    if (new Set(allFields).size !== allFields.length) throw new Error(`Model ${profile.key}: pole występuje w kilku grupach fields.`);

    const knowledgeFile = `knowledge/models/${profile.key}.json`;
    if (profile.knowledgeFile !== knowledgeFile) throw new Error(`Model ${profile.key}: knowledgeFile musi wskazywać ${knowledgeFile}.`);
    const knowledge = await json(path.join(ROOT, knowledgeFile));
    if (knowledge.version !== 2 || knowledge.modelKey !== profile.key ||
        !Array.isArray(knowledge.engineClaims) || !Array.isArray(knowledge.sources)) {
      throw new Error(`Karta wiedzy ${profile.key} jest niekompletna lub ma niezgodną wersję.`);
    }
    const sourceIds = new Set();
    const invalidSource = knowledge.sources.some((source) => {
      if (!source || typeof source.id !== "string" || !source.id.trim() || sourceIds.has(source.id) ||
          typeof source.title !== "string" || !source.title.trim() || !/^https?:\/\//.test(source.url ?? "")) return true;
      sourceIds.add(source.id);
      return false;
    });
    const claimIds = new Set();
    const invalidClaim = knowledge.engineClaims.some((claim) => {
      if (!claim || typeof claim.id !== "string" || !claim.id.trim() || claimIds.has(claim.id) ||
          !Array.isArray(claim.sourceIds) || !claim.sourceIds.length ||
          claim.sourceIds.some((id) => typeof id !== "string" || !sourceIds.has(id)) ||
          !["high", "medium", "low"].includes(claim.confidence) ||
          !claim.scope || typeof claim.scope !== "object" || Array.isArray(claim.scope) || !Array.isArray(claim.notes)) return true;
      claimIds.add(claim.id);
      return false;
    });
    if (invalidSource || invalidClaim) {
      throw new Error(`Karta wiedzy ${profile.key} zawiera nieprawidłowe twierdzenia lub źródła.`);
    }
  }

  for (const directory of ["offers", path.join("knowledge", "models")]) {
    const modelDataFiles = (await readdir(path.join(ROOT, directory))).filter((file) => file.endsWith(".json"));
    for (const file of modelDataFiles) {
      const modelKey = file.replace(/\.json$/i, "");
      if (!keys.has(modelKey)) throw new Error(`Osierocony plik ${directory}/${file}.`);
    }
  }

  const sourceIds = new Set();
  for (const file of await sourceFiles()) {
    const source = await json(path.join(ROOT, "config", "sources", file));
    if (!/^[a-z0-9-]+$/.test(source.id) || !source.name || typeof source.enabled !== "boolean") {
      throw new Error(`Nieprawidłowa konfiguracja źródła ${file}.`);
    }
    if (sourceIds.has(source.id) || file !== `${source.id}.json`) throw new Error(`Powtórzony lub niespójny plik źródła ${file}.`);
    sourceIds.add(source.id);
    if (!/^https:\/\//.test(source.searchUrl) || !source.adapter) throw new Error(`Źródło ${source.id} wymaga searchUrl i adaptera.`);
    const adapterPath = path.join(ROOT, "src", "search", "direct", "adapters", `${source.adapter}.mjs`);
    if (!/^[a-z0-9-]+$/.test(source.adapter)) throw new Error(`Nieprawidłowy identyfikator adaptera źródła ${source.id}.`);
    if (source.enabled) {
      await readFile(adapterPath, "utf8");
      const adapterModule = await import(pathToFileURL(adapterPath).href);
      if (!Object.values(adapterModule).some((value) => value?.id === source.id)) {
        throw new Error(`Adapter ${source.adapter} nie eksportuje identyfikatora ${source.id}.`);
      }
    }
    for (const profile of profiles) {
      const mappingPath = path.join(ROOT, "config", "source-mappings", source.id, `${profile.key}.json`);
      try {
        const mapping = await json(mappingPath);
        if (mapping.modelKey !== profile.key || typeof mapping.supported !== "boolean") {
          throw new Error(`Nieprawidłowe mapowanie ${source.id}/${profile.key}.`);
        }
        for (const field of ["makeSlug", "modelSlug"]) {
          if (mapping[field] !== undefined && typeof mapping[field] !== "string") throw new Error(`Mapowanie ${source.id}/${profile.key}: ${field} musi być tekstem.`);
        }
        for (const field of ["generationFilterLabel", "generationUrlValue", "bodyUrlValue"]) {
          if (mapping[field] !== undefined && mapping[field] !== null && typeof mapping[field] !== "string") {
            throw new Error(`Mapowanie ${source.id}/${profile.key}: ${field} musi być tekstem lub null.`);
          }
        }
        for (const field of ["makeId", "modelId"]) {
          if (mapping[field] !== undefined && !["string", "number"].includes(typeof mapping[field])) throw new Error(`Mapowanie ${source.id}/${profile.key}: ${field} musi być tekstem lub liczbą.`);
        }
        for (const field of ["omitGenerationInUrl", "omitGenerationFilter", "omitBodyInUrl", "yearInQuery"]) {
          if (mapping[field] !== undefined && typeof mapping[field] !== "boolean") throw new Error(`Mapowanie ${source.id}/${profile.key}: ${field} musi być wartością logiczną.`);
        }
        if (mapping.bodyAliases !== undefined && (mapping.bodyAliases === null || typeof mapping.bodyAliases !== "object" || Array.isArray(mapping.bodyAliases) ||
            Object.entries(mapping.bodyAliases).some(([alias, value]) => !alias.trim() || typeof value !== "string" || !value.trim()))) {
          throw new Error(`Mapowanie ${source.id}/${profile.key}: bodyAliases musi być obiektem.`);
        }
      } catch (error) {
        if (error?.code === "ENOENT") throw new Error(`Brak mapowania źródła ${source.id} dla modelu ${profile.key}.`);
        throw error;
      }
    }
  }
  for (const directory of await readdir(path.join(ROOT, "config", "source-mappings"), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    if (!sourceIds.has(directory.name)) throw new Error(`Osierocony katalog mapowań źródła: ${directory.name}.`);
    for (const file of await readdir(path.join(ROOT, "config", "source-mappings", directory.name))) {
      if (!file.endsWith(".json")) continue;
      const modelKey = file.replace(/\.json$/i, "");
      if (!keys.has(modelKey)) throw new Error(`Osierocone mapowanie ${directory.name}/${file}.`);
    }
  }
  await json(path.join(ROOT, "config", "search-runtime.json"));

  const seenVins = new Set();
  for (const profile of profiles) {
    const offersPath = path.join(ROOT, "offers", `${profile.key}.json`);
    const file = await json(offersPath);
    if (file.schemaVersion !== 3 || file.model?.key !== profile.key || !Array.isArray(file.offers)) {
      throw new Error(`Dane ofert ${profile.key} nie mają formatu v3; uruchom npm run cars -- migrate-offers.`);
    }
    const groupIds = new Set();
    for (const group of file.offers) {
      if (group.modelKey !== profile.key || !group.id || !Array.isArray(group.listings) || !group.listings.length) {
        throw new Error(`Nieprawidłowy rekord oferty w ${profile.key}.`);
      }
      if (groupIds.has(group.id)) throw new Error(`Powtórzony rekord ${group.id} w ${profile.key}.`);
      groupIds.add(group.id);
      if (!group.listings.some((listing) => listing.key === group.primaryListingKey)) {
        throw new Error(`Brak głównego ogłoszenia dla ${group.id}.`);
      }
      const vin = String(group.identityKey ?? "").match(/^vin:([A-HJ-NPR-Z0-9]{17})$/)?.[1];
      if (vin) {
        const composite = `${profile.key}:${vin}`;
        if (seenVins.has(composite)) throw new Error(`VIN ${vin} jest zapisany w kilku rekordach ${profile.key}.`);
        seenVins.add(composite);
      }
      for (const listing of group.listings) {
        if (!listing.key || !listing.sourceId || !/^https:\/\//.test(listing.url) || !listing.facts) {
          throw new Error(`Nieprawidłowy link źródłowy w rekordzie ${group.id}.`);
        }
        if (new Set(group.listings.map((listing) => listing.key)).size !== group.listings.length) {
          throw new Error(`Powtórzony link źródłowy w rekordzie ${group.id}.`);
        }
      }
    }
  }

  const index = await json(path.join(ROOT, "models.json"));
  const expectedModels = profiles.filter((profile) => profile.active === true).map((profile) => ({
    key: profile.key,
    name: profile.name,
    brand: profile.brand,
    model: profile.model,
    generation: profile.generation ?? "",
    bodies: profile.bodies ?? [],
    criteria: profile.criteria,
    fields: profile.fields,
    file: `offers/${profile.key}.json`,
    knowledgeFile: profile.knowledgeFile,
  }));
  if (!Array.isArray(index.models) || index.version !== 2 || !Number.isFinite(Date.parse(index.generatedAt)) ||
      JSON.stringify(index.models) !== JSON.stringify(expectedModels)) {
    throw new Error("models.json nie odpowiada aktywnym profilom; uruchom npm run cars -- sync.");
  }
  return { models: profiles.length, sources: (await sourceFiles()).length };
}

export async function listModels(sourceId) {
  if (!sourceId) {
    for (const profile of await listModelProfiles()) process.stdout.write(`${profile.active ? "active" : "inactive"}\t${profile.key}\t${profile.name}\n`);
    return;
  }
  const loaded = await loadSearchConfiguration(sourceId);
  for (const model of loaded.models) process.stdout.write(`${model.key}\t${model.name}\t${model.criteria.minimumPricePln}-${model.criteria.maximumAdvertisedPricePln} PLN\t${model.criteria.engineVariants.join(", ")}\n`);
}

export async function previewUrls(argv) {
  const { values } = argsMap(argv);
  if (!values.source) throw new Error("Podgląd URL wymaga --source <id>.");
  const requested = values.model ? [values.model] : [];
  const loaded = await loadSearchConfiguration(values.source, requested, { includeUnsupported: true, allowDisabledSource: true });
  const adapterModule = await import(pathToFileURL(loaded.adapterPath).href);
  const adapter = Object.values(adapterModule).find((value) => value?.id === values.source);
  if (!adapter?.prepareFilterPlan || !adapter?.buildFilteredSearchUrl) throw new Error(`Adapter ${values.source} nie udostępnia generatora URL.`);
  const results = loaded.models.map((model) => {
    const group = { id: `${values.source}-${model.key}`, brand: model.brand, models: [model] };
    const plan = adapter.prepareFilterPlan(group, loaded.adapterOptions);
    const built = adapter.buildFilteredSearchUrl(group, plan, loaded.sourceConfig.searchUrl);
    return { modelKey: model.key, mappingSupported: model.sourceMappings?.[values.source]?.supported === true,
      url: built.url, filtersApplied: built.filtersApplied ?? {}, omittedFilters: plan.omittedFilters ?? [] };
  });
  process.stdout.write(`${JSON.stringify({ sourceId: values.source, sourceName: loaded.source.name, urls: results }, null, 2)}\n`);
}

export function argsMap(argv) {
  const output = { values: {}, repeated: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Nieznany argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Brak wartości dla ${arg}.`);
    if (key === "set") (output.repeated[key] ??= []).push(value);
    else output.values[key] = value;
  }
  return output;
}
