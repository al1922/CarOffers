"""Shared model ranking and evidence validation for the coordinator flow."""
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from search_core import contained, load_config, read, write, assess, requirements_for_model


WEIGHTS = {"safety": 30, "reliability": 25, "luggage": 20, "power_and_use": 20, "camera": 5}


def recursive_numbers(value, names):
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key in names and isinstance(item, (int, float)) and not isinstance(item, bool):
                found.append(item)
            found.extend(recursive_numbers(item, names))
    elif isinstance(value, list):
        for item in value:
            found.extend(recursive_numbers(item, names))
    return found


def model_signals(model, card):
    topics = [claim.get("topic", "").casefold() for claim in card.get("claims", [])]
    values = [claim.get("value", {}) for claim in card.get("claims", [])]
    safety_claims = [v for t, v in zip(topics, values) if "safety" in t or "child" in t or "crash" in t]
    reliability_claims = [v for t, v in zip(topics, values) if "reliab" in t or "engine-assessment" in t or "engine_recommendation" in t]
    boot = recursive_numbers(values, {"bootLitresSeatsUp", "bootLitres"})
    safety_points = 30 if any(recursive_numbers(v, {"euroNcapStars", "stars", "overallStars"}) for v in safety_claims) else (15 if safety_claims else 0)
    reliability_points = 25 if any(recursive_numbers(v, {"modelScorePercent", "registrationYearBreakdownsPer1000", "scorePercent"}) for v in reliability_claims) else (12 if reliability_claims else 0)
    luggage_points = min(20, max(0, round(max(boot) / 30))) if boot else 0
    powers = []
    for variant in model.get("allowedEngineVariants", []):
        match = re.search(r"-(\d+)$", variant)
        if match:
            powers.append(int(match.group(1)))
    power_points = min(10, round(max(powers) / 15)) if powers else 0
    utility_points = 10 if any(body in ("wagon", "minivan") for body in model.get("bodies", [])) else 7 if any(body in ("suv", "crossover") for body in model.get("bodies", [])) else 5
    camera_claims = [v for t, v in zip(topics, values) if "camera" in t]
    camera_points = 5 if camera_claims else 0
    axes = {
        "safety": {"points": safety_points, "max": WEIGHTS["safety"], "dataPresent": bool(safety_claims)},
        "reliability": {"points": reliability_points, "max": WEIGHTS["reliability"], "dataPresent": bool(reliability_claims)},
        "luggage": {"points": luggage_points, "max": WEIGHTS["luggage"], "dataPresent": bool(boot), "bootLitresSeatsUp": max(boot) if boot else None},
        "power_and_use": {"points": utility_points + power_points, "max": WEIGHTS["power_and_use"], "dataPresent": bool(powers), "cataloguedPowerPS": max(powers) if powers else None},
        "camera": {"points": camera_points, "max": WEIGHTS["camera"], "dataPresent": bool(camera_claims)},
    }
    return {"score": sum(axis["points"] for axis in axes.values()), "axes": axes,
            "knowledgeStatus": card.get("status", "unknown"), "knowledgeReviewedAt": card.get("reviewedAt")}


def candidate_score(offer, requirements, model):
    result = assess(offer, requirements, model)
    rank = {"match": 30, "check": 10, "fail": -100}[result["verdict"]]
    if offer.get("price") is None: rank -= 5
    if offer.get("mileage") is None: rank -= 5
    if offer.get("lastVerifiedAt") or offer.get("lastCheckedAt"): rank += 2
    return rank


