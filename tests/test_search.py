"""Behavioral tests for configuration changes, evidence gaps and task ownership."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from search_core import assess, brand_key, load_config, write


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config()
        self.req = self.config["requirements"]
        self.model = self.config["models"]["models"][0]
        self.offer = {"id": "listing:test:1", "price": 55000, "priceBasis": "gross_unconditional_total",
                      "year": 2020, "mileage": 100000, "bodyCode": "wagon",
                      "engineVariant": "1.4-tgdi-140", "transmissionCode": "manual",
                      "cameraStatus": "installed_confirmed", "familyFitConfirmed": True,
                      "saleType": "fixed_price",
                      "structuralDamageStatus": "independently_checked_clear"}

    def evaluate(self):
        return assess(self.offer, self.req, self.model)

    def test_budget_boundary_and_edit(self):
        self.req["purchase"]["priceExceptions"] = []
        self.assertEqual(self.evaluate()["verdict"], "match")
        self.offer["price"] = 55001
        self.assertEqual(self.evaluate()["verdict"], "fail")
        self.req["purchase"]["maxPriceGrossPln"] = 56000
        self.assertEqual(self.evaluate()["verdict"], "match")

    def test_unknown_does_not_pass(self):
        self.req["purchase"]["priceExceptions"] = []
        del self.offer["cameraStatus"]
        self.assertEqual(self.evaluate()["verdict"], "check")
        self.offer["price"] = 60000
        self.assertEqual(self.evaluate()["verdict"], "fail")

    def test_brand_aliases_and_retrofit_setting(self):
        self.assertEqual(brand_key("SEAT"), brand_key("Seat"))
        self.assertEqual(brand_key("Škoda"), brand_key("Skoda"))
        self.offer["cameraStatus"] = "retrofit_confirmed"
        self.req["camera"]["retrofitAllowed"] = False
        self.assertEqual(self.evaluate()["verdict"], "fail")

    def test_auction_excluded_and_lpg_marked(self):
        self.offer["lpgInstalled"] = True
        self.assertTrue(any("LPG" in note for note in self.evaluate()["preferenceNotes"]))
        self.offer["saleType"] = "auction"
        self.assertEqual(self.evaluate()["verdict"], "fail")

    def test_high_mileage_preference_and_hard_limit(self):
        self.req["mileage"]["hardMaxKm"] = None  # Exercise preference independently of the live hard limit.
        self.offer["mileage"] = 180000
        self.assertEqual(self.evaluate()["verdict"], "match")
        self.assertIn("mileage_above_preference", self.evaluate()["preferenceNotes"])
        self.req["mileage"]["hardMaxKm"] = 170000
        self.assertEqual(self.evaluate()["verdict"], "fail")

    def test_seller_claim_not_independent_confirmation(self):
        self.offer["structuralDamageStatus"] = "seller_declared_clear"
        self.assertEqual(self.evaluate()["verdict"], "check")

    def test_exact_variant_and_price_conditions(self):
        self.offer["engineVariant"] = "unknown-variant"
        self.assertEqual(self.evaluate()["verdict"], "fail")
        self.offer["engineVariant"] = "1.4-tgdi-140"
        self.offer["priceBasis"] = "net"
        self.assertEqual(self.evaluate()["verdict"], "check")

    def test_corolla_has_no_hidden_budget_exception(self):
        self.req["purchase"]["priceExceptions"] = []
        model = next(m for m in self.config["models"]["models"] if m["key"] == "toyota-corolla-e210")
        self.offer["price"] = 59000
        self.assertIn("price_over_limit", assess(self.offer, self.req, model)["failures"])

    def test_impossible_variant_does_not_pass_model_wide_year_filter(self):
        model = next(m for m in self.config["models"]["models"] if m["key"] == "volkswagen-golf-vii-variant")
        self.offer["year"] = 2020
        self.offer["engineVariant"] = "1.4-tsi-ea211-150"
        result = assess(self.offer, self.req, model)
        self.assertEqual(result["verdict"], "fail")
        self.assertIn("year_outside_selection", result["failures"])
        self.assertTrue(any(x.startswith("variant_configuration_conflict:") for x in result["unknowns"]))

    def test_configured_price_exception_requires_manual_decision(self):
        self.offer["price"] = 55001
        self.assertEqual(self.evaluate()["verdict"], "check")
        self.assertIn("price_exception_requires_user_confirmation", self.evaluate()["unknowns"])

    def test_held_variant_is_not_automatically_approved(self):
        self.offer["engineVariant"] = "1.4-mpi-100"
        result = self.evaluate()
        self.assertEqual(result["verdict"], "check")
        self.assertIn("engine_review_requires_verification", result["unknowns"])

    def test_plan_snapshot_claim_ownership_and_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            import shutil
            for folder in ("config", "knowledge", "offers"):
                shutil.copytree(ROOT / folder, root / folder)
            def cli(*args):
                return subprocess.run([sys.executable, "-B", str(ROOT / "scripts/car-search.py"),
                                       *args, "--root", str(root)], capture_output=True, text=True)
            args = ("plan", "--run", "test", "--model", self.model["key"], "--source", "otomoto", "--source", "olx")
            result = cli(*args)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotEqual(cli(*args).returncode, 0)  # Existing run cannot be overwritten.
            snapshot = (root / "runs/test/snapshot.json").read_bytes()
            req = copy.deepcopy(self.req)
            req["purchase"]["maxPriceGrossPln"] = 50000
            req["yearMin"] = 2030  # Invalid for current models, should not block snapshot-based work.
            write(root / "config/requirements.json", req)
            a = cli("claim", "--run", "test", "--worker", "a")
            self.assertEqual(a.returncode, 0, a.stderr)
            task = json.loads(a.stdout)
            self.assertNotEqual(cli("claim", "--run", "test", "--worker", "a").returncode, 0)
            b = cli("claim", "--run", "test", "--worker", "b")
            self.assertNotEqual(task["id"], json.loads(b.stdout)["id"])
            result = {"taskId": task["id"], "outcome": "partial", "offers": [], "coverage": {"pagesChecked": 1}}
            write(root / "runs/test/results" / (task["id"] + ".json"), result)
            done = cli("finish", "--run", "test", "--task", task["id"], "--result", "complete")
            self.assertNotEqual(done.returncode, 0)  # Cannot claim full completion for partial evidence.
            done = cli("finish", "--run", "test", "--task", task["id"], "--result", "partial")
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(snapshot, (root / "runs/test/snapshot.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
