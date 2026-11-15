import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { ROOT, listModelProfiles } from "../config/load-search-config.mjs";
import { initializeOfferStore, removeOfferStore } from "../offers/import-run.mjs";
import { argsMap, json, keyOk, sourceFiles, writeJson, syncSiteIndex, validateConfiguration } from "./configuration.mjs";

export async function addModel(argv) {
  const { values } = argsMap(argv);
  const { key, name, brand, model, engines } = values;
  if (!keyOk(key ?? "") || !name || !brand || !model || !engines) throw new Error("Podaj --key, --name, --brand, --model oraz --engines.");
  const profilePath = path.join(ROOT, "config", "models", `${key}.json`);
  try { await readFile(profilePath); throw new Error(`Model ${key} już istnieje.`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const offersPath = path.join(ROOT, "offers", `${key}.json`);
  try { await readFile(offersPath); throw new Error(`Istnieją już dane ofert dla ${key}; CLI ich nie nadpisze.`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const number = (field) => {
    const parsed = Number(values[field]);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Nieprawidłowe --${field}.`);
    return parsed;
  };
  const yearMin = number("year-min");
  const profile = {
    version: 1, key, name, brand, model, generation: values.generation ?? "", bodies: values.body ? [values.body] : [],
    active: true,
    criteria: {
      minimumPricePln: number("price-min"), maximumAdvertisedPricePln: number("price-max"),
      yearMin, yearMax: values["year-max"] ? Number(values["year-max"]) : null,
      maximumMileageKm: number("mileage-max"), engineVariants: [...new Set(engines.split(",").map((item) => item.trim()).filter(Boolean))],
      allowAuctions: false,
    },
    fields: {
      required: ["price", "year", "mileage", "engineVariant"],
      semiRequired: ["vin", "firstRegistrationDate", "transmission", "body"],
      optional: ["location", "photos", "cameraStatus", "fuel"],
    },
    knowledgeFile: `knowledge/models/${key}.json`,
  };
  const knowledgePath = path.join(ROOT, "knowledge", "models", `${key}.json`);
  const knowledge = { version: 2, modelKey: key, engineClaims: [], sources: [] };
  let createKnowledge = false;
  try {
    const existingKnowledge = await json(knowledgePath);
    if (existingKnowledge.modelKey !== key) throw new Error(`Karta wiedzy ${key} należy do innego modelu.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    createKnowledge = true;
  }
  if (!profile.criteria.engineVariants.length) throw new Error("Podaj przynajmniej jeden wariant w --engines.");
  if (!Number.isInteger(yearMin) || yearMin < 1886) throw new Error("--year-min musi być rokiem od 1886.");
  if (profile.criteria.minimumPricePln > profile.criteria.maximumAdvertisedPricePln) throw new Error("--price-min nie może przekraczać --price-max.");
  if (profile.criteria.yearMax !== null && (!Number.isInteger(profile.criteria.yearMax) || profile.criteria.yearMax < yearMin)) {
    throw new Error("--year-max musi być całkowitym rokiem nie mniejszym niż --year-min.");
  }
  const sources = await sourceFiles();
  const mappings = [];
  for (const sourceFile of sources) {
    const source = await json(path.join(ROOT, "config", "sources", sourceFile));
    const mappingPath = path.join(ROOT, "config", "source-mappings", source.id, `${key}.json`);
    try { await readFile(mappingPath); throw new Error(`Istnieje już mapowanie ${source.id}/${key}; CLI go nie nadpisze.`); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    const mapping = { modelKey: key, supported: false };
    mappings.push({ mappingPath, mapping });
  }
  await writeJson(profilePath, profile);
  for (const { mappingPath, mapping } of mappings) await writeJson(mappingPath, mapping);
  if (createKnowledge) await writeJson(knowledgePath, knowledge);
  await initializeOfferStore(key, name);
  await syncSiteIndex();
  await validateConfiguration();
  process.stdout.write(`Dodano profil ${key}. Mapowania źródeł są wyłączone do czasu weryfikacji.\n`);
}

export async function updateModel(action, argv) {
  const { values, repeated } = argsMap(argv);
  const key = values.model;
  if (!keyOk(key ?? "")) throw new Error("Podaj --model <key>.");
  const profilePath = path.join(ROOT, "config", "models", `${key}.json`);
  const profile = await json(profilePath);
  if (action === "activate" || action === "deactivate") {
    profile.active = action === "activate";
    await writeJson(profilePath, profile);
  } else if (action === "mapping") {
    const sourceId = values.source;
    if (!/^[a-z0-9-]+$/.test(sourceId ?? "")) throw new Error("Dla mapping wymagane jest prawidłowe --source.");
    const mappingPath = path.join(ROOT, "config", "source-mappings", sourceId, `${key}.json`);
    const mapping = await json(mappingPath);
    for (const item of repeated.set ?? []) {
      const separator = item.indexOf("=");
      if (separator < 1) throw new Error(`Mapowanie musi mieć format pole=wartość: ${item}`);
      const field = item.slice(0, separator);
      const raw = item.slice(separator + 1);
      let value;
      try { value = JSON.parse(raw); } catch { value = raw; }
      mapping[field] = value;
    }
    await writeJson(mappingPath, mapping);
  } else if (action === "criteria") {
    const allowed = new Set(["minimumPricePln", "maximumAdvertisedPricePln", "yearMin", "yearMax", "maximumMileageKm", "engineVariants", "allowAuctions"]);
    for (const item of repeated.set ?? []) {
      const separator = item.indexOf("=");
      if (separator < 1) throw new Error(`Kryterium musi mieć format pole=wartość: ${item}`);
      const field = item.slice(0, separator);
      if (!allowed.has(field)) throw new Error(`Nieznane kryterium modelu: ${field}.`);
      const raw = item.slice(separator + 1);
      let value;
      try { value = JSON.parse(raw); } catch { value = raw; }
      profile.criteria[field] = value;
    }
    await writeJson(profilePath, profile);
  } else if (action === "fields") {
    const groups = new Set(["required", "semiRequired", "optional"]);
    for (const item of repeated.set ?? []) {
      const separator = item.indexOf("=");
      if (separator < 1) throw new Error(`Pola modelu muszą mieć format grupa=[...]: ${item}`);
      const field = item.slice(0, separator);
      if (!groups.has(field)) throw new Error(`Nieznana grupa pól: ${field}.`);
      let value;
      try { value = JSON.parse(item.slice(separator + 1)); }
      catch { throw new Error(`Pola ${field} przekaż jako tablicę JSON, np. [\"fuel\",\"photos\"].`); }
      if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(name)) ||
          new Set(value).size !== value.length) {
        throw new Error(`fields.${field} musi być tablicą unikalnych nazw pól.`);
      }
      profile.fields[field] = value;
    }
    for (const coreField of ["price", "year", "mileage", "engineVariant"]) {
      if (!profile.fields.required.includes(coreField)) throw new Error(`Pola wymagane muszą zawierać ${coreField}.`);
    }
    const allFields = [...profile.fields.required, ...profile.fields.semiRequired, ...profile.fields.optional];
    if (new Set(allFields).size !== allFields.length) throw new Error("Pole nie może należeć do kilku grup.");
    await writeJson(profilePath, profile);
  } else if (action === "remove") {
    await removeOfferStore(key);
    const mappingRoot = path.join(ROOT, "config", "source-mappings");
    for (const sourceId of await readdir(mappingRoot)) await rm(path.join(mappingRoot, sourceId, `${key}.json`), { force: true });
    await rm(profilePath, { force: true });
    await rm(path.join(ROOT, "knowledge", "models", `${key}.json`), { force: true });
  }
  await syncSiteIndex();
  await validateConfiguration();
  process.stdout.write(`Zaktualizowano model ${key}: ${action}.\n`);
}
