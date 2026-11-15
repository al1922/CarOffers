import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readJson(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

function keyFromFile(fileName) {
  return fileName.replace(/\.json$/i, "");
}

function runtimeModel(profile, modelKey, sourceId, mapping) {
  const criteria = profile.criteria ?? {};
  const fields = profile.fields ?? {
    required: ["price", "year", "mileage", "engineVariant"],
    semiRequired: ["vin", "firstRegistrationDate", "transmission", "body"],
    optional: ["location", "photos", "cameraStatus", "fuel", "engineCapacity", "enginePower"],
  };
  const model = {
    ...profile,
    offersFile: `offers/${modelKey}.json`,
    knowledgeFile: profile.knowledgeFile ?? `knowledge/models/${modelKey}.json`,
    allowedEngineVariants: criteria.engineVariants ?? [],
    searchYears: { min: criteria.yearMin ?? null, max: criteria.yearMax ?? null },
    fieldPolicy: fields,
    requirements: {
      purchase: {
        minimumAdvertisedPricePln: criteria.minimumPricePln ?? null,
        maxAdvertisedPricePln: criteria.maximumAdvertisedPricePln ?? criteria.maximumGrossPricePln ?? null,
        auctionsAllowed: criteria.allowAuctions ?? false,
      },
      yearMin: criteria.yearMin ?? null,
      yearMax: criteria.yearMax ?? null,
      mileage: { hardMaxKm: criteria.maximumMileageKm ?? null },
    },
  };
  model.sourceMappings = { ...(profile.sourceMappings ?? {}), [sourceId]: mapping };
  return model;
}

function composeAdapterOptions(source, mappings) {
  return {
    ...structuredClone(source.adapterConfig ?? {}),
    modelMappings: Object.fromEntries(mappings),
  };
}

export async function loadSearchConfiguration(sourceId, requestedModelKeys = [], { includeUnsupported = false, allowDisabledSource = false } = {}) {
  if (!sourceId) throw new Error("Wymagane jest wskazanie źródła przez --source.");
  if (!/^[a-z0-9-]+$/.test(sourceId)) throw new Error(`Nieprawidłowy identyfikator źródła: ${sourceId}.`);
  const sourcePath = `config/sources/${sourceId}.json`;
  let source;
  try {
    source = await readJson(sourcePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Nieznane źródło: ${sourceId}.`);
    throw error;
  }
  if (source.id !== sourceId || (!allowDisabledSource && source.enabled !== true)) {
    throw new Error(`Źródło ${sourceId} nie jest aktywne.`);
  }

  const modelFiles = (await readdir(path.join(ROOT, "config/models")))
    .filter((file) => file.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  const mappingDirectory = path.join(ROOT, "config/source-mappings", sourceId);
  const models = [];
  const mappings = new Map();
  for (const file of modelFiles) {
    const profile = await readJson(`config/models/${file}`);
    const modelKey = profile.key ?? keyFromFile(file);
    const mappingPath = path.join(mappingDirectory, `${modelKey}.json`);
    let mapping;
    try {
      mapping = JSON.parse(await readFile(mappingPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (mapping.modelKey !== modelKey) throw new Error(`Mapowanie ${sourceId}/${modelKey} ma niezgodny modelKey.`);
    if ((!includeUnsupported && mapping.supported !== true) || profile.active !== true) continue;
    mappings.set(modelKey, mapping);
    models.push(runtimeModel(profile, modelKey, sourceId, mapping));
  }

  const requested = [...new Set(requestedModelKeys)];
  if (requested.length) {
    const byKey = new Map(models.map((model) => [model.key, model]));
    const missing = requested.filter((key) => !byKey.has(key));
    if (missing.length) {
      throw new Error(`Modele są nieaktywne albo nie mają mapowania dla ${sourceId}: ${missing.join(", ")}.`);
    }
    models.splice(0, models.length, ...requested.map((key) => byKey.get(key)));
  }
  if (!models.length) throw new Error(`Brak aktywnych modeli skonfigurowanych dla źródła ${sourceId}.`);

  const runtime = await readJson("config/search-runtime.json");
  return {
    root: ROOT,
    source,
    sourceConfig: source,
    adapterOptions: composeAdapterOptions(source, mappings),
    runtime,
    models,
    adapterPath: path.join(ROOT, "src/search/direct/adapters", `${source.adapter}.mjs`),
  };
}

export async function listModelProfiles() {
  const modelFiles = (await readdir(path.join(ROOT, "config/models")))
    .filter((file) => file.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(modelFiles.map((file) => readJson(`config/models/${file}`)));
}

export { ROOT };