def build(root):
    config = load_config(root)
    requirements = config["requirements"]
    cards, ranked = {}, []
    for model in config["models"]["models"]:
        if not model.get("active"):
            continue
        model_requirements = requirements_for_model(model, requirements)
        card = read(contained(root, model["knowledgeFile"]))
        cards[model["key"]] = card
        offers = read(contained(root, model["offersFile"]))["offers"]
        offers = [o for o in offers if assess(o, model_requirements, model)["verdict"] != "fail"
                  and any(isinstance(x, dict) and isinstance(x.get("url"), str) and x["url"].startswith("https://") for x in o.get("urls", []))]
        if offers:
            ranked.append({"model": model, "signals": model_signals(model, card), "offers": offers})
    tasks = []
    for index, item in enumerate(ranked, 1):
        model = item["model"]
        model_requirements = requirements_for_model(model, requirements)
        offers = sorted(item["offers"], key=lambda o: (-candidate_score(o, model_requirements, model), o.get("id", "")))
        candidates = [{"offerId": o["id"], "title": o["title"], "urls": o.get("urls", []),
                       "year": o.get("year"), "price": o.get("price"), "mileage": o.get("mileage"),
                       "engine": o.get("engine"), "body": o.get("body"),
                       "lastVerifiedAt": o.get("lastVerifiedAt"), "lastCheckedAt": o.get("lastCheckedAt"),
                       "existingAssessment": assess(o, model_requirements, model)} for o in offers]
        tasks.append({"id": f"recommend-model--{model['key']}", "kind": "recommendation_model",
                      "phase": "model_review", "rank": index, "modelKey": model["key"], "modelName": model["name"],
                      "modelRequirements": model_requirements,
                      "modelSignals": item["signals"], "candidates": candidates,
                      "workerInstructions": [
                          "This is phase 1: analyze this model using modelRequirements, its knowledge card, allowed engines, current saved offer summaries and reputable web sources. Do not choose the final five; the coordinator compares all model results.",
                          "Assess family safety, engine reliability, luggage capacity, power and city/road suitability, and camera as an optional preference. Use the user weights from the task. Explain limits and unknowns; cite each factual claim.",
                          "Saved offer summaries help judge availability of candidates and typical budget fit, but are not evidence that a listing is still live. Do not open every listing yet.",
                          "Do not inspect or interpret photos. Do not change offers/*.json. Save only runs/<run-id>/results/<task-id>.json."
                      ],
                      "state": "pending", "worker": None, "attempts": 0})
    return config, cards, tasks


def select_models(root, run_id):
    run = root / "runs" / run_id
    queue_path = run / "tasks.json"
    queue = read(queue_path)
    model_tasks = [t for t in queue["tasks"] if t.get("kind") == "recommendation_model"]
    if not model_tasks or any(t["state"] not in ("complete", "partial") for t in model_tasks):
        raise ValueError("All model-review tasks must be complete or partial before selecting five models")
    scores = []
    for task in model_tasks:
        result = read(run / "results" / (task["id"] + ".json"))
        points = {}
        for axis, maximum in WEIGHTS.items():
            status = result["research"][axis]["status"]
            points[axis] = maximum if status == "confirmed" else round(maximum / 2) if status == "partial" else 0
        scores.append((sum(points.values()), task, result, points))
    scores.sort(key=lambda x: (-x[0], x[1]["modelName"].casefold()))
    selected = [entry for entry in scores if entry[1]["candidates"]][:5]
    if len(selected) != 5:
        raise ValueError("Fewer than five analyzed models have candidate listing URLs")
    listing_tasks = []
    for rank, (score, model_task, model_result, points) in enumerate(selected, 1):
        candidates = model_task["candidates"]
        listing_tasks.append({"id": f"recommend-listing--{rank}--{model_task['modelKey']}",
            "kind": "recommendation_listing", "phase": "listing_review", "rank": rank,
            "modelKey": model_task["modelKey"], "modelName": model_task["modelName"],
            "modelRequirements": model_task["modelRequirements"],
            "modelScore": score, "modelPoints": points, "modelResearch": model_result["research"],
            "modelSignals": model_task["modelSignals"],
            "candidates": candidates,
            "workerInstructions": [
                "This is phase 2 for a model selected by the coordinator after comparing every model review.",
                "Open candidate listing URLs in order. If one is sold, removed, inaccessible or otherwise not current, record the attempt and try the next listing for this same model.",
                "Use modelRequirements as the hard criteria for this model. For the first currently available candidate, inspect the listing carefully and verify year of production, exact engine/power, body, transmission, gross purchase price (financing terms are irrelevant), mileage, sale type, LPG, camera, location and seller statements. Preserve unknowns and cite the listing URL.",
                "Use the research sources from phase 1 and add exact-market/exact-version sources where necessary. Write user-facing titles, facts and research notes in Polish. Do not analyze photos or infer condition/equipment from them. If the listing card exposes direct HTTPS photo URLs, save up to 12 in selectedOffer.photos; otherwise omit photos.",
                "Save only runs/<run-id>/results/<task-id>.json. Never edit offers/*.json."
            ], "state": "pending", "worker": None, "attempts": 0})
    queue["tasks"].extend(listing_tasks)
    queue["selectedModels"] = [{"rank": i, "modelKey": t["modelKey"], "modelName": t["modelName"],
        "modelScore": s, "points": p, "research": r["research"]} for i, (s, t, r, p) in enumerate(selected, 1)]
    queue["phase"] = "listing_review"
    write(queue_path, queue)
    write(run / "recommendation-shortlist.json", {"status": "selected_for_listing_review", "weights": WEIGHTS,
        "selectedModels": queue["selectedModels"]})
    return listing_tasks


