#!/usr/bin/env python3
"""Read-only CarOffers validation, Python 3.10+, standard library only."""
import argparse
from collections import Counter
from datetime import date
import ipaddress
import json
import math
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "schemas"
VIN = re.compile(r"[A-HJ-NPR-Z0-9]{17}", re.I)


def valid_url(value):
    """HTTP(S) URL syntax only; never performs network requests."""
    if not isinstance(value, str) or re.search(r'[\s\x00-\x20\x7f\\<>"{}|^`]', value):
        return False
    if re.search(r"%(?![0-9a-fA-F]{2})", value):
        return False
    try:
        u = urlsplit(value)
        if u.scheme not in ("http", "https") or not u.netloc or not u.hostname:
            return False
        if u.username is not None or u.password is not None:
            return False
        if u.port is not None and not 1 <= u.port <= 65535:
            return False
        host = u.hostname
        try:
            ipaddress.ip_address(host)
            return True
        except ValueError:
            host = host.encode("idna").decode("ascii").rstrip(".")
            return len(host) <= 253 and all(
                re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", label)
                for label in host.split(".")
            )
    except (ValueError, UnicodeError):
        return False


def valid_date(value):
    try:
        return bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)) and bool(date.fromisoformat(value))
    except (ValueError, TypeError):
        return False


def issue(issues, severity, code, file, path, message):
    issues.append(dict(severity=severity, code=code, file=str(file), path=path, message=message))


def pointer(path, key):
    return path + "/" + str(key).replace("~", "~0").replace("/", "~1")


def matches_type(value, kind):
    numeric = type(value) in (int, float)
    return {
        "null": value is None,
        "boolean": type(value) is bool,
        "string": isinstance(value, str),
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "number": numeric and (type(value) is int or math.isfinite(value)),
        "integer": numeric and (type(value) is int or (math.isfinite(value) and value.is_integer())),
    }[kind]


# Deliberately bounded JSON Schema evaluator. Reject unsupported schema keywords
# rather than silently skipping constraints when a schema is extended.
KEYWORDS = {"$schema", "$defs", "$ref", "title", "description", "type", "required",
            "properties", "additionalProperties", "items", "minItems", "minLength",
            "minimum", "maximum", "pattern", "format", "enum", "const"}


def check_schema(schema, root=None):
    root = schema if root is None else root
    unsupported = set(schema) - KEYWORDS
    if unsupported:
        raise ValueError("Nieobsługiwane słowa schematu: " + ", ".join(sorted(unsupported)))
    if "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/$defs/") or ref[8:] not in root.get("$defs", {}):
            raise ValueError("Nieobsługiwana referencja schematu: " + ref)
    if "format" in schema and schema["format"] not in ("date", "uri"):
        raise ValueError("Nieobsługiwany format: " + schema["format"])
    if "pattern" in schema:
        re.compile(schema["pattern"])
    for key in ("$defs", "properties"):
        for child in schema.get(key, {}).values():
            check_schema(child, root)
    for key in ("items", "additionalProperties"):
        if isinstance(schema.get(key), dict):
            check_schema(schema[key], root)


