import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT, loadSearchConfiguration } from "../config/load-search-config.mjs";
import { assessVehicleCondition } from "../search/shared/vehicle-condition.mjs";
import { apiFields } from "../search/direct/listing-data.mjs";
import { hasUnresolvedRequiredFields, mapCandidateToOffer } from "./mapper.mjs";
import { passesRequiredCriteria, upsertOfferFromSearch } from "./records.mjs";

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function stageAndCommit(files) {
  const staged = [];
  for (const item of files) {
    const tempPath = `${item.path}.cars-stage-${process.pid}`;
    await writeFile(tempPath, `${JSON.stringify(item.value, null, 2)}\n`, "utf8");
    staged.push({ ...item, tempPath, backupPath: `${item.path}.cars-backup-${process.pid}` });
  }
  const movedBackups = [];
  const installed = [];
  try {
    for (const item of staged) {
      try {
        await rename(item.path, item.backupPath);
        movedBackups.push(item);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await rename(item.tempPath, item.path);
      installed.push(item);
    }
  } catch (error) {
    for (const item of [...installed].reverse()) await rm(item.path, { force: true });
    for (const item of [...movedBackups].reverse()) await rename(item.backupPath, item.path).catch(() => {});
    for (const item of staged) await rm(item.tempPath, { force: true });
    throw error;
  }
  await Promise.all(movedBackups.map((item) => rm(item.backupPath, { force: true }).catch(() => {})));
}

function offerFilePath(modelKey) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(modelKey ?? "")) throw new Error("Nieprawidłowy klucz modelu.");
  return path.join(ROOT, "offers", `${modelKey}.json`);
}