def validate_research(result):
    for axis in WEIGHTS:
        finding = result.get("research", {}).get(axis)
        if not isinstance(finding, dict) or finding.get("status") not in ("confirmed", "partial", "unknown"):
            raise ValueError(f"research.{axis} needs a confirmed, partial or unknown status")
        if finding.get("status") != "unknown" and not finding.get("evidence"):
            raise ValueError(f"research.{axis} needs source evidence")
        for source in finding.get("evidence", []):
            if (not isinstance(source, dict) or not isinstance(source.get("title"), str) or
                    not source["title"].strip() or not isinstance(source.get("url"), str) or
                    not source["url"].startswith("https://") or not isinstance(source.get("checkedAt"), str)):
                raise ValueError(f"research.{axis} evidence needs a title, HTTPS URL and checkedAt")


def validate_model_result(task, result):
    if result.get("outcome") not in ("complete", "partial") or result.get("taskId") != task["id"] or not result.get("checkedAt"):
        raise ValueError("Model-review result requires matching taskId, complete/partial outcome and checkedAt")
    if result.get("modelKey") != task["modelKey"] or not isinstance(result.get("summary"), str) or not result["summary"].strip():
        raise ValueError("Model-review result requires matching modelKey and a non-empty summary")
    validate_research(result)


def validate_listing_result(task, result):
    if result.get("outcome") != "complete":
        raise ValueError("Recommendation review tasks must finish with outcome=complete")
    if result.get("taskId") != task["id"] or not isinstance(result.get("checkedAt"), str):
        raise ValueError("Result needs matching taskId and checkedAt")
    if result.get("availability") not in ("available", "none_available"):
        raise ValueError("availability must be available or none_available")
    candidates = {url["url"]: c["offerId"] for c in task["candidates"] for url in c["urls"]}
    tried = result.get("triedUrls")
    if not isinstance(tried, list) or any(url not in candidates for url in tried):
        raise ValueError("triedUrls must contain only candidate listing URLs")
    chosen = result.get("selectedOffer")
    if chosen is not None:
        if chosen.get("url") not in candidates or chosen.get("offerId") != candidates[chosen["url"]]:
            raise ValueError("selectedOffer must match one of this task's saved candidates")
        if result.get("availability") != "available":
            raise ValueError("A selected offer must be verified available")
        if chosen["url"] not in tried:
            raise ValueError("The selected listing URL must be included in triedUrls")
        if not isinstance(chosen.get("facts"), dict):
            raise ValueError("selectedOffer.facts must contain the fields read from the listing")
        photos = chosen.get("photos")
        if photos is not None and (not isinstance(photos, list) or len(photos) > 12 or
                                   any(not isinstance(url, str) or not url.startswith("https://") for url in photos)):
            raise ValueError("selectedOffer.photos must be an optional array of up to 12 HTTPS URLs")
        validate_research(result)
    elif len(set(tried)) < len(candidates):
        raise ValueError("When no candidate is available, every saved listing URL must be tried")
    elif result.get("availability") != "none_available":
        raise ValueError("A result without selectedOffer must use availability=none_available")
    return True


def validate_result(task, result):
    if task.get("kind") == "recommendation_model":
        return validate_model_result(task, result)
    if task.get("kind") == "recommendation_listing":
        return validate_listing_result(task, result)
    raise ValueError("Unknown recommendation task kind")


def plain_value(value):
    if isinstance(value, dict):
        for key in ("value", "grossPln", "pricePln", "priceGrossPln", "variant", "type", "code", "city"):
            if value.get(key) is not None:
                return plain_value(value[key])
        return value.get("note") or value.get("terms") or "Nieustalone"
    if value is None or value == "unknown" or value == "not_provided":
        return "Nieustalone"
    if isinstance(value, bool):
        return "Tak" if value else "Nie"
    return value


