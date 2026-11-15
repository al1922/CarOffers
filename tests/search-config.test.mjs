import test from "node:test";
import assert from "node:assert/strict";
import { loadSearchConfiguration } from "../src/config/load-search-config.mjs";
import { aaaautoAdapter } from "../src/search/direct/adapters/aaaauto.mjs";
import { otomotoAdapter } from "../src/search/direct/adapters/otomoto.mjs";

for (const sourceId of ["otomoto", "aaaauto"]) {
  test(`${sourceId} builds a model URL from its source mapping without network access`, async () => {
    const loaded = await loadSearchConfiguration(sourceId, ["kia-xceed"]);
    const model = loaded.models[0];
    const adapter = sourceId === "otomoto" ? otomotoAdapter : aaaautoAdapter;
    const group = { id: `${sourceId}-kia-xceed`, brand: model.brand, models: [model] };
    const plan = adapter.prepareFilterPlan(group, loaded.adapterOptions);
    const built = adapter.buildFilteredSearchUrl(group, plan, loaded.sourceConfig.searchUrl);
    const url = new URL(built.url);

    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, sourceId === "otomoto" ? "www.otomoto.pl" : "www.aaaauto.pl");
    assert.equal(loaded.adapterOptions.modelMappings[model.key].supported, true);
    assert.ok(url.pathname.toLowerCase().includes("xceed"));
  });
}

test("passes model-specific source mappings through the generic adapter context", async () => {
  const loaded = await loadSearchConfiguration("aaaauto", ["kia-xceed"]);
  assert.deepEqual(loaded.adapterOptions.modelMappings["kia-xceed"].bodyAliases, { hatchback: "crossover" });
});
