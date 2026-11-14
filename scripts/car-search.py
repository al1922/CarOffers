#!/usr/bin/env python3
"""Manual coordinator tools; does not scrape websites or publish changes."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import unicodedata
from urllib.parse import urlsplit
from search_core import ASSESSMENT_FIELDS, ROOT, assess, audit, audit_model_index, brand_key, contained, description, read, write, requirements_for_model


BODY_TERMS = {
    "wagon": "kombi", "sedan": "sedan", "suv": "SUV", "crossover": "crossover",
    "hatchback": "hatchback", "minivan": "minivan"
}


def compact_text(value):
    return re.sub(r"[^a-z0-9]", "", str(value).casefold())


def search_task_host(task):
    profile = task.get("searchProfile") if isinstance(task, dict) else None
    search_url = profile.get("searchUrl") if isinstance(profile, dict) else None
    if not isinstance(search_url, str):
        return None
    try:
        host = urlsplit(search_url).hostname
    except ValueError:
        return None
    if not host:
        return None
    host = host.casefold()
    return host[4:] if host.startswith("www.") else host


def safe_portal_url(value):
    """Encode raw characters rejected by the offer URL contract before navigation/storage."""
    return str(value).replace("|", "%7C")


SOURCE_ACCESS_DENIAL = re.compile(
    r"\b(?:HTTP\s*)?(?:401|403|429)\b|captcha|challenge|access denied|forbidden|"
    r"robots?\.txt|odm[oó]w[a-z]* dost[eę]pu|zablokowan\w* przez portal|niedozwolon\w* przez robots",
    re.I,
)


def source_wide_access_block(task, result):
    """Return a block record only for denial at the source search endpoint or root robots.txt."""
    if task.get("kind") != "search" or not isinstance(result, dict) or result.get("outcome") not in ("blocked", "partial"):
        return None
    profile = task.get("searchProfile") or {}
    source_url = profile.get("searchUrl")
    try:
        base = urlsplit(source_url)
        if base.scheme != "https" or not base.hostname:
            return None
        base_host = base.hostname.casefold().removeprefix("www.")
        base_path = base.path.rstrip("/") or "/"
    except (TypeError, ValueError):
        return None
    for error in result.get("errors", []):
        if not isinstance(error, dict) or not SOURCE_ACCESS_DENIAL.search(str(error.get("error", ""))):
            continue
        try:
            denied = urlsplit(error.get("url", ""))
            if (denied.scheme != "https" or not denied.hostname or
                    denied.hostname.casefold().removeprefix("www.") != base_host or
                    denied.port != base.port):
                continue
        except (TypeError, ValueError):
            continue
        denied_path = denied.path.rstrip("/") or "/"
        is_root_robots = denied_path.casefold() == "/robots.txt"
        is_search_endpoint = denied_path == base_path
        if is_root_robots or is_search_endpoint:
            return {"sourceId": task.get("sourceId"), "taskId": task.get("id"),
                    "url": error.get("url"), "reason": str(error.get("error", "Access denied"))[:500],
                    "checkedAt": result.get("checkedAt")}
    return None


def apply_source_access_blocks(queue, run):
    """Skip unstarted model tasks after a confirmed source-wide access denial."""
    blocks = queue.setdefault("sourceAccessBlocks", [])
    if not isinstance(blocks, list):
        blocks = queue["sourceAccessBlocks"] = []
    known = {(entry.get("sourceId"), entry.get("taskId")) for entry in blocks if isinstance(entry, dict)}
    changed = False
    for task in queue.get("tasks", []):
        if task.get("kind") != "search" or task.get("state") not in ("blocked", "partial"):
            continue
        result_path = run / "results" / (str(task.get("id", "")) + ".json")
        if not result_path.is_file():
            continue
        try:
            result = read(result_path)
        except (OSError, ValueError, TypeError):
            continue
        block = source_wide_access_block(task, result)
        if block and (block["sourceId"], block["taskId"]) not in known:
            blocks.append(block)
            known.add((block["sourceId"], block["taskId"]))
            changed = True
    for block in blocks:
        if not isinstance(block, dict) or not block.get("sourceId"):
            continue
        for task in queue.get("tasks", []):
            if (task.get("kind") != "search" or task.get("sourceId") != block["sourceId"] or
                    task.get("state") not in ("pending", "pending_manual")):
                continue
            task.update(state="skipped", worker=None, skippedAt=datetime.now(timezone.utc).isoformat(),
                        skipReason="source_access_block", skippedAfterTask=block.get("taskId"),
                        note=f"Pominięto bez ponawiania po odmowie dostępu na źródle: {block.get('url', '')}")
            changed = True
    return changed


def build_search_profile(source, model, model_req, knowledge):
    profile_source = {**source, "searchUrl": safe_portal_url(source["searchUrl"])}
    return {
        "searchUrl": profile_source["searchUrl"],
        "filtersAvailable": source["filters"],
        "filtersToVerifyManually": sorted({"make", "model", "body", "price", "year",
                                            "mileage", "fuel", "transmission", "seller_type"} - set(source["filters"])),
        "brands": [model["brand"]], "bodies": model["bodies"],
        "years": {"min": max(model_req["yearMin"], model["searchYears"]["min"]),
                  "max": model["searchYears"]["max"]},
        "engineVariants": model["allowedEngineVariants"],
        "requirements": model_req,
        "maxGrossPurchasePln": model_req["purchase"]["maxPriceGrossPln"],
        "priceOverLimitRequiresUserApproval": bool(model_req["purchase"]["priceExceptions"]),
        "preferredMileageKm": model_req["mileage"]["preferredMaxKm"],
        "candidateScreening": {
            "stage": "results_list_before_opening_candidate_cards",
            "visibleFields": ["production_year", "price_and_terms", "mileage", "body", "engine_variant", "sale_type"],
            "screeningLimits": {
                "productionYearMin": max(model_req["yearMin"], model["searchYears"]["min"]),
                "productionYearMax": model["searchYears"]["max"],
                "basePurchaseGrossPlnMax": model_req["purchase"]["maxPriceGrossPln"],
                "hardMileageKmMax": model_req["mileage"].get("hardMaxKm"),
                "bodyCodes": model["bodies"], "engineVariants": model["allowedEngineVariants"],
                "auctionsAllowed": model_req["purchase"]["auctionsAllowed"]
            },
            "priceExceptions": model_req["purchase"]["priceExceptions"],
            "priceOverLimitRequiresUserApproval": bool(model_req["purchase"]["priceExceptions"]),
            "rejectOnlyOnVisibleConfirmedFailure": True,
            "unknownHandling": "open_card_if_other_visible_fields_are_plausible",
            "reminders": [
                "production year is not first registration or model year",
                "a displayed price is not unconditional gross purchase price unless its terms say so",
                "apply configured price exceptions only with explicit user approval",
                "search result snippets do not confirm listing availability"
            ]
        },
        "transmissions": model_req["transmissions"],
        "cameraRequired": model_req["camera"]["required"],
        "cameraRetrofitAllowed": model_req["camera"]["retrofitAllowed"],
        "lpgAllowedAndMustBeMarked": model_req["lpg"]["allowed"],
        "familyProfile": model_req["use"],
        "structuralDamageAllowed": model_req["structuralDamageAllowed"],
        "country": model_req["location"], "excludeAuctions": not model_req["purchase"]["auctionsAllowed"],
        "sourceAccessStatus": source["accessStatus"],
        "queryPlan": build_query_plan(profile_source, model, model_req, knowledge),
        "captureOfferLocation": {
            "required": True,
            "whenMissing": "set location.status=not_provided and show that distance cannot be calculated",
            "fields": ["countryCode", "voivodeship", "city", "postalCode"],
            "coordinates": "record only when provided or geocoded with a recorded source",
            "doNotGuess": True
        },
        "sourceMethod": source["method"]
    }


def worker_project_hashes(root):
    paths = []
    for folder, suffixes in ((root / "scripts", {".mjs", ".py"}),
                             (root / "config", {".json"})):
        paths.extend(path for path in folder.glob("*") if path.is_file() and path.suffix in suffixes)
    paths.extend(path for path in (root / "knowledge" / "models").glob("*.json") if path.is_file())
    paths.extend(path for path in (root / "package.json", root / "package-lock.json") if path.is_file())
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


def active_offer_snapshot(root):
    urls = set()
    for offer_file in (root / "offers").glob("*.json"):
        document = read(offer_file)
        for offer in document.get("offers", []):
            if not isinstance(offer, dict):
                continue
            for item in offer.get("urls", []):
                url = item.get("url") if isinstance(item, dict) else None
                if isinstance(url, str):
                    urls.add(url)
    return {"activeOfferUrls": sorted(urls)}


def export_worker_bundle(root, run, queue, task):
    task_id = task.get("id", "")
    if task.get("kind") != "search" or task.get("state") != "running" or not task.get("worker"):
        raise ValueError("export-worker requires a running search task with an assigned worker")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", task_id):
        raise ValueError("Task has an invalid ID")
    result_path = run / "results" / f"{task_id}.json"
    if result_path.exists():
        raise ValueError("A result already exists for this task; preserving it")
    bundle_root = run / "worker-bundles"
    bundle_path = bundle_root / task_id
    if bundle_path.exists():
        raise ValueError(f"Worker bundle already exists; preserving it: {bundle_path.relative_to(root).as_posix()}")

    claim = dict(task)
    claim["runId"] = run.name
    claim["sharedResultsCache"] = build_shared_search_cache(root, run, queue, task["sourceId"], task)
    claim.update(active_offer_snapshot(root))
    bundle_root.mkdir(parents=True, exist_ok=True)
    temp_path = Path(tempfile.mkdtemp(prefix=f".{task_id}-", dir=bundle_root))
    try:
        write(temp_path / "claim.json", claim)
        input_files = {"claim.json": hashlib.sha256((temp_path / "claim.json").read_bytes()).hexdigest()}
        continuation = task.get("continuation")
        if continuation:
            source_task_id = continuation.get("sourceTaskId", "")
            if not isinstance(source_task_id, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", source_task_id):
                raise ValueError("Continuation has an invalid source task ID")
            source_path = run / "results" / f"{source_task_id}.json"
            source_result = read(source_path)
            if source_result.get("taskId") != source_task_id or source_result.get("outcome") != "partial":
                raise ValueError("Continuation source result is missing or no longer partial")
            source_coverage = source_result.get("coverage", {})
            saved_pages = source_coverage.get("searchResults", []) if isinstance(source_coverage, dict) else []
            if not any(isinstance(page, dict) and (page.get("queryId") or "unfiltered") == continuation.get("queryId") and
                       page.get("nextUrl") == continuation.get("nextUrl") and
                       page.get("nextUrlAllowed") is not False and page.get("paginationComplete") is not True
                       for page in (saved_pages if isinstance(saved_pages, list) else [])):
                raise ValueError("Continuation URL is not present as an allowed nextUrl in its source result")
            target_path = temp_path / "continuation-source-result.json"
            shutil.copyfile(source_path, target_path)
            input_files[target_path.name] = hashlib.sha256(target_path.read_bytes()).hexdigest()

        manifest = {
            "formatVersion": 1,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "runId": run.name,
            "taskId": task_id,
            "worker": task["worker"],
            "sourceId": task["sourceId"],
            "modelKey": task.get("modelKey"),
            "task": {key: task.get(key) for key in ("id", "kind", "state", "worker", "sourceId", "modelKey", "searchProfile", "continuation")},
            "inputFiles": input_files,
            "projectFiles": worker_project_hashes(root),
            "requiresMatchingCheckout": True,
        }
        write(temp_path / "manifest.json", manifest)
        os.replace(temp_path, bundle_path)
    except Exception:
        shutil.rmtree(temp_path, ignore_errors=True)
        raise
    return bundle_path


def collect_worker_bundle(root, run, queue, task):
    task_id = task.get("id", "")
    bundle_path = run / "worker-bundles" / task_id
    manifest_path = bundle_path / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError(f"Worker bundle manifest is missing: {manifest_path.relative_to(root).as_posix()}")
    manifest = read(manifest_path)
    if manifest.get("formatVersion") != 1 or manifest.get("runId") != run.name or manifest.get("taskId") != task_id:
        raise ValueError("Worker bundle manifest does not match this run/task")
    if manifest.get("worker") != task.get("worker") or task.get("kind") != "search" or task.get("state") != "running":
        raise ValueError("Task must still be running for the worker assigned in the bundle")
    if manifest.get("projectFiles") != worker_project_hashes(root):
        raise ValueError("CarOffers code/config differs from the exported bundle; use the matching checkout")

    claim_path = bundle_path / "claim.json"
    claim = read(claim_path)
    expected_inputs = manifest.get("inputFiles")
    if not isinstance(expected_inputs, dict) or "claim.json" not in expected_inputs:
        raise ValueError("Worker bundle input manifest is invalid")
    for filename, expected_hash in expected_inputs.items():
        if filename not in {"claim.json", "continuation-source-result.json"}:
            raise ValueError("Worker bundle contains an unexpected input file")
        input_path = bundle_path / filename
        if not input_path.is_file() or hashlib.sha256(input_path.read_bytes()).hexdigest() != expected_hash:
            raise ValueError(f"Worker bundle input changed or is missing: {filename}")

    task_fields = ("id", "kind", "state", "worker", "sourceId", "modelKey", "searchProfile", "continuation")
    if any(claim.get(key) != task.get(key) for key in task_fields):
        raise ValueError("Exported claim no longer matches the running task in tasks.json")
    if manifest.get("task") != {key: task.get(key) for key in task_fields}:
        raise ValueError("Bundle task metadata does not match the current task")
    if claim.get("runId") != run.name or manifest.get("sourceId") != task.get("sourceId") or manifest.get("modelKey") != task.get("modelKey"):
        raise ValueError("Worker bundle identity mismatch")
    if task.get("continuation"):
        source_task_id = task["continuation"].get("sourceTaskId")
        source_path = run / "results" / f"{source_task_id}.json"
        bundle_source = bundle_path / "continuation-source-result.json"
        if not bundle_source.is_file() or not source_path.is_file() or bundle_source.read_bytes() != source_path.read_bytes():
            raise ValueError("Continuation source result differs from the local run; export a fresh bundle")
    elif "continuation-source-result.json" in expected_inputs:
        raise ValueError("Unexpected continuation source result in a normal search bundle")

    result_path = bundle_path / "result.json"
    receipt_path = bundle_path / "result.sha256"
    if not result_path.is_file() or not receipt_path.is_file():
        raise ValueError("Network worker has not returned a complete result bundle")
    result_bytes = result_path.read_bytes()
    if receipt_path.read_text(encoding="ascii").strip() != hashlib.sha256(result_bytes).hexdigest():
        raise ValueError("Returned result checksum does not match")
    result = read(result_path)
    if not isinstance(result, dict) or result.get("taskId") != task_id or result.get("outcome") not in ("complete", "partial", "blocked", "no_matches"):
        raise ValueError("Returned result taskId/outcome is invalid")
    if task.get("continuation") and result.get("continuation") != task.get("continuation"):
        raise ValueError("Returned continuation metadata does not match the local task")

    local_result = run / "results" / f"{task_id}.json"
    if local_result.exists():
        raise ValueError(f"A local result already exists; preserving it: {local_result.relative_to(root).as_posix()}")
    fd, temp_name = tempfile.mkstemp(prefix=f".{task_id}.collect-", suffix=".tmp", dir=local_result.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(result_bytes)
            handle.flush()
            os.fsync(handle.fileno())
        if os.name == "nt":
            # Windows rename is atomic within a directory and refuses to replace
            # an existing destination, unlike os.replace.
            os.rename(temp_name, local_result)
        else:
            os.link(temp_name, local_result)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
    return local_result


def engine_search_aliases(variant, knowledge):
    match = re.search(r"-(\d+)$", variant)
    power = int(match.group(1)) if match else None
    prefix = compact_text(variant[:match.start()] if match else variant)
    aliases = []

    def visit(value):
        if isinstance(value, dict):
            label = value.get("label") or value.get("name") or value.get("variant")
            candidate_power = value.get("powerPS", value.get("systemPowerPS"))
            if isinstance(label, str) and (power is None or candidate_power == power):
                compact_label = compact_text(label)
                if compact_label and (prefix.startswith(compact_label) or compact_label.startswith(prefix)):
                    aliases.append(label + (f" {power} KM" if power else ""))
            for nested in value.values():
                visit(nested)
        elif isinstance(value, list):
            for nested in value:
                visit(nested)

    for claim in knowledge.get("claims", []):
        if claim.get("topic") == "engine":
            visit(claim.get("value", {}))
    fallback = variant.replace("-", " ") + (f" KM" if power else "")
    unique = []
    for alias in [*aliases, fallback]:
        if alias.casefold() not in {item.casefold() for item in unique}:
            unique.append(alias)
    return unique


def build_query_plan(source, model, requirements, knowledge):
    years = {"min": max(requirements["yearMin"], model["searchYears"]["min"]),
             "max": model["searchYears"]["max"]}
    body_terms = list(dict.fromkeys(BODY_TERMS.get(body, body) for body in model["bodies"]))
    filter_values = {
        "make": model["brand"], "model": model["model"], "body": model["bodies"],
        "year": years, "price": {"maxGrossPln": requirements["purchase"]["maxPriceGrossPln"]},
        "mileage": {"maxKm": requirements["mileage"].get("hardMaxKm")},
        "location": requirements["location"], "transmission": requirements["transmissions"]
    }
    native_filters = {key: value for key, value in filter_values.items()
                      if key in source["filters"] and value is not None}
    prefix = f"{model['brand']} {model['model']}"
    queries = [{"id": "model-body", "text": " ".join([prefix, *([model["generation"]] if model.get("generation") else []), *body_terms])}]
    engine_queries = []
    for variant in model["allowedEngineVariants"]:
        aliases = engine_search_aliases(variant, knowledge)
        query = " ".join([prefix, *body_terms, aliases[0]])
        queries.append({"id": "engine-" + variant, "text": query, "engineVariant": variant})
        engine_queries.append({"engineVariant": variant, "aliases": aliases})
    return {
        "sourceId": source["id"], "searchUrl": source["searchUrl"],
        "availableFilters": list(source["filters"]), "nativeFilters": native_filters,
        "manualFilters": {key: value for key, value in filter_values.items() if key not in native_filters},
        "textQueries": queries, "engineAliases": engine_queries,
        "bodyAliases": body_terms,
        "cardChecks": ["production_year", "listing_availability", "listed_gross_price",
                       "exact_engine_variant", "sale_type", "lpg_installed", "camera", "structural_damage"]
    }


def normalized_search_text(value):
    return "".join(char for char in unicodedata.normalize("NFD", str(value or "").lower())
                   if unicodedata.category(char) != "Mn")


def listing_matches_profile(listing, profile):
    plan = profile.get("queryPlan", {})
    query = plan.get("manualFilters", {})
    native = plan.get("nativeFilters", {})
    model = normalized_search_text(query.get("model") or native.get("model", "")).strip()
    brand = normalized_search_text(query.get("make") or native.get("make", "")).strip()
    text = normalized_search_text(" ".join(str(listing.get(key, "")) for key in ("title", "visibleText", "snippet")))
    if not model or model not in text:
        return False
    if not brand:
        return True
    aliases = {"volkswagen": ("volkswagen", "vw"), "skoda": ("skoda", "skoda")}
    if model.isdigit():
        return any(f"{alias} {model}" in text for alias in aliases.get(brand, (brand,)))
    return any(alias in text for alias in aliases.get(brand, (brand,)))


def card_matches_profile(card, profile):
    plan = profile.get("queryPlan", {})
    query = plan.get("manualFilters", {})
    native = plan.get("nativeFilters", {})
    expected_model = normalized_search_text(query.get("model") or native.get("model", ""))
    expected_brand = normalized_search_text(query.get("make") or native.get("make", ""))
    fields = card.get("fields", {}) if isinstance(card, dict) else {}
    actual_model = normalized_search_text(fields.get("Model", ""))
    actual_brand = normalized_search_text(fields.get("Marka", ""))
    if expected_model and expected_brand and actual_model and actual_brand:
        actual_model_key = re.sub(r"[^a-z0-9]", "", actual_model)
        expected_model_key = re.sub(r"[^a-z0-9]", "", expected_model)
        brand_aliases = {"volkswagen": ("volkswagen", "vw"), "skoda": ("skoda",)}
        actual_brand_key = re.sub(r"[^a-z0-9]", "", actual_brand)
        brand_matches = {re.sub(r"[^a-z0-9]", "", item)
                         for item in brand_aliases.get(expected_brand, (expected_brand,))}
        return actual_model_key == expected_model_key and actual_brand_key in brand_matches
    return listing_matches_profile({"title": card.get("title", "")}, profile)


def build_shared_search_cache(root, run, queue, source_id, task=None):
    pages, snippets, checked_urls, card_reads = {}, {}, set(), {}
    terminal = {"complete", "partial", "blocked", "no_matches"}
    for prior in queue.get("tasks", []):
        if prior.get("kind") != "search" or prior.get("sourceId") != source_id or prior.get("state") not in terminal:
            continue
        result_path = run / "results" / (prior["id"] + ".json")
        if not result_path.exists():
            continue
        try:
            result = read(result_path)
        except (OSError, ValueError, TypeError):
            continue
        coverage = result.get("coverage", {}) if isinstance(result, dict) else {}
        if not isinstance(coverage, dict):
            continue
        checked_listing_urls = coverage.get("listingUrlsChecked", [])
        search_results = coverage.get("searchResults", [])
        offers = result.get("offers", []) if isinstance(result, dict) else []
        reads = coverage.get("cardReads")
        for entry in reads if isinstance(reads, list) else []:
            if (not isinstance(entry, dict) or not isinstance(entry.get("url"), str)
                    or not isinstance(entry.get("checkedAt"), str)):
                continue
            previous = card_reads.get(entry["url"])
            if previous is None or entry["checkedAt"] > previous["checkedAt"]:
                card_reads[entry["url"]] = entry
        for url in checked_listing_urls if isinstance(checked_listing_urls, list) else []:
            if isinstance(url, str):
                checked_urls.add(url)
        for offer in offers if isinstance(offers, list) else []:
            observation = offer.get("observation", {}) if isinstance(offer, dict) else {}
            if isinstance(observation, dict) and isinstance(observation.get("url"), str):
                checked_urls.add(observation["url"])
        for page in search_results if isinstance(search_results, list) else []:
            if not isinstance(page, dict) or not isinstance(page.get("url"), str):
                continue
            page_key = page["url"]
            page_listings = page.get("listings")
            listing_count = len(page_listings) if isinstance(page_listings, list) else None
            page_entry = {"url": page_key, "checkedAt": page.get("checkedAt"),
                          "queryId": page.get("queryId"), "nextUrl": page.get("nextUrl"),
                          "nextUrlAllowed": page.get("nextUrlAllowed"),
                          "paginationComplete": page.get("paginationComplete") is True,
                          "listingCount": listing_count, "taskId": prior["id"],
                          "modelKey": prior.get("modelKey")}
            previous_page = pages.get(page_key)
            if previous_page is None or (page_entry.get("checkedAt") or "") > (previous_page.get("checkedAt") or ""):
                pages[page_key] = page_entry
            for listing in page_listings if isinstance(page_listings, list) else []:
                if not isinstance(listing, dict) or not isinstance(listing.get("url"), str):
                    continue
                listing_key = listing["url"]
                snippet_entry = {**listing, "pageUrl": page_key,
                                 "checkedAt": page.get("checkedAt"),
                                 "taskId": prior["id"],
                                 "modelKey": prior.get("modelKey")}
                previous_snippet = snippets.get(listing_key)
                if previous_snippet is None or (snippet_entry.get("checkedAt") or "") > (previous_snippet.get("checkedAt") or ""):
                    snippets[listing_key] = snippet_entry
    profile = task.get("searchProfile", {}) if isinstance(task, dict) else {}
    plan = profile.get("queryPlan", {})
    model_scoped = bool(plan.get("manualFilters", {}).get("model") or plan.get("nativeFilters", {}).get("model"))
    candidate_urls = None
    if model_scoped:
        candidate_urls = set()
        for url, listing in snippets.items():
            cached = card_reads.get(url)
            matches = (card_matches_profile(cached.get("card") or {}, profile)
                       if cached and isinstance(cached.get("card"), dict)
                       else listing_matches_profile(listing, profile))
            if matches:
                candidate_urls.add(url)
    ordered_pages = sorted(pages.values(), key=lambda item: item.get("checkedAt") or "", reverse=True)[:100]
    ordered_snippets = sorted(snippets.values(), key=lambda item: item.get("checkedAt") or "", reverse=True)[:300]
    cached_counts = {}
    for snippet in ordered_snippets:
        page_url = snippet.get("pageUrl")
        cached_counts[page_url] = cached_counts.get(page_url, 0) + 1
    for page in ordered_pages:
        cached_count = cached_counts.get(page["url"], 0)
        page["cachedListingCount"] = cached_count
        page["listingsComplete"] = page.get("listingCount") is not None and cached_count == page["listingCount"]
    if candidate_urls is not None:
        for entry in card_reads.values():
            if card_matches_profile(entry.get("card") or {}, profile):
                candidate_urls.add(entry["url"])
        ordered_card_reads = [entry for entry in card_reads.values() if entry["url"] in candidate_urls]
        ordered_checked_urls = sorted(checked_urls & candidate_urls)
    else:
        ordered_card_reads = list(card_reads.values())
        ordered_checked_urls = sorted(checked_urls)
    return {"checkedSearchPages": ordered_pages, "visibleListings": ordered_snippets,
            "listingUrlsChecked": ordered_checked_urls[-500:],
            "cardReads": sorted(ordered_card_reads, key=lambda item: item["checkedAt"], reverse=True)[:500],
            **({"cacheModelKey": task.get("modelKey")} if model_scoped else {})}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=["validate", "sync", "plan", "refresh-plan", "availability-plan", "archive-availability-plan", "claim", "continue-search", "export-worker", "collect-worker", "finish", "assess", "import-preview", "import-apply", "direct-import"])
    p.add_argument("--root", type=Path, default=ROOT)
    p.add_argument("--run")
    p.add_argument("--worker")
    p.add_argument("--task")
    p.add_argument("--manual", action="store_true",
                   help="claim a manual-only search task for visible public-browser review")
    p.add_argument("--result", choices=["complete", "partial", "blocked", "no_matches"])
    p.add_argument("--note", default="")
    p.add_argument("--agents", type=int, default=3,
                   help="maximum concurrent workers recorded for a run; search claims enforce this limit")
    p.add_argument("--model", action="append", dest="models")
    p.add_argument("--source", action="append", dest="sources")
    p.add_argument("--older-than-days", type=int, help="For refresh-plan, include listings not successfully checked within this many days")
    p.add_argument("--offer", action="append", dest="offer_ids", help="For refresh-plan, explicitly select an offer ID (repeatable)")
    p.add_argument("--photo-audit", action="store_true",
                   help="For refresh-plan, require a per-card audit of direct photo URLs")
    args = p.parse_args()
    if args.manual and args.command != "claim":
        p.error("--manual is only valid with claim")
    if args.photo_audit and args.command != "refresh-plan":
        p.error("--photo-audit is only valid with refresh-plan")
    root = args.root.resolve()
    if args.command == "direct-import":
        if not args.run or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", args.run):
            p.error("--run requires a simple alphanumeric direct-search ID")
        config, issues = audit(root)
        if any(item["severity"] == "error" for item in issues):
            p.error(json.dumps(issues, ensure_ascii=False))
        from offer_import import apply, prepare, prepare_direct_import_run
        try:
            import_run_id = prepare_direct_import_run(root, args.run, config)
            if import_run_id is None:
                print(json.dumps({"status": "no_offers", "directRunId": args.run}, ensure_ascii=False))
                return 0
            plan = prepare(root, import_run_id, config)
            counts = {}
            for change in plan["changes"]:
                counts[change["kind"]] = counts.get(change["kind"], 0) + 1
            skipped = {}
            for item in plan["skipped"]:
                skipped[item["reason"]] = skipped.get(item["reason"], 0) + 1
            if plan["conflicts"]:
                print(json.dumps({"status": "conflicts", "directRunId": args.run, "importRunId": import_run_id,
                                  "changes": counts, "conflicts": plan["conflicts"], "skipped": skipped}, ensure_ascii=False))
                return 2
            apply_status = apply(root, import_run_id)
            if apply_status in ("applied", "already_applied"):
                report = []
                for model in config["models"]["models"]:
                    model_req = requirements_for_model(model, config["requirements"])
                    for offer in read(contained(root, model["offersFile"]))["offers"]:
                        report.append({**assess(offer, model_req, model),
                                       "input": {key: offer.get(key) for key in ASSESSMENT_FIELDS}})
                write(root / "reports/current-assessment.json", {"generatedAt": datetime.now(timezone.utc).isoformat(),
                      "configuration": config, "assessments": report})
            print(json.dumps({"status": apply_status, "directRunId": args.run, "importRunId": import_run_id,
                              "changes": counts, "conflicts": 0, "skipped": skipped}, ensure_ascii=False))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            p.error(str(exc))
        return 0
    if args.command in ("import-preview", "import-apply"):
        if not args.run or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", args.run):
            p.error("--run requires a simple alphanumeric ID")
        from offer_import import apply, prepare
        try:
            if args.command == "import-apply":
                print(apply(root, args.run))
            else:
                config, issues = audit(root)
                if any(i["severity"] == "error" for i in issues):
                    raise ValueError(json.dumps(issues, ensure_ascii=False))
                plan = prepare(root, args.run, config)
                change_counts = {}
                for change in plan["changes"]:
                    change_counts[change["kind"]] = change_counts.get(change["kind"], 0) + 1
                skipped_counts = {}
                for item in plan["skipped"]:
                    skipped_counts[item["reason"]] = skipped_counts.get(item["reason"], 0) + 1
                changes_text = ", ".join(f"{count} {kind}" for kind, count in sorted(change_counts.items())) or "0 changes"
                skipped_text = ", ".join(f"{count} {reason}" for reason, count in sorted(skipped_counts.items())) or "none skipped"
                print(f"Preview: {changes_text}; {len(plan['conflicts'])} conflicts; skipped: {skipped_text}; offers unchanged")
        except (OSError, ValueError, KeyError, TypeError) as exc:
            p.error(str(exc))
        return 0
    if args.command in ("claim", "continue-search", "export-worker", "collect-worker", "finish"):
        if not args.run or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", args.run):
            p.error("--run requires a simple alphanumeric ID")
        snapshot = read(root / "runs" / args.run / "snapshot.json")
        content = {"config": snapshot["config"], "knowledge": snapshot["knowledge"]}
        digest = hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if digest != snapshot["sha256"]:
            p.error("Snapshot integrity check failed")
        config, issues = snapshot["config"], []
    else:
        config, issues = audit(root)
    for item in issues:
        print(json.dumps(item, ensure_ascii=False))
    if any(i["severity"] == "error" for i in issues):
        return 1
    req, models, sources = config["requirements"], config["models"]["models"], config["sources"]["sources"]
    if args.command == "validate":
        adapter_config = read(root / "config/portal-adapters.json")
        adapters = adapter_config.get("adapters", {})
        enabled_sources = [source for source in sources if source.get("enabled")]
        adapter_errors = []
        supported_modes = {"text_query", "make_model", "native_select", "suggestion_brand_model", "dialog_make_model", "checkbox_model", "catalog_model", "olx_category", "autoplac_dialog", "existing_results", "blocked", "dedicated"}
        known_source_ids = {source.get("id") for source in sources}
        for source_id in adapters:
            if source_id not in known_source_ids:
                adapter_errors.append(f"Adapter references unknown source: {source_id}")
        for source in enabled_sources:
            adapter = adapters.get(source["id"])
            if not isinstance(adapter, dict):
                adapter_errors.append(f"Missing portal adapter: {source['id']}")
                continue
            if adapter.get("mode") not in supported_modes:
                adapter_errors.append(f"Unsupported portal adapter mode for {source['id']}: {adapter.get('mode')}")
            if adapter.get("mode") == "text_query" and not adapter.get("queryInput"):
                adapter_errors.append(f"text_query adapter requires queryInput: {source['id']}")
            if adapter.get("mode") == "make_model" and not (adapter.get("makeInput") and adapter.get("modelInput")):
                adapter_errors.append(f"make_model adapter requires makeInput and modelInput: {source['id']}")
            if adapter.get("mode") == "native_select" and not adapter.get("modelSelect"):
                adapter_errors.append(f"native_select adapter requires modelSelect: {source['id']}")
            if adapter.get("mode") == "suggestion_brand_model" and not adapter.get("queryInput"):
                adapter_errors.append(f"suggestion_brand_model adapter requires queryInput: {source['id']}")
            if adapter.get("mode") == "dialog_make_model" and (
                not all(adapter.get(key) for key in ("filterGroup", "confirmChoice", "showResults"))
                or not isinstance(adapter.get("controls"), dict)
                or set(adapter["controls"]) != {"make", "model"}
            ):
                adapter_errors.append(f"dialog_make_model adapter requires filterGroup, make/model controls, confirmChoice and showResults: {source['id']}")
            if adapter.get("mode") == "checkbox_model" and not all(adapter.get(key) for key in ("openFilters", "modelCheckbox")):
                adapter_errors.append(f"checkbox_model adapter requires openFilters and modelCheckbox: {source['id']}")
            if adapter.get("mode") == "catalog_model" and (
                not all(adapter.get(key) for key in ("openFilters", "dialogName", "modelControl", "showResults"))
                or not isinstance(adapter.get("modelLabels"), dict)
            ):
                adapter_errors.append(f"catalog_model adapter requires dialog and model controls: {source['id']}")
            if not adapter.get("cardMode"):
                adapter_errors.append(f"Portal adapter requires cardMode: {source['id']}")
            if adapter.get("mode") == "blocked" and not adapter.get("note"):
                adapter_errors.append(f"Blocked portal adapter requires an explanation: {source['id']}")
            if adapter.get("mode") == "dedicated" and source["id"] != "sprzedajemy":
                adapter_errors.append(f"dedicated adapter mode is reserved for the Sprzedajemy workflow: {source['id']}")
        if adapter_errors:
            for error in adapter_errors:
                print("ERROR: " + error)
            return 1
        index_issues = audit_model_index(root, config)
        for item in index_issues:
            print(json.dumps(item, ensure_ascii=False))
        if any(item["severity"] == "error" for item in index_issues):
            return 1
        print(f"OK: {len(models)} models, {len(sources)} sources, {len(enabled_sources)} enabled portal adapters")
    elif args.command == "sync":
        for m in models:
            model_req = requirements_for_model(m, req)
            path = contained(root, m["offersFile"])
            doc = read(path)
            doc["model"]["requirements"] = description(model_req, m)
            write(path, doc)
        # The published index remains compatible with the existing frontend.
        index = []
        for path in sorted((root / "offers").glob("*.json")):
            m = read(path)["model"]
            index.append({"key": m["key"], "name": m["name"], "description": m.get("description", ""),
                          "requirements": m.get("requirements"), "file": f"offers/{path.name}"})
        write(root / "models.json", {"version": 1, "models": index})
        print("Synced requirement descriptions and index; offer records unchanged")
    elif args.command == "assess":
        output = []
        for m in models:
            model_req = requirements_for_model(m, req)
            for offer in read(contained(root, m["offersFile"]))["offers"]:
                output.append({**assess(offer, model_req, m), "input": {key: offer.get(key) for key in ASSESSMENT_FIELDS}})
        write(root / "reports/current-assessment.json", {"generatedAt": datetime.now(timezone.utc).isoformat(),
              "configuration": config, "assessments": output})
        print(f"Assessed {len(output)} stored offers; report only, no listing availability check")
    else:
        if not args.run or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", args.run):
            p.error("--run requires a simple alphanumeric ID")
        run = root / "runs" / args.run
        if args.command == "plan":
            if args.agents < 1:
                p.error("--agents must be positive")
            selected_m = [m for m in models if m["active"] and (not args.models or m["key"] in args.models)]
            candidate_s = [s for s in sources if s["enabled"] and s["category"] != "auction"
                           and s["purchaseConditions"].get("auction") is not True
                           and (not args.sources or s["id"] in args.sources)]
            if args.models and set(args.models) - {m["key"] for m in selected_m}:
                p.error("Unknown or inactive model")
            if args.sources and set(args.sources) - {s["id"] for s in candidate_s}:
                p.error("Unknown or disabled source")
            adapter_config = read(root / "config" / "portal-adapters.json")
            adapters = adapter_config.get("adapters", {})
            excluded_sources = []
            blocked_source_records = []
            for source in candidate_s:
                adapter = adapters.get(source["id"])
                if isinstance(adapter, dict) and adapter.get("mode") == "blocked":
                    record = {"sourceId": source["id"], "sourceName": source.get("name", source["id"]),
                              "reason": adapter.get("note") or "Adapter is marked blocked"}
                    excluded_sources.append(record)
                    blocked_source_records.append((source, record))
            excluded_ids = {item["sourceId"] for item in excluded_sources}
            selected_s = [source for source in candidate_s if source["id"] not in excluded_ids]
            cards = {m["key"]: read(contained(root, m["knowledgeFile"])) for m in selected_m}
            manual_review_sources = []
            manual_tasks = []
            for source, blocked_record in blocked_source_records:
                compatible_models = [m for m in selected_m if not source["brands"] or
                                     brand_key(m["brand"]) in [brand_key(b) for b in source["brands"]]]
                if not compatible_models:
                    continue
                review_entry = {
                    "sourceId": source["id"], "sourceName": source.get("name", source["id"]),
                    "searchUrl": safe_portal_url(source["searchUrl"]), "reason": blocked_record["reason"],
                    "status": "needs_manual_review", "method": "visible_public_browser_only",
                    "stopConditions": ["HTTP 401/403/429", "CAPTCHA or access challenge", "robots.txt denial"],
                    "models": [],
                    "instruction": "Try the public interface once in the visible browser. Record only vehicle cards that open normally; stop on any listed access condition. Never bypass or retry a denial."
                }
                for model in compatible_models:
                    model_req = requirements_for_model(model, req)
                    task_id = f"manual--{source['id']}--{model['key']}"
                    profile = build_search_profile(source, model, model_req, cards[model["key"]])
                    profile["manualOnly"] = True
                    manual_tasks.append({"id": task_id, "kind": "search", "sourceId": source["id"],
                                         "modelKey": model["key"], "manualOnly": True,
                                         "searchProfile": profile, "state": "pending_manual",
                                         "worker": None, "attempts": 0,
                                         "note": "Ręczna próba w widocznym publicznym interfejsie; bez automatycznego czytnika."})
                    review_entry["models"].append({
                        "modelKey": model["key"], "modelName": model["name"], "taskId": task_id,
                        "bodies": model["bodies"],
                        "years": {"min": max(model_req["yearMin"], model["searchYears"]["min"]),
                                  "max": model["searchYears"]["max"]},
                        "engineVariants": model["allowedEngineVariants"],
                        "maxGrossPurchasePln": model_req["purchase"]["maxPriceGrossPln"],
                        "queryPlan": profile["queryPlan"]
                    })
                manual_review_sources.append(review_entry)
            tasks = []
            for s in sorted(selected_s, key=lambda s: s["priority"]):
                for m in sorted(selected_m, key=lambda m: m["priority"]):
                    if s["brands"] and brand_key(m["brand"]) not in [brand_key(b) for b in s["brands"]]:
                        continue
                    model_req = requirements_for_model(m, req)
                    tasks.append({"id": f"{s['id']}--{m['key']}", "kind": "search",
                                  "sourceId": s["id"], "modelKey": m["key"],
                                  "searchProfile": build_search_profile(s, m, model_req, cards[m["key"]]),
                                  "state": "pending", "worker": None, "attempts": 0, "note": ""})
            tasks.extend(manual_tasks)
            if not tasks and not manual_review_sources:
                blocked_note = "; sources marked blocked: " + ", ".join(item["sourceId"] for item in excluded_sources) if excluded_sources else ""
                p.error("No eligible tasks" + blocked_note)
            run.mkdir(parents=True, exist_ok=False)
            (run / "results").mkdir()
            snapshot = {"config": config, "knowledge": cards}
            digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            write(run / "snapshot.json", {"createdAt": datetime.now(timezone.utc).isoformat(), "sha256": digest, **snapshot})
            write(run / "tasks.json", {"version": 1, "agents": args.agents, "workerAssignments": {},
                  "excludedSources": excluded_sources, "manualReviewSources": manual_review_sources,
                  "sourceAccessBlocks": [], "tasks": tasks})
            by_source = {}
            automated_tasks = [task for task in tasks if not task.get("manualOnly")]
            for task in automated_tasks:
                by_source[task["sourceId"]] = by_source.get(task["sourceId"], 0) + 1
            skipped = [s["id"] for s in selected_s if not any(t["sourceId"] == s["id"] for t in tasks)]
            print(f"Prepared {len(automated_tasks)} automated tasks across {len(by_source)} compatible sources; "
                  f"at most {args.agents} search workers may run concurrently; no websites searched")
            if excluded_sources:
                print("Skipped blocked adapters: " + ", ".join(item["sourceId"] for item in excluded_sources))
            if manual_review_sources:
                print(f"Manual browser review required: {len(manual_tasks)} model tasks across " +
                      ", ".join(item["sourceId"] for item in manual_review_sources))
            if skipped:
                print("No compatible selected model: " + ", ".join(skipped))
        elif args.command in ("refresh-plan", "availability-plan", "archive-availability-plan"):
            availability_only = args.command == "availability-plan"
            archive_availability_only = args.command == "archive-availability-plan"
            if (availability_only or archive_availability_only) and (args.models or args.sources or args.older_than_days is not None or args.offer_ids or args.photo_audit):
                p.error(f"{args.command} always checks every {'archived' if archive_availability_only else 'active'} listing URL; do not pass model, source, age, offer or photo filters")
            if args.agents < 1:
                p.error("--agents must be positive")
            if args.older_than_days is not None and args.older_than_days < 0:
                p.error("--older-than-days must be zero or greater")
            selected_m = [m for m in models if m["active"] and (not args.models or m["key"] in args.models)]
            selected_s = [s for s in sources if s["enabled"] and s["category"] != "auction"
                          and s["purchaseConditions"].get("auction") is not True
                          and (not args.sources or s["id"] in args.sources)]
            if args.models and set(args.models) - {m["key"] for m in selected_m}:
                p.error("Unknown or inactive model")
            if args.sources and set(args.sources) - {s["id"] for s in selected_s}:
                p.error("Unknown or disabled source")
            requested_ids = set(args.offer_ids or [])
            now = datetime.now(timezone.utc)
            threshold = now - timedelta(days=args.older_than_days or 0)
            source_hosts = {}
            for source in selected_s:
                hosts = set()
                for field in ("searchUrl", "url"):
                    host = urlsplit(source.get(field, "")).hostname
                    if host:
                        hosts.add(host.lower().removeprefix("www."))
                source_hosts[source["id"]] = hosts

            def source_for_url(url):
                host = urlsplit(url).hostname if isinstance(url, str) else None
                if not host:
                    return None
                host = host.lower().removeprefix("www.")
                matches = [sid for sid, hosts in source_hosts.items()
                           if any(host == base or host.endswith("." + base) for base in hosts)]
                return matches[0] if len(matches) == 1 else None

            def parse_checked(value):
                if not isinstance(value, str):
                    return None
                try:
                    checked = datetime.fromisoformat(value.replace("Z", "+00:00"))
                    return checked.astimezone(timezone.utc) if checked.tzinfo else None
                except ValueError:
                    return None

            grouped, found_ids, unmapped_targets = {}, set(), []
            for model in selected_m:
                document = read(contained(root, model["offersFile"]))
                collection_name = "archivedOffers" if archive_availability_only else "offers"
                for offer in document.get(collection_name, []):
                    if archive_availability_only and offer.get("archive", {}).get("status") == "excluded":
                        continue
                    if requested_ids and offer.get("id") not in requested_ids:
                        continue
                    found_ids.add(offer.get("id"))
                    state_by_url = {state.get("url", ""): state for state in offer.get("listingStates", [])}
                    history = offer.get("history", [])
                    links = offer.get("urls", [])
                    if not links:
                        unmapped_targets.append({"offerId": offer["id"], "modelKey": model["key"], "url": None,
                                                 "reason": "no_listing_url"})
                    for link in links:
                        url = link.get("url") if isinstance(link, dict) else link
                        source_id = source_for_url(url)
                        if not source_id:
                            if isinstance(url, str):
                                unmapped_targets.append({"offerId": offer["id"], "modelKey": model["key"], "url": url,
                                                         "reason": "no_unique_enabled_source_match"})
                            continue
                        source = next(s for s in selected_s if s["id"] == source_id)
                        if source["brands"] and brand_key(model["brand"]) not in [brand_key(b) for b in source["brands"]]:
                            unmapped_targets.append({"offerId": offer["id"], "modelKey": model["key"], "url": url,
                                                     "reason": "source_brand_scope_mismatch"})
                            continue
                        prior_state = state_by_url.get(url, {})
                        event_dates = [parse_checked(event.get("checkedAt")) for event in history
                                       if event.get("url") == url and event.get("availability") in ("available", "sold", "removed")]
                        last_checked = parse_checked(prior_state.get("lastCheckedAt")) or max(
                            (date for date in event_dates if date), default=None)
                        if args.older_than_days is not None and not requested_ids and prior_state.get("status") not in ("sold", "removed"):
                            if last_checked is not None and last_checked > threshold:
                                continue
                        target = {"offerId": offer["id"], "url": url, "title": offer.get("title", ""),
                                  "lastCheckedAt": last_checked.isoformat() if last_checked else None,
                                  "previousPrice": offer.get("price"), "listingStatus": prior_state.get("status", "unknown")}
                        grouped.setdefault((source_id, model["key"]), []).append(target)
            missing_ids = requested_ids - found_ids
            if missing_ids:
                p.error("Unknown offer ID(s) in selected models: " + ", ".join(sorted(missing_ids)))
            source_by_id = {s["id"]: s for s in selected_s}
            model_by_key = {m["key"]: m for m in selected_m}
            tasks = []
            for (source_id, model_key), targets in sorted(
                    grouped.items(), key=lambda item: (source_by_id[item[0][0]]["priority"], item[0][1])):
                source, model = source_by_id[source_id], model_by_key[model_key]
                unique_targets = list({(target["offerId"], target["url"]): target for target in targets}.values())
                target_batches = ([unique_targets[index:index + 5]
                                   for index in range(0, len(unique_targets), 5)]
                                  if availability_only or archive_availability_only else [unique_targets])
                for batch_number, target_batch in enumerate(target_batches, start=1):
                    task_prefix = "archive-availability" if archive_availability_only else ("availability" if availability_only else "refresh")
                    task_id = (f"{task_prefix}--{source_id}--{model_key}--{batch_number:02d}"
                               if availability_only or archive_availability_only else f"refresh--{source_id}--{model_key}")
                    kind = "archive-availability" if archive_availability_only else ("availability" if availability_only else "refresh")
                    task = {"id": task_id, "kind": kind,
                            "sourceId": source_id, "modelKey": model_key, "refreshTargets": target_batch,
                            "photoAuditRequired": args.photo_audit,
                            "sourceMethod": source["method"], "state": "pending", "worker": None,
                            "attempts": 0, "note": ""}
                    if archive_availability_only:
                        task["workerInstructions"] = (
                            "Archived availability only: use scripts/availability-check.mjs; check only assigned archived listing URLs, "
                            "without researching or updating vehicle facts. A URL is available only when its current rendered page "
                            "returns HTTP 2xx and the page shows a strong title match, price and contact action; all three proof fields "
                            "are required by finish. HTTP 410 is removed. HTTP 403/404 without explicit closure text, timeouts, CAPTCHA "
                            "and other access blocks are access_error; do not bypass them. A confirmed available URL restores that archived "
                            "offer to active offers. Access errors or closed listings stay archived. Never restore status excluded.")
                    elif availability_only:
                        task["workerInstructions"] = (
                            "Availability only: use scripts/availability-check.mjs; do not substitute cached snippets or manual notes. "
                            "A URL is available only when its current rendered page returns HTTP 2xx and the page itself shows a strong "
                            "title match, price and contact action; all three proof fields are required by finish. HTTP 410 is removed. "
                            "HTTP 403/404 without explicit closure text, timeouts, CAPTCHA and other access blocks are access_error "
                            "(do not bypass them). HTTP 404 with an explicit closure message is removed/sold. Check up to four pages "
                            "concurrently and do not inspect or update vehicle facts. On import, if every URL for a car was checked and "
                            "none is available, archive as closed when every status is sold/removed; otherwise archive as unverified. "
                            "Any proven live URL keeps the car active.")
                    tasks.append(task)
            if not tasks and not unmapped_targets:
                p.error("No refresh candidates matched the selected models, sources and age/offer filters")
            run.mkdir(parents=True, exist_ok=False)
            (run / "results").mkdir()
            cards = {m["key"]: read(contained(root, m["knowledgeFile"])) for m in selected_m}
            snapshot = {"config": config, "knowledge": cards}
            digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            write(run / "snapshot.json", {"createdAt": now.isoformat(), "sha256": digest, **snapshot})
            run_kind = "archive-availability" if archive_availability_only else ("availability" if availability_only else "refresh")
            write(run / "tasks.json", {"version": 1, "kind": run_kind, "agents": args.agents,
                  "workerAssignments": {}, "refreshAfterDays": args.older_than_days,
                  "photoAuditRequired": args.photo_audit,
                  "unmappedTargets": unmapped_targets, "tasks": tasks})
            target_count = sum(len(task["refreshTargets"]) for task in tasks)
            mode = "all archived listing URLs (availability only)" if archive_availability_only else ("all active listing URLs (availability only)" if availability_only else (f"not checked within {args.older_than_days} days" if args.older_than_days is not None else "all active offer records"))
            task_type = "availability" if availability_only or archive_availability_only else "refresh"
            print(f"Prepared {len(tasks)} {task_type} tasks for {target_count} listing pages ({mode}); "
                  f"{len(unmapped_targets)} URL(s) need manual source mapping; no websites checked")
        else:
            queue = read(run / "tasks.json")
            if args.command == "export-worker":
                task = next((item for item in queue["tasks"] if item.get("id") == args.task), None)
                if not task:
                    p.error("export-worker requires an existing --task")
                if task.get("manualOnly"):
                    p.error("Manual-only tasks must be completed in the visible browser, not exported to a network worker")
                try:
                    bundle_path = export_worker_bundle(root, run, queue, task)
                except (OSError, ValueError, KeyError, TypeError) as exc:
                    p.error(str(exc))
                print(f"Worker bundle ready: {bundle_path.relative_to(root).as_posix()}")
            elif args.command == "collect-worker":
                task = next((item for item in queue["tasks"] if item.get("id") == args.task), None)
                if not task:
                    p.error("collect-worker requires an existing --task")
                try:
                    local_result = collect_worker_bundle(root, run, queue, task)
                except (OSError, ValueError, KeyError, TypeError) as exc:
                    p.error(str(exc))
                print(f"Worker result collected: {local_result.relative_to(root).as_posix()}; run finish locally")
            elif args.command == "continue-search":
                if not args.worker or not args.task:
                    p.error("continue-search requires --worker and --task")
                if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", args.task):
                    p.error("--task must be a simple task ID")
                if any(t.get("state") == "running" and t.get("worker") == args.worker for t in queue["tasks"]):
                    p.error(f"Worker {args.worker} already has a running task")
                assignments = queue.setdefault("workerAssignments", {})
                assigned_sources = assignments.get(args.worker, [])
                if isinstance(assigned_sources, str):
                    assigned_sources = [assigned_sources]
                parent = next((t for t in queue["tasks"] if t.get("id") == args.task), None)
                if not parent or parent.get("kind") != "search" or parent.get("state") != "partial":
                    p.error("continue-search requires an existing partial search task")
                if parent.get("manualOnly"):
                    p.error("Manual-only tasks cannot be continued by an automated search worker")
                if any(isinstance(block, dict) and block.get("sourceId") == parent.get("sourceId")
                       for block in queue.get("sourceAccessBlocks", [])):
                    p.error("This source was stopped after a source-wide access denial; continuation is not allowed")
                if assigned_sources and parent.get("sourceId") not in assigned_sources:
                    p.error(f"Worker {args.worker} is not assigned to source {parent.get('sourceId')}")
                prior_path = run / "results" / (parent["id"] + ".json")
                if not prior_path.is_file():
                    p.error("The partial task has no saved result to continue")
                prior_result = read(prior_path)
                if not isinstance(prior_result, dict) or prior_result.get("taskId") != parent["id"] or prior_result.get("outcome") != "partial":
                    p.error("Saved result does not match the partial task")
                coverage = prior_result.get("coverage", {})
                pages = coverage.get("searchResults", []) if isinstance(coverage, dict) else []
                pages_by_query = {}
                for page in pages if isinstance(pages, list) else []:
                    if not isinstance(page, dict) or not isinstance(page.get("url"), str):
                        continue
                    query_id = page.get("queryId") or "unfiltered"
                    pages_by_query.setdefault(query_id, []).append(page)
                query_ids = list(dict.fromkeys([
                    item.get("queryId") for item in coverage.get("searchQueries", [])
                    if isinstance(item, dict) and item.get("queryId") and item.get("complete") is not True
                ] + list(pages_by_query))) if isinstance(coverage, dict) else list(pages_by_query)
                search_profile = parent.get("searchProfile")
                profile_url = search_profile.get("searchUrl") if isinstance(search_profile, dict) else None
                if not isinstance(profile_url, str):
                    p.error("Task has no frozen search URL")
                base = urlsplit(profile_url)
                if base.scheme != "https" or not base.netloc:
                    p.error("Task search URL must use HTTPS")
                running_search_workers = {t.get("worker") for t in queue["tasks"]
                                          if t.get("kind") == "search" and t.get("state") == "running" and t.get("worker")}
                max_search_workers = queue.get("agents", 1)
                if type(max_search_workers) is not int or max_search_workers < 1:
                    p.error("Search worker limit in tasks.json must be a positive integer")
                if len(running_search_workers) >= max_search_workers:
                    p.error(f"Search worker limit reached ({max_search_workers}); finish an active task before continuing")
                parent_host = search_task_host(parent)
                active_search_hosts = {search_task_host(t) for t in queue["tasks"]
                                       if t.get("kind") == "search" and t.get("state") == "running"}
                active_search_hosts.discard(None)
                if parent_host and parent_host in active_search_hosts:
                    p.error("Another search task for this portal host is running; wait before continuing")
                errors = prior_result.get("errors", [])
                blocked_next = re.compile(r"403|429|captcha|robots?\.txt|access denied|forbidden|challenge|niedozwol", re.I)
                continuation = None
                for query_id in query_ids:
                    query_pages = pages_by_query.get(query_id, [])
                    if not query_pages:
                        continue
                    last_page = query_pages[-1]
                    next_url = last_page.get("nextUrl")
                    if (not isinstance(next_url, str) or not next_url or
                            last_page.get("nextUrlAllowed") is False or last_page.get("paginationComplete") is True or
                            last_page.get("fromSharedCache") or next_url in {page.get("url") for page in query_pages}):
                        continue
                    target = urlsplit(next_url)
                    if (target.scheme != "https" or target.netloc.casefold() != base.netloc.casefold() or
                            target.username or target.password):
                        continue
                    if any(isinstance(error, dict) and error.get("url") == next_url and
                           blocked_next.search(str(error.get("error", ""))) for error in errors):
                        continue
                    continuation = {"sourceTaskId": parent["id"], "queryId": query_id, "nextUrl": next_url}
                    break
                if not continuation:
                    p.error("No resumable, same-origin nextUrl was found. Keep this task partial; blocked or robots-denied pages are not retried.")
                task_by_id = {task.get("id"): task for task in queue["tasks"] if isinstance(task, dict)}
                prior_offer_ids, prior_offer_urls, ancestors = set(), set(), set()
                ancestor_id = parent["id"]
                while ancestor_id and ancestor_id not in ancestors:
                    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", ancestor_id):
                        break
                    ancestors.add(ancestor_id)
                    ancestor_path = run / "results" / (ancestor_id + ".json")
                    try:
                        ancestor_result = prior_result if ancestor_id == parent["id"] else read(ancestor_path)
                    except (OSError, ValueError, TypeError):
                        ancestor_result = {}
                    ancestor_offers = ancestor_result.get("offers", []) if isinstance(ancestor_result, dict) else []
                    for offer in (ancestor_offers if isinstance(ancestor_offers, list) else []):
                        if not isinstance(offer, dict):
                            continue
                        if isinstance(offer.get("id"), str):
                            prior_offer_ids.add(offer["id"])
                        observation = offer.get("observation", {})
                        if isinstance(observation, dict) and isinstance(observation.get("url"), str):
                            prior_offer_urls.add(observation["url"])
                    ancestor = task_by_id.get(ancestor_id, {})
                    ancestor_id = (ancestor.get("continuation") or {}).get("sourceTaskId")
                continuation["priorOfferIds"] = sorted(prior_offer_ids)
                continuation["priorOfferUrls"] = sorted(prior_offer_urls)
                if any(t.get("state") in ("pending", "running") and
                       t.get("continuation", {}).get("sourceTaskId") == parent["id"] and
                       t.get("continuation", {}).get("nextUrl") == continuation["nextUrl"]
                       for t in queue["tasks"]):
                    p.error("A continuation for this nextUrl is already pending or running")
                query_slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", continuation["queryId"]).strip("-_") or "page"
                sequence = 1
                while True:
                    task_id = f"continue--{parent['id']}--{query_slug}--{sequence}"
                    if all(t.get("id") != task_id for t in queue["tasks"]):
                        break
                    sequence += 1
                continuation_task = {key: value for key, value in parent.items()
                                     if key not in {"state", "worker", "attemptStartedAt", "attempts", "note", "continuation", "sharedResultsCache"}}
                continuation_task.update({"id": task_id, "kind": "search", "state": "running", "worker": args.worker,
                    "attempts": 1, "attemptStartedAt": datetime.now(timezone.utc).isoformat(),
                    "note": f"Kontynuacja {parent['id']} / {continuation['queryId']} od zapisanego nextUrl",
                    "continuation": continuation})
                queue["tasks"].append(continuation_task)
                write(run / "tasks.json", queue)
                claimed_task = dict(continuation_task)
                claimed_task["runId"] = args.run
                claimed_task["sharedResultsCache"] = build_shared_search_cache(
                    root, run, queue, continuation_task["sourceId"], continuation_task)
                print(json.dumps(claimed_task, ensure_ascii=False))
            elif args.command == "claim":
                if apply_source_access_blocks(queue, run):
                    write(run / "tasks.json", queue)
                if not args.worker:
                    p.error("--worker required")
                claim_sources = args.sources or []
                known_sources = {s["id"] for s in config["sources"]["sources"]}
                unknown_sources = set(claim_sources) - known_sources
                if unknown_sources:
                    p.error("Unknown source in run snapshot: " + ", ".join(sorted(unknown_sources)))
                assignments = queue.setdefault("workerAssignments", {})
                assigned_sources = assignments.get(args.worker, [])
                if isinstance(assigned_sources, str):
                    assigned_sources = [assigned_sources]
                if assigned_sources and claim_sources and not set(claim_sources).issubset(set(assigned_sources)):
                    p.error(f"Worker {args.worker} is already assigned to: " + ", ".join(assigned_sources))
                source_filter = set(assigned_sources or claim_sources) or None
                if any(t["state"] == "running" and t["worker"] == args.worker for t in queue["tasks"]):
                    p.error("Worker already has a running task")
                running_search_workers = {t.get("worker") for t in queue["tasks"]
                                          if t.get("kind") == "search" and t.get("state") == "running" and t.get("worker")}
                max_search_workers = queue.get("agents", 1)
                if type(max_search_workers) is not int or max_search_workers < 1:
                    p.error("Search worker limit in tasks.json must be a positive integer")
                if args.worker not in running_search_workers and len(running_search_workers) >= max_search_workers:
                    p.error(f"Search worker limit reached ({max_search_workers}); finish an active task before claiming another")
                active_search_hosts = {search_task_host(t) for t in queue["tasks"]
                                       if t.get("kind") == "search" and t.get("state") == "running"}
                active_search_hosts.discard(None)
                expected_state = "pending_manual" if args.manual else "pending"
                pending_tasks = [t for t in queue["tasks"] if t["state"] == expected_state and
                                 bool(t.get("manualOnly")) == args.manual and
                                 (source_filter is None or t["sourceId"] in source_filter)]
                task = next((t for t in pending_tasks
                             if t.get("kind") != "search" or search_task_host(t) not in active_search_hosts), None)
                if not task:
                    if pending_tasks:
                        print("No claimable search tasks; pending tasks share a portal host with an active search worker")
                    else:
                        label = "manual review tasks" if args.manual else "automated search tasks"
                        print("No pending " + label + (" for sources " + ", ".join(sorted(source_filter)) if source_filter else ""))
                    return 0
                task.update(state="running", worker=args.worker, attempts=task["attempts"] + 1,
                            attemptStartedAt=datetime.now(timezone.utc).isoformat())
                if source_filter:
                    assignments.setdefault(args.worker, sorted(source_filter))
                if task.get("manualOnly"):
                    result_path = run / "results" / f"{task['id']}.json"
                    template_path = run / "manual-templates" / f"{task['id']}.json"
                    if result_path.exists() or template_path.exists():
                        p.error("A manual result or template already exists for this task; preserve it and resolve it before claiming")
                    now = datetime.now(timezone.utc).isoformat()
                    write(template_path, {"taskId": task["id"], "outcome": "partial", "checkedAt": now,
                                          "coverage": {"searchUrls": [], "pagesChecked": 0,
                                                       "remaining": "Ręczna próba oczekuje na zapis faktycznie sprawdzonych stron i kart.",
                                                       "searchResults": [], "listingUrlsChecked": [], "cardReads": []},
                                          "offers": [], "errors": [],
                                          "notes": ["Manual-only task; use only the visible public interface. Update checkedAt to the actual inspection time before finish."]})
                    task["manualResultTemplate"] = template_path.relative_to(root).as_posix()
                write(run / "tasks.json", queue)
                claimed_task = dict(task)
                claimed_task["runId"] = args.run
                if task.get("kind") == "search":
                    claimed_task["sharedResultsCache"] = build_shared_search_cache(
                        root, run, queue, task["sourceId"], task)
                print(json.dumps(claimed_task, ensure_ascii=False))
            else:
                task = next((t for t in queue["tasks"] if t["id"] == args.task), None)
                if not task or task["state"] != "running" or not args.result:
                    p.error("Running --task and --result required")
                result = read(run / "results" / (task["id"] + ".json"))
                def reject_result(reason):
                    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
                    rejected = run / "results" / "rejected" / f"{task['id']}-attempt-{task['attempts']}-{stamp}.json"
                    write(rejected, result)
                    p.error("Result validation failed; task remains running so its saved result can be corrected and finish retried. "
                            "Resolve this task before claiming another one. Rejected copy saved to " +
                            rejected.relative_to(root).as_posix() + ": " + str(reason))

                if not isinstance(result, dict):
                    reject_result("Result file must contain a JSON object")
                if result.get("taskId") != task["id"] or result.get("outcome") != args.result:
                    reject_result("Result file taskId/outcome mismatch")
                if not isinstance(result.get("offers"), list) or not isinstance(result.get("coverage"), dict):
                    reject_result("Result requires offers array and coverage object")
                coverage = result["coverage"]
                if args.result in ("complete", "no_matches") and (not coverage.get("searchUrls") or
                        type(coverage.get("pagesChecked")) is not int or coverage["pagesChecked"] < 1 or coverage.get("remaining") != ""):
                    reject_result("Complete coverage requires searchUrls, pagesChecked >= 1 and empty remaining")
                if task.get("kind") == "search" and args.result in ("complete", "no_matches") and task.get("sourceId") != "sprzedajemy":
                    queries = coverage.get("searchQueries")
                    if (not isinstance(queries, list) or not queries or
                            any(not isinstance(query, dict) or not query.get("queryId") or
                                query.get("complete") is not True or type(query.get("pagesChecked")) is not int or
                                query["pagesChecked"] < 1 for query in queries)):
                        reject_result("Complete search requires explicit completion for every executed query")
                    if not isinstance(coverage.get("cardReads"), list):
                        reject_result("Complete search requires verified cardReads, including an empty array when there were no candidates")
                if args.result == "no_matches" and result["offers"]:
                    reject_result("no_matches cannot contain offers")
                if args.result == "blocked" and task.get("kind") not in ("refresh", "availability", "archive-availability") and result["offers"]:
                    reject_result("blocked cannot contain offers")
                if task.get("kind") in ("refresh", "availability", "archive-availability") and args.result == "no_matches":
                    reject_result("Refresh/availability tasks have known target listings; use complete, partial or blocked")
                if task.get("kind") in ("refresh", "availability", "archive-availability") and args.result == "complete":
                    targets = {(target["offerId"], target["url"]) for target in task.get("refreshTargets", [])}
                    target_urls = {url for _, url in targets}
                    if coverage["pagesChecked"] < len(target_urls) or not target_urls.issubset(set(coverage["searchUrls"])):
                        reject_result("Complete refresh coverage must include every target listing URL")
                    observed = set()
                    for offer in result["offers"]:
                        observation = offer.get("observation", {}) if isinstance(offer, dict) else {}
                        pair = (offer.get("id"), observation.get("url")) if isinstance(offer, dict) else (None, None)
                        if pair not in targets:
                            reject_result("Refresh result contains an offer outside its assigned targets")
                        if observation.get("availability") == "access_error":
                            reject_result("A refresh with access errors cannot be marked complete")
                        observed.add(pair)
                    if observed != targets:
                        reject_result("Complete refresh requires one observation for every assigned target")
                if task.get("kind") in ("refresh", "availability", "archive-availability") and args.result == "partial":
                    targets = {(target["offerId"], target["url"]) for target in task.get("refreshTargets", [])}
                    for offer in result["offers"]:
                        observation = offer.get("observation", {}) if isinstance(offer, dict) else {}
                        pair = (offer.get("id"), observation.get("url")) if isinstance(offer, dict) else (None, None)
                        if pair not in targets:
                            reject_result("Refresh result contains an offer outside its assigned targets")
                if task.get("kind") in ("availability", "archive-availability"):
                    targets = {(target["offerId"], target["url"]) for target in task.get("refreshTargets", [])}
                    observed = set()
                    for offer in result["offers"]:
                        observation = offer.get("observation", {}) if isinstance(offer, dict) else {}
                        pair = (offer.get("id"), observation.get("url")) if isinstance(offer, dict) else (None, None)
                        if pair not in targets or pair in observed:
                            reject_result("Availability must contain exactly one observation for each assigned URL")
                        observed.add(pair)
                        status = observation.get("availability")
                        http_status = observation.get("httpStatus")
                        if status not in ("available", "sold", "removed", "access_error"):
                            reject_result("Availability observation has an unknown status")
                        if http_status == 410 and status != "removed":
                            reject_result("HTTP 410 must be recorded as removed")
                        if http_status in (403, 404) and status != "access_error" and not observation.get("closedMessage"):
                            reject_result("HTTP 403/404 requires access_error unless the page contains an explicit closure message")
                        if status == "available":
                            proof = observation.get("availabilityProof", {})
                            if (not isinstance(proof, dict) or type(http_status) is not int or not 200 <= http_status < 300 or
                                    proof.get("identity") is not True or proof.get("contact") is not True or
                                    proof.get("price") is not True):
                                reject_result("Available requires HTTP 2xx plus a matching title, visible price and contact control")
                        if status in ("sold", "removed") and http_status != 410 and not observation.get("closedMessage"):
                            reject_result("Sold/removed requires HTTP 410 or an explicit closure message from the page")
                    if observed != targets:
                        reject_result("Availability result must cover every assigned listing URL")
                from offer_import import validate_worker_result
                model = next((m for m in config["models"]["models"] if m["key"] == task["modelKey"]), None)
                if model is None:
                    p.error("Task model is missing from the run snapshot")
                try:
                    validate_worker_result(result, task, model, root,
                                            require_search_cache=(task.get("kind") == "search"))
                except (ValueError, KeyError, TypeError) as exc:
                    reject_result(exc)
                finished_at = datetime.now(timezone.utc)
                task.update(state=args.result, note=args.note, attemptFinishedAt=finished_at.isoformat())
                started_at = task.get("attemptStartedAt")
                if isinstance(started_at, str):
                    try:
                        started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
                        task["attemptElapsedMs"] = max(0, int((finished_at - started).total_seconds() * 1000))
                    except ValueError:
                        pass
                apply_source_access_blocks(queue, run)
                write(run / "tasks.json", queue)
                print("Task recorded; published offers unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
