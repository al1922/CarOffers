#!/usr/bin/env python3
"""Tworzy models.json z plików offers/*.json (bez GitHub API)."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
models = []
for path in sorted((root / "offers").glob("*.json")):
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data.get("offers"), list):
        raise ValueError(f"{path.name}: pole offers musi być tablicą")
    meta = data.get("model")
    if not isinstance(meta, dict):
        raise ValueError(f"{path.name}: brak obiektu model")
    key = path.stem
    if meta.get("key") != key:
        raise ValueError(f"{path.name}: model.key musi wynosić {key!r}")
    if not isinstance(meta.get("name"), str) or not meta["name"].strip():
        raise ValueError(f"{path.name}: model.name musi być tekstem")
    models.append({"key": key, "name": meta["name"],
                   "description": meta.get("description", ""),
                   "requirements": meta.get("requirements"),
                   "file": f"offers/{path.name}"})
output = {"version": 1, "models": models}
(root / "models.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Zaktualizowano models.json: {len(models)} modeli")