export async function initializeOfferStore(modelKey, modelName) {
  const offerPath = offerFilePath(modelKey);
  try {
    await readFile(offerPath, "utf8");
    throw new Error(`Dane ofert ${modelKey} już istnieją.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(offerPath), { recursive: true });
  await stageAndCommit([{ path: offerPath, value: {
    schemaVersion: 3,
    updatedAt: new Date().toISOString(),
    model: { key: modelKey, name: modelName },
    offers: [],
  } }]);
}

export async function clearAllOfferListings() {
  const offersDir = path.join(ROOT, "offers");
  const files = (await readdir(offersDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const stagedFiles = [];
  let offers = 0;
  let listings = 0;

  for (const name of files) {
    const modelKey = path.basename(name, ".json");
    const filePath = path.join(offersDir, name);
    const current = await readJson(filePath);
    if (current.schemaVersion !== 3 || current.model?.key !== modelKey || !Array.isArray(current.offers)) {
      throw new Error(`Dane ${modelKey} są nieprawidłowe; importer nie wyczyścił żadnej bazy.`);
    }
    offers += current.offers.length;
    listings += current.offers.reduce((sum, offer) => sum + (Array.isArray(offer?.listings) ? offer.listings.length : 0), 0);
    stagedFiles.push({ path: filePath, value: { ...current, updatedAt: new Date().toISOString(), offers: [] } });
  }

  if (stagedFiles.length) await stageAndCommit(stagedFiles);
  return { models: stagedFiles.length, offers, listings };
}

export async function removeOfferStore(modelKey) {
  const offerPath = offerFilePath(modelKey);
  let current;
  try {
    current = await readJson(offerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: false, offers: 0 };
    throw error;
  }
  if (current.schemaVersion !== 3 || current.model?.key !== modelKey || !Array.isArray(current.offers)) {
    throw new Error(`Dane ofert ${modelKey} są nieprawidłowe; importer nie usunął pliku.`);
  }
  await rm(offerPath);
  return { removed: true, offers: current.offers.length };
}

export async function importDirectRun(runId) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(runId)) throw new Error("Nieprawidłowy identyfikator przebiegu.");
  const runDir = path.join(ROOT, "runs", "direct-search", runId);
  const runSummary = await readJson(path.join(runDir, "run.json"));
  if (runSummary.runId !== runId || runSummary.filterOnly || runSummary.sourceStatus !== "ready" ||
      ["blocked", "unavailable"].includes(runSummary.outcome)) {
    throw new Error("Przebieg nie ma potwierdzonego dostępu do źródła; import pominięty.");
  }
  const modelKeys = [...new Set((runSummary.results ?? []).map((result) => result.modelKey))];
  if (!modelKeys.length) return { runId, added: 0, updated: 0, skipped: 0, models: 0 };
  const loaded = await loadSearchConfiguration(runSummary.sourceId, modelKeys);
  const resultsDir = path.join(runDir, "results");
  const modelByKey = new Map(loaded.models.map((model) => [model.key, model]));
  const stagedFiles = [];
  const counts = { runId, added: 0, updated: 0, skipped: 0, models: 0 };
  for (const modelKey of modelKeys) {
    const model = modelByKey.get(modelKey);
    if (!model) throw new Error(`Brak aktywnego profilu ${modelKey} dla źródła ${runSummary.sourceId}.`);
    const resultPath = path.join(resultsDir, `${runSummary.sourceId}--${modelKey}.json`);
    const result = await readJson(resultPath);
    if (result.runId !== runId || result.modelKey !== modelKey || result.sourceId !== runSummary.sourceId) {
      throw new Error(`Plik wyniku nie pasuje do przebiegu: ${path.basename(resultPath)}.`);
    }
    const offerPath = path.join(ROOT, "offers", `${modelKey}.json`);
    let current;
    try { current = await readJson(offerPath); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      current = { schemaVersion: 3, model: { key: modelKey, name: model.name }, offers: [] };
    }
    if (current.schemaVersion !== 3 || !Array.isArray(current.offers)) {
      throw new Error(`Dane ${modelKey} wymagają migracji: uruchom npm run cars -- migrate-offers.`);
    }
    const groups = current.offers;
    const candidates = (result.candidates ?? []).filter((candidate) => candidate.classification?.status === "available");
    for (const candidate of candidates) {
      const sourcePayload = candidate.sourcePayload?.[runSummary.sourceId] ?? {};
      const conditionAssessment = assessVehicleCondition({ sourceId: runSummary.sourceId,
        listing: { title: candidate.title, visibleText: candidate.listingEvidence?.visibleText ?? "",
          sourceFields: sourcePayload.listingFields ?? candidate.sourceData?.listingFields ?? candidate.sourceData },
        detail: { ...(candidate.detail ?? {}),
          fields: { ...apiFields(candidate.apiResponses ?? []), ...(candidate.detail?.fields ?? {}) },
          sourceFields: sourcePayload.detailFields ?? candidate.detail?.sourceFields },
      });
      if (candidate.conditionAssessment?.isDamaged === true || conditionAssessment.isDamaged === true) {
        counts.skipped += 1;
        continue;
      }
      const mapped = mapCandidateToOffer(candidate, runSummary.sourceId);
      const offer = mapped.offer;
      if (!offer || !candidate.url || hasUnresolvedRequiredFields(candidate, model) || !passesRequiredCriteria(offer, model)) {
        counts.skipped += 1;
        continue;
      }
      const updated = upsertOfferFromSearch(groups, offer, {
        model,
        sourceId: runSummary.sourceId,
        sourceName: runSummary.sourceName ?? loaded.source.name,
        url: candidate.url,
        checkedAt: result.generatedAt ?? runSummary.completedAt,
        sourceExtensions: mapped.sourceExtensions,
        fieldEvidence: mapped.fieldEvidence,
      });
      counts[updated.action] += 1;
    }
    const value = {
      schemaVersion: 3,
      updatedAt: runSummary.completedAt ?? new Date().toISOString(),
      model: { key: modelKey, name: model.name },
      offers: groups,
    };
    stagedFiles.push({ path: offerPath, value });
  }
  await mkdir(path.join(ROOT, "offers"), { recursive: true });
  await stageAndCommit(stagedFiles);
  counts.models = stagedFiles.length;
  try {
    const historyPath = path.join(ROOT, "runs", "direct-search-history.jsonl");
    await mkdir(path.dirname(historyPath), { recursive: true });
    await appendFile(historyPath, `${JSON.stringify({ schemaVersion: 1, runId, sourceId: runSummary.sourceId,
      startedAt: runSummary.startedAt, completedAt: runSummary.completedAt, outcome: runSummary.outcome,
      models: runSummary.results?.length ?? 0,
      listingsSeen: (runSummary.results ?? []).reduce((sum, item) => sum + (item.listingsSeen ?? 0), 0),
      listingsOpened: (runSummary.results ?? []).reduce((sum, item) => sum + (item.listingsOpened ?? 0), 0),
      offersQualified: (runSummary.results ?? []).reduce((sum, item) => sum + (item.offersQualified ?? 0), 0),
      timings: runSummary.timings ?? [], import: { added: counts.added, updated: counts.updated, skipped: counts.skipped } })}\n`, "utf8");
    counts.metricsHistory = "saved";
  } catch {
    counts.metricsHistory = "save_failed";
  }
  try {
    await rm(runDir, { recursive: true, force: true });
    counts.runArtifacts = "cleaned_after_import";
  } catch {
    counts.runArtifacts = "retained_cleanup_failed";
  }
  return counts;
}
