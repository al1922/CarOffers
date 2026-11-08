#!/usr/bin/env python3
"""Generate a static, read-only search coverage report for GitHub Pages."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
from search_core import ROOT, read, write


def generate(root):
    runs, warnings = [], []
    for path in sorted((root / 'runs').glob('*/tasks.json'), reverse=True):
        try:
            queue = read(path)
            snapshot = read(path.with_name('snapshot.json'))
            tasks = []
            for task in queue['tasks']:
                result_path = path.parent / 'results' / (task['id'] + '.json')
                result = read(result_path) if result_path.exists() else {}
                tasks.append({key: task.get(key) for key in ('id', 'sourceId', 'modelKey', 'state', 'note')} | {
                    'checkedAt': result.get('checkedAt'), 'coverage': result.get('coverage'),
                    'errors': result.get('errors', []), 'offersRecorded': len(result.get('offers', []))})
            runs.append({'id': path.parent.name, 'createdAt': snapshot.get('createdAt'), 'tasks': tasks})
        except (ValueError, OSError, KeyError, TypeError) as exc:
            warnings.append({'runId': path.parent.name, 'message': str(exc)})
    report = {'version': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(), 'runs': runs, 'warnings': warnings}
    write(root / 'reports/dashboard.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    report = generate(args.root.resolve())
    print(f"Dashboard: {len(report['runs'])} runs, {len(report['warnings'])} warnings; no websites searched")
