#!/usr/bin/env python3
"""Manual coordinator tools; does not scrape websites or publish changes."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
from search_core import ASSESSMENT_FIELDS, ROOT, assess, audit, brand_key, contained, description, read, write


BODY_TERMS = {
    "wagon": "kombi", "sedan": "sedan", "suv": "SUV", "crossover": "crossover",
    "hatchback": "hatchback", "minivan": "minivan"
}


def compact_text(value):
    return re.sub(r"[^a-z0-9]", "", str(value).casefold())


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
    queries = [{"id": "model-body", "text": " ".join([prefix, model["generation"], *body_terms])}]
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


def build_shared_search_cache(root, run, queue, source_id):
    pages, snippets, checked_urls = {}, {}, set()
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
            pages.setdefault(page_key, {"url": page_key, "checkedAt": page.get("checkedAt"),
                                         "queryId": page.get("queryId"), "taskId": prior["id"],
                                         "modelKey": prior.get("modelKey")})
            for listing in page.get("listings", []):
                if not isinstance(listing, dict) or not isinstance(listing.get("url"), str):
                    continue
                listing_key = listing["url"]
                snippets.setdefault(listing_key, {**listing, "pageUrl": page_key,
                                                   "checkedAt": page.get("checkedAt"),
                                                   "taskId": prior["id"],
                                                   "modelKey": prior.get("modelKey")})
    ordered_pages = sorted(pages.values(), key=lambda item: item.get("checkedAt") or "", reverse=True)[:100]
    ordered_snippets = sorted(snippets.values(), key=lambda item: item.get("checkedAt") or "", reverse=True)[:300]
    return {"checkedSearchPages": ordered_pages, "visibleListings": ordered_snippets,
            "listingUrlsChecked": sorted(checked_urls)[-500:]}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=["validate", "sync", "plan", "refresh-plan", "claim", "finish", "assess", "import-preview", "import-apply"])
    p.add_argument("--root", type=Path, default=ROOT)
    p.add_argument("--run")
    p.add_argument("--worker")
    p.add_argument("--task")
    p.add_argument("--result", choices=["complete", "partial", "blocked", "no_matches"])
    p.add_argument("--note", default="")
    p.add_argument("--agents", type=int, default=3)
    p.add_argument("--model", action="append", dest="models")
    p.add_argument("--source", action="append", dest="sources")
    p.add_argument("--older-than-days", type=int, help="For refresh-plan, include listings not successfully checked within this many days")
    p.add_argument("--offer", action="append", dest="offer_ids", help="For refresh-plan, explicitly select an offer ID (repeatable)")
    p.add_argument("--photo-audit", action="store_true",
                   help="For refresh-plan, require a per-card audit of direct photo URLs")
    args = p.parse_args()
    if args.photo_audit and args.command != "refresh-plan":
        p.error("--photo-audit is only valid with refresh-plan")
    root = args.root.resolve()
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
    if args.command in ("claim", "finish"):
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
        print(f"OK: {len(models)} models, {len(sources)} sources")
    elif args.command == "sync":
        for m in models:
            path = contained(root, m["offersFile"])
            doc = read(path)
            doc["model"]["requirements"] = description(req, m)
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
            for offer in read(contained(root, m["offersFile"]))["offers"]:
                output.append({**assess(offer, req, m), "input": {key: offer.get(key) for key in ASSESSMENT_FIELDS}})
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
            selected_s = [s for s in sources if s["enabled"] and s["category"] != "auction"
                          and s["purchaseConditions"].get("auction") is not True
                          and (not args.sources or s["id"] in args.sources)]
            if args.models and set(args.models) - {m["key"] for m in selected_m}:
                p.error("Unknown or inactive model")
            if args.sources and set(args.sources) - {s["id"] for s in selected_s}:
                p.error("Unknown or disabled source")
            cards = {m["key"]: read(contained(root, m["knowledgeFile"])) for m in selected_m}
            tasks = []
            for s in sorted(selected_s, key=lambda s: s["priority"]):
                for m in sorted(selected_m, key=lambda m: m["priority"]):
                    if s["brands"] and brand_key(m["brand"]) not in [brand_key(b) for b in s["brands"]]:
                        continue
                    tasks.append({"id": f"{s['id']}--{m['key']}", "kind": "search",
                                  "sourceId": s["id"], "modelKey": m["key"],
                                  "searchProfile": {
                                      "searchUrl": s["searchUrl"],
                                      "filtersAvailable": s["filters"],
                                      "filtersToVerifyManually": sorted({"make", "model", "body", "price", "year",
                                          "mileage", "fuel", "transmission", "seller_type"} - set(s["filters"])),
                                      "brands": [m["brand"]], "bodies": m["bodies"],
                                      "years": {"min": max(req["yearMin"], m["searchYears"]["min"]),
                                                "max": m["searchYears"]["max"]},
                                      "engineVariants": m["allowedEngineVariants"],
                                      "maxGrossPurchasePln": req["purchase"]["maxPriceGrossPln"],
                                      "priceOverLimitRequiresUserApproval": bool(req["purchase"]["priceExceptions"]),
                                      "preferredMileageKm": req["mileage"]["preferredMaxKm"],
                                      "candidateScreening": {
                                          "stage": "results_list_before_opening_candidate_cards",
                                          "visibleFields": ["production_year", "price_and_terms", "mileage",
                                                            "body", "engine_variant", "sale_type"],
                                          "screeningLimits": {
                                              "productionYearMin": max(req["yearMin"], m["searchYears"]["min"]),
                                              "productionYearMax": m["searchYears"]["max"],
                                              "basePurchaseGrossPlnMax": req["purchase"]["maxPriceGrossPln"],
                                              "hardMileageKmMax": req["mileage"].get("hardMaxKm"),
                                              "bodyCodes": m["bodies"],
                                              "engineVariants": m["allowedEngineVariants"],
                                              "auctionsAllowed": req["purchase"]["auctionsAllowed"]
                                          },
                                          "priceExceptions": req["purchase"]["priceExceptions"],
                                          "priceOverLimitRequiresUserApproval": bool(req["purchase"]["priceExceptions"]),
                                          "rejectOnlyOnVisibleConfirmedFailure": True,
                                          "unknownHandling": "open_card_if_other_visible_fields_are_plausible",
                                          "reminders": [
                                              "production year is not first registration or model year",
                                              "a displayed price is not unconditional gross purchase price unless its terms say so",
                                              "apply configured price exceptions only with explicit user approval",
                                              "search result snippets do not confirm listing availability"
                                          ]
                                      },
                                      "transmissions": req["transmissions"],
                                      "cameraRequired": req["camera"]["required"],
                                      "cameraRetrofitAllowed": req["camera"]["retrofitAllowed"],
                                      "lpgAllowedAndMustBeMarked": req["lpg"]["allowed"],
                                      "familyProfile": req["use"],
                                      "structuralDamageAllowed": req["structuralDamageAllowed"],
                                      "country": req["location"], "excludeAuctions": True,
                                      "sourceAccessStatus": s["accessStatus"],
                                      "queryPlan": build_query_plan(s, m, req, cards[m["key"]]),
                                      "captureOfferLocation": {
                                          "required": True,
                                          "whenMissing": "set location.status=not_provided and show that distance cannot be calculated",
                                          "fields": ["countryCode", "voivodeship", "city", "postalCode"],
                                          "coordinates": "record only when provided or geocoded with a recorded source",
                                          "doNotGuess": True
                                      },
                                      "sourceMethod": s["method"]
                                  },
                                  "state": "pending", "worker": None, "attempts": 0, "note": ""})
            if not tasks:
                p.error("No eligible tasks")
            run.mkdir(parents=True, exist_ok=False)
            (run / "results").mkdir()
            snapshot = {"config": config, "knowledge": cards}
            digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            write(run / "snapshot.json", {"createdAt": datetime.now(timezone.utc).isoformat(), "sha256": digest, **snapshot})
            write(run / "tasks.json", {"version": 1, "agents": args.agents, "workerAssignments": {}, "tasks": tasks})
            by_source = {}
            for task in tasks:
                by_source[task["sourceId"]] = by_source.get(task["sourceId"], 0) + 1
            skipped = [s["id"] for s in selected_s if not any(t["sourceId"] == s["id"] for t in tasks)]
            print(f"Prepared {len(tasks)} tasks across {len(by_source)} compatible sources; no websites searched")
            if skipped:
                print("No compatible selected model: " + ", ".join(skipped))
        elif args.command == "refresh-plan":
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
                for offer in document["offers"]:
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
                tasks.append({"id": f"refresh--{source_id}--{model_key}", "kind": "refresh",
                              "sourceId": source_id, "modelKey": model_key, "refreshTargets": unique_targets,
                              "photoAuditRequired": args.photo_audit,
                              "sourceMethod": source["method"], "state": "pending", "worker": None,
                              "attempts": 0, "note": ""})
            if not tasks and not unmapped_targets:
                p.error("No refresh candidates matched the selected models, sources and age/offer filters")
            run.mkdir(parents=True, exist_ok=False)
            (run / "results").mkdir()
            cards = {m["key"]: read(contained(root, m["knowledgeFile"])) for m in selected_m}
            snapshot = {"config": config, "knowledge": cards}
            digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            write(run / "snapshot.json", {"createdAt": now.isoformat(), "sha256": digest, **snapshot})
            write(run / "tasks.json", {"version": 1, "kind": "refresh", "agents": args.agents,
                  "workerAssignments": {}, "refreshAfterDays": args.older_than_days,
                  "photoAuditRequired": args.photo_audit,
                  "unmappedTargets": unmapped_targets, "tasks": tasks})
            target_count = sum(len(task["refreshTargets"]) for task in tasks)
            mode = f"not checked within {args.older_than_days} days" if args.older_than_days is not None else "all active offer records"
            print(f"Prepared {len(tasks)} refresh tasks for {target_count} listing pages ({mode}); "
                  f"{len(unmapped_targets)} URL(s) need manual source mapping; no websites checked")
        else:
            queue = read(run / "tasks.json")
            if args.command == "claim":
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
                task = next((t for t in queue["tasks"] if t["state"] == "pending" and
                             (source_filter is None or t["sourceId"] in source_filter)), None)
                if not task:
                    print("No pending tasks" + (" for sources " + ", ".join(sorted(source_filter)) if source_filter else ""))
                    return 0
                task.update(state="running", worker=args.worker, attempts=task["attempts"] + 1)
                if source_filter:
                    assignments.setdefault(args.worker, sorted(source_filter))
                write(run / "tasks.json", queue)
                claimed_task = dict(task)
                if task.get("kind") == "search":
                    claimed_task["sharedResultsCache"] = build_shared_search_cache(
                        root, run, queue, task["sourceId"])
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
                    p.error("Result validation failed; task remains running. Rejected copy saved to " +
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
                if args.result == "no_matches" and result["offers"]:
                    reject_result("no_matches cannot contain offers")
                if args.result == "blocked" and task.get("kind") != "refresh" and result["offers"]:
                    reject_result("blocked cannot contain offers")
                if task.get("kind") == "refresh" and args.result == "no_matches":
                    reject_result("Refresh tasks have known target listings; use complete, partial or blocked")
                if task.get("kind") == "refresh" and args.result == "complete":
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
                if task.get("kind") == "refresh" and args.result == "partial":
                    targets = {(target["offerId"], target["url"]) for target in task.get("refreshTargets", [])}
                    for offer in result["offers"]:
                        observation = offer.get("observation", {}) if isinstance(offer, dict) else {}
                        pair = (offer.get("id"), observation.get("url")) if isinstance(offer, dict) else (None, None)
                        if pair not in targets:
                            reject_result("Refresh result contains an offer outside its assigned targets")
                from offer_import import validate_worker_result
                model = next((m for m in config["models"]["models"] if m["key"] == task["modelKey"]), None)
                if model is None:
                    p.error("Task model is missing from the run snapshot")
                try:
                    validate_worker_result(result, task, model, root,
                                            require_search_cache=(task.get("kind") == "search"))
                except (ValueError, KeyError, TypeError) as exc:
                    reject_result(exc)
                task.update(state=args.result, note=args.note)
                write(run / "tasks.json", queue)
                print("Task recorded; published offers unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
