"""Shared local configuration, validation and assessment. Standard library only."""
import importlib.util
import json
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSESSMENT_FIELDS = ("price", "priceBasis", "year", "bodyCode", "engineVariant", "transmissionCode",
                     "cameraStatus", "structuralDamageStatus", "mileage", "familyFitConfirmed", "saleType", "lpgInstalled")
spec = importlib.util.spec_from_file_location("offer_validation", ROOT / "scripts/validate-offers.py")
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=validation.unique_object,
                      parse_constant=validation.reject_constant)


def write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def contained(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"Path outside project: {relative}")
    return path


def brand_key(value):
    return "".join(c for c in unicodedata.normalize("NFKD", value.casefold()) if not unicodedata.combining(c))


def load_config(root=ROOT):
    return {name: read(root / "config" / f"{file}.json") for name, file in
            [("requirements", "requirements"), ("models", "search-models"), ("sources", "sources")]}


def audit(root=ROOT):
    config = load_config(root)
    issues = []
    for key, filename in [("requirements", "requirements"), ("models", "search-models"), ("sources", "sources")]:
        schema = read(ROOT / "schemas" / f"{filename}-v1.schema.json")
        validation.check_schema(schema)
        validation.validate_schema(config[key], schema, schema, issues, filename)
    if any(i["severity"] == "error" for i in issues):
        return config, issues
    for exception in config["requirements"]["purchase"]["priceExceptions"]:
        if (exception.get("rule") != "slightly_above_limit_only_for_exceptional_offer" or
                exception.get("amountPln") is not None or exception.get("userMustConfirm") is not True):
            validation.issue(issues, "error", "UNSUPPORTED_EXCEPTION", "requirements", "",
                             "Only a manually confirmed, unbounded slight-overage exception is supported")
    for key, collection in [("models", "models"), ("sources", "sources")]:
        ids = [x["key" if key == "models" else "id"] for x in config[key][collection]]
        if len(ids) != len(set(ids)):
            validation.issue(issues, "error", "DUPLICATE", key, "", "Duplicate model/source ID")
    for model in config["models"]["models"]:
        try:
            years = model["searchYears"]
            if years["max"] is not None and years["max"] < max(years["min"], config["requirements"]["yearMin"]):
                raise ValueError("Empty production-year selection")
            if len(model["allowedEngineVariants"]) != len(set(model["allowedEngineVariants"])):
                raise ValueError("Duplicate engine variant")
            doc = read(contained(root, model["offersFile"]))
            card = read(contained(root, model["knowledgeFile"]))
            if doc["model"]["key"] != model["key"] or card["modelKey"] != model["key"]:
                raise ValueError("Model reference mismatch")
            schema = read(ROOT / "schemas/knowledge-v1.schema.json")
            validation.check_schema(schema)
            validation.validate_schema(card, schema, schema, issues, model["knowledgeFile"])
            source_ids = [s["id"] for s in card["sources"]]
            if len(source_ids) != len(set(source_ids)):
                raise ValueError("Duplicate knowledge source ID")
            for claim in card["claims"]:
                if not claim["sourceIds"] or not set(claim["sourceIds"]).issubset(source_ids):
                    raise ValueError("Claim without valid evidence")
            for constraint in model.get("variantConstraints", []):
                if not set(constraint["sourceIds"]).issubset(source_ids) or not constraint["sourceIds"]:
                    raise ValueError("Variant constraint without valid evidence")
                if not set(constraint["engines"]).issubset(model["allowedEngineVariants"]):
                    raise ValueError("Variant constraint references engine outside selection")
        except (OSError, KeyError, ValueError) as exc:
            validation.issue(issues, "error", "REFERENCE", model["key"], "", str(exc))
    return config, issues


def description(requirements, model):
    p = requirements["purchase"]
    years = model["searchYears"]
    age = f"od {max(requirements['yearMin'], years['min'])}"
    if years["max"] is not None:
        age += f" do {years['max']}"
    camera = "kamera obecna lub potwierdzona możliwość montażu" if requirements["camera"]["retrofitAllowed"] else "kamera obecna"
    price_text = f"maks. {p['maxPriceGrossPln']:,} zł brutto według ceny podanej w ogłoszeniu"
    if p["priceExceptions"]:
        price_text += "; niewielkie przekroczenie tylko po ręcznej zgodzie użytkownika"
    return (f"{model['name']}; {model['legacyEngineSelection']}; rocznik {age}; "
            f"{price_text}; "
            f"przebieg do {requirements['mileage']['preferredMaxKm']:,} km preferowany; "
            f"{camera}; bez poważnych szkód konstrukcyjnych; LPG dopuszczone i oznaczane; bez aukcji."
            ).replace(",", " ")


