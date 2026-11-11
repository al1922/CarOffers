import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createCardReader, createHtmlCardReader, navigationForVerification, stopCardReads } from "./sprzedajemy-verify.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, "node_modules", ".cache", "ms-playwright");
const { chromium } = await import("playwright");

const resultPath = process.argv[2];
if (!resultPath) throw new Error("Usage: node scripts/benchmark-sprzedajemy-cards.mjs <previous-result.json>");
const result = JSON.parse(await readFile(resultPath, "utf8"));
if (!result.taskId?.startsWith("sprzedajemy--")) throw new Error("Expected a Sprzedajemy result");

const reads = new Map(result.coverage.cardReads.filter(({ card }) => card).map(({ url, card }) => [url, card]));
const sample = new Map();
for (const [status, count] of [["available", 15], ["rejected", 15], ["price_review", 10], ["unverified", 10]]) {
  const urls = result.diagnostics.checks.filter((check) => check.status === status && reads.has(check.url));
  for (let i = 0; i < Math.min(count, urls.length); i += 1) {
    sample.set(urls[Math.floor(i * urls.length / count)].url, status);
  }
}
for (const url of reads.keys()) {
  if (sample.size >= 50) break;
  if (!sample.has(url)) sample.set(url, "other");
}
if (sample.size < 50) throw new Error("At least 50 previously read cards are required");

function normalized(value) {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, normalized(field)]));
  }
  return value;
}

async function measure(read) {
  const start = performance.now();
  try {
    const { card, method } = await read();
    return { card, fallback: method === "fallback", ms: performance.now() - start };
  } catch (error) {
    return { error: error.message.split("\n")[0], blocked: stopCardReads(error), ms: performance.now() - start };
  }
}

const rows = [];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const parserPage = await context.newPage();
  const navigate = await navigationForVerification(context, page, "https://sprzedajemy.pl/");
  const readHtml = createHtmlCardReader(context, parserPage, navigate.isAllowed);
  const readRendered = createCardReader(navigate, page);
  const readFast = createCardReader(navigate, page, readHtml);
  for (const [url, previousStatus] of sample) {
    const methods = {
      rendered: () => readRendered(url),
      html: () => readFast(url),
    };
    const order = rows.length % 2 ? ["html", "rendered"] : ["rendered", "html"];
    const measured = {};
    for (const method of order) {
      measured[method] = await measure(methods[method]);
      if (measured[method].blocked) break;
    }
    const { rendered, html } = measured;
    const differingFields = rendered?.card && html?.card
      ? Object.keys(rendered.card).filter((key) =>
        !isDeepStrictEqual(normalized(rendered.card[key]), normalized(html.card[key]))) : [];
    rows.push({ url, previousStatus, renderedMs: Math.round(rendered?.ms ?? 0), htmlMs: Math.round(html?.ms ?? 0),
      fallback: html?.fallback ?? false, differingFields, renderedError: rendered?.error, htmlError: html?.error,
      blocked: Boolean(rendered?.blocked || html?.blocked) });
    if (rendered?.blocked || html?.blocked) break;
  }
} finally {
  await browser.close();
}
const comparable = rows.filter((row) => !row.renderedError && !row.htmlError);
const total = (field) => comparable.reduce((sum, row) => sum + row[field], 0);
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(), sourceResult: resultPath,
  summary: { attempted: rows.length, comparable: comparable.length, blocked: rows.some((row) => row.blocked),
    fallbacks: comparable.filter((row) => row.fallback).length,
    cardsWithDifferences: comparable.filter((row) => row.differingFields.length).length,
    renderedMs: total("renderedMs"), htmlMs: total("htmlMs") }, rows,
}, null, 2));