def validate_schema(value, schema, root, issues, file, path=""):
    if "$ref" in schema:
        validate_schema(value, root["$defs"][schema["$ref"][8:]], root, issues, file, path)
        # Siblings of $ref also apply in draft 2020-12.
    def error(code, message):
        issue(issues, "error", code, file, path, message)
    kinds = schema.get("type", [])
    kinds = [kinds] if isinstance(kinds, str) else kinds
    if kinds and not any(matches_type(value, kind) for kind in kinds):
        error("TYPE", "Oczekiwany typ: " + "/".join(kinds))
        return
    if "const" in schema and value != schema["const"]:
        error("CONST", f"Wymagana wartość: {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        error("ENUM", "Niedopuszczalna wartość")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            error("MIN_LENGTH", "Tekst jest za krótki")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            error("PATTERN", "Tekst nie odpowiada wymaganemu formatowi")
        if schema.get("format") == "date" and not valid_date(value):
            error("DATE", "Wymagana poprawna data YYYY-MM-DD")
        if schema.get("format") == "uri" and not valid_url(value):
            error("URL", "Niepoprawny bezwzględny URL HTTP(S), host, port lub kodowanie")
    if type(value) in (int, float):
        if "minimum" in schema and value < schema["minimum"]:
            error("MINIMUM", f"Wartość mniejsza niż {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            error("MAXIMUM", f"Wartość większa niż {schema['maximum']}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            error("MIN_ITEMS", "Tablica jest za krótka")
        if "items" in schema:
            for i, item in enumerate(value):
                validate_schema(item, schema["items"], root, issues, file, pointer(path, i))
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                issue(issues, "error", "REQUIRED", file, pointer(path, key), "Brak wymaganego pola")
        props = schema.get("properties", {})
        for key, item in value.items():
            if key in props:
                validate_schema(item, props[key], root, issues, file, pointer(path, key))
            else:
                extra = schema.get("additionalProperties", True)
                if isinstance(extra, dict):
                    validate_schema(item, extra, root, issues, file, pointer(path, key))
                elif extra is False:
                    issue(issues, "error", "EXTRA_FIELD", file, pointer(path, key), "Niedopuszczalne pole")
                elif "properties" in schema:
                    issue(issues, "warning", "UNKNOWN_FIELD", file, pointer(path, key), "Pole spoza opisanego kontraktu; zachowano kompatybilność")


class DuplicateMember(ValueError):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateMember(f"Powtórzona nazwa pola JSON: {key}")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError("Niedopuszczalna stała JSON: " + value)


def read_json(path, label, issues):
    try:
        data = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object,
                          parse_constant=reject_constant)
        if data is None:
            raise ValueError("Dokument nie może być null; wymagany obiekt")
        return data
    except (OSError, UnicodeError, ValueError, RecursionError) as exc:
        issue(issues, "error", "JSON", label, "", str(exc))
        return None


def canonical_url(value):
    # Retain query and case-sensitive path: query can identify the listing.
    u = urlsplit(value)
    host = u.hostname.lower().removeprefix("www.")
    port = u.port
    if port and (u.scheme, port) not in (("https", 443), ("http", 80)):
        host += ":" + str(port)
    return host + u.path.rstrip("/") + ("?" + u.query if u.query else "")


def audit_repository(root, today=None, schema_dir=SCHEMAS):
    root = Path(root)
    today = today or date.today()
    issues = []
    schemas = {}
    for name in ("offers-v2", "models-v1"):
        schema = read_json(Path(schema_dir) / (name + ".schema.json"), "schemas/" + name, issues)
        if schema is not None:
            try:
                check_schema(schema)
                schemas[name] = schema
            except (ValueError, TypeError, KeyError) as exc:
                issue(issues, "error", "SCHEMA", "schemas/" + name, "", str(exc))
    if len(schemas) != 2:
        return make_report(0, 0, 0, issues)

    index = read_json(root / "models.json", "models.json", issues)
    if index is not None:
        validate_schema(index, schemas["models-v1"], schemas["models-v1"], issues, "models.json")
    entries = index.get("models", []) if isinstance(index, dict) else []
    entries = entries if isinstance(entries, list) else []
    indexed = {}
    indexed_files = {}
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        for field, seen in (("key", indexed), ("file", indexed_files)):
            value = entry.get(field)
            if not isinstance(value, str):
                continue
            if value in seen:
                issue(issues, "error", "DUPLICATE_MODEL", "models.json", f"/models/{i}/{field}", f"Powtórzone {field}: {value}")
            seen[value] = entry

    paths = sorted((root / "offers").glob("*.json"))
    if not paths:
        issue(issues, "error", "NO_FILES", "offers", "", "Brak plików offers/*.json")
    actual_files = {"offers/" + p.name for p in paths}
    for name in indexed_files:
        if name not in actual_files:
            issue(issues, "error", "INDEX_FILE", "models.json", "", f"Indeks wskazuje nieistniejący plik: {name}")
    ids, identities, model_keys = {}, {}, {}
    count, archived_count = 0, 0
    for path in paths:
        label = "offers/" + path.name
        data = read_json(path, label, issues)
        if data is None:
            continue
        validate_schema(data, schemas["offers-v2"], schemas["offers-v2"], issues, label)
        if not isinstance(data, dict):
            continue
        model = data.get("model")
        model = model if isinstance(model, dict) else {}
        key = model.get("key")
        if key != path.stem:
            issue(issues, "error", "MODEL_FILENAME", label, "/model/key", "model.key musi odpowiadać nazwie pliku")
        if isinstance(key, str):
            if key in model_keys:
                issue(issues, "error", "DUPLICATE_MODEL", label, "/model/key", "Model występuje już w " + model_keys[key])
            model_keys[key] = label
        meta = indexed_files.get(label)
        if meta is None:
            issue(issues, "error", "INDEX_MISSING", label, "/model", "Pliku brakuje w models.json")
        else:
            for field, default in (("key", None), ("name", None), ("description", ""), ("requirements", None)):
                if meta.get(field, default) != model.get(field, default):
                    issue(issues, "error", "INDEX_MISMATCH", label, "/model/" + field, "Wartość różni się od models.json")
        if valid_date(data.get("updatedAt")) and date.fromisoformat(data["updatedAt"]) > today:
            issue(issues, "warning", "FUTURE_DATE", label, "/updatedAt", "Data aktualizacji jest w przyszłości")
        offers = data.get("offers")
        if not isinstance(offers, list):
            continue
        count += len(offers)
        for i, offer in enumerate(offers):
            if not isinstance(offer, dict):
                continue
            at = f"/offers/{i}"
            def warn(code, field, message):
                location = at
                for segment in field.split("/"):
                    location = pointer(location, segment)
                issue(issues, "warning", code, label, location, message)
            if "modelKey" not in offer:
                warn("UNKNOWN_MODEL_KEY", "modelKey", "Brak opcjonalnego modelKey; model wynika z pliku")
            elif offer["modelKey"] != key:
                issue(issues, "error", "MODEL_KEY", label, at + "/modelKey", "modelKey różni się od model.key")
            for field in ("year", "price", "mileage", "vin"):
                if offer.get(field) is None:
                    warn("UNKNOWN_VALUE", field, "Brak danych; nie jest to błąd krytyczny")
            if offer.get("price") == 0 and type(offer.get("price")) in (int, float):
                warn("ZERO_PRICE", "price", "Cena 0 wymaga potwierdzenia; brak ceny zapisuj jako null")
            year = offer.get("year")
            if type(year) in (int, float) and year > today.year + 1:
                warn("FUTURE_YEAR", "year", "Rocznik dalszy niż następny rok wymaga sprawdzenia")
            if "verdict" not in offer or offer.get("verdict") == "review":
                warn("LEGACY_VERDICT", "verdict", "Brak oceny lub alias review; preferowane check")
            oid = offer.get("id")
            if isinstance(oid, str):
                folded = oid.lower()  # Same identity convention as app.js.
                if folded in ids:
                    issue(issues, "error", "DUPLICATE_ID", label, at + "/id", "ID występuje już w " + ids[folded])
                else:
                    ids[folded] = label + at
                if oid.startswith("url:"):
                    if not valid_url(oid[4:]):
                        issue(issues, "error", "URL_ID", label, at + "/id", "ID zawiera niepoprawny URL")
                    warn("LEGACY_URL_ID", "id", "Historyczne ID oparte na URL; zachowano")
                if oid.startswith("vin:"):
                    vin = offer.get("vin")
                    if isinstance(vin, str) and oid[4:].upper() != vin.upper():
                        issue(issues, "error", "VIN_ID_MISMATCH", label, at + "/vin", "VIN różni się od VIN zawartego w ID")
                    elif vin is None:
                        warn("VIN_ID_WITHOUT_VIN", "vin", "ID zawiera VIN, ale pole vin jest nieznane")
            local_keys = set()
            vin = offer.get("vin")
            if isinstance(vin, str) and VIN.fullmatch(vin):
                local_keys.add("vin:" + vin.upper())
            listing_ids = offer.get("listingIds", [])
            if isinstance(listing_ids, list):
                seen_listing = set()
                for j, lid in enumerate(listing_ids):
                    if not isinstance(lid, str):
                        continue
                    if lid.lower() in seen_listing:
                        warn("REPEATED_LISTING_ID", f"listingIds/{j}", "Powtórzony identyfikator wewnątrz oferty")
                    seen_listing.add(lid.lower())
                    if ":" not in lid:
                        warn("LEGACY_LISTING_ID", f"listingIds/{j}", "Brak przestrzeni nazw portalu; historyczny format")
                    local_keys.add("listing:" + lid.lower())
            urls = offer.get("urls", [])
            if isinstance(urls, list):
                if not urls:
                    warn("NO_LINKS", "urls", "Historyczny rekord bez linku")
                seen_urls = set()
                for j, link in enumerate(urls):
                    if not isinstance(link, dict):
                        continue
                    for field in ("url", "normalized"):
                        value = link.get(field)
                        if valid_url(value):
                            local_keys.add("url:" + canonical_url(value))
                            if value.startswith("http:"):
                                warn("HTTP_LINK", f"urls/{j}/{field}", "Poprawny HTTP, ale frontend otwiera wyłącznie HTTPS")
                    value = link.get("url")
                    if valid_url(value):
                        canonical = canonical_url(value)
                        if canonical in seen_urls:
                            warn("REPEATED_URL", f"urls/{j}/url", "Powtórzony URL wewnątrz oferty")
                        seen_urls.add(canonical)
            for identity in sorted(local_keys):
                if identity in identities:
                    warn("SHARED_IDENTITY", "id", f"Wspólny identyfikator {identity!r} z {identities[identity]}; kandydat do scalenia")
                else:
                    identities[identity] = label + at
        archived = data.get("archivedOffers", [])
        if isinstance(archived, list):
            archived_count += len(archived)
            for i, offer in enumerate(archived):
                if not isinstance(offer, dict):
                    continue
                at = f"/archivedOffers/{i}"
                archive_meta = offer.get("archive")
                archive_date = archive_meta.get("archivedAt") if isinstance(archive_meta, dict) else None
                if (not isinstance(archive_meta, dict) or archive_meta.get("status") != "closed" or
                        not archive_meta.get("reason") or not isinstance(archive_date, str) or
                        not valid_date(archive_date[:10])):
                    issue(issues, "error", "ARCHIVE_METADATA", label, at + "/archive",
                          "Rekord archiwalny wymaga statusu closed, przyczyny i daty archiwizacji")
                oid = offer.get("id")
                if isinstance(oid, str):
                    folded = oid.lower()
                    if folded in ids:
                        issue(issues, "error", "DUPLICATE_ID", label, at + "/id", "ID występuje już w " + ids[folded])
                    else:
                        ids[folded] = label + at
                local_keys = set()
                vin = offer.get("vin")
                if isinstance(vin, str) and VIN.fullmatch(vin):
                    local_keys.add("vin:" + vin.upper())
                for listing_id in offer.get("listingIds", []):
                    if isinstance(listing_id, str):
                        local_keys.add("listing:" + listing_id.lower())
                for link in offer.get("urls", []):
                    if isinstance(link, dict) and valid_url(link.get("url")):
                        local_keys.add("url:" + canonical_url(link["url"]))
                for identity in sorted(local_keys):
                    if identity in identities:
                        issue(issues, "warning", "SHARED_IDENTITY", label, at + "/id",
                              f"Wspólny identyfikator {identity!r} z {identities[identity]}; kandydat do scalenia")
                    else:
                        identities[identity] = label + at
    return make_report(len(paths), count, archived_count, issues)


def make_report(files, offers, archived, issues):
    return {"files": files, "offers": offers, "archivedOffers": archived,
            "errors": sum(i["severity"] == "error" for i in issues),
            "warnings": sum(i["severity"] == "warning" for i in issues), "issues": issues}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="Katalog danych (domyślnie repozytorium)")
    parser.add_argument("--json", action="store_true", help="Raport JSON na stdout")
    parser.add_argument("--strict", action="store_true", help="Także ostrzeżenia dają kod wyjścia 1")
    args = parser.parse_args(argv)
    report = audit_repository(args.root)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"Pliki ofert: {report['files']}; aktywne oferty: {report['offers']}; archiwum: {report['archivedOffers']}; błędy: {report['errors']}; ostrzeżenia: {report['warnings']}")
        for item in report["issues"]:
            print(f"{item['severity'].upper()} {item['code']} {item['file']}#{item['path']}: {item['message']}")
        print("Kategorie: " + json.dumps(dict(sorted(Counter(i['code'] for i in report['issues']).items())), ensure_ascii=False))
    return int(bool(report["errors"] or (args.strict and report["warnings"])))


if __name__ == "__main__":
    sys.exit(main())
