#!/usr/bin/env python3
"""Compare two one-page read-only portal pilots; does not access websites."""
import json
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parent.parent
BASELINE = ROOT / "reports/portal-adapter-pilot-baseline-2026-11-09.json"
CURRENT = ROOT / "reports/portal-adapter-pilot.json"
OUTPUT = ROOT / "reports/portal-performance-comparison.json"


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


old, new = read(BASELINE), read(CURRENT)
old_rows = {item["sourceId"]: item for item in old["results"]}
new_rows = {item["sourceId"]: item for item in new["results"]}
rows = []
for source_id in sorted(set(old_rows) & set(new_rows)):
    before, after = old_rows[source_id], new_rows[source_id]
    old_metrics = before.get("diagnostics") or {}
    new_metrics = after.get("diagnostics") or {}
    rows.append({
        "sourceId": source_id,
        "oldStatus": before.get("status"), "newStatus": after.get("status"),
        "oldCandidates": before.get("candidates", 0), "newCandidates": after.get("candidates", 0),
        "oldNavigationMs": old_metrics.get("navigationMs"), "newNavigationMs": new_metrics.get("navigationMs"),
        "oldReaderElapsedMs": old_metrics.get("elapsedMs"), "newReaderElapsedMs": new_metrics.get("elapsedMs"),
        "oldRenderWaitMs": old_metrics.get("renderWaitMs"), "newRenderWaitMs": new_metrics.get("renderWaitMs"),
    })

comparable = [row for row in rows if row["oldCandidates"] > 0 and row["newCandidates"] > 0]
old_elapsed = [row["oldReaderElapsedMs"] for row in comparable if isinstance(row["oldReaderElapsedMs"], (int, float))]
new_elapsed = [row["newReaderElapsedMs"] for row in comparable if isinstance(row["newReaderElapsedMs"], (int, float))]
old_navigation = [row["oldNavigationMs"] for row in comparable if isinstance(row["oldNavigationMs"], (int, float))]
new_navigation = [row["newNavigationMs"] for row in comparable if isinstance(row["newNavigationMs"], (int, float))]
candidate_counts_match = all(row["oldCandidates"] == row["newCandidates"] for row in rows)
old_elapsed_median = round(median(old_elapsed)) if old_elapsed else None
new_elapsed_median = round(median(new_elapsed)) if new_elapsed else None
old_navigation_median = round(median(old_navigation)) if old_navigation else None
new_navigation_median = round(median(new_navigation)) if new_navigation else None

report = {
    "version": 1,
    "generatedAt": new["checkedAt"],
    "baselineCheckedAt": old["checkedAt"],
    "currentCheckedAt": new["checkedAt"],
    "method": "One same-source, one-page pilot before and after replacing the fixed 900 ms wait with a results-aware wait capped at 1200 ms. Image/font/media requests were not blocked in either run.",
    "summary": {
        "sourcesCompared": len(rows),
        "candidateSources": len(comparable),
        "candidateCountsUnchanged": candidate_counts_match,
        "oldMedianReaderElapsedMs": old_elapsed_median,
        "newMedianReaderElapsedMs": new_elapsed_median,
        "readerElapsedMedianChangePercent": round((new_elapsed_median / old_elapsed_median - 1) * 100, 1) if old_elapsed_median and new_elapsed_median else None,
        "oldMedianNavigationMs": old_navigation_median,
        "newMedianNavigationMs": new_navigation_median,
        "navigationMedianChangePercent": round((new_navigation_median / old_navigation_median - 1) * 100, 1) if old_navigation_median and new_navigation_median else None,
    },
    "limitations": [
        "These are single one-page smoke pilots, not complete searches or a statistical benchmark.",
        "Historical full-search task files do not record elapsed duration, so this comparison establishes a new baseline rather than a direct comparison with the old workflow.",
        "Sources with no visible candidates may wait longer up to the 1200 ms results timeout.",
    ],
    "sources": rows,
}
OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"reportPath": OUTPUT.relative_to(ROOT).as_posix(), **report["summary"]}, ensure_ascii=False))
