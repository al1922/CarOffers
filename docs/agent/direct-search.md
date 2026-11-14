# Direct search flow

`npm run search:direct -- --source otomoto [--model <model-key> ...]` runs an
independent visible Chromium flow. OTOMOTO uses per-model URLs with filters
encoded in the path/query, then clicks the normal Search control only if the
page did not automatically issue its results request. It audits the actual
same-session GraphQL filters before collecting cards. `--ui-filters` selects
the older form interaction. The flow records same-origin XHR/Fetch JSON
responses from that browser session, collects each results page separately,
merges API records with visible cards, and deduplicates by offer URL. It does
not claim work from the regular search queue.

After a `completed` or `partial` run, qualified offers are saved by default
through the existing local import pipeline. The importer prepares a preview,
checks identities and conflicts, then applies only a conflict-free preview.
Canonical URLs, listing IDs, and VINs prevent duplicate active records; an
active duplicate is skipped rather than overwritten by a search result. Use
`--no-import` to keep the run review-only. Import artifacts are stored under
`runs/direct-import-<run-id>/`; the original direct-search result remains
unchanged. A conflict leaves its preview for review and prevents writes.

Models are searched one at a time. This keeps each model's generation and
numeric filters independent in the OTOMOTO form. Offers are assigned back to
exact model-name tokens and checked against each model's requirements. A card
shared by multiple model matches is opened once.
Detail pages run in a bounded worker pool (default concurrency 3); set
`--detail-concurrency` to tune it. `--models key1,key2` is an alternative to
repeating `--model`. `--max-cards` is the per-model detail limit.

Pagination is driven through the next-page control where the portal uses an
in-page button. A discovered next-page URL is used only when the portal exposes
a normal link. Each page has separate response evidence. If the configured
page limit is reached while another page exists, coverage is reported as
partial rather than complete.

Before opening cards, the OTOMOTO adapter audits the final `listingScreen`
request for the selected models and every configured body, price, year, and
mileage filter. API extraction is limited to that page's final listing request,
not the broader intermediate requests generated while choosing filters. If the
portal request is missing an expected filter, the run records the mismatch and
the affected candidate cannot be marked `available` based only on that search.
Numeric filter inputs are entered with keyboard events and polled until they
retain the requested values after blur. A transient filter-control timeout can trigger one full reset and
reapplication of the filter set. If the first listing request omits a filter,
the adapter returns to the clean search page, reapplies the full set, and audits
the new request. Ambiguous options are not retried. Access denials and
challenges are never retried. If the retry also fails, pagination stops for
that group. Cards from pages with failed filter audits are not opened; cards
from earlier pages with passing audits may still be inspected.

Filter plans are prepared per source/model group before search navigation.
Source-specific `filterProfile` entries in `config/direct-search.json` hold UI
aliases, model-specific generation option labels, and field/option readiness
limits; canonical make/model values remain in the model configuration.
Autocomplete matching ignores diacritics and option result counts, then requires
one exact visible option (generation labels may include a year range or a short
examples description). OTOMOTO enables dependent autocomplete fields only after
the previous selection is applied, so the adapter submits at those dependency
boundaries. Numeric fields are entered with keyboard events because the page can
refresh its listing request while fields are being edited. After each change,
the adapter waits briefly for a matching listing request before moving on; wait
timeouts are recorded separately. The runner audits all captured `listingScreen`
requests, including those sent before the final Search click, and retries missing
numeric filters once. Pagination links preserve the search filters from the
current page.

For a live filter check without opening cards or importing offers, use:
`npm run search:direct -- --source otomoto --model <model-key> --filters-only`.
The result records whether a captured page-one `listingScreen` request included
every expected filter, together with the prepared plan and stage timings. A blocked
or challenged source stops before filter interaction.

OTOMOTO URL slugs for generations are source-specific and live in
`config/direct-search.json` under `urlGenerationValues`. If a body or year value
is not supported in the path for a model, the profile can place it in a query
parameter. If OTOMOTO does not expose a reliable body filter for a model, omit
that source filter and verify body from the offer card; do not claim the portal
filter was applied. URL navigation and the Search click are checked against
`robots.txt`; access denials and challenges stop the run.

Each source has its own adapter in `scripts/direct-search/adapters/`. The source
allowlist and run bounds live in `config/direct-search.json`. Adding a portal
means adding an adapter and registering it in `scripts/direct-search/runner.mjs`;
the existing search flow and `config/portal-adapters.json` remain independent.

Output is isolated under `runs/direct-search/<run-id>/`: `run.json`, one JSON
result per source/model, and `timings.json`. The timing file includes individual
measurements and totals, averages, minimums, maximums, and error counts per
stage. Stages include browser startup, robots check, navigation, cookie choice,
each filter action, results wait/extraction, pagination, response-body capture,
listing navigation/detail extraction/classification, the parallel detail batch,
and artifact writes. For parallel work, timings distinguish the batch wall time
from the time spent on each individual listing. Results and detail pages wait
for their data-ready signals rather than fixed settle delays; the configured
`filterReadyTimeoutMs`, `resultReadyTimeoutMs`, and `detailReadyTimeoutMs` are
upper bounds. A failed first-page filter audit allows one measured retry.

XHR/Fetch payloads are parsed in the active Playwright session; raw response
bodies are not saved. A bounded projection of listing-relevant JSON keys is
recorded alongside request URL, status, type, byte count, and network duration.
The browser does not replay captured requests. HTTP 401/403/429, CAPTCHA, or
other access challenges stop the current source run; they are never bypassed.
A separate run may be started on a new explicit user request. Cookie
consent waits for a prompt only on the first make group; later groups check
immediately and handle any still-visible prompt or overlay.

The first adapter targets OTOMOTO and applies make, one or more models,
compatible generations, compatible body type, maximum price, minimum year, and
maximum mileage through visible search controls when those values exist in the
model configuration. It reads
`robots.txt` through a same-origin browser navigation so the preflight uses
the same browser transport as the search flow. If the policy cannot be read,
the source is marked unavailable and model navigation does not begin.
