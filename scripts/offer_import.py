"""Reviewable, offline imports. Only the coordinator calls preview/apply.

No network requests, inferred facts, or publication. A prepared transaction can
be resumed after interruption; each replaced file has a preserved before image.
"""
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from search_core import ROOT, assess, contained, read, validation, requirements_for_model


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     allow_nan=False).encode()).hexdigest()


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def atomic_write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("checkedAt requires an ISO timestamp with timezone")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or "T" not in value:
            raise ValueError()
        return parsed.astimezone(timezone.utc)
    except ValueError:
        raise ValueError("checkedAt requires an ISO timestamp with timezone") from None


def normalized_url(value):
    if not validation.valid_url(value):
        raise ValueError("Invalid observation URL")
    url = urlsplit(value)
    # Keep query parameters: on some portals they identify the listing.
    return urlunsplit((url.scheme.lower(), url.netloc.lower(), url.path.rstrip("/"), url.query, ""))


def identities(offer):
    keys = {"id:" + offer["id"].lower()} if offer.get("id") else set()
    if offer.get("vin"):
        keys.add("vin:" + offer["vin"].upper())
    keys.update("listing:" + item.lower() for item in offer.get("listingIds", []))
    keys.update("url:" + validation.canonical_url(item["url"]) for item in offer.get("urls", []))
    return keys


def validate_result(result, task):
    if result.get("taskId") != task["id"] or result.get("outcome") != task["state"]:
        raise ValueError("Result does not match finished task " + task["id"])
    if result.get("outcome") not in ("complete", "partial", "blocked", "no_matches"):
        raise ValueError("Invalid result outcome")
    if not isinstance(result.get("offers"), list) or not isinstance(result.get("errors"), list):
        raise ValueError("Result requires offers and errors arrays")
    for index, item in enumerate(result["errors"]):
        if not isinstance(item, dict) or not any(
                isinstance(item.get(field), str) and item[field].strip() for field in ("note", "error")):
            raise ValueError(f"Result error {index} requires a note or error message")
        if item.get("url") is not None:
            normalized_url(item["url"])
    coverage = result.get("coverage", {})
    if not isinstance(coverage, dict) or not isinstance(coverage.get("searchUrls"), list):
        raise ValueError("Result requires coverage.searchUrls")
    if any(not validation.valid_url(url) for url in coverage["searchUrls"]):
        raise ValueError("Invalid coverage URL")
    if type(coverage.get("pagesChecked")) is not int or coverage["pagesChecked"] < 0:
        raise ValueError("Invalid coverage.pagesChecked")
    if not isinstance(coverage.get("remaining"), str):
        raise ValueError("Result requires coverage.remaining")
    if task["state"] in ("complete", "no_matches") and (
            coverage["pagesChecked"] < 1 or not coverage["searchUrls"] or coverage["remaining"]):
        raise ValueError("Full outcome requires complete coverage")
    if task["state"] == "no_matches" and result["offers"]:
        raise ValueError("no_matches result cannot contain offers")
    if task["state"] == "blocked" and task.get("kind") not in ("refresh", "availability") and result["offers"]:
        raise ValueError("Blocked search result cannot contain offers")
    if result["offers"]:
        timestamp(result.get("checkedAt"))
    elif not validation.valid_date(result.get("checkedAt")):
        timestamp(result.get("checkedAt"))


