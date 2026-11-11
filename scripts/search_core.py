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


def requirements_for_model(model, defaults):
    """Return the model's frozen criteria, falling back for older snapshots."""
    return model.get("requirements") or defaults


def audit(root=ROOT):
    config = load_config(root)
    issues = []
    for key, filename in [("requirements", "requirements"), ("models", "search-models"), ("sources", "sources")]:
        schema = read(ROOT / "schemas" / f"{filename}-v1.schema.json")
        validation.check_schema(schema)
        validation.validate_schema(config[key], schema, schema, issues, filename)
    if any(i["severity"] == "error" for i in issues):
        return config, issues
    configured_offer_files = set()
    for model in config["models"]["models"]:
        relative = Path(model["offersFile"]).as_posix()
        if relative in configured_offer_files:
            validation.issue(issues, "error", "DUPLICATE_OFFERS_FILE", "config/search-models.json",
                             model["key"], f"Plik ofert jest przypisany więcej niż raz: {relative}")
        configured_offer_files.add(relative)
    actual_offer_files = {f"offers/{path.name}" for path in (root / "offers").glob("*.json")}
    for relative in sorted(configured_offer_files - actual_offer_files):
        validation.issue(issues, "error", "MODEL_OFFERS_MISSING", "config/search-models.json", "",
                         f"Model wskazuje brakujący plik {relative}")
    for relative in sorted(actual_offer_files - configured_offer_files):
        validation.issue(issues, "error", "ORPHAN_OFFERS_FILE", relative, "",
                         "Plik ofert nie ma modelu w config/search-models.json; usuń go lub przywróć konfigurację")
    requirements_schema = read(ROOT / "schemas/requirements-v1.schema.json")
    for model in config["models"]["models"]:
        model_requirements = model.get("requirements")
        if not isinstance(model_requirements, dict):
            validation.issue(issues, "error", "MODEL_REQUIREMENTS", model["key"], "requirements",
                             "Every model must define its own requirements object")
            continue
        validation.validate_schema(model_requirements, requirements_schema, requirements_schema, issues,
                                   model["key"] + ".requirements")
        for exception in model_requirements.get("purchase", {}).get("priceExceptions", []):
            if (exception.get("rule") != "slightly_above_limit_only_for_exceptional_offer" or
                    exception.get("amountPln") is not None or exception.get("userMustConfirm") is not True):
                validation.issue(issues, "error", "UNSUPPORTED_EXCEPTION", model["key"], "requirements",
                                 "Only a manually confirmed, unbounded slight-overage exception is supported")
    for key, collection in [("models", "models"), ("sources", "sources")]:
        ids = [x["key" if key == "models" else "id"] for x in config[key][collection]]
        if len(ids) != len(set(ids)):
            validation.issue(issues, "error", "DUPLICATE", key, "", "Duplicate model/source ID")
    for model in config["models"]["models"]:
        try:
            years = model["searchYears"]
            model_requirements = requirements_for_model(model, config["requirements"])
            if years["max"] is not None and years["max"] < max(years["min"], model_requirements["yearMin"]):
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


def audit_model_index(root=ROOT, config=None):
    """Check that the generated site index lists exactly the configured offer files."""
    config = config or load_config(root)
    issues = []
    index_path = root / "models.json"
    try:
        index = read(index_path)
    except (OSError, ValueError) as exc:
        validation.issue(issues, "error", "MODEL_INDEX_READ", "models.json", "", str(exc))
        return issues
    expected = {model["key"]: Path(model["offersFile"]).as_posix()
                for model in config["models"]["models"]}
    entries = index.get("models", []) if isinstance(index, dict) else []
    entries = entries if isinstance(entries, list) else []
    actual = {}
    for position, entry in enumerate(entries):
        if not isinstance(entry, dict) or not isinstance(entry.get("key"), str):
            continue
        key = entry["key"]
        if key in actual:
            validation.issue(issues, "error", "MODEL_INDEX_DUPLICATE", "models.json",
                             f"/models/{position}/key", f"Powtórzony model w indeksie: {key}")
        actual[key] = entry.get("file")
    for key in sorted(expected.keys() - actual.keys()):
        validation.issue(issues, "error", "MODEL_INDEX_MISSING", "models.json", "",
                         f"Indeks nie zawiera modelu {key}; uruchom `python -B scripts/car-search.py sync`")
    for key in sorted(actual.keys() - expected.keys()):
        validation.issue(issues, "error", "MODEL_INDEX_ORPHAN", "models.json", "",
                         f"Indeks zawiera model {key}, którego nie ma w konfiguracji; uruchom sync")
    for key in sorted(expected.keys() & actual.keys()):
        if actual[key] != expected[key]:
            validation.issue(issues, "error", "MODEL_INDEX_FILE", "models.json", "",
                             f"Model {key} wskazuje {actual[key]!r}, oczekiwano {expected[key]!r}; uruchom sync")
    return issues


