#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, "node_modules", ".cache", "ms-playwright");
const { chromium } = await import("playwright");
const sourceFilter = new Set();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] !== "--source" || !process.argv[i + 1]) throw new Error("Usage: node scripts/inspect-portal-structure.mjs [--source <id> ...]");
  sourceFilter.add(process.argv[++i]);
}
const config = JSON.parse(await readFile(path.join(ROOT, "config/sources.json"), "utf8"));
const sources = config.sources.filter((source) => source.enabled && (!sourceFilter.size || sourceFilter.has(source.id)));
const browser = await chromium.launch({ headless: true });
const results = new Array(sources.length);
let cursor = 0;
async function inspect(source, index) {
  const page = await browser.newPage();
  const responses = [];
  const pendingResponseReads = new Set();
  page.on("response", (response) => {
    if (!["xhr", "fetch"].includes(response.request().resourceType())) return;
    const readResponse = (async () => {
      const headers = response.headers();
      const isJson = /(?:application\/json|\+json)/i.test(headers["content-type"] ?? "");
      const item = { status: response.status(), host: safeHost(response.url()), path: safePath(response.url()), json: isJson };
      if (isJson && Number(headers["content-length"] ?? 0) <= 2_000_000) {
        try {
          const body = await Promise.race([response.body(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500))]);
          if (body.length > 2_000_000) item.shapeReadError = "body_exceeds_2mb";
          else item.shape = jsonShape(JSON.parse(body.toString("utf8")));
        }
        catch { item.shapeReadError = "body_unavailable_or_invalid_json"; }
      } else if (isJson) item.shapeReadError = "body_exceeds_2mb";
      responses.push(item);
    })();
    pendingResponseReads.add(readResponse);
    readResponse.finally(() => pendingResponseReads.delete(readResponse));
  });
  let httpStatus = null;
  let error = null;
  try {
    const response = await page.goto(source.searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    httpStatus = response?.status() ?? null;
    await page.waitForTimeout(900);
    await Promise.race([Promise.allSettled([...pendingResponseReads]), new Promise((resolve) => setTimeout(resolve, 2000))]);
    results[index] = {
      sourceId: source.id,
      httpStatus,
      title: await page.title().catch(() => ""),
      finalHost: safeHost(page.url()),
      structure: await page.evaluate(() => {
        const visible = (element) => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
        const selectorCounts = {};
        for (const selector of ["article", "[data-testid*=offer]", "[data-testid*=listing]", "[class*=offer-card]", "[class*=listing-card]", "[class*=vehicle-card]", "[class*=car-card]", "[class*=result-card]"]) {
          selectorCounts[selector] = [...document.querySelectorAll(selector)].filter(visible).length;
        }
        const controls = [...document.querySelectorAll("input,select,button")].filter(visible).slice(0, 80).map((item) => ({
          tag: item.tagName.toLowerCase(), type: item.getAttribute("type") ?? "", name: item.getAttribute("name") ?? "",
          placeholder: (item.getAttribute("placeholder") ?? "").slice(0, 100),
          ariaLabel: (item.getAttribute("aria-label") ?? "").slice(0, 100),
          text: (item.innerText ?? item.value ?? "").trim().replace(/\s+/g, " ").slice(0, 90),
        }));
        const anchors = [...document.querySelectorAll('a[href]')].filter(visible);
        const anchorStats = { titledHttpsLinks: 0, yearPriceOrMileageAncestors: 0, sameHostListingCandidates: 0 };
        const siteHost = location.hostname.replace(/^www\./i, "");
        for (const anchor of anchors) {
          const title = (anchor.innerText ?? anchor.getAttribute("aria-label") ?? "").trim();
          if (!title || title.length < 8 || !anchor.href.startsWith("https://")) continue;
          anchorStats.titledHttpsLinks += 1;
          let parent = anchor;
          let plausiblyListing = false;
          for (let depth = 0; parent && depth <= 5; depth += 1, parent = parent.parentElement) {
            const text = (parent.innerText ?? "").replace(/\s+/g, " ").trim();
            if (text.length >= 35 && text.length <= 2200 && /\b(?:19|20)\d{2}\b/.test(text) && /(?:zł|PLN|\bkm\b)/i.test(text)) {
              plausiblyListing = true;
              break;
            }
          }
          if (plausiblyListing) {
            anchorStats.yearPriceOrMileageAncestors += 1;
            const host = new URL(anchor.href).hostname.replace(/^www\./i, "");
            if (host === siteHost || host.endsWith(`.${siteHost}`)) anchorStats.sameHostListingCandidates += 1;
          }
        }
        const nextLinks = anchors.filter((item) => item.rel === "next" || /następ|dalej|next|pokaż więcej/i.test(`${item.innerText} ${item.getAttribute("aria-label") ?? ""}`));
        return { bodyTextChars: (document.body?.innerText ?? "").length, selectorCounts, controls,
          visibleAnchorCount: anchors.length, anchorStats,
          nextLinkLabels: nextLinks.slice(0, 5).map((item) => (item.innerText ?? item.getAttribute("aria-label") ?? "").trim().slice(0, 80)) };
      }),
      apiResponses: responses.slice(0, 20),
    };
  } catch (cause) {
    error = String(cause?.message ?? cause).split("\n")[0].slice(0, 240);
    results[index] = { sourceId: source.id, httpStatus, error, apiResponses: responses.slice(0, 20) };
  }
  process.stderr.write(`${index + 1}/${sources.length} ${source.id}: HTTP ${httpStatus ?? "?"}${error ? " error" : " inspected"}\n`);
  await page.close();
}
function safeHost(value) { try { return new URL(value).hostname; } catch { return ""; } }
function safePath(value) { try { return new URL(value).pathname; } catch { return ""; } }
function jsonShape(value) {
  const arrays = [];
  const visited = new WeakSet();
  function walk(node, currentPath, depth) {
    if (!node || typeof node !== "object" || visited.has(node) || depth > 5) return;
    visited.add(node);
    if (Array.isArray(node)) {
      arrays.push({ path: currentPath || "$", length: node.length,
        itemKeys: Object.keys(node.find((item) => item && typeof item === "object" && !Array.isArray(item)) ?? {}).slice(0, 100) });
      for (let index = 0; index < Math.min(node.length, 5); index += 1) walk(node[index], `${currentPath}[${index}]`, depth + 1);
      return;
    }
    for (const [key, nested] of Object.entries(node).slice(0, 100)) walk(nested, currentPath ? `${currentPath}.${key}` : key, depth + 1);
  }
  walk(value, "", 0);
  return { topLevelType: Array.isArray(value) ? "array" : typeof value,
    topLevelKeys: value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).slice(0, 100) : [], arrays: arrays.slice(0, 40) };
}
try {
  await Promise.all(Array.from({ length: Math.min(3, sources.length) }, async () => {
    while (cursor < sources.length) { const index = cursor++; await inspect(sources[index], index); }
  }));
} finally { await browser.close(); }
const report = { version: 1, checkedAt: new Date().toISOString(), note: "DOM structure only; no listing data, cards opened, or queue/database changes.", sourcesChecked: results.length, results };
const output = path.join(ROOT, "reports", "portal-structure-inspection.json");
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ reportPath: path.relative(ROOT, output), sourcesChecked: results.length }, null, 2)}\n`);