def validate_observation(offer, result, model, root=ROOT):
    schema = read(Path(root) / "schemas/offers-v2.schema.json")
    partial_schema = {**schema["$defs"]["offer"], "required": []}
    issues = []
    validation.validate_schema(offer, partial_schema, schema, issues, "observation")
    if any(i["severity"] == "error" for i in issues):
        raise ValueError("Invalid observation fields: " + json.dumps(issues, ensure_ascii=False))
    observation = offer.get("observation")
    if not isinstance(observation, dict):
        raise ValueError("Offer requires observation")
    checked = timestamp(observation.get("checkedAt"))
    if checked > datetime.now(timezone.utc):
        raise ValueError("Observation timestamp is in the future")
    if checked > timestamp(result["checkedAt"]):
        raise ValueError("Observation is later than result.checkedAt")
    normalized_url(observation.get("url"))
    if observation.get("availability") not in ("available", "removed", "sold", "access_error"):
        raise ValueError("Invalid observation availability")
    if not isinstance(observation.get("note"), str) or not observation["note"].strip():
        raise ValueError("Observation requires a factual note (including status evidence)")
    if not offer.get("id") and not offer.get("urls") and not offer.get("listingIds") and not offer.get("vin"):
        raise ValueError("Observation requires listing identity")
    if offer.get("modelKey", model["key"]) != model["key"]:
        raise ValueError("Offer model differs from task model")
    evidence = observation.get("evidence", [])
    if not isinstance(evidence, list):
        raise ValueError("Observation evidence must be an array")
    for item in evidence:
        if not isinstance(item, dict) or not isinstance(item.get("fields"), list) or not item["fields"]:
            raise ValueError("Evidence requires fields")
        normalized_url(item.get("url"))
        if timestamp(item.get("checkedAt")) > timestamp(result["checkedAt"]):
            raise ValueError("Evidence timestamp is later than result.checkedAt")
        if item.get("kind") not in ("seller", "independent", "technical") or not item.get("note"):
            raise ValueError("Evidence requires kind and note")
    for field in ("cameraStatus", "structuralDamageStatus", "familyFitConfirmed"):
        if offer.get(field) in ("installed_confirmed", "retrofit_confirmed", "confirmed",
                                "independently_checked_clear", True):
            matching = [item for item in evidence if field in item["fields"]]
            if not matching or (offer.get(field) == "independently_checked_clear" and
                                not any(item["kind"] == "independent" for item in matching)):
                raise ValueError("Confirmation without supporting evidence: " + field)
    return observation


