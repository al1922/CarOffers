#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDirectSearch } from "./direct-search/runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `Usage:
  npm run search:direct -- --source otomoto [--model <model-key> ...]
       [--models <key1,key2,...>] [--max-pages <n>] [--max-cards <n>]
       [--detail-concurrency <n>] [--headless] [--no-import] [--filters-only] [--ui-filters]

Runs a separate visible-browser search flow for one portal. For OTOMOTO it
opens per-model URLs with filters encoded; --ui-filters selects the older form
interaction. It records same-session XHR/Fetch JSON responses, opens
result cards and classifies them. Qualified offers are imported locally through
the existing preview, conflict check, deduplication and transaction workflow.
Pass --no-import to keep the run as a review-only result.
Pass --filters-only to set and audit the first results request without opening offer cards or importing data.
HTTP 401/403/429, CAPTCHA and other access challenges stop the source run.
`;

function parseArgs(argv) {
  const options = { sourceId: null, modelKeys: [], headless: false, importOffers: true, urlFilters: true };
  const valueAfter = (index, option) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Brak wartości dla ${option}.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--source") options.sourceId = valueAfter(index++, arg);
    else if (arg === "--model") options.modelKeys.push(valueAfter(index++, arg));
    else if (arg === "--models") options.modelKeys.push(...valueAfter(index++, arg).split(",").map((value) => value.trim()).filter(Boolean));
    else if (arg === "--max-pages") options.maxPages = Number(valueAfter(index++, arg));
    else if (arg === "--max-cards") options.maxCards = Number(valueAfter(index++, arg));
    else if (arg === "--detail-concurrency") options.detailConcurrency = Number(valueAfter(index++, arg));
    else if (arg === "--headless") options.headless = true;
    else if (arg === "--no-import") options.importOffers = false;
    else if (arg === "--filters-only") options.filterOnly = true;
    else if (arg === "--url-filters") options.urlFilters = true;
    else if (arg === "--ui-filters") options.urlFilters = false;
    else throw new Error(`Nieznana opcja: ${arg}`);
  }
  if (options.help) return options;
  if (!options.sourceId) throw new Error("Wymagane jest --source <source-id>.");
  for (const [name, value, min, max] of [["--max-pages", options.maxPages, 1, 20], ["--max-cards", options.maxCards, 1, 200],
    ["--detail-concurrency", options.detailConcurrency, 1, 8]]) {
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
      throw new Error(`${name} musi być liczbą całkowitą z zakresu ${min}-${max}.`);
    }
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(HELP);
  else {
    const result = await runDirectSearch(options);
    let importResult = { status: "disabled" };
    if (options.filterOnly) importResult = { status: "not_applicable_filter_only" };
    else if (!options.importOffers) importResult = { status: "not_requested" };
    else if (!["completed", "partial"].includes(result.runSummary.outcome) || result.runSummary.sourceStatus !== "ready") {
      importResult = { status: "skipped", reason: "search_not_importable" };
    } else {
      const imported = spawnSync("python", ["-B", path.join(ROOT, "scripts/car-search.py"), "direct-import",
        "--root", ROOT, "--run", result.runSummary.runId], { cwd: ROOT, encoding: "utf8" });
      if (imported.error) {
        importResult = { status: "error", message: imported.error.message };
        process.exitCode = 2;
      } else {
        try { importResult = JSON.parse(imported.stdout.trim()); }
        catch { importResult = { status: "error", message: imported.stderr?.trim() || imported.stdout?.trim() || "Import command returned no summary." }; }
        if (imported.status !== 0) process.exitCode = imported.status ?? 2;
      }
      if (imported.stderr?.trim()) process.stderr.write(`${imported.stderr.trim()}\n`);
    }
    process.stdout.write(`${JSON.stringify({ runId: result.runSummary.runId, sourceId: result.runSummary.sourceId,
      outcome: result.runSummary.outcome, filterOnly: result.runSummary.filterOnly, searchGroups: result.runSummary.searchGroups,
      results: result.runSummary.results, runDir: result.runDir,
      stageTotals: result.timings.stageTotals, import: importResult }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 2;
}
