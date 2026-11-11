"""Behavioral tests for configuration changes, evidence gaps and task ownership."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from search_core import assess, brand_key, load_config, read, write

car_search_spec = importlib.util.spec_from_file_location("car_search_cli", ROOT / "scripts/car-search.py")
car_search_cli = importlib.util.module_from_spec(car_search_spec)
car_search_spec.loader.exec_module(car_search_cli)


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config()
        self.model = self.config["models"]["models"][0]
        self.req = self.model["requirements"]
        self.offer = {"id": "listing:test:1", "price": 55000, "priceBasis": "gross_total",
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

    def test_financing_conditions_do_not_change_gross_price_assessment(self):
        self.offer["priceBasis"] = "gross_total"
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
        self.assertIn("gross_purchase_price", self.evaluate()["unknowns"])

    def test_corolla_has_no_hidden_budget_exception(self):
        model = next(m for m in self.config["models"]["models"] if m["key"] == "toyota-corolla-e210")
        model["requirements"]["purchase"]["priceExceptions"] = []
        self.offer["price"] = 59000
        self.assertIn("price_over_limit", assess(self.offer, model["requirements"], model)["failures"])

    def test_variant_constraint_is_reported_inside_model_year_range(self):
        model = next(m for m in self.config["models"]["models"] if m["key"] == "toyota-corolla-e210")
        self.offer["year"] = 2021
        self.offer["bodyCode"] = "sedan"
        self.offer["engineVariant"] = "1.6-valvematic-132"
        result = assess(self.offer, model["requirements"], model)
        self.assertNotIn("year_outside_selection", result["failures"])
        self.assertEqual(result["verdict"], "check")
        self.assertTrue(any(x.startswith("variant_configuration_conflict:") for x in result["unknowns"]))

    def test_configured_price_exception_requires_manual_decision(self):
        self.offer["price"] = 55001
        self.assertEqual(self.evaluate()["verdict"], "check")
        self.assertIn("price_exception_requires_user_confirmation", self.evaluate()["unknowns"])

    def test_each_model_owns_its_requirements_and_template_is_not_authoritative(self):
        template = {key: value for key, value in self.config["requirements"].items() if key != "purpose"}
        models = self.config["models"]["models"]
        for model in models:
            self.assertIsInstance(model.get("requirements"), dict)
            self.assertIsNot(model["requirements"], template)
        model_with_different_year = next(model for model in models
                                         if model["requirements"]["yearMin"] != template["yearMin"])
        self.assertEqual(model_with_different_year["requirements"]["yearMin"], 2017)

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
            model_config_path = root / "config/search-models.json"
            model_config = read(model_config_path)
            selected_model = next(m for m in model_config["models"] if m["key"] == self.model["key"])
            selected_model["requirements"]["purchase"]["maxPriceGrossPln"] = 52000
            write(model_config_path, model_config)
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
            self.assertEqual(task["searchProfile"]["requirements"]["purchase"]["maxPriceGrossPln"], 52000)
            self.assertEqual(task["searchProfile"]["maxGrossPurchasePln"], 52000)
            self.assertNotEqual(cli("claim", "--run", "test", "--worker", "a").returncode, 0)
            b = cli("claim", "--run", "test", "--worker", "b")
            self.assertNotEqual(task["id"], json.loads(b.stdout)["id"])
            checked_at = "2026-01-01T00:00:00Z"
            result_url = task["searchProfile"]["searchUrl"]
            result = {"taskId": task["id"], "outcome": "partial", "checkedAt": checked_at,
                      "offers": [], "errors": [],
                      "coverage": {"searchUrls": [result_url], "pagesChecked": 1,
                                   "remaining": "Search scope not fully checked",
                                   "searchResults": [{"url": result_url, "checkedAt": checked_at, "listings": []}],
                                   "listingUrlsChecked": []}}
            write(root / "runs/test/results" / (task["id"] + ".json"), result)
            done = cli("finish", "--run", "test", "--task", task["id"], "--result", "complete")
            self.assertNotEqual(done.returncode, 0)  # Cannot claim full completion for partial evidence.
            done = cli("finish", "--run", "test", "--task", task["id"], "--result", "partial")
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(snapshot, (root / "runs/test/snapshot.json").read_bytes())

    def test_shared_search_cache_keeps_latest_page_and_next_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            results = run / "results"
            results.mkdir(parents=True)
            page_url = "https://sprzedajemy.pl/motoryzacja/samochody-osobowe/hyundai/i30"
            listing_url = "https://sprzedajemy.pl/hyundai-i30-test"
            tasks = []
            for task_id, checked_at, title, next_url in [
                ("older", "2026-11-08T10:00:00Z", "Old title", page_url + "?offset=30"),
                ("newer", "2026-11-09T10:00:00Z", "Current title", page_url + "?offset=30&sort=new"),
            ]:
                tasks.append({"id": task_id, "kind": "search", "sourceId": "sprzedajemy",
                              "modelKey": self.model["key"], "state": "partial"})
                write(results / (task_id + ".json"), {
                    "offers": [], "coverage": {
                        "listingUrlsChecked": [listing_url],
                        "cardReads": [{"url": listing_url, "checkedAt": checked_at,
                                       "card": {"title": title, "fields": {}, "photos": []}}],
                        "searchResults": [{
                        "url": page_url, "checkedAt": checked_at, "nextUrl": next_url,
                        "listings": [{"title": title, "url": listing_url}],
                    }]},
                })
            cache = car_search_cli.build_shared_search_cache(Path(tmp), run, {"tasks": tasks}, "sprzedajemy")
            page = cache["checkedSearchPages"][0]
            listing = cache["visibleListings"][0]
            self.assertEqual(page["taskId"], "newer")
            self.assertEqual(page["nextUrl"], page_url + "?offset=30&sort=new")
            self.assertTrue(page["listingsComplete"])
            self.assertEqual(listing["title"], "Current title")
            self.assertEqual(cache["cardReads"][0]["card"]["title"], "Current title")

    def test_shared_search_cache_never_calls_truncated_listing_page_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            results = run / "results"
            results.mkdir(parents=True)
            page_url = "https://sprzedajemy.pl/motoryzacja/samochody-osobowe/hyundai/i30"
            listings = [{"title": f"Offer {index}", "url": f"https://sprzedajemy.pl/offer-{index}"}
                        for index in range(301)]
            task = {"id": "many", "kind": "search", "sourceId": "sprzedajemy",
                    "modelKey": self.model["key"], "state": "partial"}
            write(results / "many.json", {"offers": [], "coverage": {"searchResults": [{
                "url": page_url, "checkedAt": "2026-11-09T10:00:00Z", "nextUrl": page_url + "?offset=30",
                "listings": listings,
            }]}})
            cache = car_search_cli.build_shared_search_cache(Path(tmp), run, {"tasks": [task]}, "sprzedajemy")
            page = cache["checkedSearchPages"][0]
            self.assertEqual(page["listingCount"], 301)
            self.assertEqual(page["cachedListingCount"], 300)
            self.assertFalse(page["listingsComplete"])

    def test_shared_card_cache_is_scoped_to_the_claimed_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            results = run / "results"
            results.mkdir(parents=True)
            listings = [
                {"title": "Hyundai i30 1.5 DPi (Kia Ceed)", "url": "https://sprzedajemy.pl/hyundai-i30"},
                {"title": "Kia Ceed SW 1.4 MPI", "url": "https://sprzedajemy.pl/kia-ceed"},
            ]
            reads = [{"url": item["url"], "checkedAt": "2026-11-09T10:00:00Z",
                      "card": {"title": item["title"], "fields":
                               {"Marka": "Hyundai", "Model": "i30"} if "hyundai" in item["url"] else
                               {"Marka": "Kia", "Model": "Ceed"}, "photos": []}}
                     for item in listings]
            write(results / "prior.json", {"offers": [], "coverage": {
                "searchResults": [{"url": "https://sprzedajemy.pl/search", "checkedAt": "2026-11-09T10:00:00Z",
                                   "listings": listings}],
                "listingUrlsChecked": [item["url"] for item in listings], "cardReads": reads,
            }})
            prior = {"id": "prior", "kind": "search", "sourceId": "sprzedajemy", "state": "partial"}
            task = {"modelKey": "kia-ceed", "searchProfile": {"queryPlan": {"manualFilters": {
                "make": "Kia", "model": "Ceed"}}}}
            cache = car_search_cli.build_shared_search_cache(Path(tmp), run, {"tasks": [prior]}, "sprzedajemy", task)
            self.assertEqual(cache["cacheModelKey"], "kia-ceed")
            self.assertEqual([entry["card"]["title"] for entry in cache["cardReads"]], ["Kia Ceed SW 1.4 MPI"])
            self.assertEqual(cache["listingUrlsChecked"], ["https://sprzedajemy.pl/kia-ceed"])


if __name__ == "__main__":
    unittest.main()