def validate_worker_result(result, task, model, root=ROOT, require_search_cache=False):
    """Validate a worker artifact before it can be finished or imported."""
    finished_task = {**task, "state": result.get("outcome")}
    validate_result(result, finished_task)
    timestamp(result.get("checkedAt"))
    if task.get("kind") not in ("search", "refresh", "availability"):
        raise ValueError("Unknown task kind")
    if task["kind"] == "search":
        coverage = result["coverage"]
        if require_search_cache:
            for field in ("searchResults", "listingUrlsChecked"):
                if field not in coverage:
                    raise ValueError("Search coverage requires " + field)
        pages = coverage.get("searchResults", [])
        checked_listing_urls = coverage.get("listingUrlsChecked", [])
        if not isinstance(pages, list) or not isinstance(checked_listing_urls, list):
            raise ValueError("Search cache fields must be arrays")
        for url in checked_listing_urls:
            normalized_url(url)
        coverage_urls = {normalized_url(url) for url in coverage["searchUrls"]}
        for page_index, page in enumerate(pages):
            if not isinstance(page, dict) or not isinstance(page.get("listings"), list):
                raise ValueError(f"Search result page {page_index} requires a listings array")
            page_url = normalized_url(page.get("url"))
            if page_url not in coverage_urls:
                raise ValueError(f"Search result page {page_index} URL is missing from coverage.searchUrls")
            page_checked = timestamp(page.get("checkedAt"))
            if page_checked > timestamp(result["checkedAt"]):
                raise ValueError(f"Search result page {page_index} is later than result.checkedAt")
            query_id = page.get("queryId")
            if query_id is not None and not isinstance(query_id, str):
                raise ValueError(f"Search result page {page_index} queryId must be text")
            for listing_index, listing in enumerate(page["listings"]):
                if not isinstance(listing, dict) or not isinstance(listing.get("title"), str) or not listing["title"].strip():
                    raise ValueError(f"Search result listing {page_index}:{listing_index} requires a title")
                normalized_url(listing.get("url"))
                for field in ("year", "price", "mileage", "engine", "body"):
                    if field in listing and listing[field] is not None and not isinstance(listing[field], (str, int, float)):
                        raise ValueError(f"Search result listing {page_index}:{listing_index} has invalid {field}")
        if require_search_cache and coverage.get("pagesChecked", 0) < len(pages):
            raise ValueError("coverage.pagesChecked is smaller than coverage.searchResults")
        checked_listing_set = {normalized_url(url) for url in checked_listing_urls}
        card_reads = coverage.get("cardReads", [])
        if not isinstance(card_reads, list):
            raise ValueError("coverage.cardReads must be an array")
        for entry in card_reads:
            if (not isinstance(entry, dict) or normalized_url(entry.get("url")) not in checked_listing_set
                    or timestamp(entry.get("checkedAt")) > timestamp(result["checkedAt"])
                    or ("card" in entry) == ("error" in entry)):
                raise ValueError("Card reads require a checked URL, timestamp, and either card or error")
            if "card" in entry and (not isinstance(entry["card"], dict)
                                    or not isinstance(entry["card"].get("fields"), dict)
                                    or not isinstance(entry["card"].get("photos"), list)):
                raise ValueError("Card snapshot requires fields and photos")
            if "error" in entry and (not isinstance(entry["error"], str) or not entry["error"].strip()):
                raise ValueError("Card read error must be a nonempty message")
        for offer in result["offers"]:
            observation = offer.get("observation", {})
            if normalized_url(observation.get("url")) not in checked_listing_set:
                raise ValueError("Every search offer URL must appear in coverage.listingUrlsChecked")
    for index, offer in enumerate(result["offers"]):
        if not isinstance(offer, dict):
            raise ValueError(f"Offer {index} must be an object")
        if "mileageKm" in offer:
            legacy_mileage = offer.pop("mileageKm")
            if "mileage" in offer and offer["mileage"] is not None and legacy_mileage is not None and offer["mileage"] != legacy_mileage:
                raise ValueError(f"Offer {index} has conflicting mileage and mileageKm")
            if offer.get("mileage") is None:
                offer["mileage"] = legacy_mileage
        engine_variant = offer.get("engineVariant")
        if engine_variant is not None and engine_variant not in model.get("allowedEngineVariants", []):
            raise ValueError(f"Offer {index} engineVariant is not in the model catalog: {engine_variant}")
        observation = validate_observation(offer, result, model, root)
        if task.get("kind") == "refresh" and task.get("photoAuditRequired"):
            photo_check = observation.get("photoCheck")
            if not isinstance(photo_check, dict) or photo_check.get("status") not in (
                    "found", "no_direct_https", "access_error"):
                raise ValueError(f"Refresh offer {index} requires photoCheck status: found, no_direct_https or access_error")
            if not isinstance(photo_check.get("note"), str) or not photo_check["note"].strip():
                raise ValueError(f"Refresh offer {index} photoCheck requires a factual note")
            if photo_check["status"] == "found" and not offer.get("photos"):
                raise ValueError(f"Refresh offer {index} photoCheck found requires at least one photos URL")
            if offer.get("photos") is not None and len(offer["photos"]) > 12:
                raise ValueError(f"Refresh offer {index} photos cannot exceed 12 URLs")
            if photo_check["status"] == "access_error" and observation["availability"] != "access_error":
                raise ValueError(f"Refresh offer {index} photoCheck access_error requires access_error availability")
            if observation["availability"] == "access_error" and photo_check["status"] != "access_error":
                raise ValueError(f"Refresh offer {index} access_error requires photoCheck access_error")
        if task["kind"] == "search":
            required = ("id", "title", "urls", "location", "saleType", "lpgInstalled")
            missing = [field for field in required if field not in offer]
            if missing:
                raise ValueError(f"Search offer {index} is missing required fields: " + ", ".join(missing))
            if observation["availability"] != "available":
                raise ValueError(f"Search offer {index} must have confirmed available status")
            if offer.get("saleType") == "auction":
                raise ValueError(f"Search offer {index} is an excluded auction")
            observation_url = normalized_url(observation["url"])
            linked_urls = {normalized_url(item["url"]) for item in offer["urls"]}
            if observation_url not in linked_urls:
                raise ValueError(f"Search offer {index} observation URL must be listed in urls")
            location = offer["location"]
            if location.get("status") == "available" and not all(
                    location.get(field) for field in ("countryCode", "voivodeship", "city")):
                raise ValueError(f"Search offer {index} available location requires countryCode, voivodeship and city")
        elif task["kind"] == "refresh" and observation["availability"] == "available":
            missing = [field for field in ("saleType", "lpgInstalled") if field not in offer]
            if missing:
                raise ValueError(f"Refresh offer {index} is missing required fields: " + ", ".join(missing))
    if task["kind"] in ("refresh", "availability"):
        targets = {(item["offerId"], normalized_url(item["url"]))
                   for item in task.get("refreshTargets", [])}
        target_urls = {url for _, url in targets}
        observed = []
        for index, offer in enumerate(result["offers"]):
            observation = offer["observation"]
            pair = (offer.get("id"), normalized_url(observation["url"]))
            if pair not in targets:
                raise ValueError(f"Refresh offer {index} is outside its assigned targets")
            observed.append(pair)
        if len(observed) != len(set(observed)):
            raise ValueError("Refresh result contains duplicate target observations")
        if task["kind"] == "availability":
            for offer in result["offers"]:
                observation = offer["observation"]
                status = observation.get("httpStatus")
                if status is not None and (type(status) is not int or not 100 <= status <= 599):
                    raise ValueError("HTTP status must be an integer between 100 and 599")
                if status == 403 and observation["availability"] != "access_error":
                    raise ValueError("HTTP 403 is an access error, not proof that a listing is closed")
                if status == 410 and observation["availability"] != "removed":
                    raise ValueError("HTTP 410 Gone must be recorded as removed")
                if status == 404 and observation["availability"] != "access_error" and "komunikat zamknięcia" not in observation["note"].casefold():
                    raise ValueError("HTTP 404 alone is not proof that a listing is closed")
        if result["outcome"] in ("complete", "partial", "blocked"):
            if set(observed) != targets:
                raise ValueError("Refresh result requires one observation for every assigned target")
            coverage_urls = {normalized_url(url) for url in result["coverage"]["searchUrls"]}
            if not target_urls.issubset(coverage_urls):
                raise ValueError("Refresh coverage must include every target listing URL")
            if result["outcome"] == "complete":
                if any(offer["observation"]["availability"] == "access_error"
                       for offer in result["offers"]):
                    raise ValueError("A refresh with access errors cannot be marked complete")
                if result["coverage"]["pagesChecked"] < len(target_urls):
                    raise ValueError("Complete refresh pagesChecked must cover every target URL")