def assess(offer, requirements, model):
    """Assess structured evidence; never infer facts from arbitrary seller prose."""
    fail, unknown, preferences = [], [], []
    price = offer.get("price")
    if type(price) not in (int, float) or price <= 0:
        unknown.append("purchase_price")
    elif price > requirements["purchase"]["maxPriceGrossPln"]:
        if requirements["purchase"]["priceExceptions"]:
            unknown.append("price_exception_requires_user_confirmation")
        else:
            fail.append("price_over_limit")
    if offer.get("priceBasis") in (None, "unknown", "net"):
        unknown.append("gross_price_basis")
    year = offer.get("year")
    if type(year) is not int:
        unknown.append("production_year")
    elif year < max(requirements["yearMin"], model["searchYears"]["min"]) or (
            model["searchYears"]["max"] is not None and year > model["searchYears"]["max"]):
        fail.append("year_outside_selection")
    if offer.get("bodyCode") is None:
        unknown.append("body")
    elif offer["bodyCode"] not in model["bodies"]:
        fail.append("body_outside_selection")
    if offer.get("engineVariant") is None:
        unknown.append("exact_engine_variant")
    elif offer["engineVariant"] not in model["allowedEngineVariants"]:
        fail.append("engine_outside_selection")
    review = model.get("engineReview", {}).get("variants", {}).get(offer.get("engineVariant"), {})
    if review.get("status", "").startswith("hold"):
        unknown.append("engine_review_requires_verification")
    for rule in model.get("variantConstraints", []):
        if offer.get("engineVariant") not in rule["engines"]:
            continue
        year_conflict = type(year) is int and ((rule.get("yearMin") is not None and year < rule["yearMin"]) or
                                              (rule.get("yearMax") is not None and year > rule["yearMax"]))
        body_conflict = rule.get("bodies") and offer.get("bodyCode") is not None and offer["bodyCode"] not in rule["bodies"]
        if year_conflict or body_conflict:
            unknown.append("variant_configuration_conflict:" + rule["id"])
    if offer.get("transmissionCode") is None:
        unknown.append("transmission")
    elif offer["transmissionCode"] not in requirements["transmissions"]:
        fail.append("transmission_outside_selection")
    camera = offer.get("cameraStatus")
    if camera == "not_installable":
        fail.append("camera_unavailable")
    elif camera == "retrofit_confirmed" and not requirements["camera"]["retrofitAllowed"]:
        fail.append("camera_retrofit_not_allowed")
    elif camera not in ("installed_confirmed", "retrofit_confirmed"):
        unknown.append("camera_or_compatible_retrofit")
    if offer.get("structuralDamageStatus") == "confirmed":
        fail.append("structural_damage")
    elif offer.get("structuralDamageStatus") != "independently_checked_clear":
        unknown.append("structural_history")
    mileage = offer.get("mileage")
    if type(mileage) is int and mileage >= 0:
        if requirements["mileage"]["hardMaxKm"] is not None and mileage > requirements["mileage"]["hardMaxKm"]:
            fail.append("mileage_over_hard_limit")
        if mileage > requirements["mileage"]["preferredMaxKm"]:
            preferences.append("mileage_above_preference")
    else:
        unknown.append("mileage")
    if requirements.get("use", {}).get("strollerAndLuggageRequired", True) and offer.get("familyFitConfirmed") is not True:
        unknown.append("stroller_and_family_fit")
    if offer.get("saleType") == "auction":
        fail.append("auction_not_allowed")
    elif offer.get("saleType") != "fixed_price":
        unknown.append("purchase_not_auction")
    if offer.get("lpgInstalled") is True:
        preferences.append("LPG: potwierdzić dokumenty instalacji, homologację zbiornika i serwis")
    return {"id": offer.get("id"), "modelKey": model["key"],
            "verdict": "fail" if fail else "check" if unknown else "match",
            "failures": fail, "unknowns": unknown, "preferenceNotes": preferences}
