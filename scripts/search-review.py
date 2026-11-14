#!/usr/bin/env python3
"""Build a read-only, actionable review of a completed or partial search run."""
import argparse
import json
import math
import os
import re
import statistics
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
PATTERNS = {
    "dns": re.compile(r"ENOTFOUND|ERR_NAME_NOT_RESOLVED|EAI_AGAIN|name_not_resolved|getaddrinfo", re.I),
    "access_block": re.compile(r"\b403\b|\b429\b|captcha|access denied|forbidden|challenge", re.I),
    "robots_denial": re.compile(r"robots?\.txt|niedozwolon\w+ przez robots", re.I),
    "reader_cache": re.compile(r"cache miss|reader_cache_miss|web open failed|stale_results", re.I),
    "adapter": re.compile(r"not defined|timed?\s*out|timeout|selector|locator|adapter|javascript_required|nie znaleziono jednoznacznej opcji", re.I),
    "coverage_limit": re.compile(r"limit|next\s*url|kolejn[aą]|pozosta[lł]|paginac|coverage_incomplete|zakres.*niepe[lł]n", re.I),
}


def read_json(path):
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def task_result(run_dir, task):
    task_id = task.get("id", "")
    if not isinstance(task_id, str) or not RUN_ID_RE.fullmatch(task_id):
        return {}
    result_path = run_dir / "results" / f"{task_id}.json"
    if not result_path.is_file():
        return {}
    try:
        result = read_json(result_path)
        return result if isinstance(result, dict) else {}
    except (OSError, ValueError):
        return {}


def categories_for(task, result):
    coverage = result.get("coverage") or {}
    errors = result.get("errors") or []
    text_parts = [str(result.get("outcome", "")), str(coverage.get("remaining", "")), str(task.get("note", ""))]
    for error in errors:
        if isinstance(error, dict):
            text_parts.extend((str(error.get("error", "")), str(error.get("code", "")), str(error.get("type", ""))))
        else:
            text_parts.append(str(error))
    text = "\n".join(text_parts)
    error_text = "\n".join(str(error.get("error", "")) if isinstance(error, dict) else str(error)
                             for error in errors)
    found = {name for name, pattern in PATTERNS.items() if pattern.search(text)}
    if PATTERNS["access_block"].search(error_text):
        found.add("access_block")
    if result.get("outcome") == "blocked":
        found.add("access_block")
    return found