RESERVED = {"observation", "verdict", "verdictTitle", "verdictNote", "assessment", "history",
            "listingStates", "firstSeenAt", "lastCheckedAt", "lastVerifiedAt", "lastAttemptAt", "archive"}


def merge_offer(old, incoming, observation, model, requirements, event_id, run_id, availability_only=False):
    updated = copy.deepcopy(old or {})
    if availability_only and not old:
        raise ValueError("Availability observations may update existing offers only")
    # Canonicalize the legacy spelling to the current contract's gross_total value.
    if updated.get("priceBasis") == "gross_unconditional_total":
        updated["priceBasis"] = "gross_total"
    if observation["availability"] == "available":
        updated.pop("archive", None)
    if observation["availability"] == "available":
        for key, value in incoming.items():
            if key in RESERVED or value is None or (old and key == "id"):
                continue
            if key in ("urls", "listingIds"):
                values = updated.setdefault(key, [])
                for item in value:
                    if key == "urls":
                        item_url = normalized_url(item["url"])
                        already_present = any(
                            normalized_url(existing["url"]) == item_url for existing in values
                        )
                    else:
                        already_present = item in values
                    if not already_present:
                        values.append(copy.deepcopy(item))
            elif key in ("details", "specs"):
                updated.setdefault(key, {}).update({k: v for k, v in value.items() if v is not None})
            elif key == "photos":
                # Multiple listing URLs can point to the same car. Keep the
                # distinct images seen across those cards, capped at the
                # documented maximum.
                photos = updated.setdefault("photos", [])
                for photo in value:
                    if photo not in photos and len(photos) < 12:
                        photos.append(copy.deepcopy(photo))
            elif key == "location" and old and value.get("status") == "not_provided" and updated.get("location", {}).get("status") == "available":
                continue
            else:
                updated[key] = copy.deepcopy(value)
        if incoming.get("price") is not None and not incoming.get("priceLabel"):
            updated.pop("priceLabel", None)
        if incoming.get("mileage") is not None and not incoming.get("mileageLabel"):
            updated.pop("mileageLabel", None)
    if not old:
        for field in ("id", "title", "urls", "location", "saleType", "lpgInstalled"):
            if field not in incoming:
                raise ValueError("New offer requires " + field)
        if not incoming["urls"] or observation["availability"] != "available":
            raise ValueError("New offer requires an available listing and URL")
        if not isinstance(incoming["location"], dict):
            raise ValueError("New offer requires a structured location")
        updated.setdefault("lpgInstalled", None)
        updated["firstSeenAt"] = observation["checkedAt"]
    updated.setdefault("modelKey", model["key"])
    if updated.get("id", "").startswith("vin:") and updated.get("vin") and updated["id"][4:].upper() != updated["vin"].upper():
        raise ValueError("VIN differs from offer id")
    if updated.get("saleType") not in (None, "fixed_price", "auction") or type(updated.get("lpgInstalled")) not in (bool, type(None)):
        raise ValueError("Invalid saleType/lpgInstalled")
    location = updated.get("location", {})
    if location.get("status") == "available" and not all(location.get(k) for k in ("countryCode", "voivodeship", "city")):
        raise ValueError("Available location requires countryCode, voivodeship, city")
    if any(location.get(k) is not None for k in ("postalCode", "latitude", "longitude")) and not location.get("geoSource"):
        raise ValueError("Postal code/coordinates require geoSource URL")
    if location.get("geoSource"):
        normalized_url(location["geoSource"])
    listing_url = normalized_url(observation["url"])
    states = updated.setdefault("listingStates", [])
    state = next((s for s in states if s["url"] == listing_url), None)
    if state is None:
        state = {"url": listing_url, "status": "unknown"}
        states.append(state)
    state["lastAttemptAt"] = observation["checkedAt"]
    if observation["availability"] != "access_error":
        state.update(status=observation["availability"], lastCheckedAt=observation["checkedAt"])
        state["lastVerifiedAt"] = observation["checkedAt"]
        updated["lastCheckedAt"] = observation["checkedAt"]
        updated["lastVerifiedAt"] = observation["checkedAt"]
    state["lastObservation"] = copy.deepcopy(observation)
    updated["lastAttemptAt"] = observation["checkedAt"]
    changes = {key: {"before": (old or {}).get(key), "after": value} for key, value in updated.items()
               if key not in RESERVED and (old or {}).get(key) != value}
    updated.setdefault("history", []).append({"eventId": event_id, "runId": run_id,
        "checkedAt": observation["checkedAt"], "url": observation["url"],
        "availability": observation["availability"], "note": observation["note"],
        "httpStatus": observation.get("httpStatus"),
        "photoCheck": copy.deepcopy(observation.get("photoCheck")),
        "evidence": copy.deepcopy(observation.get("evidence", [])),
        "reportedFields": {k: copy.deepcopy(v) for k, v in incoming.items() if k not in RESERVED}, "changes": changes})
    if not availability_only:
        updated["assessment"] = assess(updated, requirements, model)
        updated["verdict"] = updated["assessment"]["verdict"]
        updated["verdictTitle"] = {"match": "Zgodne", "check": "Do weryfikacji", "fail": "Poza wymaganiami"}[updated["verdict"]]
        updated["verdictNote"] = "; ".join(updated["assessment"]["failures"] + updated["assessment"]["unknowns"] + updated["assessment"]["preferenceNotes"])
    schema = read(ROOT / "schemas/offers-v2.schema.json")
    issues = []
    validation.validate_schema(updated, schema["$defs"]["offer"], schema, issues, "import")
    if any(i["severity"] == "error" for i in issues):
        raise ValueError("Invalid merged offer: " + json.dumps(issues, ensure_ascii=False))
    return updated, changes


