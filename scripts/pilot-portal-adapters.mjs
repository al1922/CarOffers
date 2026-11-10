#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [, , ...args] = process.argv;
const concurrencyArg = args.indexOf("--concurrency");
const concurrency = concurrencyArg >= 0 ? Number(args[concurrencyArg + 1]) : 3;
const sourceFilter = new Set();
const inspectCardSources = new Set();
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--source" && args[i + 1]) sourceFilter.add(args[++i]);
  else if (args[i] === "--inspect-card-source" && args[i + 1]) inspectCardSources.add(args[++i]);
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error("--concurrency must be between 1 and 4");
}

const [sourceConfig, modelConfig, queue] = await Promise.all([
  readFile(path.join(ROOT, "config/sources.json"), "utf8").then(JSON.parse),
  readFile(path.join(ROOT, "config/search-models.json"), "utf8").then(JSON.parse),
  readFile(path.join(ROOT, "runs/search-20261109/tasks.json"), "utf8").then(JSON.parse),
]);
const sources = sourceConfig.sources.filter((source) => source.enabled && (!sourceFilter.size || sourceFilter.has(source.id)));
const unknownSources = [...sourceFilter].filter((id) => !sourceConfig.sources.some((source) => source.id === id));
if (unknownSources.length) throw new Error(`Unknown source(s): ${unknownSources.join(", ")}`);
const models = new Map(modelConfig.models.filter((model) => model.active).map((model) => [model.key, model]));
const templates = new Map();
for (const task of queue.tasks) {
  if (task.kind !== "search" || !models.has(task.modelKey)) continue;
  const group = templates.get(task.sourceId) ?? [];
  group.push(task);
  templates.set(task.sourceId, group);
}
const jobs = sources.map((source) => {
  const candidates = templates.get(source.id) ?? [];
  const wantedBrands = new Set((source.brands ?? []).map((brand) => brand.toLocaleLowerCase("pl-PL")));
  const template = candidates.find((task) => wantedBrands.has(models.get(task.modelKey).brand.toLocaleLowerCase("pl-PL"))) ?? candidates[0];
  if (!template) return { source, task: null };
  const task = structuredClone(template);
  task.state = "running";
  task.worker = "read-only-adapter-pilot";
  task.searchProfile.searchUrl = source.searchUrl;
  task.searchProfile.queryPlan.searchUrl = source.searchUrl;
  task.searchProfile.queryPlan.textQueries = task.searchProfile.queryPlan.textQueries.slice(0, 1);
  delete task.sharedResultsCache;
  return { source, task };
});

function runReader(job) {
  return new Promise((resolve) => {
    if (!job.task) {
      resolve({ sourceId: job.source.id, status: "no_task_template", pagesChecked: 0, candidates: 0 });
      return;
    }
    const readerArgs = [path.join(ROOT, "scripts/portal-candidates.mjs"), "--claim-stdin", "--max-pages", "1"];
    if (inspectCardSources.has(job.source.id)) readerArgs.push("--inspect-one-card");
    const child = spawn(process.execPath, readerArgs, {
      cwd: ROOT,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(ROOT, "node_modules", ".cache", "ms-playwright") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ sourceId: job.source.id, modelKey: job.task.modelKey, status: "adapter_error",
          error: (stderr || `adapter exited ${code}`).split("\n")[0].slice(0, 240) });
        return;
      }
      try {
        const result = JSON.parse(stdout);
        const pages = result.coverage?.searchResults ?? [];
        const visibleListings = pages.flatMap((page) => page.listings ?? []);
        const listings = visibleListings.length;
        const fieldCoverage = {
          withTitleAndUrl: visibleListings.filter((listing) => listing.title && listing.url).length,
          withDisplayedPriceText: visibleListings.filter((listing) => listing.visibleFields?.displayedPriceText).length,
          withMileageKm: visibleListings.filter((listing) => Number.isFinite(listing.visibleFields?.mileageKm)).length,
          withExplicitProductionYear: visibleListings.filter((listing) => Number.isFinite(listing.visibleFields?.productionYear)).length,
          withYearMentionOnly: visibleListings.filter((listing) => listing.visibleFields?.yearMentions?.length).length,
        };
        resolve({ sourceId: job.source.id, modelKey: job.task.modelKey, status: result.outcome,
          pagesChecked: result.coverage?.pagesChecked ?? 0, candidates: listings,
          fieldCoverage, diagnostics: result.diagnostics ?? null,
          querySubmitted: pages[0]?.querySubmitted ?? false,
          queryNote: pages[0]?.queryNote ?? null,
          cardPilot: result.cardPilot ?? null,
          errors: result.errors?.map((entry) => ({ url: entry.url, error: entry.error })) ?? [],
          notes: result.coverage?.remaining ?? "" });
      } catch {
        resolve({ sourceId: job.source.id, modelKey: job.task.modelKey, status: "invalid_adapter_output",
          error: stderr.slice(0, 240) || "Adapter output was not valid JSON" });
      }
    });
    child.stdin.end(JSON.stringify(job.task));
  });
}

const results = new Array(jobs.length);
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (cursor < jobs.length) {
    const index = cursor++;
    results[index] = await runReader(jobs[index]);
    process.stderr.write(`${index + 1}/${jobs.length} ${results[index].sourceId}: ${results[index].status}, ${results[index].candidates ?? 0} candidates\n`);
  }
}));

const report = {
  version: 1,
  checkedAt: new Date().toISOString(),
  note: "Read-only one-query pilot. Visible field counts are parsing diagnostics, not listing facts or availability evidence. No task queue or offer database was changed.",
  sourcesChecked: results.length,
  results,
};
const reportPath = path.join(ROOT, "reports", "portal-adapter-pilot.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ reportPath: path.relative(ROOT, reportPath), sourcesChecked: results.length,
  counts: Object.fromEntries([...new Set(results.map((result) => result.status))].map((status) => [status, results.filter((result) => result.status === status).length])) }, null, 2)}\n`);
