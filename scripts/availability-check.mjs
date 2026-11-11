#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { portalNavigationPolicy } from "./portal-robots.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ERROR_RE = /access denied|verify you are human|captcha|robot check|dostęp został zablokowany|zbyt wiele żądań/i;
const CLOSED_RE = /(?:ogłoszenie|oferta)\s+nie\s+jest\s+(?:już\s+)?(?:dostępne|dostępna)|(?:ogłoszenie|oferta)\s+(?:jest\s+)?(?:już\s+)?(?:niedostępne|niedostępna|nieaktualne|nieaktualna|zakończone|zakończona|usunięte|usunięta|sprzedane|sprzedana)|(?:ogłoszenie|oferta)\s+(?:został[oa]?\s+(?:zakończon[ae]|usunięt[ae]|sprzedan[ey])|trafił[oa]?\s+do\s+archiwum)|(?:pojazd|samochód|auto)\s+(?:został[oa]?\s+)?sprzedan[ey]|oferta\s+w\s+archiwum|nie\s+znaleźliśmy\s+tej\s+oferty|this\s+(?:listing|ad)\s+is\s+no\s+longer\s+available|listing\s+has\s+ended/i;

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
    });
    process.stdin.on("error", reject);
  });
}

function sourceHosts(source) {
  return [source?.searchUrl, source?.url].filter(Boolean).flatMap((value) => {
    try { return [new URL(value).hostname.toLowerCase().replace(/^www\./, "")]; }
    catch { return []; }
  });
}

function belongsToSource(url, source) {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return sourceHosts(source).some((base) => host === base || host.endsWith("." + base));
}

function readableHtml(html) {
  return String(html).replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/\s+/g, " ").trim();
}

