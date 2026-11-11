"""Regression tests: temporary fixtures only, no writes to production data."""
import copy
from datetime import date
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("validate_offers", ROOT / "scripts/validate-offers.py")
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)


def document(key="test-model"):
    return {
        "version": 2, "updatedAt": "2026-11-07",
        "model": {"key": key, "name": "Model testowy", "description": "Kombi", "requirements": None},
        "offers": [{"id": "listing:portal:123", "modelKey": key,
                    "title": "Samochód", "vin": "U5YH5814GLL068044",
                    "listingIds": ["portal:123"],
                    "urls": [{"url": "https://example.com/offer?id=123"}],
                    "price": 50000, "mileage": 100000, "year": 2020, "verdict": "check"}]
    }


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "offers").mkdir()
        self.doc = document()

    def write(self, docs=None, index=None):
        docs = docs or [self.doc]
        for d in docs:
            path = self.root / "offers" / (d["model"]["key"] + ".json")
            path.write_text(json.dumps(d), encoding="utf-8")
        if index is None:
            index = {"version": 1, "models": [dict(d["model"], file="offers/" + d["model"]["key"] + ".json") for d in docs]}
        (self.root / "models.json").write_text(json.dumps(index), encoding="utf-8")

    def audit(self, docs=None):
        self.write(docs)
        return validator.audit_repository(self.root, today=date(2026, 11, 8))

    def assertCode(self, report, code, severity="error"):
        self.assertTrue(any(i["code"] == code and i["severity"] == severity for i in report["issues"]), report)

    def test_valid_document(self):
        r = self.audit()
        self.assertEqual((r["errors"], r["warnings"], r["offers"]), (0, 0, 1))

    def test_seller_classification_and_first_registration_date_are_in_contract(self):
        offer = self.doc["offers"][0]
        offer["offerType"] = "company"
        offer["firstRegistrationDate"] = "2020-04-15"
        self.assertEqual(self.audit()["errors"], 0)

        offer["offerType"] = "dealer"
        self.assertCode(self.audit(), "ENUM")

        offer["offerType"] = "company"
        offer["firstRegistrationDate"] = "15.04.2020"
        self.assertCode(self.audit(), "DATE")

    def test_publication_date_is_optional_and_must_be_a_calendar_date(self):
        offer = self.doc["offers"][0]
        offer["publicationDate"] = "2026-11-07"
        self.assertEqual(self.audit()["errors"], 0)
        offer["publicationDate"] = "wczoraj"
        self.assertCode(self.audit(), "DATE")

    def test_invalid_prices(self):
        for price in ("50000", -1, True, [], {}):
            with self.subTest(price=price):
                self.doc["offers"][0]["price"] = price
                self.assertGreater(self.audit()["errors"], 0)

    def test_decimal_price_valid(self):
        self.doc["offers"][0]["price"] = 50000.50
        self.assertEqual(self.audit()["errors"], 0)

    def test_zero_price_warning(self):
        self.doc["offers"][0]["price"] = 0
        r = self.audit()
        self.assertEqual(r["errors"], 0)
        self.assertCode(r, "ZERO_PRICE", "warning")

    def test_invalid_numeric_parameters(self):
        for key, value in (("mileage", -1), ("mileage", 12.5), ("mileage", "100"),
                           ("mileage", False), ("year", "2020"), ("year", 2020.5),
                           ("year", True), ("year", 1800), ("year", 2101)):
            with self.subTest(key=key, value=value):
                self.doc = document()
                self.doc["offers"][0][key] = value
                self.assertGreater(self.audit()["errors"], 0)

    def test_missing_required_offer_fields(self):
        for key in ("id", "title", "urls"):
            with self.subTest(key=key):
                self.doc = document()
                del self.doc["offers"][0][key]
                self.assertCode(self.audit(), "REQUIRED")

    def test_missing_required_envelope_field(self):
        del self.doc["updatedAt"]
        self.assertCode(self.audit(), "REQUIRED")

    def test_unknown_historical_parameters(self):
        o = self.doc["offers"][0]
        for key in ("vin", "price", "year", "mileage", "engine", "specs", "details", "modelKey", "listingIds", "verdict"):
            o.pop(key, None)
        o["urls"] = []
        r = self.audit()
        self.assertEqual(r["errors"], 0)
        self.assertCode(r, "UNKNOWN_VALUE", "warning")
        self.assertCode(r, "NO_LINKS", "warning")

    def test_null_parameters(self):
        for field in ("vin", "price", "year", "mileage", "engine", "body", "seller", "priority"):
            self.doc["offers"][0][field] = None
        r = self.audit()
        self.assertEqual(r["errors"], 0)
        self.assertCode(r, "UNKNOWN_VALUE", "warning")

    def test_null_containers_rejected(self):
        for field in ("urls", "listingIds", "specs", "details"):
            with self.subTest(field=field):
                self.doc = document()
                self.doc["offers"][0][field] = None
                self.assertCode(self.audit(), "TYPE")

    def test_duplicate_id_same_file_case_insensitive(self):
        second = copy.deepcopy(self.doc["offers"][0])
        second["id"] = second["id"].upper()
        self.doc["offers"].append(second)
        self.assertCode(self.audit(), "DUPLICATE_ID")

    def test_duplicate_id_between_files(self):
        other = document("other-model")
        self.assertCode(self.audit([self.doc, other]), "DUPLICATE_ID")

    def test_invalid_id(self):
        for oid in ("", "123", "listing:", "listing:portal:", "listing:p::1", "listing:bad id", "vin:BAD", None, 123):
            with self.subTest(oid=oid):
                self.doc["offers"][0]["id"] = oid
                self.assertGreater(self.audit()["errors"], 0)

    def test_legacy_identifiers(self):
        self.doc["offers"][0]["id"] = "url:https://example.com/offer/123"
        self.doc["offers"][0]["listingIds"] = ["ID6Ij4Tq"]
        r = self.audit()
        self.assertEqual(r["errors"], 0)
        self.assertCode(r, "LEGACY_URL_ID", "warning")
        self.assertCode(r, "LEGACY_LISTING_ID", "warning")

    def test_invalid_urls(self):
        for url in ("/offer/1", "javascript:alert(1)", "https://", "https://bad host/x",
                    "https://example.com:99999/x", "https://example.com:abc/x",
                    "https://user:password@example.com/x", "https://example.com/\\x",
                    "https://example.com/%ZZ", "https://-bad.com/x", "https://example.com/<x>", None, 42):
            with self.subTest(url=url):
                self.doc["offers"][0]["urls"] = [{"url": url}]
                self.assertGreater(self.audit()["errors"], 0)

    def test_invalid_normalized_url(self):
        self.doc["offers"][0]["urls"][0]["normalized"] = "bad"
        self.assertCode(self.audit(), "URL")

    def test_http_is_warning(self):
        self.doc["offers"][0]["urls"] = [{"url": "http://example.com/123"}]
        r = self.audit()
        self.assertEqual(r["errors"], 0)
        self.assertCode(r, "HTTP_LINK", "warning")

    def test_url_id_validates_embedded_url(self):
        self.doc["offers"][0]["id"] = "url:https://example.com:bad/offer"
        self.assertCode(self.audit(), "URL_ID")

    def test_query_identifies_distinct_listings(self):
        second = copy.deepcopy(self.doc["offers"][0])
        second.update(id="listing:portal:456", vin=None, listingIds=["portal:456"],
                      urls=[{"url": "https://example.com/offer?id=456"}])
        self.doc["offers"].append(second)
        r = self.audit()
        self.assertFalse(any(i["code"] == "SHARED_IDENTITY" for i in r["issues"]), r)

    def test_shared_vin_listing_url_are_warnings(self):
        second = copy.deepcopy(self.doc["offers"][0])
        second["id"] = "listing:other:456"
        self.doc["offers"].append(second)
        r = self.audit()
        self.assertEqual(r["errors"], 0)
        self.assertEqual(sum(i["code"] == "SHARED_IDENTITY" for i in r["issues"]), 3)

    def test_invalid_vin(self):
        for vin in ("", "UNKNOWN", "U5YH5814GLL06804I", "U5YH5814GLL06804O", "U5YH5814GLL06804Q", 123):
            with self.subTest(vin=vin):
                self.doc["offers"][0]["vin"] = vin
                self.assertGreater(self.audit()["errors"], 0)

    def test_vin_id_conflict(self):
        self.doc["offers"][0]["id"] = "vin:U5YH5814ALL079976"
        self.assertCode(self.audit(), "VIN_ID_MISMATCH")

    def test_lowercase_vin_accepted(self):
        self.doc["offers"][0]["vin"] = "u5yh5814gll068044"
        self.assertEqual(self.audit()["errors"], 0)

    def test_model_key_mismatch(self):
        self.doc["offers"][0]["modelKey"] = "other-model"
        self.assertCode(self.audit(), "MODEL_KEY")

    def test_filename_mismatch(self):
        self.write()
        (self.root / "offers/test-model.json").rename(self.root / "offers/other.json")
        self.assertCode(validator.audit_repository(self.root), "MODEL_FILENAME")

    def test_index_metadata_mismatch(self):
        self.write()
        index = json.loads((self.root / "models.json").read_text())
        index["models"][0]["requirements"] = "Inne wymagania"
        (self.root / "models.json").write_text(json.dumps(index))
        self.assertCode(validator.audit_repository(self.root), "INDEX_MISMATCH")

    def test_index_missing_and_dangling_entry(self):
        self.write(index={"version": 1, "models": [{"key": "other-model", "name": "Inny", "file": "offers/other-model.json"}]})
        r = validator.audit_repository(self.root)
        self.assertCode(r, "INDEX_MISSING")
        self.assertCode(r, "INDEX_FILE")

    def test_duplicate_index(self):
        m = dict(self.doc["model"], file="offers/test-model.json")
        self.write(index={"version": 1, "models": [m, m]})
        self.assertCode(validator.audit_repository(self.root), "DUPLICATE_MODEL")

    def test_wrong_version_and_verdict(self):
        self.doc["version"] = 3
        self.doc["offers"][0]["verdict"] = "good"
        r = self.audit()
        self.assertCode(r, "CONST")
        self.assertCode(r, "ENUM")

    def test_review_alias(self):
        self.doc["offers"][0]["verdict"] = "review"
        r = self.audit()
        self.assertEqual(r["errors"], 0)
        self.assertCode(r, "LEGACY_VERDICT", "warning")

    def test_invalid_date(self):
        self.doc["updatedAt"] = "2026-02-30"
        self.assertCode(self.audit(), "DATE")

    def test_unknown_field_warning(self):
        self.doc["offers"][0]["futureExtension"] = {"x": 1}
        r = self.audit()
        self.assertEqual(r["errors"], 0)
        self.assertCode(r, "UNKNOWN_FIELD", "warning")

    def test_duplicate_json_member(self):
        self.write()
        (self.root / "offers/test-model.json").write_text('{"version": 2, "version": 3}')
        self.assertCode(validator.audit_repository(self.root), "JSON")

    def test_invalid_json_and_nonfinite_values(self):
        for contents in ("{broken", "null", '{"price": NaN}', '{"price": Infinity}',
                         '{"price": -Infinity}'):
            with self.subTest(contents=contents):
                self.write()
                (self.root / "offers/test-model.json").write_text(contents)
                self.assertCode(validator.audit_repository(self.root), "JSON")

    def test_overflowing_json_number(self):
        self.write()
        path = self.root / "offers/test-model.json"
        path.write_text(path.read_text().replace('"price": 50000', '"price": 1e999'))
        self.assertCode(validator.audit_repository(self.root), "TYPE")

    def test_no_files(self):
        self.write()
        (self.root / "offers/test-model.json").unlink()
        self.assertCode(validator.audit_repository(self.root), "NO_FILES")

    def test_missing_index(self):
        self.write()
        (self.root / "models.json").unlink()
        self.assertCode(validator.audit_repository(self.root), "JSON")

    def test_schema_unknown_keyword_fails_closed(self):
        with self.assertRaises(ValueError):
            validator.check_schema({"type": "string", "not": {"const": "bad"}})

    def test_cli_exit_codes_and_json(self):
        self.write()
        cmd = [sys.executable, "-B", str(ROOT / "scripts/validate-offers.py"), "--root", str(self.root), "--json"]
        good = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(good.returncode, 0, good.stderr)
        self.assertEqual(json.loads(good.stdout)["errors"], 0)
        self.doc["offers"][0]["vin"] = None
        self.write()
        self.assertEqual(subprocess.run(cmd, capture_output=True).returncode, 0)
        self.assertEqual(subprocess.run(cmd + ["--strict"], capture_output=True).returncode, 1)
        self.doc["offers"][0]["price"] = "bad"
        self.write()
        self.assertEqual(subprocess.run(cmd, capture_output=True).returncode, 1)

    def test_production_data_and_schemas(self):
        r = validator.audit_repository(ROOT, today=date(2026, 11, 8))
        self.assertEqual(r["errors"], 0, r)
        paths = list((ROOT / "offers").glob("*.json"))
        self.assertEqual(r["files"], len(paths))
        self.assertEqual(r["offers"], sum(len(json.loads(p.read_text(encoding="utf-8"))["offers"]) for p in paths))

    def test_numbers_outside_frontend_safe_range(self):
        for field in ("price", "mileage"):
            with self.subTest(field=field):
                self.doc = document()
                self.doc["offers"][0][field] = 10 ** 400
                self.assertCode(self.audit(), "MAXIMUM")


if __name__ == "__main__":
    unittest.main()
