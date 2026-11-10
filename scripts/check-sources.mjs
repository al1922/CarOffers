#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, "node_modules", ".cache", "ms-playwright");
const { chromium } = await import("playwright");

const config = JSON.parse(await readFile(path.join(ROOT, "config/sources.json"), "utf8"));
const sourceFilter = new Set();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] !== "--source" || !process.argv[i + 1]) {
    throw new Error("Usage: npm run check:sources [-- --source <source-id> ...]");
  }
  sourceFilter.add(process.argv[++i]);
}

const sources = config.sources.filter((source) => source.enabled &&
  (!sourceFilter.size || sourceFilter.has(source.id)));
const unknown = [...sourceFilter].filter((id) => !config.sources.some((source) => source.id === id));
if (unknown.length) throw new Error(`Unknown source id(s): ${unknown.join(", ")}`);
const browser = await chromium.launch({ headless: true });
const results = new Array(sources.length);
let cursor = 0;

async function check(source, index) {
  const page = await browser.newPage();
  const apiResponses = [];
  page.on("response", (response) => {
    const request = response.request();
    if (!["xhr", "fetch"].includes(request.resourceType())) return;
    const contentType = response.headers()["content-type"] ?? "";
    apiResponses.push({
      status: response.status(),
      json: /(?:application\/json|\+json)/i.test(contentType),
      host: safeHost(response.url()),
      path: safePath(response.url()),
    });
  });

  const started = Date.now();
  let navigationStatus = null;
  let navigationError = null;
  let finalUrl = "about:blank";
  let title = "";
  let text = "";
  let visibleListingLikeLinks = 0;
  try {
    const response = await page.goto(source.searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    navigationStatus = response?.status() ?? null;
    await page.waitForTimeout(1000);
    finalUrl = page.url();
    title = await page.title().catch(() => "");
    const observed = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? "";
      const anchors = [...document.querySelectorAll("a[href]")];
      const likelyListingLinks = anchors.filter((anchor) => {
        const label = (anchor.innerText ?? "").trim();
        if (!label || !anchor.href.startsWith("https://")) return false;
        const parentText = (anchor.closest("article, li, [class*=offer], [class*=card], [class*=result]")?.innerText ?? label)
          .replace(/\s+/g, " ").slice(0, 1600);
        return /\b(?:19|20)\d{2}\b/.test(parentText) &&
          /(?:\d[\d\s.,]*\s?(?:zł|PLN)|\d{1,3}(?:[\s.,]\d{3})+\s?km)/i.test(parentText);
      });
      return { text: bodyText.slice(0, 6000), visibleListingLikeLinks: likelyListingLinks.length };
    });
    text = observed.text;
    visibleListingLikeLinks = observed.visibleListingLikeLinks;
  } catch (error) {
    navigationError = String(error?.message ?? error).split("\n")[0].slice(0, 240);
    finalUrl = page.url();
  }

  const blockedText = /access denied|robot check|captcha|verify you are human|too many requests|dostęp został zablokowany|oh noes/i
    .test(`${title}\n${text}`);
  const blocked = [401, 403, 429].includes(navigationStatus) ||
    /ERR_CERT_|ERR_BLOCKED_BY_CLIENT|ERR_NAME_NOT_RESOLVED/.test(navigationError ?? "") || blockedText;
  const searchSurface = /szukaj|wyszukiw|filtr|ofert|wynik|samochod|używan/i.test(`${title}\n${text}`);

  results[index] = {
    sourceId: source.id,
    requestedUrl: source.searchUrl,
    finalUrl,
    httpStatus: navigationStatus,
    status: blocked ? "blocked" : navigationError ? "error" :
      text.length === 0 ? "no_visible_content" : searchSurface ? "page_visible" : "page_visible_no_search_surface",
    title,
    visibleTextChars: text.length,
    visibleListingLikeLinks,
    xhrFetchCount: apiResponses.length,
    jsonResponses: apiResponses.filter((entry) => entry.json).length,
    failedApiResponses: apiResponses.filter((entry) => entry.status >= 400)
      .map(({ status, host, path: apiPath }) => ({ status, host, path: apiPath })).slice(0, 6),
    elapsedMs: Date.now() - started,
    error: navigationError,
    limitation: "Probe-only: link counts are heuristic and do not establish listing coverage or offer availability.",
  };
  await page.close();
}

function safeHost(value) {
  try { return new URL(value).hostname; } catch { return ""; }
}

function safePath(value) {
  try { return new URL(value).pathname; } catch { return ""; }
}

try {
  const workers = Array.from({ length: Math.min(4, sources.length) }, async () => {
    while (cursor < sources.length) {
      const index = cursor++;
      await check(sources[index], index);
    }
  });
  await Promise.all(workers);
  process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)}\n`);
} finally {
  await browser.close();
}