def prepare(root, run_id, config):
    run = contained(root, "runs/" + run_id)
    for journal in (root / "runs").glob("*/imports/*/transaction.json"):
        if not journal.with_name("applied.json").exists():
            raise ValueError("Resume unfinished import-apply before preparing another preview: " + str(journal))
    snapshot = read(run / "snapshot.json")
    if digest({"config": snapshot["config"], "knowledge": snapshot["knowledge"]}) != snapshot["sha256"]:
        raise ValueError("Snapshot integrity check failed")
    inputs = {}
    def capture(relative):
        path = contained(root, relative)
        inputs[relative] = file_hash(path)
        return read(path) if path.exists() else None
    for path in sorted((root / "config").glob("*.json")):
        capture(path.relative_to(root).as_posix())
    for path in sorted((root / "knowledge/models").glob("*.json")):
        capture(path.relative_to(root).as_posix())
    capture(f"runs/{run_id}/snapshot.json")
    queue = capture(f"runs/{run_id}/tasks.json")
    archive_access_errors = queue.get("kind") == "availability"
    ledger_path = "data/import-state.json"
    ledger = capture(ledger_path) or {"version": 1, "results": {}, "events": []}
    models = {m["key"]: m for m in config["models"]["models"]}
    documents = {key: capture(m["offersFile"]) for key, m in models.items()}
    original = copy.deepcopy(documents)
    changes, conflicts = [], []
    skipped = [{"reason": "unmapped_refresh_target", **target} for target in queue.get("unmappedTargets", [])]
    terminal = {"complete", "partial", "blocked", "no_matches"}
    pending_observations = []
    imported_results = {}
    for task in queue["tasks"]:
        if task["state"] not in terminal:
            skipped.append({"taskId": task["id"], "reason": "task_not_finished"})
            continue
        relative = f"runs/{run_id}/results/{task['id']}.json"
        result = capture(relative)
        if result is None:
            raise ValueError("Missing result: " + relative)
        validate_result(result, task)
        checksum = digest(result)
        if relative in ledger["results"]:
            if ledger["results"][relative] != checksum:
                raise ValueError("Previously imported result changed; preserve it and create a new run: " + relative)
            skipped.append({"taskId": task["id"], "reason": "already_imported"})
            continue
        model = models.get(task["modelKey"])
        if model is None:
            raise ValueError("Task model not in current configuration")
        validate_worker_result(result, task, model, root)
        for incoming in result["offers"]:
            if not isinstance(incoming, dict):
                raise ValueError("Offer must be an object")
            observation = validate_observation(incoming, result, model, root)
            event_id = digest({"model": model["key"], "offer": incoming})
            pending_observations.append((timestamp(observation["checkedAt"]), task, relative,
                                         checksum, incoming, observation, event_id, model))
        imported_results[relative] = checksum

    # Refresh tasks can observe the same car through different portals at
    # different times. Merge observations chronologically so a later task in
    # queue order cannot make a valid earlier observation look like a conflict.
    pending_observations.sort(key=lambda item: item[0])
    for _, task, relative, checksum, incoming, observation, event_id, model in pending_observations:
            if event_id in ledger["events"]:
                continue
            keys = identities(incoming)
            matches = [(key, collection, index, offer) for key, doc in documents.items()
                       for collection in ("offers", "archivedOffers")
                       for index, offer in enumerate(doc.get(collection, [])) if keys & identities(offer)]
            reason = None
            if len(matches) > 1:
                reason = "multiple_identity_matches"
            elif matches:
                key, collection, index, old = matches[0]
                if key != model["key"]:
                    reason = "identity_in_different_model"
                elif old.get("vin") and incoming.get("vin") and old["vin"].upper() != incoming["vin"].upper():
                    reason = "conflicting_vin"
                elif any(old.get(field) is not None and incoming.get(field) is not None and
                         old[field] != incoming[field] for field in ("year", "engineVariant", "bodyCode")):
                    reason = "conflicting_vehicle_parameters"
                elif old.get("lastAttemptAt") and timestamp(old["lastAttemptAt"]) > timestamp(observation["checkedAt"]):
                    reason = "older_observation"
            else:
                old = None
            known_urls = [item["url"] for item in incoming.get("urls", [])]
            if old:
                known_urls += [item["url"] for item in old.get("urls", [])]
            if normalized_url(observation["url"]) not in {normalized_url(url) for url in known_urls}:
                raise ValueError("Observation URL must belong to this offer")
            if reason:
                conflicts.append({"taskId": task["id"], "offerId": incoming.get("id"),
                                  "url": observation["url"], "reason": reason})
                continue
            if (task.get("kind") in ("refresh", "availability") and matches
                    and collection == "archivedOffers"):
                skipped.append({"taskId": task["id"], "offerId": incoming.get("id"),
                                "url": observation["url"], "reason": "offer_archived_since_plan"})
                continue
            if task.get("kind") == "search" and matches and collection == "offers":
                skipped.append({"taskId": task["id"], "offerId": incoming.get("id"),
                                "url": observation["url"], "reason": "already_active_offer"})
                continue
            merged, fields = merge_offer(old, incoming, observation, model,
                                         requirements_for_model(model, config["requirements"]), event_id, run_id,
                                         availability_only=task.get("kind") == "availability")
            manually_excluded = bool(old and (old.get("archive") or {}).get("status") == "excluded")
            reactivated = bool(matches and collection == "archivedOffers" and
                               observation["availability"] == "available" and not manually_excluded)
            if matches:
                if reactivated:
                    documents[model["key"]]["archivedOffers"].pop(index)
                    documents[model["key"]]["offers"].append(merged)
                else:
                    documents[model["key"]][collection][index] = merged
            else:
                documents[model["key"]]["offers"].append(merged)
            ledger["events"].append(event_id)
            changes.append({"taskId": task["id"], "offerId": merged["id"],
                            "kind": "reactivated" if reactivated else ("updated" if old else "new"),
                            "url": observation["url"], "availability": observation["availability"], "fields": fields,
                            "verdict": merged["verdict"]})
    ledger["results"].update(imported_results)
    for model_key, doc in documents.items():
        active, archived = doc["offers"], doc.get("archivedOffers", [])
        kept = []
        for offer in active:
            urls = []
            for item in offer.get("urls", []):
                try:
                    urls.append(normalized_url(item["url"]))
                except (KeyError, TypeError, ValueError):
                    continue
            states = {}
            for state in offer.get("listingStates", []):
                try:
                    states[normalized_url(state["url"])] = state
                except (KeyError, TypeError, ValueError):
                    continue
            statuses = []
            for url in urls:
                if url not in states:
                    statuses.append(None)
                    continue
                state = states[url]
                last_observation = state.get("lastObservation", {})
                # access_error intentionally does not overwrite the last successfully
                # verified status; availability runs still use the latest attempt when
                # moving a listing that could not be opened to the unverified archive.
                statuses.append(last_observation.get("availability")
                                if last_observation.get("availability") == "access_error"
                                else state.get("status"))
            all_confirmed_closed = bool(urls) and all(status in ("sold", "removed") for status in statuses)
            all_terminal_and_unavailable = (archive_access_errors and bool(urls)
                                            and all(status in ("sold", "removed", "access_error") for status in statuses))
            if all_confirmed_closed or all_terminal_and_unavailable:
                archive_times = []
                for url in urls:
                    state = states[url]
                    last_observation = state.get("lastObservation", {})
                    observed_at = (last_observation.get("checkedAt")
                                   if last_observation.get("availability") == "access_error"
                                   else state.get("lastCheckedAt"))
                    if observed_at:
                        archive_times.append(timestamp(observed_at))
                archived_offer = copy.deepcopy(offer)
                confirmed = all_confirmed_closed
                archived_offer["archive"] = {"status": "closed" if confirmed else "unverified",
                                              "reason": "all_listings_confirmed_closed" if confirmed else "no_listing_url_confirmed_available; at_least_one_access_error",
                                              "archivedAt": max(archive_times).isoformat() if archive_times else datetime.now(timezone.utc).isoformat()}
                archived.append(archived_offer)
                changes.append({"taskId": None, "offerId": offer["id"], "kind": "archived",
                                "availability": "sold_or_removed" if confirmed else "unverified_access_error",
                                "reason": archived_offer["archive"]["reason"],
                                "verdict": offer.get("verdict"), "fields": {}})
            else:
                kept.append(offer)
        if len(kept) != len(active):
            doc["offers"] = kept
            doc["archivedOffers"] = archived
    outputs = {}
    for key, doc in documents.items():
        if doc != original[key]:
            dates = [h["checkedAt"][:10] for o in doc["offers"] + doc.get("archivedOffers", []) for h in o.get("history", [])]
            doc["updatedAt"] = max([doc["updatedAt"]] + dates)
            outputs[models[key]["offersFile"]] = doc
    if ledger != (read(contained(root, ledger_path)) if inputs[ledger_path] else {"version": 1, "results": {}, "events": []}):
        outputs[ledger_path] = ledger
    plan = {"version": 1, "runId": run_id, "snapshotSha256": snapshot["sha256"],
            "schemaSha256": file_hash(ROOT / "schemas/offers-v2.schema.json"),
            "assessmentConfigurationSha256": digest(config), "inputs": inputs,
            "changes": changes, "conflicts": conflicts, "skipped": skipped, "outputs": outputs}
    plan["sha256"] = digest(plan)
    atomic_write(run / "import-preview.json", plan)
    lines = [f"# Podgląd importu: {run_id}", "", f"Zmiany: {len(changes)}. Konflikty: {len(conflicts)}. Pominięte: {len(skipped)}.",
             "Ocena według bieżącej konfiguracji; wyszukiwanie według snapshotu przebiegu.", ""]
    for change in changes:
        lines.append(f"- {change['kind']}: {change['offerId']} — {change['availability']}, {change['verdict']}")
        for field, values in change["fields"].items():
            lines.append(f"  - {field}: {json.dumps(values['before'], ensure_ascii=False)} → {json.dumps(values['after'], ensure_ascii=False)}")
    for conflict in conflicts:
        lines.append(f"- KONFLIKT: {conflict['offerId']} — {conflict['reason']}")
    for item in skipped:
        if item.get("reason") == "unmapped_refresh_target":
            lines.append(f"- POMINIĘTO URL: {item.get('offerId')} — {item.get('url') or 'brak URL'} ({item.get('reason')})")
        else:
            lines.append(f"- POMINIĘTO ZADANIE: {item.get('taskId')} — {item.get('reason')}")
    (run / "import-preview.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return plan


def apply(root, run_id):
    run = contained(root, "runs/" + run_id)
    plan = read(run / "import-preview.json")
    checksum = plan.pop("sha256")
    if digest(plan) != checksum or plan["runId"] != run_id:
        raise ValueError("Preview integrity check failed")
    if plan["schemaSha256"] != file_hash(ROOT / "schemas/offers-v2.schema.json"):
        raise ValueError("Schema changed; prepare a new preview")
    if plan["conflicts"]:
        raise ValueError("Resolve conflicts in a new preserved result/run before applying")
    transaction = run / "imports" / checksum
    receipt = transaction / "applied.json"
    if receipt.exists():
        return "already_applied"
    journal = transaction / "transaction.json"
    if journal.exists():
        saved = read(journal)
        if saved["planSha256"] != checksum:
            raise ValueError("Transaction integrity check failed")
        for relative, expected in saved["afterHashes"].items():
            current = file_hash(contained(root, relative))
            if current not in (plan["inputs"][relative], expected):
                raise ValueError("Concurrent modification during recovery: " + relative)
    else:
        saved = None
    for relative, expected in plan["inputs"].items():
        if saved and relative in plan["outputs"]:
            continue
        if file_hash(contained(root, relative)) != expected:
            raise ValueError("Input changed; prepare a new preview: " + relative)
    if not plan["outputs"]:
        return "no_changes"
    if saved is None:
        after_hashes = {}
        for relative, value in plan["outputs"].items():
            target = contained(root, relative)
            backup = contained(transaction / "before", relative)
            if target.exists():
                backup.parent.mkdir(parents=True, exist_ok=True)
                backup.write_bytes(target.read_bytes())
            staged = contained(transaction / "after", relative)
            atomic_write(staged, value)
            after_hashes[relative] = file_hash(staged)
        atomic_write(journal, {"planSha256": checksum, "afterHashes": after_hashes, "inputs": plan["inputs"]})
    for relative, value in plan["outputs"].items():
        atomic_write(contained(root, relative), value)
    atomic_write(receipt, {"planSha256": checksum, "appliedAt": datetime.now(timezone.utc).isoformat(),
                           "files": list(plan["outputs"])})
    return "applied"
