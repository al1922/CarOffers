#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, "node_modules", ".cache", "ms-playwright");
const { chromium } = await import("playwright");

const HELP = `Usage:
  node scripts/playwright-pages.mjs --url <https-url> [--url <https-url> ...]
       [--ready-selector <css>] [--settle-ms <n>] [--include-api-json]
       [--next-selector <css> --max-pages <n>]
       [--block-types image,font,media] [--headed]

Opens supplied URLs in order in one browser context; with --next-selector it
also follows visible HTTPS hrefs up to --max-pages. Captures rendered page
text/links and XHR/Fetch metadata. JSON bodies are omitted unless
--include-api-json is set. It does not click, submit, log in, retry, or bypass
access controls. Check source instructions and robots.txt before use.
`;

function parseArgs(argv) {
  const options = { urls: [], settleMs: 0, blockTypes: [], headed: false, includeApiJson: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--url") options.urls.push(argv[++i]);
    else if (arg === "--ready-selector") options.readySelector = argv[++i];
    else if (arg === "--next-selector") options.nextSelector = argv[++i];
    else if (arg === "--max-pages") options.maxPages = Number(argv[++i]);
    else if (arg === "--settle-ms") options.settleMs = Number(argv[++i]);
    else if (arg === "--block-types") options.blockTypes = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--include-api-json") options.includeApiJson = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.help) return options;
  if (!options.urls.length || options.urls.some((url) => !url)) throw new Error("Provide at least one --url");
  if (!Number.isFinite(options.settleMs) || options.settleMs < 0 || options.settleMs > 10000) {
    throw new Error("--settle-ms must be between 0 and 10000");
  }
  options.maxPages ??= 1;
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 100) {
    throw new Error("--max-pages must be an integer between 1 and 100");
  }
  if (options.maxPages > 1 && !options.nextSelector) {
    throw new Error("--next-selector is required when --max-pages is greater than 1");
  }
  const allowedTypes = new Set(["image", "font", "media"]);
  if (options.blockTypes.some((type) => !allowedTypes.has(type))) {
    throw new Error("--block-types accepts only image,font,media");
  }
  for (const url of options.urls) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error(`Only HTTPS URLs are accepted: ${url}`);
  }
  return options;
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const browser = await chromium.launch({ headless: !options.headed });
  try {
    const context = await browser.newContext();
    if (options.blockTypes.length) {
      await context.route("**/*", (route) => options.blockTypes.includes(route.request().resourceType())
        ? route.abort()
        : route.continue());
    }
    const page = await context.newPage();
    const pageResults = [];
    const visitedPages = new Set();

    async function capturePage(url, startUrl, pageNumber) {
      const startedAt = Date.now();
      const apiResponses = [];
      const pendingBodies = [];
      const onResponse = (response) => {
        const request = response.request();
        if (!["xhr", "fetch"].includes(request.resourceType())) return;
        const headers = response.headers();
        const entry = {
          url: response.url(),
          status: response.status(),
          contentType: headers["content-type"] ?? null,
        };
        apiResponses.push(entry);
        if (options.includeApiJson && /(?:application\/json|\+json)/i.test(entry.contentType ?? "")) {
          pendingBodies.push(response.json().then((data) => {
            const bytes = jsonSize(data);
            entry.bodyBytes = bytes;
            if (bytes <= 2_000_000) entry.json = data;
            else entry.jsonOmitted = "response exceeds 2 MB";
          }).catch(() => { entry.jsonOmitted = "response body unavailable or invalid JSON"; }));
        }
      };
      page.on("response", onResponse);

      let navigationStatus = null;
      let navigationError = null;
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        navigationStatus = response?.status() ?? null;
        if (options.readySelector) {
          await page.locator(options.readySelector).first().waitFor({ state: "attached", timeout: 10000 });
        }
        if (options.settleMs) await page.waitForTimeout(options.settleMs);
      } catch (error) {
        navigationError = String(error?.message ?? error).slice(0, 500);
      }

      await Promise.allSettled(pendingBodies);
      let rendered = { title: "", text: "", textTruncated: false, links: [] };
      if (!navigationError || page.url() !== "about:blank") {
        try {
          rendered = await page.evaluate(() => {
            const text = document.body?.innerText ?? "";
            const links = [...document.querySelectorAll("a[href]")].slice(0, 500).map((anchor) => ({
              text: (anchor.innerText ?? anchor.getAttribute("aria-label") ?? "").trim().slice(0, 200),
              url: anchor.href,
            }));
            return {
              title: document.title,
              text: text.slice(0, 50000),
              textTruncated: text.length > 50000,
              links,
            };
          });
        } catch { /* retain navigation/network diagnostics */ }
      }
      page.off("response", onResponse);
      pageResults.push({
        startUrl,
        pageNumber,
        requestedUrl: url,
        finalUrl: page.url(),
        checkedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        navigationStatus,
        navigationError,
        ...rendered,
        apiResponses,
      });
    }

    for (const startUrl of options.urls) {
      let currentUrl = startUrl;
      for (let pageNumber = 1; pageNumber <= options.maxPages; pageNumber += 1) {
        if (visitedPages.has(currentUrl)) break;
        visitedPages.add(currentUrl);
        await capturePage(currentUrl, startUrl, pageNumber);
        if (!options.nextSelector) break;

        const next = page.locator(options.nextSelector).first();
        if (!(await next.count()) || !(await next.isVisible())) break;
        const nextState = await next.evaluate((element) => ({
          href: element instanceof HTMLAnchorElement ? element.href : null,
          disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
        }));
        if (nextState.disabled || !nextState.href) break;
        const nextUrl = new URL(nextState.href, currentUrl).href;
        if (!nextUrl.startsWith("https://") || visitedPages.has(nextUrl)) break;
        if (pageNumber === options.maxPages) break;
        currentUrl = nextUrl;
      }
    }

    process.stdout.write(`${JSON.stringify({ pages: pageResults }, null, 2)}\n`);
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
