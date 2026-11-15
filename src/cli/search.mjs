import { importDirectRun } from "../offers/import-run.mjs";
import { validateConfiguration } from "./configuration.mjs";

async function parseSearch(argv) {
  const options = { sourceId: null, modelKeys: [], headless: false, importOffers: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Brak wartości dla ${arg}.`);
      return value;
    };
    if (arg === "--source") options.sourceId = take();
    else if (arg === "--model") options.modelKeys.push(take());
    else if (arg === "--models") options.modelKeys.push(...take().split(",").map((key) => key.trim()).filter(Boolean));
    else if (arg === "--max-pages") options.maxPages = Number(take());
    else if (arg === "--max-cards") options.maxCards = Number(take());
    else if (arg === "--detail-concurrency") options.detailConcurrency = Number(take());
    else if (arg === "--headless") options.headless = true;
    else if (arg === "--no-import") options.importOffers = false;
    else if (arg === "--filters-only") options.filterOnly = true;
    else if (arg === "--url-filters") options.urlFilters = true;
    else if (arg === "--ui-filters") options.urlFilters = false;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`Nieznana opcja wyszukiwania: ${arg}.`);
  }
  if (!options.sourceId) throw new Error("Wyszukiwanie wymaga --source <id>; bez źródła nic nie zostanie uruchomione.");
  for (const [flag, value, min, max] of [["--max-pages", options.maxPages, 1, 20], ["--max-cards", options.maxCards, 1, 200],
    ["--detail-concurrency", options.detailConcurrency, 1, 8]]) {
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
      throw new Error(`${flag} musi być liczbą całkowitą z zakresu ${min}-${max}.`);
    }
  }
  return options;
}

async function search(argv, helpText) {
  const options = await parseSearch(argv);
  if (options.help) { process.stdout.write(helpText); return; }
  const { runDirectSearch } = await import("../search/direct/runner.mjs");
  const result = await runDirectSearch(options);
  let imported = { status: "disabled" };
  if (options.filterOnly) imported = { status: "not_applicable_filter_only" };
  else if (!options.importOffers) imported = { status: "not_requested" };
  else if (["completed", "partial"].includes(result.runSummary.outcome) && result.runSummary.sourceStatus === "ready") {
    imported = { status: "imported", ...await importDirectRun(result.runSummary.runId) };
  } else imported = { status: "skipped", reason: "search_not_importable" };
  process.stdout.write(`${JSON.stringify({ runId: result.runSummary.runId, sourceId: result.runSummary.sourceId,
    outcome: result.runSummary.outcome, searchGroups: result.runSummary.searchGroups, results: result.runSummary.results,
    ...(imported.runArtifacts === "cleaned_after_import" ? {} : { runDir: result.runDir }), import: imported }, null, 2)}\n`);
}

export async function runSearch(argv, helpText) {
  await validateConfiguration();
  return search(argv, helpText);
}