def display_facts(facts):
    def first(*keys):
        return next((facts[k] for k in keys if facts.get(k) is not None), None)
    price_value = first("pricePln", "priceGrossPln", "price")
    price = plain_value(price_value)
    if isinstance(price, (int, float)):
        price = f"{price:,.0f} zł".replace(",", " ")
    elif isinstance(price, str) and price.isdigit():
        price = f"{int(price):,} zł".replace(",", " ")
    year = plain_value(first("productionYear", "year"))
    mileage = plain_value(first("mileageKm", "mileage"))
    if isinstance(mileage, (int, float)):
        mileage = f"{mileage:,.0f} km".replace(",", " ")
    engine_value = first("engineVariant", "engine")
    engine = plain_value(engine_value)
    if isinstance(engine_value, dict) and engine == "Nieustalone":
        parts = [engine_value.get(k) for k in ("variant", "powerPs", "powerPS", "fuel") if engine_value.get(k) is not None]
        engine = " · ".join(map(str, parts)) or "Nieustalone"
    sale_value = first("saleType")
    sale_text = str(plain_value(sale_value)).casefold()
    sale_type = "Aukcja" if sale_text == "auction" else "Cena stała" if sale_text in ("fixed_price", "fixed_price_non_auction") or "not an auction" in sale_text or "bez aukcji" in sale_text else "Nieustalone"
    seller = first("sellerType", "offerType")
    if seller is None and isinstance(facts.get("seller"), dict):
        seller = facts["seller"].get("type")
    lpg = plain_value(first("lpgInstalled", "lpg"))
    camera = first("cameraStatus", "camera")
    location = facts.get("location")
    if isinstance(location, dict):
        location = location.get("city") or location.get("note")
    return {"Rocznik produkcji": year, "Przebieg": mileage, "Cena zakupu": price,
            "Silnik": engine, "Nadwozie": plain_value(first("body")),
            "Skrzynia": plain_value(first("transmission")), "Typ sprzedaży": sale_type,
            "Sprzedawca": plain_value(seller), "LPG": lpg, "Kamera": plain_value(camera),
            "Lokalizacja": plain_value(location),
            "Warunki ceny": plain_value(first("priceTerms", "priceBasis"))}


def finalize(root, run_id):
    run = root / "runs" / run_id
    queue = read(run / "tasks.json")
    listing_tasks = [t for t in queue["tasks"] if t.get("kind") == "recommendation_listing"]
    if len(listing_tasks) != 5 or any(t["state"] != "complete" for t in listing_tasks):
        raise ValueError("All five detailed listing-review tasks must be complete")
    ranked = []
    weights = queue["weights"]
    for task in listing_tasks:
        result = read(run / "results" / (task["id"] + ".json"))
        if result.get("availability") != "available" or not result.get("selectedOffer"):
            continue
        findings = result["research"]
        points = {}
        for axis, maximum in weights.items():
            status = findings[axis]["status"]
            points[axis] = maximum if status == "confirmed" else round(maximum / 2) if status == "partial" else 0
        total = sum(points.values())
        listing = dict(result["selectedOffer"])
        facts = listing.get("facts", {})
        if isinstance(facts.get("saleType"), str) and facts["saleType"].casefold() in ("private", "company", "leasing_return"):
            facts["sellerType"] = facts.get("sellerType") or facts["saleType"]
            facts["saleType"] = "unknown"
        if isinstance(facts.get("saleType"), dict) and str(facts["saleType"].get("value", "")).startswith("fixed_price"):
            facts["saleType"] = "fixed_price"
        listing["displayFacts"] = display_facts(facts)
        ranked.append({"modelKey": task["modelKey"], "modelName": task["modelName"],
                       "modelSignals": task["modelSignals"], "listing": listing,
                       "checkedAt": result["checkedAt"], "points": points, "score": total,
                       "research": findings, "triedUrls": result["triedUrls"]})
    ranked.sort(key=lambda x: (-x["score"], x["modelName"].casefold()))
    for index, item in enumerate(ranked, 1): item["rank"] = index
    report = {"version": 1, "status": "complete", "generatedAt": datetime.now(timezone.utc).isoformat(),
              "sourceRun": run_id, "weights": weights, "recommendations": ranked,
              "note": "Wynik dotyczy pięciu wybranych modeli i jednej potwierdzonej aktualnej oferty na model. Braki informacji otrzymują zero punktów."}
    write(root / "reports" / "recommendations.json", report)
    write(run / "recommendation-report.json", report)
    print(f"Wrote recommendations.json with {len(ranked)} currently available listings")
