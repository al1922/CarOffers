import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { ROOT, listModelProfiles } from "../config/load-search-config.mjs";
import { argsMap, json, writeJson, syncSiteIndex, validateConfiguration } from "./configuration.mjs";

export async function addSource(argv) {
  const { values } = argsMap(argv);
  const { id, name, adapter, "search-url": searchUrl } = values;
  if (!/^[a-z0-9-]+$/.test(id ?? "") || !/^[a-z0-9-]+$/.test(adapter ?? "") || !name || !searchUrl) {
    throw new Error("Podaj --id, --name, --adapter i --search-url.");
  }
  let parsedUrl;
  try { parsedUrl = new URL(searchUrl); } catch { throw new Error("--search-url musi być poprawnym adresem HTTPS."); }
  if (parsedUrl.protocol !== "https:") throw new Error("--search-url musi używać HTTPS.");
  const sourcePath = path.join(ROOT, "config", "sources", `${id}.json`);
  try { await readFile(sourcePath); throw new Error(`Źródło ${id} już istnieje.`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const mappingDirectory = path.join(ROOT, "config", "source-mappings", id);
  if (await readdir(path.dirname(mappingDirectory)).then((items) => items.includes(id))) {
    throw new Error(`Istnieje już katalog mapowań dla źródła ${id}.`);
  }
  const source = { id, name, enabled: false, adapter, searchUrl, limits: {}, adapterConfig: {}, filterMode: "url" };
  const profiles = await listModelProfiles();
  await writeJson(sourcePath, source);
  for (const profile of profiles) {
    await writeJson(path.join(mappingDirectory, `${profile.key}.json`), { modelKey: profile.key, supported: false });
  }
  await syncSiteIndex();
  await validateConfiguration();
  process.stdout.write(`Dodano źródło ${id} jako wyłączone. Dodaj adapter ${adapter}, sprawdź URL-e, a potem użyj source activate.\n`);
}

export async function updateSource(action, argv) {
  const { values } = argsMap(argv);
  const id = values.id;
  if (!/^[a-z0-9-]+$/.test(id ?? "")) throw new Error("Podaj prawidłowe --id źródła.");
  const sourcePath = path.join(ROOT, "config", "sources", `${id}.json`);
  if (action === "remove") {
    await rm(sourcePath, { force: true });
    const mappingPath = path.join(ROOT, "config", "source-mappings", id);
    if (await readdir(path.dirname(mappingPath)).then((items) => items.includes(id))) {
      const workspaceRoot = path.resolve(ROOT);
      const targetPath = path.resolve(mappingPath);
      if (!targetPath.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error("Katalog mapowania wychodzi poza workspace.");
      await rm(targetPath, { recursive: true, force: true });
    }
  } else {
    const source = await json(sourcePath);
    source.enabled = action === "activate";
    if (source.enabled) {
      const adapterPath = path.join(ROOT, "src", "search", "direct", "adapters", `${source.adapter}.mjs`);
      await readFile(adapterPath);
    }
    await writeJson(sourcePath, source);
  }
  await syncSiteIndex();
  await validateConfiguration();
  process.stdout.write(`Zaktualizowano źródło ${id}: ${action}.\n`);
}