def valid_duration(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def reader_duration_ms(result):
    diagnostics = result.get("diagnostics") or {}
    if not isinstance(diagnostics, dict):
        return None
    elapsed = valid_duration(diagnostics.get("elapsedMs"))
    if elapsed is not None:
        return elapsed
    list_ms = valid_duration(diagnostics.get("listMs"))
    card_ms = valid_duration(diagnostics.get("cardMs"))
    if list_ms is None and card_ms is None:
        return None
    return (list_ms or 0) + (card_ms or 0)


def timing_summary(values):
    values = sorted(values)
    if not values:
        return None
    p95_index = max(0, math.ceil(0.95 * len(values)) - 1)
    return {"count": len(values), "totalMs": round(sum(values)),
            "medianMs": round(statistics.median(values)), "p95Ms": round(values[p95_index])}


def summarize(run_id, run_dir, queue):
    search_tasks = [task for task in queue.get("tasks", []) if task.get("kind") == "search"]
    sources = defaultdict(lambda: {"tasks": 0, "outcomes": Counter(), "issues": Counter(),
                                   "pagesChecked": 0, "visibleListings": 0, "cardUrlsTried": 0,
                                   "offersRecorded": 0, "readerTimesMs": [], "attemptTimesMs": []})
    outcome_counts = Counter()
    issue_counts = Counter()
    task_summaries = []
    pages_total = listings_total = cards_total = offers_total = results_found = 0
    for task in search_tasks:
        result = task_result(run_dir, task)
        outcome = result.get("outcome") or task.get("state") or "pending"
        if not result and task.get("state") == "pending_manual":
            outcome = "needs_manual_review"
        elif not result and task.get("state") == "running" and task.get("manualOnly"):
            outcome = "manual_in_progress"
        source_id = task.get("sourceId") or "unknown"
        coverage = result.get("coverage") or {}
        pages = coverage.get("searchResults") or []
        page_count = coverage.get("pagesChecked")
        if not isinstance(page_count, int):
            page_count = len(coverage.get("searchUrls") or pages)
        visible = sum(len(page.get("listings") or []) for page in pages if isinstance(page, dict))
        card_urls = len(set(url for url in coverage.get("listingUrlsChecked", []) if isinstance(url, str)))
        offers = len(result.get("offers") or [])
        issues = categories_for(task, result)
        reader_ms = reader_duration_ms(result)
        attempt_ms = valid_duration(task.get("attemptElapsedMs"))
        results_found += int(bool(result))
        outcome_counts[outcome] += 1
        pages_total += page_count
        listings_total += visible
        cards_total += card_urls
        offers_total += offers
        group = sources[source_id]
        group["tasks"] += 1
        group["outcomes"][outcome] += 1
        group["issues"].update(issues)
        group["pagesChecked"] += page_count
        group["visibleListings"] += visible
        group["cardUrlsTried"] += card_urls
        group["offersRecorded"] += offers
        if reader_ms is not None:
            group["readerTimesMs"].append(reader_ms)
        if attempt_ms is not None:
            group["attemptTimesMs"].append(attempt_ms)
        issue_counts.update(issues)
        task_summaries.append({"id": task.get("id"), "sourceId": source_id, "modelKey": task.get("modelKey"),
                               "outcome": outcome, "resultFound": bool(result), "issues": sorted(issues),
                               "pagesChecked": page_count, "visibleListings": visible,
                               "cardUrlsTried": card_urls, "offersRecorded": offers,
                               "readerElapsedMs": round(reader_ms) if reader_ms is not None else None,
                               "attemptElapsedMs": round(attempt_ms) if attempt_ms is not None else None})

    source_rows = []
    for source_id, group in sorted(sources.items()):
        source_rows.append({"sourceId": source_id, "tasks": group["tasks"],
                            "outcomes": dict(sorted(group["outcomes"].items())),
                            "issues": dict(sorted(group["issues"].items())),
                            "pagesChecked": group["pagesChecked"], "visibleListings": group["visibleListings"],
                            "cardUrlsTried": group["cardUrlsTried"], "offersRecorded": group["offersRecorded"],
                            "readerTiming": timing_summary(group["readerTimesMs"]),
                            "attemptTiming": timing_summary(group["attemptTimesMs"]),
                            "readerMsPerRecordedOffer": round(sum(group["readerTimesMs"]) / group["offersRecorded"])
                            if group["offersRecorded"] and group["readerTimesMs"] else None})

    manual_review_sources = queue.get("manualReviewSources", [])
    if not isinstance(manual_review_sources, list):
        manual_review_sources = []
    task_by_id = {task.get("id"): task for task in queue.get("tasks", []) if isinstance(task, dict)}
    raw_source_blocks = queue.get("sourceAccessBlocks", [])
    if not isinstance(raw_source_blocks, list):
        raw_source_blocks = []
    blocked_source_ids = {item.get("sourceId") for item in raw_source_blocks if isinstance(item, dict)}
    resolved_manual_sources = []
    for source in manual_review_sources:
        if not isinstance(source, dict):
            continue
        entry = dict(source)
        model_tasks = [task_by_id.get(model.get("taskId")) for model in entry.get("models", [])
                       if isinstance(model, dict) and model.get("taskId")]
        states = [task.get("state") for task in model_tasks if isinstance(task, dict)]
        if entry.get("sourceId") in blocked_source_ids:
            entry["status"] = "access_blocked"
        elif states and any(state == "running" for state in states):
            entry["status"] = "manual_in_progress"
        elif states and any(state == "pending_manual" for state in states):
            entry["status"] = "needs_manual_review"
        elif states and all(state in ("complete", "partial", "blocked", "no_matches", "skipped") for state in states):
            entry["status"] = "access_blocked" if any(state in ("blocked", "skipped") for state in states) else "reviewed"
        resolved_manual_sources.append(entry)
    manual_review_sources = resolved_manual_sources

    recommendations = []
    dns_tasks = [task for task in task_summaries if "dns" in task["issues"]]
    dns_sources = sorted({task["sourceId"] for task in dns_tasks})
    if dns_tasks:
        if len(dns_sources) >= 3:
            evidence = f"{len(dns_tasks)} zadań na {len(dns_sources)} niezależnych źródłach ma błąd DNS."
            action = "Uruchom preflight DNS i ten sam dozwolony checker w zatwierdzonym środowisku sieciowym. Nie oznaczaj tych portali jako niedostępnych."
        else:
            evidence = f"Błąd DNS dotyczy {len(dns_tasks)} zadań w źródłach: {', '.join(dns_sources)}."
            action = "Sprawdź DNS dla tego źródła w zatwierdzonym środowisku; ponów tylko dozwolony checker, jeśli preflight przejdzie."
        recommendations.append({"priority": "high", "code": "dns", "title": "Oddziel problem sieci od stanu portalu", "evidence": evidence, "action": action})

    access_tasks = [task for task in task_summaries if "access_block" in task["issues"]]
    if access_tasks:
        names = sorted({task["sourceId"] for task in access_tasks})
        recommendations.append({"priority": "high", "code": "access_block", "title": "Zatrzymaj próbę po odmowie dostępu",
                                "evidence": f"{len(access_tasks)} zadań wskazuje 403/429, CAPTCHA, challenge lub status blocked; źródła: {', '.join(names)}.",
                                "action": "Nie ponawiaj tej próby automatycznie i nie obchodź zabezpieczeń. Sprawdzaj inne dozwolone źródła; do tego zakresu wróć dopiero, gdy portal udostępnia go normalnie."})

    pending_manual_review = [item for item in manual_review_sources
                             if item.get("status") in ("needs_manual_review", "manual_in_progress")]
    if pending_manual_review:
        names = ", ".join(item.get("sourceId", "unknown") for item in pending_manual_review)
        recommendations.append({"priority": "high", "code": "manual_review",
                                "title": "Sprawdź ręcznie pominięte portale",
                                "evidence": f"{len(pending_manual_review)} źródeł pominięto w automatycznym odczycie: {names}.",
                                "action": "Użyj `python -B scripts/car-search.py claim --manual --run RUN --worker manual-1 --source SOURCE`, wykonaj publiczne wyszukiwanie widoczną przeglądarką i uzupełnij przygotowany wynik. Zakończ przy CAPTCHA, 401/403/429, challenge lub odmowie robots.txt. Nie ponawiaj ani nie obchodź blokady."})

    robots_tasks = [task for task in task_summaries if "robots_denial" in task["issues"]]
    if robots_tasks:
        names = sorted({task["sourceId"] for task in robots_tasks})
        recommendations.append({"priority": "high", "code": "robots_denial", "title": "Nie otwieraj adresów wykluczonych przez robots.txt",
                                "evidence": f"{len(robots_tasks)} zadań wskazuje odmowę dla adresu lub strony paginacji; źródła: {', '.join(names)}.",
                                "action": "Zachowaj partial dla tego zakresu. Kontynuuj tylko po adresach dozwolonych przez portal; nie traktuj odmowy pojedynczego nextUrl jako blokady całej domeny."})

    adapter_tasks = [task for task in task_summaries if "adapter" in task["issues"]]
    if adapter_tasks:
        counts = Counter(task["sourceId"] for task in adapter_tasks)
        top = ", ".join(f"{source} ({count})" for source, count in counts.most_common(5))
        recommendations.append({"priority": "medium", "code": "adapter", "title": "Popraw adaptery o powtarzalnych błędach UI",
                                "evidence": f"Błędy selektorów, filtrów, timeoutów lub kodu wystąpiły w {len(adapter_tasks)} zadań; najczęściej: {top}.",
                                "action": "Zrób mały pilotaż tylko dla tych portali: potwierdź działanie filtrów i odczyt kart, a dopiero potem uruchamiaj pełny zakres modeli."})

    limit_tasks = [task for task in task_summaries if "coverage_limit" in task["issues"] and
                   "access_block" not in task["issues"] and "robots_denial" not in task["issues"]]
    if limit_tasks:
        counts = Counter(task["sourceId"] for task in limit_tasks)
        top = ", ".join(f"{source} ({count})" for source, count in counts.most_common(5))
        recommendations.append({"priority": "medium", "code": "coverage_limit", "title": "Kontynuuj udokumentowaną paginację zamiast zaczynać od początku",
                                "evidence": f"{len(limit_tasks)} zadań wskazuje limit stron/kart albo dalszy URL; źródła: {top}.",
                                "action": "Dla partial z zapisanym nextUrl uruchom `python -B scripts/car-search.py continue-search --run RUN --task TASK --worker WORKER`. Polecenie wybiera jedną stronę tej samej kwerendy; czytnik ponownie sprawdza robots.txt i domenę przed nawigacją. Nie powtarzaj całego przebiegu."})

    reader_tasks = [task for task in task_summaries if "reader_cache" in task["issues"]]
    if reader_tasks:
        names = sorted({task["sourceId"] for task in reader_tasks})
        recommendations.append({"priority": "medium", "code": "reader_cache", "title": "Nie traktuj migawki indeksu jako bieżącej karty",
                                "evidence": f"{len(reader_tasks)} zadań zawiera Cache miss lub błąd czytnika; źródła: {', '.join(names)}.",
                                "action": "Kandydatów z migawki weryfikuj w normalnym, zatwierdzonym czytniku Playwright. Gdy karta nadal nie jest dostępna, zostaw wynik partial i nie importuj jej jako dostępnej."})

    pending = sum(task.get("state") in ("pending", "running") and not task.get("manualOnly")
                  for task in search_tasks)
    if pending:
        recommendations.append({"priority": "medium", "code": "unfinished", "title": "Wznów istniejącą kolejkę przed tworzeniem kolejnej",
                                "evidence": f"{pending} zadań wyszukiwania nadal ma stan pending/running.",
                                "action": "Najpierw dokończ lub jawnie anuluj/przywróć te zadania; unikniesz powtarzania już wykonanego zakresu."})

    recommendations.sort(key=lambda item: ({"high": 0, "medium": 1, "low": 2}[item["priority"]], item["code"]))
    snapshot_path = run_dir / "snapshot.json"
    try:
        created_at = read_json(snapshot_path).get("createdAt")
    except (OSError, ValueError, AttributeError):
        created_at = None
    excluded_sources = queue.get("excludedSources", [])
    if not isinstance(excluded_sources, list):
        excluded_sources = []
    source_access_blocks = queue.get("sourceAccessBlocks", [])
    if not isinstance(source_access_blocks, list):
        source_access_blocks = []
    skipped_tasks = sum(task.get("state") == "skipped" for task in search_tasks)
    all_reader_times = [task["readerElapsedMs"] for task in task_summaries if task["readerElapsedMs"] is not None]
    all_attempt_times = [task["attemptElapsedMs"] for task in task_summaries if task["attemptElapsedMs"] is not None]
    return {"version": 1, "generatedAt": datetime.now(timezone.utc).isoformat(), "runId": run_id,
            "createdAt": created_at, "readOnly": True,
            "summary": {"searchTasks": len(search_tasks), "resultsFound": results_found,
                        "outcomes": dict(sorted(outcome_counts.items())), "pagesChecked": pages_total,
                        "visibleListings": listings_total, "cardUrlsTried": cards_total,
                        "offersRecorded": offers_total, "issues": dict(sorted(issue_counts.items())),
                        "readerTiming": timing_summary(all_reader_times),
                        "attemptTiming": timing_summary(all_attempt_times),
                        "excludedSourceCount": len(excluded_sources),
                        "manualReviewSourceCount": sum(item.get("status") in ("needs_manual_review", "manual_in_progress")
                                                        for item in manual_review_sources),
                        "skippedTasks": skipped_tasks},
            "sources": source_rows, "excludedSources": excluded_sources,
            "manualReviewSources": manual_review_sources, "sourceAccessBlocks": source_access_blocks,
            "recommendations": recommendations, "tasks": task_summaries}


def render_markdown(report):
    summary = report["summary"]
    lines = [f"# Przegląd wyszukiwania: `{report['runId']}`", "",
             f"Wygenerowano: {report['generatedAt']} (UTC). Raport jest tylko do odczytu; nie zmienia kolejki ani ofert.", "",
             "## Podsumowanie", "",
             f"- Zadania search: {summary['searchTasks']}; wyniki: {summary['resultsFound']}",
             f"- Statusy: {', '.join(f'{key}: {value}' for key, value in summary['outcomes'].items()) or 'brak'}",
             f"- Zadania pominięte po odmowie źródła: {summary.get('skippedTasks', 0)}; portale oczekujące na ręczną próbę: {summary.get('manualReviewSourceCount', 0)}",
             f"- Strony: {summary['pagesChecked']}; widoczne wpisy: {summary['visibleListings']}; próby otwarcia kart: {summary['cardUrlsTried']}; zapisane oferty: {summary['offersRecorded']}",
             f"- Suma czasu czytników (czas pracy, nie czas ścienny): {summary['readerTiming']['totalMs'] / 1000:.1f} s; mediana zadania: {summary['readerTiming']['medianMs'] / 1000:.1f} s; p95: {summary['readerTiming']['p95Ms'] / 1000:.1f} s" if summary["readerTiming"] else "- Czas czytników: brak pomiarów",
             f"- Czas prób claim–finish: mediana {summary['attemptTiming']['medianMs'] / 1000:.1f} s; p95: {summary['attemptTiming']['p95Ms'] / 1000:.1f} s" if summary["attemptTiming"] else "- Czas claim–finish: brak pomiarów",
             f"- Sygnały problemów: {', '.join(f'{key}: {value}' for key, value in summary['issues'].items()) or 'brak'}", "",
             "## Zalecane następne kroki", ""]
    if report.get("excludedSources"):
        lines.extend(["## Źródła pominięte jako zablokowane", ""])
        lines.extend(f"- {item.get('sourceId', 'unknown')}: {item.get('reason', 'adapter blocked')}"
                     for item in report["excludedSources"] if isinstance(item, dict))
        lines.append("")
    if report.get("manualReviewSources"):
        lines.extend(["## Ręczna kontrola w widocznej przeglądarce", ""])
        for item in report["manualReviewSources"]:
            models = ", ".join(model.get("modelName", model.get("modelKey", ""))
                                for model in item.get("models", []) if isinstance(model, dict)) or "brak zgodnych modeli"
            lines.append(f"- {item.get('sourceName', item.get('sourceId', 'unknown'))} (`{item.get('status', 'unknown')}`; modele: {models}): {item.get('reason', '')}")
        if any(item.get("status") in ("needs_manual_review", "manual_in_progress") for item in report["manualReviewSources"]):
            lines.append("Dla oczekujących pozycji użyj `claim --manual` i widocznej przeglądarki. CAPTCHA, odmowa dostępu lub `robots.txt` kończą próbę; nie obchodź ani nie ponawiaj blokady.")
        lines.append("")
    if report.get("sourceAccessBlocks"):
        lines.extend(["## Zatrzymania po odmowie dostępu", ""])
        for item in report["sourceAccessBlocks"]:
            if isinstance(item, dict):
                lines.append(f"- {item.get('sourceId', 'unknown')} — {item.get('url', '')}: {item.get('reason', '')}")
        lines.append("")
    if not report["recommendations"]:
        lines.append("Brak rozpoznanych problemów w zapisanych wynikach. To nie oznacza, że portale zostały sprawdzone poza zakresem tego przebiegu.")
    for index, recommendation in enumerate(report["recommendations"], 1):
        lines.extend([f"{index}. **[{recommendation['priority']}] {recommendation['title']}**",
                      f"   - Dowód: {recommendation['evidence']}", f"   - Działanie: {recommendation['action']}"])
    lines.extend(["", "## Źródła", "", "| Portal | Zadania | Statusy | Strony | Wpisy | Próby kart | Oferty | Mediana czytnika | p95 czytnika | ms/ofertę | Sygnały |",
                  "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|"])
    for source in report["sources"]:
        outcomes = ", ".join(f"{key}: {value}" for key, value in source["outcomes"].items()) or "—"
        issues = ", ".join(f"{key}: {value}" for key, value in source["issues"].items()) or "—"
        timing = source.get("readerTiming") or {}
        median = f"{timing['medianMs'] / 1000:.1f} s" if timing else "—"
        p95 = f"{timing['p95Ms'] / 1000:.1f} s" if timing else "—"
        per_offer = f"{source['readerMsPerRecordedOffer']}" if source.get("readerMsPerRecordedOffer") is not None else "—"
        lines.append(f"| {source['sourceId']} | {source['tasks']} | {outcomes} | {source['pagesChecked']} | {source['visibleListings']} | {source['cardUrlsTried']} | {source['offersRecorded']} | {median} | {p95} | {per_offer} | {issues} |")
    lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, help="Run ID from runs/<run-id>/tasks.json")
    args = parser.parse_args()
    if not RUN_ID_RE.fullmatch(args.run):
        parser.error("--run must contain only letters, digits, underscores, or hyphens")
    run_dir = ROOT / "runs" / args.run
    tasks_path = run_dir / "tasks.json"
    if not tasks_path.is_file():
        parser.error(f"No task queue found: {tasks_path}")
    queue = read_json(tasks_path)
    if not isinstance(queue, dict) or not isinstance(queue.get("tasks"), list):
        parser.error(f"Invalid task queue: {tasks_path}")
    report = summarize(args.run, run_dir, queue)
    json_path = run_dir / "search-review.json"
    markdown_path = run_dir / "search-review.md"
    atomic_write(json_path, json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    atomic_write(markdown_path, render_markdown(report))
    summary = report["summary"]
    print(f"Review: {markdown_path.relative_to(ROOT).as_posix()}")
    print(f"{summary['searchTasks']} zadań; wyniki {summary['resultsFound']}; statusy {summary['outcomes']}; rekomendacje {len(report['recommendations'])}.")


if __name__ == "__main__":
    main()