def description(requirements, model):
    p = requirements["purchase"]
    years = model["searchYears"]
    age = f"od {max(requirements['yearMin'], years['min'])}"
    if years["max"] is not None:
        age += f" do {years['max']}"
    camera = ("kamera wymagana, obecna lub z potwierdzoną możliwością montażu"
              if requirements["camera"]["required"] and requirements["camera"]["retrofitAllowed"]
              else "kamera wymagana" if requirements["camera"]["required"]
              else "kamera jako preferencja")
    damage = "bez poważnych szkód konstrukcyjnych" if not requirements["structuralDamageAllowed"] else "szkody konstrukcyjne oceniane indywidualnie"
    lpg = ("LPG dopuszczone" + (" i oznaczane" if requirements["lpg"]["mustBeMarked"] else "")
           if requirements["lpg"]["allowed"] else "LPG wykluczone")
    auction = "bez aukcji" if not p["auctionsAllowed"] else "aukcje dopuszczone"
    price_text = f"maks. {p['maxPriceGrossPln']:,} zł brutto według ceny podanej w ogłoszeniu"
    if p["priceExceptions"]:
        price_text += "; niewielkie przekroczenie tylko po ręcznej zgodzie użytkownika"
    family = requirements.get("use", {})
    adults, children = family.get("adults", 0), family.get("children", 0)
    adults_label = "dorosła osoba" if adults == 1 else "dorosłych"
    children_label = "dziecko" if children == 1 else "dzieci"
    family_text = f"{adults} {adults_label} i {children} {children_label}"
    if family.get("strollerAndLuggageRequired", True):
        family_text += "; wymagane miejsce na wózek i bagaż"
    return (f"{model['name']}; {model['legacyEngineSelection']}; rodzina: {family_text}; rocznik {age}; "
            f"{price_text}; "
            f"przebieg do {requirements['mileage']['preferredMaxKm']:,} km preferowany; "
            f"{camera}; {damage}; {lpg}; {auction}."
            ).replace(",", " ")


def assess(offer, requirements, model):
    """Assess structured evidence; never infer facts from arbitrary seller prose."""
    fail, unknown, preferences = [], [], []
    price = offer.get("price")
    gross_price = offer.get("priceBasis") == "gross_total"
    if not gross_price:
        unknown.append("gross_purchase_price")
    if type(price) not in (int, float) or price <= 0:
        unknown.append("purchase_price")
    elif gross_price and price > requirements["purchase"]["maxPriceGrossPln"]:
        if requirements["purchase"]["priceExceptions"]:
            unknown.append("price_exception_requires_user_confirmation")
        else:
            fail.append("price_over_limit")
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
    if camera == "not_installable" and requirements["camera"]["required"]:
        fail.append("camera_unavailable")
    elif camera == "retrofit_confirmed" and not requirements["camera"]["retrofitAllowed"]:
        fail.append("camera_retrofit_not_allowed")
    elif camera not in ("installed_confirmed", "retrofit_confirmed") and requirements["camera"]["required"]:
        unknown.append("camera_or_compatible_retrofit")
    if offer.get("structuralDamageStatus") == "confirmed" and not requirements["structuralDamageAllowed"]:
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
    if offer.get("saleType") == "auction" and not requirements["purchase"]["auctionsAllowed"]:
        fail.append("auction_not_allowed")
    elif offer.get("saleType") not in ("fixed_price", "auction"):
        unknown.append("purchase_not_auction")
    if offer.get("lpgInstalled") is True:
        if not requirements["lpg"]["allowed"]:
            fail.append("lpg_not_allowed")
        else:
            preferences.append("LPG: potwierdzić dokumenty instalacji, homologację zbiornika i serwis")
    return {"id": offer.get("id"), "modelKey": model["key"],
            "verdict": "fail" if fail else "check" if unknown else "match",
            "failures": fail, "unknowns": unknown, "preferenceNotes": preferences}
