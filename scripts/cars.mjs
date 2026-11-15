#!/usr/bin/env node
import { clearAllOfferListings, importDirectRun } from "../src/offers/import-run.mjs";
import { migrateLegacyOffers } from "../src/offers/migrate-v2.mjs";
import { addModel, updateModel } from "../src/cli/models.mjs";
import { addSource, updateSource } from "../src/cli/sources.mjs";
import { argsMap, listModels, previewUrls, syncSiteIndex, validateConfiguration } from "../src/cli/configuration.mjs";
import { runSearch } from "../src/cli/search.mjs";

const HELP = `CarOffers — jeden punkt wejścia

Polecenia:
  npm run cars -- validate
  npm run cars -- sync
  npm run cars -- models [--source <id>]
  npm run cars -- urls --source <id> [--model <key>]
  npm run cars -- search --source <id> [--model <key>] [--headless] [--no-import]
      [--max-pages <n>] [--max-cards <n>] [--detail-concurrency <n>]
  npm run cars -- import --run <run-id>
  npm run cars -- offers clear
  npm run cars -- migrate-offers
  npm run cars -- model add --key <key> --name <nazwa> --brand <marka> --model <model>
      --year-min <rok> --price-min <PLN> --price-max <PLN> --mileage-max <km> --engines <wariant,...>
  npm run cars -- model mapping --source <id> --model <key> --set <pole=wartość> [--set ...]
  npm run cars -- model criteria --model <key> --set <pole=wartość> [--set ...]
  npm run cars -- model fields --model <key> --set <grupa=[pola,...]> [--set ...]
  npm run cars -- model deactivate --model <key>
  npm run cars -- model activate --model <key>
  npm run cars -- model remove --model <key>
  npm run cars -- source add --id <id> --name <nazwa> --adapter <adapter> --search-url <https-url>
  npm run cars -- source activate --id <id>
  npm run cars -- source deactivate --id <id>
  npm run cars -- source remove --id <id>

Źródło jest wymagane przy search. Bez --model wyszukiwane są wszystkie aktywne
modele skonfigurowane dla wskazanego źródła. Nowe mapowanie źródła jest tworzone
wyłączone; włącz je dopiero po sprawdzeniu filtrów i URL portalu.`;
process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") process.exit(0);
  throw error;
});

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") { process.stdout.write(HELP); return; }
  if (command === "validate") {
    const result = await validateConfiguration();
    process.stdout.write(`OK: ${result.models} modeli, ${result.sources} źródła.\n`);
  } else if (command === "sync") {
    const models = await syncSiteIndex();
    process.stdout.write(`Zsynchronizowano models.json: ${models} aktywnych modeli.\n`);
  } else if (command === "models") {
    const sourceAt = argv.indexOf("--source");
    if (sourceAt >= 0 && !argv[sourceAt + 1]) throw new Error("Brak wartości dla --source.");
    await listModels(sourceAt >= 0 ? argv[sourceAt + 1] : null);
  } else if (command === "urls") {
    await previewUrls(argv);
  } else if (command === "migrate-offers") {
    const result = await migrateLegacyOffers();
    await syncSiteIndex();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "import") {
    const { values } = argsMap(argv);
    if (!values.run) throw new Error("Import wymaga --run <run-id>.");
    process.stdout.write(`${JSON.stringify(await importDirectRun(values.run), null, 2)}\n`);
  } else if (command === "offers") {
    const [action, ...extra] = argv;
    if (action !== "clear" || extra.length) throw new Error("Użycie: npm run cars -- offers clear");
    const result = await clearAllOfferListings();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "search") {
    await runSearch(argv, HELP);
  } else if (command === "model") {
    const [action, ...modelArgs] = argv;
    if (action === "add") await addModel(modelArgs);
    else if (["activate", "deactivate", "remove", "mapping", "criteria", "fields"].includes(action)) await updateModel(action, modelArgs);
    else throw new Error(`Nieznana operacja modelu: ${action ?? ""}.`);
  } else if (command === "source") {
    const [action, ...sourceArgs] = argv;
    if (action === "add") await addSource(sourceArgs);
    else if (["activate", "deactivate", "remove"].includes(action)) await updateSource(action, sourceArgs);
    else throw new Error(`Nieznana operacja źródła: ${action ?? ""}.`);
  } else throw new Error(`Nieznane polecenie: ${command}.\n\n${HELP}`);
}
main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 2;
});
