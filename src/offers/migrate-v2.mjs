import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT, listModelProfiles } from "../config/load-search-config.mjs";
import { canonicalUrl, factsFromOffer, listingFromOffer, upsertListing, createOfferGroup } from "./records.mjs";

const legacyNames = {
  otomoto: "OTOMOTO", "otomoto.pl": "OTOMOTO", aaaauto: "AAA Auto", "aaaauto.pl": "AAA Auto",
  olx: "OLX", "olx.pl": "OLX", sprzedajemy: "Sprzedajemy", "sprzedajemy.pl": "Sprzedajemy",
  autoplac: "Autoplac", "autoplac.pl": "Autoplac", automarket: "Automarket", "automarket.pl": "Automarket",
  allegrolokalnie: "Allegro Lokalnie", "allegrolokalnie.pl": "Allegro Lokalnie",
  pewneauto: "PewneAuto", "pewneauto.pl": "PewneAuto",
};

function sourceIdForUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "otomoto.pl" || host.endsWith(".otomoto.pl")) return "otomoto";
    if (host === "aaaauto.pl" || host.endsWith(".aaaauto.pl")) return "aaaauto";
    return host.replace(/[^a-z0-9.-]/g, "-");
  } catch {
    return "unknown";
  }
}

function fallbackSourceName(sourceId) {
  return legacyNames[sourceId] ?? sourceId;
}

async function sourceName(sourceId) {
  try {
    const config = JSON.parse(await readFile(path.join(ROOT, "config", "sources", `${sourceId}.json`), "utf8"));
    return config.name ?? fallbackSourceName(sourceId);
  } catch {
    return fallbackSourceName(sourceId);
  }
}

function legacyLinks(offer) {
  const values = [...(offer.urls ?? []), ...(offer.listingStates ?? []).map((state) => ({ url: state.url }))];
  return [...new Map(values.map((entry) => [canonicalUrl(entry?.url), entry]).filter(([url]) => url)).values()];
}

export async function migrateLegacyOffers() {
  const models = await listModelProfiles();
  const migrated = [];
  let moved = 0;
  let skipped = 0;
  for (const model of models) {
    const filePath = path.join(ROOT, "offers", `${model.key}.json`);
    let legacy;
    try { legacy = JSON.parse(await readFile(filePath, "utf8")); }
    catch (error) {
      if (error?.code === "ENOENT") legacy = { offers: [] };
      else throw error;
    }
    if (legacy.schemaVersion === 3) {
      for (const group of legacy.offers ?? []) {
        for (const listing of group.listings ?? []) {
          listing.sourceName = await sourceName(listing.sourceId);
          listing.facts = factsFromOffer(listing.facts ?? {}, listing.lastCheckedAt ?? null);
        }
        const checked = group.listings?.map((listing) => listing.lastCheckedAt).filter(Boolean).sort().at(-1);
        group.lastUpdatedAt = checked ?? group.lastUpdatedAt ?? group.firstSeenAt ?? null;
      }
      migrated.push({ model, filePath, data: legacy });
      continue;
    }
    const groups = [];
    for (const offer of legacy.offers ?? []) {
      const links = legacyLinks(offer);
      if (!links.length) { skipped += 1; continue; }
      for (const [index, link] of links.entries()) {
        const url = canonicalUrl(link.url);
        const sourceId = sourceIdForUrl(url);
        const source = await sourceName(sourceId);
        const checkedAt = offer.lastCheckedAt ?? offer.lastVerifiedAt ?? offer.firstSeenAt ?? legacy.updatedAt ?? new Date().toISOString();
        const primaryOffer = index === 0 ? offer : { vin: offer.vin };
        const listing = listingFromOffer(primaryOffer, sourceId, source, url, checkedAt);
        const vin = /^[A-HJ-NPR-Z0-9]{17}$/i.test(String(offer.vin ?? "")) ? offer.vin.toUpperCase() : null;
        const existingIndex = groups.findIndex((group) => group.listings.some((item) => item.key === listing.key)) >= 0
          ? groups.findIndex((group) => group.listings.some((item) => item.key === listing.key))
          : vin ? groups.findIndex((group) => group.identityKey === `vin:${vin}`) : -1;
        if (existingIndex >= 0) groups[existingIndex] = upsertListing(groups[existingIndex], listing, checkedAt);
        else {
          const group = createOfferGroup(primaryOffer, listing, model.key, checkedAt);
          group.firstSeenAt = offer.firstSeenAt ?? checkedAt;
          group.lastUpdatedAt = checkedAt;
          groups.push(group);
        }
        moved += index === 0 ? 1 : 0;
      }
    }
    const data = {
      schemaVersion: 3,
      updatedAt: new Date().toISOString(),
      model: { key: model.key, name: model.name },
      offers: groups,
    };
    migrated.push({ model, filePath, data });
  }

  for (const { filePath, data } of migrated) {
    if (data.schemaVersion !== 3) continue;
    const tempPath = `${filePath}.migration.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  }
  return { models: migrated.length, movedLegacyOffers: moved, skippedWithoutUrl: skipped };
}
