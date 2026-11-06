# Oferty samochodów — GitHub Pages

Strona statyczna bez GitHub API i bez ocen/statusów użytkownika. Modele w osobnych plikach `offers/*.json`; indeks `models.json` generuje GitHub Actions po dodaniu modelu.

## Publikacja

Skopiuj zawartość tego katalogu do **katalogu głównego repozytorium** (nie przesyłaj samego ZIP). W GitHub → Settings → Pages ustaw publikację z gałęzi `main` i `/ (root)`. Zachowaj `.github/workflows/update-models.yml` i `scripts/generate-models.py`. W Settings → Actions → General włącz uprawnienie zapisu dla workflow, jeżeli automatyczne aktualizowanie indeksu ma działać.

## Dodanie modelu

Dodaj plik `offers/skoda-octavia.json` zawierający:

```json
{
  "version": 2,
  "updatedAt": "2026-11-06",
  "model": {"key": "skoda-octavia", "name": "Skoda Octavia", "description": "Liftback / kombi", "requirements": null},
  "offers": []
}
```

Po udanym przebiegu GitHub Actions indeks `models.json` zaktualizuje się automatycznie. Można również uruchomić lokalnie `python scripts/generate-models.py` i zatwierdzić wygenerowany plik.

## Format oferty (v2)

```json
{
  "id": "listing:portal:123456",
  "vin": null,
  "listingIds": ["portal:123456"],
  "urls": [{"url":"https://example.com/ogloszenie/123456", "normalized":"https://example.com/ogloszenie/123456", "label":"Zobacz ogłoszenie"}],
  "title": "Skoda Octavia 1.5 TSI",
  "year": 2021,
  "price": 59000,
  "priceLabel": "59 000 zł",
  "mileage": 98000,
  "mileageLabel": "98 000 km",
  "engine": "1.5 TSI · 150 KM",
  "body": "Kombi",
  "transmission": "Manualna",
  "seller": "Sprzedawca / lokalizacja",
  "subtitle": "2021 · Kombi · 1.5 TSI",
  "priority": "Priorytet 2",
  "verdict": "check",
  "verdictTitle": "Wymaga weryfikacji",
  "verdictNote": "Potwierdzić historię serwisową",
  "specs": {"Rocznik":"2021"},
  "details": {"Historia i pochodzenie":"...", "Wyposażenie":"...", "Problemy / niepewności":"...", "Ocena":"..."}
}
```

Pola `price`, `mileage`, `year` są **liczbami**, nie tekstem. `verdict`: `match`, `check` lub `fail`. Wersja 2 nie potrzebuje pola `html`; istniejące 44 oferty Corolli zostały przekonwertowane.

## Nowe oferty i duplikaty

„Nowe” oznacza identyfikatory, których nie było podczas poprzedniego otwarcia danego modelu w tej przeglądarce. Pierwsze uruchomienie ustanawia stan początkowy. Informacja jest lokalna i nie synchronizuje się między urządzeniami. Duplikaty są łączone na podstawie identycznego VIN, ID ogłoszenia lub znormalizowanego URL; dwa ogłoszenia bez wspólnych identyfikatorów nie będą automatycznie scalane. Dane ofert pochodzą z przekazanego zestawienia — strona nie sprawdza ich bieżącej dostępności.

## Uruchamianie lokalne

Przez `file://` przeglądarka może blokować `fetch`. Użyj `python -m http.server 8000`, a następnie `http://localhost:8000`.