function matchesKnownTitle(text, title) {
  const distinctive = String(title ?? "").trim().split(/\s+/).slice(0, 3).join(" ");
  return distinctive.length >= 8 && text.toLocaleLowerCase("pl-PL").includes(distinctive.toLocaleLowerCase("pl-PL"));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--claim-stdin") {
    throw new Error("Usage: npm run availability:check -- --claim-stdin < claimed-task.json");
  }
  const task = await readStdin();
  if (task?.kind !== "availability" || task.state !== "running" || !task.worker || !task.id || !task.runId) {
    throw new Error("Input must be the JSON claim for a running availability task, with runId and worker");
  }
  if (!Array.isArray(task.refreshTargets) || !task.refreshTargets.length) {
    throw new Error("Availability task has no refreshTargets");
  }

  const runDir = path.join(ROOT, "runs", task.runId);
  const snapshot = JSON.parse(await fs.readFile(path.join(runDir, "snapshot.json"), "utf8"));
  const source = snapshot.config.sources.sources.find((item) => item.id === task.sourceId);
  if (!source) throw new Error("Task source is missing from the run snapshot");
  const outputPath = path.join(runDir, "results", `${task.id}.json`);
  try { await fs.access(outputPath); throw new Error(`Refusing to overwrite existing evidence: ${outputPath}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, "node_modules", ".cache", "ms-playwright");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const results = [];
  let blockedCount = 0;
  try {
    const context = await browser.newContext();
    const policies = new Map();

    for (const target of task.refreshTargets) {
      try {
        if (!/^https:\/\//i.test(target.url) || !belongsToSource(target.url, source)) {
          throw new Error("URL nie należy do przypisanego portalu lub nie używa HTTPS.");
        }
        const origin = new URL(target.url).origin;
        if (!policies.has(origin)) {
          try { policies.set(origin, { allowed: await portalNavigationPolicy(context, target.url) }); }
          catch (error) { policies.set(origin, { error }); }
        }
      } catch (error) {
        policies.set(`invalid:${target.url}`, { error });
      }
    }

    const checkTarget = async (target) => {
      const url = target.url;
      const observationTime = new Date().toISOString();
      let status = "access_error";
      let note = "Nie udało się jednoznacznie ustalić dostępności ogłoszenia.";
      let httpStatus = null;
      let page = null;
      try {
        if (!/^https:\/\//i.test(url) || !belongsToSource(url, source)) {
          throw new Error("URL nie należy do przypisanego portalu lub nie używa HTTPS.");
        }
        const origin = new URL(url).origin;
        const policy = policies.get(origin);
        if (policy?.error) throw policy.error;
        const allowed = policy?.allowed;
        if (!allowed) throw new Error("Nie udało się odczytać robots.txt portalu.");
        if (!allowed(url)) throw new Error("robots.txt nie zezwala na odczyt tej ścieżki.");

        const response = await context.request.get(url, { timeout: 10000, maxRedirects: 5 });
        httpStatus = response?.status() ?? null;
        const finalUrl = response?.url() ?? url;
        if (new URL(finalUrl).origin !== origin || !allowed(finalUrl)) {
          throw new Error("Przekierowanie poza dozwolony adres portalu.");
        }
        if (httpStatus === 403) {
          blockedCount += 1;
          note = "Portal odmówił dostępu (HTTP 403); status oferty pozostaje nieustalony.";
        } else if (httpStatus === 410) {
          status = "removed";
          note = "Portal zwrócił HTTP 410 Gone dla adresu ogłoszenia.";
        } else if (httpStatus === 404) {
          const body = readableHtml(await response.text().catch(() => ""));
          const closed = body.match(CLOSED_RE);
          if (closed) {
            status = /sprzedan/i.test(closed[0]) ? "sold" : "removed";
            note = `Portal zwrócił HTTP 404 i jawny komunikat zamknięcia: „${closed[0]}”.`;
          } else note = "Portal zwrócił HTTP 404; sam kod nie potwierdza zamknięcia ogłoszenia.";
        } else {
          const html = await response.text().catch(() => "");
          const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, " ") ?? "";
          let visible = readableHtml(`${title} ${html}`);
          if (visible.length < 80 || !matchesKnownTitle(visible, target.title)) {
            page = await context.newPage();
            page.setDefaultNavigationTimeout(18000);
            const pageResponse = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });
            if (pageResponse) httpStatus = pageResponse.status();
            if (new URL(page.url()).origin !== origin || !allowed(page.url())) {
              throw new Error("Przekierowanie poza dozwolony adres portalu.");
            }
            const renderedTitle = await page.title().catch(() => "");
            const renderedText = await page.locator("body").innerText({ timeout: 2500 }).catch(() => "");
            visible = `${renderedTitle} ${renderedText}`.replace(/\s+/g, " ").trim();
          }
          if (httpStatus === 410) {
            status = "removed";
            note = "Portal zwrócił HTTP 410 Gone dla adresu ogłoszenia.";
          } else if (httpStatus === 403 || httpStatus === 429 || ERROR_RE.test(visible)) {
            blockedCount += 1;
            note = `Portal wyświetlił blokadę lub limit dostępu${httpStatus ? ` (HTTP ${httpStatus})` : ""}.`;
          } else if (httpStatus === 404 && !CLOSED_RE.test(visible)) {
            note = "Portal zwrócił HTTP 404; sam kod nie potwierdza zamknięcia ogłoszenia.";
          } else {
            const closed = visible.match(CLOSED_RE);
            const identityMatches = matchesKnownTitle(visible, target.title);
            if (closed) {
              status = /sprzedan/i.test(closed[0]) ? "sold" : "removed";
              note = `Portal wyświetlił komunikat zamknięcia: „${closed[0]}”.`;
            } else if (httpStatus >= 200 && httpStatus < 300 && visible.length > 80 && identityMatches) {
              status = "available";
              note = "Załadowana karta pasuje tytułem do znanej oferty (HTTP " + httpStatus + "); nie znaleziono komunikatu o zamknięciu.";
            } else {
              note = `Karta nie potwierdza tożsamości oferty${httpStatus ? ` (HTTP ${httpStatus})` : ""}; status pozostaje nieustalony.`;
            }
          }
        }
      } catch (error) {
        note = String(error?.message ?? error).split("\n")[0].slice(0, 400);
        if (/odmówił dostępu|blokad|robots\.txt|429|403/i.test(note)) blockedCount += 1;
      } finally {
        if (page) await page.close().catch(() => {});
      }
      const result = { id: target.offerId, observation: {
        url, checkedAt: observationTime, availability: status, note, httpStatus,
      } };
      process.stderr.write(`${status}\t${httpStatus ?? "-"}\t${url}\n`);
      return result;
    };

    const concurrency = Math.max(1, Math.min(4, task.refreshTargets.length));
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= task.refreshTargets.length) return;
        results[index] = await checkTarget(task.refreshTargets[index]);
      }
    });
    await Promise.all(workers);
    await context.close();
  } finally {
    await browser.close();
  }

  const accessErrors = results.filter((item) => item.observation.availability === "access_error").length;
  const outcome = accessErrors === 0 ? "complete" : (blockedCount === results.length ? "blocked" : "partial");
  const checkedAt = new Date().toISOString();
  const targetUrls = task.refreshTargets.map((item) => item.url);
  const artifact = {
    taskId: task.id,
    outcome,
    checkedAt,
    coverage: {
      searchUrls: targetUrls,
      pagesChecked: results.length,
      remaining: accessErrors ? `${accessErrors} adres(y) bez rozstrzygniętego statusu` : "",
      listingUrlsChecked: targetUrls,
    },
    offers: results,
    errors: results.filter((item) => item.observation.availability === "access_error")
      .map((item) => ({ url: item.observation.url, note: item.observation.note })),
  };
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(`Saved ${results.length} observations (${outcome}) to ${path.relative(ROOT, outputPath)}\n`);
}

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error) + "\n");
  process.exitCode = 1;
});
