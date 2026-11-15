import { writeFile } from "node:fs/promises";
import path from "node:path";

export const CHALLENGE = /access denied|robot check|captcha|verify you are human|too many requests|dostęp został zablokowany|oh noes/i;

export function isAccessDenied(status) {
  return [401, 403, 429].includes(status);
}

export function isRequiredDataDenial(adapter, response, context) {
  return adapter.isRequiredDataResponse?.(response, context) === true;
}

export async function pageHasChallenge(page) {
  const text = `${await page.title().catch(() => "")}\n${await page.locator("body").innerText().catch(() => "")}`;
  return CHALLENGE.test(text);
}

export async function persistTimings(timings, runDir) {
  const reportPath = path.join(runDir, "timings.json");
  await writeFile(reportPath, `${JSON.stringify(timings.report(), null, 2)}\n`, "utf8");
}

export function selectedModels(models, options) {
  const requested = [...new Set(options.modelKeys ?? (options.modelKey ? [options.modelKey] : []))];
  if (!requested.length) return models.filter((model) => model.active);
  const byKey = new Map(models.filter((model) => model.active).map((model) => [model.key, model]));
  const missing = requested.filter((key) => !byKey.has(key));
  if (missing.length) throw new Error(`Nie znaleziono aktywnych modeli: ${missing.join(", ")}.`);
  return requested.map((key) => byKey.get(key));
}

export function splitOversizedModelGroups(groups, maxModels = 1) {
  return groups.flatMap((group) => {
    if (group.models.length <= maxModels) return [group];
    const chunks = [];
    for (let offset = 0; offset < group.models.length; offset += maxModels) {
      const models = group.models.slice(offset, offset + maxModels);
      chunks.push({ ...group, id: `${group.id}-${chunks.length + 1}`, models });
    }
    return chunks;
  });
}
