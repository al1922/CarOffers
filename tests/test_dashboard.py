"""Static coverage must distinguish failed/partial work from no matches."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from search_core import read, write
spec = importlib.util.spec_from_file_location('dashboard', ROOT / 'scripts/generate-dashboard.py')
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)


class DashboardTests(unittest.TestCase):
    def test_partial_coverage_and_missing_result_are_not_no_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / 'runs' / 'test'
            write(run / 'snapshot.json', {'createdAt': '2026-11-07T09:00:00Z'})
            write(run / 'tasks.json', {'tasks': [
                {'id': 'source--model', 'sourceId': 'source', 'modelKey': 'model', 'state': 'partial'},
                {'id': 'source--other', 'sourceId': 'source', 'modelKey': 'other', 'state': 'pending'}]})
            write(run / 'results/source--model.json', {'checkedAt': '2026-11-07',
                'coverage': {'pagesChecked': 1, 'remaining': 'Dalsze strony', 'searchUrls': ['https://example.com/']},
                'offers': [], 'errors': [{'error': 'Błąd dostępu'}]})
            report = dashboard.generate(root)
            first, second = report['runs'][0]['tasks']
            self.assertEqual(first['state'], 'partial')
            self.assertEqual(first['coverage']['remaining'], 'Dalsze strony')
            self.assertEqual(second['state'], 'pending')
            self.assertIsNone(second['checkedAt'])
            self.assertEqual(read(root / 'reports/dashboard.json'), report)

    def test_broken_run_is_reported_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root / 'runs/broken/tasks.json', {'tasks': []})
            report = dashboard.generate(root)
            self.assertEqual(report['runs'], [])
            self.assertEqual(report['warnings'][0]['runId'], 'broken')


if __name__ == '__main__':
    unittest.main()
