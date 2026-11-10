#!/usr/bin/env node
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, "node_modules", ".cache", "ms-playwright");
const { chromium } = await import("playwright");
const sourcesArg = process.argv.indexOf("--sources");
const wantedSources = new Set(sourcesArg >= 0 ? (process.argv[sourcesArg + 1] ?? "").split(",").filter(Boolean) : ["automarket", "autoplac", "olx"]);
const runDirs = (await readdir(path.join(ROOT, "runs"), { withFileTypes: true }))
  .filter((item) => item.isDirectory()).map((item) => item.name);
const [modelConfig, sourceConfig, pilot] = await Promise.all([
  readFile(path.join(ROOT, "config/search-models.json"), "utf8").then(JSON.parse),
  readFile(path.join(ROOT, "config/sources.json"), "utf8").then(JSON.parse),
  readFile(path.join(ROOT, "reports/portal-adapter-pilot.json"), "utf8").then(JSON.parse),
]);
const enabledSourceIds = new Set(sourceConfig.sources.filter((source) => source.enabled).map((source) => source.id));
for (const id of wantedSources) if (!enabledSourceIds.has(id)) throw new Error(`Unknown enabled source: ${id}`);
const activeModels = new Map(modelConfig.models.filter((model) => model.active).map((model) => [model.key, model]));
const blockedSources = new Set(pilot.results.filter((result) => result.status === "blocked").map((result) => result.sourceId));
const knownUrls = new Set();
for (const model of activeModels.values()) {
  const doc = JSON.parse(await readFile(path.join(ROOT, model.offersFile), "utf8"));
  for (const key of ["offers", "archive"]) for (const offer of doc[key] ?? []) {
    for (const link of offer.urls ?? []) if (link?.url) knownUrls.add(canonical(link.url));
  }
}

const samples = new Map();
for (const runId of runDirs) {
  const runDir = path.join(ROOT, "runs", runId);
  let queue;
  try { queue = JSON.parse(await readFile(path.join(runDir, "tasks.json"), "utf8")); }
  catch { continue; }
  const tasks = new Map(queue.tasks.filter((task) => task.kind === "search").map((task) => [task.id, task]));
  const resultDir = path.join(runDir, "results");
  let files = [];
  try { files = await import("node:fs/promises").then(({ readdir }) => readdir(resultDir)); } catch { continue; }
  for (const name of files.filter((value) => value.endsWith(".json") && !value.startsWith("tasks-before-cancel"))) {
    let result;
    try { result = JSON.parse(await readFile(path.join(resultDir, name), "utf8")); } catch { continue; }
    const task = tasks.get(result.taskId);
    if (!task || !wantedSources.has(task.sourceId) || blockedSources.has(task.sourceId)) continue;
    const model = activeModels.get(task.modelKey);
    if (!model || samples.has(task.sourceId)) continue;
    for (const offer of result.offers ?? []) {
      if (offer.modelKey !== task.modelKey) continue;
      const url = (offer.urls ?? []).map((link) => link?.url).find((item) => item && !knownUrls.has(canonical(item)));
      if (url) {
        samples.set(task.sourceId, { sourceId: task.sourceId, modelKey: task.modelKey, modelName: model.name, url });
        break;
      }
    }
  }
}

function canonical(value) {
  try { const url = new URL(value); url.hash = ""; url.hostname = url.hostname.toLowerCase(); url.pathname = url.pathname.replace(/\/$/, ""); return url.href; }
  catch { return String(value); }
}

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const sample of samples.values()) {
    const page = await browser.newPage();
    const started = Date.now();
    try {
      const response = await page.goto(sample.url, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(450);
      const body = await page.locator("body").innerText().catch(() => "");
      const title = await page.title().catch(() => "");
      const signals = {
        anyDisplayedPrice: /\d[\d\s.,]*\s*(?:zł|pln)/i.test(body),
        grossPriceWords: /brutto|cena/i.test(body),
        productionYearLabel: /rok produkcji|produkcja/i.test(body),
        firstRegistrationLabel: /pierwsza rejestracja|data pierwszej rejestracji/i.test(body),
        mileageLabel: /przebieg|\bkm\b/i.test(body),
        engineLabel: /silnik|pojemność|cm³|km\b|kw\b/i.test(body),
        transmissionLabel: /skrzynia|manualna|automatyczna|dsg|cvt/i.test(body),
        bodyLabel: /nadwozie|kombi|wagon|sedan|hatchback|suv/i.test(body),
        lpgMention: /\blpg\b|\bgaz\b/i.test(body),
        cameraMention: /kamera cofania|kamera 360|kamera/i.test(body),
        damageMention: /bezwypadk|uszkodze|kolizj|szkod/i.test(body),
      };
      results.push({ sourceId: sample.sourceId, modelKey: sample.modelKey, status: response && response.status() < 400 ? "page_read" : "http_error",
        httpStatus: response?.status() ?? null, titleLength: title.length, bodyTextChars: body.length,
        elapsedMs: Date.now() - started, signals });
    } catch (error) {
      results.push({ sourceId: sample.sourceId, modelKey: sample.modelKey, status: "access_error", elapsedMs: Date.now() - started,
        error: String(error?.message ?? error).split("\n")[0].slice(0, 220) });
    } finally { await page.close().catch(() => {}); }
  }
} finally { await browser.close(); }

const report = { version: 1, checkedAt: new Date().toISOString(),
  note: "Read-only card smoke checks using previously recorded sample URLs absent from active/archive offer data. No photos analyzed; no facts or offers imported.",
  samplesChecked: results.length, results };
const reportPath = path.join(ROOT, "reports", "portal-card-pilot.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ reportPath: path.relative(ROOT, reportPath), samplesChecked: results.length, results }, null, 2)}\n`);
