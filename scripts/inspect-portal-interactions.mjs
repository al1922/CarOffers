#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, "node_modules", ".cache", "ms-playwright");
const { chromium } = await import("playwright");
const ids = process.argv.slice(2);
if (!ids.length) throw new Error("Provide source ids to inspect");
const config = JSON.parse(await readFile(path.join(ROOT, "config/sources.json"), "utf8"));
const sources = ids.map((id) => {
  const source = config.sources.find((item) => item.id === id && item.enabled);
  if (!source) throw new Error(`Unknown enabled source: ${id}`);
  return source;
});
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const source of sources) {
    const page = await browser.newPage();
    let status = null;
    let clicked = null;
    try {
      const response = await page.goto(source.searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      status = response?.status() ?? null;
      await page.waitForTimeout(1000);
      const body = await page.locator("body").innerText().catch(() => "");
      if (/cookie|ciasteczk|zgod[ay]|consent/i.test(body)) {
        const reject = page.getByRole("button", { name: /^(deny|reject all|reject optional|only necessary|necessary only|odrzuć|odrzuć wszystkie|nie akceptuję|nie zgadzam|tylko niezbędne)$/i }).first();
        if (await reject.isVisible().catch(() => false)) { await reject.click().catch(() => {}); clicked = "reject_optional_cookies"; }
      }
      if (source.id === "toyota-pewne-auto") {
        const button = page.locator(".homepage-search__form__group").filter({ hasText: "MARKA" }).first();
        if (await button.isVisible().catch(() => false)) { await button.click({ timeout: 1800 }).catch(() => {}); clicked = "attempt_open_make_filter"; await page.waitForTimeout(400); }
      }
      if (source.id === "hyundai-korea-motors") {
        const filterButton = page.getByRole("button", { name: /filtruj|szukaj/i }).first();
        if (await filterButton.isVisible().catch(() => false)) { await filterButton.click(); clicked = "apply_visible_filters"; await page.waitForTimeout(700); }
      }
      const structure = await page.evaluate(() => {
        const visible = (element) => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
        const controls = [...document.querySelectorAll("input,select,button")].filter(visible).slice(0, 80).map((item) => ({
          tag: item.tagName.toLowerCase(), type: item.getAttribute("type") ?? "", name: item.getAttribute("name") ?? "",
          placeholder: item.getAttribute("placeholder") ?? "", aria: item.getAttribute("aria-label") ?? "",
          text: (item.innerText ?? item.value ?? "").trim().replace(/\s+/g, " ").slice(0, 70),
          checked: item instanceof HTMLInputElement && item.type === "checkbox" ? item.checked : undefined,
        }));
        const links = [...document.querySelectorAll("a[href]")].filter(visible).map((item) => ({
          text: (item.innerText ?? item.getAttribute("aria-label") ?? "").trim().replace(/\s+/g, " ").slice(0, 90),
          host: (() => { try { return new URL(item.href).hostname; } catch { return ""; } })(),
          path: (() => { try { return new URL(item.href).pathname; } catch { return ""; } })(),
        })).filter((item) => /używan|auta od ręki|ofert|samochod|stock|dealer|pojazd/i.test(item.text)).slice(0, 25);
        const widgetAncestors = [];
        for (const marker of ["Wybierz markę", "Wybierz model", "Pokaż oferty"]) {
          const target = [...document.querySelectorAll("body *")].find((item) => item.children.length === 0 && (item.innerText ?? "").trim() === marker && visible(item));
          if (!target) continue;
          let current = target;
          for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
            widgetAncestors.push({ marker, tag: current.tagName.toLowerCase(), role: current.getAttribute("role"),
              aria: current.getAttribute("aria-label"), name: current.getAttribute("name"),
              className: String(current.className ?? "").slice(0, 160),
              text: (current.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 140) });
          }
        }
        return { text: (document.body?.innerText ?? "").slice(0, 1200), controls, links, widgetAncestors };
      });
      results.push({ sourceId: source.id, status, clicked, finalUrl: page.url(), ...structure });
    } catch (error) {
      results.push({ sourceId: source.id, status, clicked, error: String(error?.message ?? error).split("\n")[0].slice(0, 240) });
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
