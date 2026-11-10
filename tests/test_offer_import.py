"""End-to-end offline imports with real configuration and isolated offer files."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import offer_import as importer
from search_core import load_config, read, write


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for folder in ("config", "knowledge", "offers", "schemas"):
            shutil.copytree(ROOT / folder, self.root / folder)
        self.config = load_config(self.root)
        self.model = self.config["models"]["models"][0]
        self.key = self.model["key"]
        self.path = self.root / self.model["offersFile"]
        doc = read(self.path)
        doc["offers"] = []
        write(self.path, doc)
        self.offer = {"id": "listing:otomoto:test1", "title": "Test i30", "price": 50000,
                      "year": 2020, "mileage": 90000,
                      "urls": [{"url": "https://www.otomoto.pl/test1"}],
                      "listingIds": ["otomoto:test1"], "saleType": "fixed_price", "lpgInstalled": None,
                      "location": {"status": "not_provided"},
                      "observation": {"url": "https://www.otomoto.pl/test1", "checkedAt": "2026-11-07T10:00:00Z",
                                      "availability": "available", "note": "Odczytano kartę ogłoszenia."}}

    def run_fixture(self, name="test", offer=None, kind="search"):
        run = self.root / "runs" / name
        task_id = "otomoto--" + self.key
        selected_offer = copy.deepcopy(offer or self.offer)
        task = {"id": task_id, "kind": kind, "modelKey": self.key,
                "sourceId": "otomoto", "state": "partial"}
        if kind == "refresh":
            task["refreshTargets"] = [{"offerId": selected_offer["id"], "url": selected_offer["observation"]["url"]}]
            selected_offer["observation"].setdefault("photoCheck", {
                "status": "access_error" if selected_offer["observation"]["availability"] == "access_error" else "no_direct_https",
                "note": "Karta nie ujawnia bezpośredniego URL-a HTTPS zdjęcia."})
        write(run / "tasks.json", {"tasks": [task]})
        content = {"config": self.config, "knowledge": {self.key: read(self.root / self.model["knowledgeFile"])}}
        write(run / "snapshot.json", {**content, "sha256": importer.digest(content)})
        result = {"taskId": task_id, "outcome": "partial", "checkedAt": "2026-11-07T12:00:00Z",
                  "coverage": {"searchUrls": [selected_offer["observation"]["url"] if kind == "refresh" else "https://www.otomoto.pl/"], "pagesChecked": 1,
                               "remaining": "Dalsze strony",
                               "searchResults": [{"url": "https://www.otomoto.pl/",
                                                  "checkedAt": "2026-11-07T11:00:00Z",
                                                  "listings": [{"title": selected_offer.get("title", "Test i30"),
                                                                "url": selected_offer["observation"]["url"]}]}],
                               "listingUrlsChecked": [selected_offer["observation"]["url"]]},
                  "offers": [selected_offer], "errors": []}
        write(run / "results" / (task_id + ".json"), result)
        return run

    def preview(self, name="test"):
        return importer.prepare(self.root, name, self.config)

    def stored(self):
        return read(self.path)["offers"][0]

    def test_preview_is_read_only_then_apply_is_idempotent(self):
        self.run_fixture()
        before = self.path.read_bytes()
        plan = self.preview()
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual(len(plan["changes"]), 1)
        self.assertEqual(importer.apply(self.root, "test"), "applied")
        after = self.path.read_bytes()
        self.assertEqual(importer.apply(self.root, "test"), "already_applied")
        self.assertEqual(after, self.path.read_bytes())
        self.assertEqual(self.stored()["verdict"], "check")
        self.assertIsNone(self.stored()["lpgInstalled"])
        self.assertEqual(len(self.preview()["changes"]), 0)
        self.assertEqual(importer.apply(self.root, "test"), "no_changes")

    def test_legacy_mileage_km_is_canonicalized_and_conflicts_are_rejected(self):
        incoming = copy.deepcopy(self.offer)
        incoming["mileage"] = None
        incoming["mileageKm"] = 94500
        self.run_fixture("legacy-mileage", incoming)
        self.preview("legacy-mileage")
        importer.apply(self.root, "legacy-mileage")
        self.assertEqual(self.stored()["mileage"], 94500)
        self.assertNotIn("mileageKm", self.stored())

        conflict = copy.deepcopy(self.offer)
        conflict["mileage"] = 90000
        conflict["mileageKm"] = 95000
        self.run_fixture("conflicting-mileage", conflict)
        with self.assertRaisesRegex(ValueError, "conflicting mileage"):
            self.preview("conflicting-mileage")

    def test_price_history_and_sparse_update_preserves_facts(self):
        self.run_fixture()
        self.preview()
        importer.apply(self.root, "test")
        incoming = {"id": self.offer["id"], "price": 48000, "year": None,
                    "observation": {**self.offer["observation"], "checkedAt": "2026-11-07T11:00:00Z"}}
        incoming.update(title=self.offer["title"], urls=self.offer["urls"], location=self.offer["location"],
                        saleType=self.offer["saleType"], lpgInstalled=self.offer["lpgInstalled"])
        self.run_fixture("update", incoming, kind="refresh")
        self.preview("update")
        importer.apply(self.root, "update")
        self.assertEqual(self.stored()["year"], 2020)
        self.assertEqual(self.stored()["price"], 48000)
        self.assertEqual(self.stored()["history"][-1]["changes"]["price"], {"before": 50000, "after": 48000})

    def test_access_error_never_marks_sold_or_changes_price(self):
        self.run_fixture()
        self.preview()
        importer.apply(self.root, "test")
        incoming = {"id": self.offer["id"], "price": 1,
                    "observation": {**self.offer["observation"], "checkedAt": "2026-11-07T11:00:00Z",
                                    "availability": "access_error", "note": "HTTP 410; nie ustalono sprzedaży."}}
        self.run_fixture("error", incoming, kind="refresh")
        self.preview("error")
        importer.apply(self.root, "error")
        stored = self.stored()
        self.assertEqual(stored["listingStates"][0]["status"], "available")
        self.assertEqual(stored["price"], 50000)
        self.assertEqual(stored["lastCheckedAt"], "2026-11-07T10:00:00Z")
        self.assertEqual(stored["lastAttemptAt"], "2026-11-07T11:00:00Z")

    def test_conflicting_vin_blocks_apply(self):
        self.offer["vin"] = "WVWZZZ1KZAW000001"
        self.run_fixture()
        self.preview()
        importer.apply(self.root, "test")
        incoming = copy.deepcopy(self.offer)
        incoming["vin"] = "WVWZZZ1KZAW000002"
        self.run_fixture("conflict", incoming)
        self.assertEqual(self.preview("conflict")["conflicts"][0]["reason"], "conflicting_vin")
        with self.assertRaisesRegex(ValueError, "Resolve conflicts"):
            importer.apply(self.root, "conflict")

    def test_concurrent_edit_requires_new_preview(self):
        self.run_fixture()
        self.preview()
        doc = read(self.path)
        doc["model"]["description"] = "Concurrent edit"
        write(self.path, doc)
        with self.assertRaisesRegex(ValueError, "Input changed"):
            importer.apply(self.root, "test")

    def test_recovery_after_partial_write_and_backup(self):
        self.run_fixture()
        before = self.path.read_bytes()
        plan = self.preview()
        real_write = importer.atomic_write
        def interrupted(path, value):
            if Path(path) == self.root / "data/import-state.json":
                raise OSError("simulated interruption")
            real_write(path, value)
        with patch.object(importer, "atomic_write", side_effect=interrupted):
            with self.assertRaises(OSError):
                importer.apply(self.root, "test")
        with self.assertRaisesRegex(ValueError, "Resume unfinished"):
            self.preview()
        self.assertEqual(importer.apply(self.root, "test"), "applied")
        self.assertEqual(len(self.stored()["history"]), 1)
        backup = self.root / "runs/test/imports" / plan["sha256"] / "before" / self.model["offersFile"]
        self.assertEqual(backup.read_bytes(), before)

    def test_confirmation_requires_evidence(self):
        self.offer["structuralDamageStatus"] = "independently_checked_clear"
        self.run_fixture()
        with self.assertRaisesRegex(ValueError, "Confirmation without"):
            self.preview()

    def test_reimport_changed_result_rejected(self):
        run = self.run_fixture()
        self.preview()
        importer.apply(self.root, "test")
        result_path = next((run / "results").glob("*.json"))
        result = read(result_path)
        result["offers"][0]["price"] = 47000
        write(result_path, result)
        with self.assertRaisesRegex(ValueError, "Previously imported result changed"):
            self.preview()

    def test_same_vin_other_listing_joins_with_separate_availability(self):
        self.offer["vin"] = "WVWZZZ1KZAW000001"
        self.run_fixture()
        self.preview()
        importer.apply(self.root, "test")
        incoming = copy.deepcopy(self.offer)
        incoming.update(id="listing:otomoto:test2", listingIds=["otomoto:test2"], urls=[{"url": "https://www.otomoto.pl/test2"}])
        incoming["observation"]["url"] = incoming["urls"][0]["url"]
        self.run_fixture("second", incoming)
        self.preview("second")
        importer.apply(self.root, "second")
        self.assertEqual(len(read(self.path)["offers"]), 1)
        self.assertEqual(len(self.stored()["listingStates"]), 1)

    def test_duplicate_observation_in_new_run_does_not_duplicate_history(self):
        self.run_fixture()
        self.preview()
        importer.apply(self.root, "test")
        self.run_fixture("repeat")
        self.assertEqual(self.preview("repeat")["changes"], [])
        importer.apply(self.root, "repeat")
        self.assertEqual(len(self.stored()["history"]), 1)

    def test_missing_location_and_invalid_input_rejected_without_mutation(self):
        self.offer["location"] = None
        self.run_fixture()
        with self.assertRaisesRegex(ValueError, "Invalid observation fields"):
            self.preview()
        self.assertEqual(read(self.path)["offers"], [])

    def test_snapshot_tampering_rejected(self):
        run = self.run_fixture()
        snapshot = read(run / "snapshot.json")
        snapshot["config"]["requirements"]["yearMin"] = 1900
        write(run / "snapshot.json", snapshot)
        with self.assertRaisesRegex(ValueError, "Snapshot integrity"):
            self.preview()

    def test_location_and_confirmation_evidence_are_preserved(self):
        self.offer["location"] = {"status": "available", "countryCode": "PL", "voivodeship": "mazowieckie", "city": "Warszawa"}
        self.offer["structuralDamageStatus"] = "independently_checked_clear"
        self.offer["observation"]["evidence"] = [{"fields": ["structuralDamageStatus"],
            "kind": "independent", "url": "https://example.com/report", "checkedAt": "2026-11-07T09:00:00Z", "note": "Zakres niezależnej kontroli"}]
        self.run_fixture()
        self.preview()
        importer.apply(self.root, "test")
        self.assertEqual(self.stored()["history"][0]["evidence"][0]["kind"], "independent")
        incoming = {"id": self.offer["id"], "location": {"status": "not_provided"},
                    "observation": {**self.offer["observation"], "checkedAt": "2026-11-07T11:00:00Z"}}
        incoming.update(title=self.offer["title"], urls=self.offer["urls"],
                        saleType=self.offer["saleType"], lpgInstalled=self.offer["lpgInstalled"])
        self.run_fixture("sparse", incoming, kind="refresh")
        self.preview("sparse")
        importer.apply(self.root, "sparse")
        self.assertEqual(self.stored()["location"]["city"], "Warszawa")
        self.assertEqual(self.stored()["history"][-1]["reportedFields"]["location"]["status"], "not_provided")

    def test_cli_preview_and_apply(self):
        self.run_fixture()
        for command in ("import-preview", "import-apply"):
            process = subprocess.run([sys.executable, "-B", str(ROOT / "scripts/car-search.py"),
                                      command, "--root", str(self.root), "--run", "test"],
                                     capture_output=True, text=True)
            self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        self.assertEqual(self.stored()["price"], 50000)


if __name__ == "__main__":
    unittest.main()
