# Pierwszy etap implementacji aktualizacji ofert

8 listopada 2026. Zmiany przygotowane lokalnie, bez publikacji i bez nowych
zapytań do portali samochodowych. Nie zastosowano importu do rzeczywistych ofert.

## Wdrożone

- `import-preview` i `import-apply`: kontrolowane scalenie wyników pracowników.
- Deduplikacja po VIN, ID i URL, blokowanie konfliktów i starszych obserwacji.
- Historia zmian i dowodów, osobna dostępność każdego ogłoszenia.
- Idempotencja, zachowanie brakujących danych, kopie sprzed zapisu, wznowienie
  przerwanego importu i kontrola zmian wejściowych.
- Wymagana lokalizacja nowej oferty, jawny rodzaj sprzedaży i informacja o LPG.
- Walidacja potwierdzeń i dodatkowych parametrów strukturalnych.
- Ocena według bieżącej konfiguracji; statusy silników `hold...` wymagają kontroli.
- Raport oceny zawiera czas i pola wejściowe. Strona sprawdza zgodność raportu
  z aktualną konfiguracją i ofertą; nieaktualna ocena przechodzi na `check`.
- Strona pokazuje powody oceny po polsku, historię cen, dowody, LPG i lokalizację.
- Parametry zapytania URL pozostają częścią tożsamości także na stronie.
- Usunięto historyczną specyfikację Corolli z limitem 60 000 zł zaszytą w HTML;
  opis wymagań jest teraz prezentowany z indeksu generowanego z konfiguracji.

## Weryfikacja

- 67 testów Python: OK. Testy używające katalogów tymczasowych wykonano poza
  sandboxem po uzyskaniu zgody, ponieważ sandbox blokował te katalogi.
- 4 testy integracyjne logiki strony (`node --test tests/test_app.cjs`): OK.
  To testy z uproszczonym DOM, nie test rzeczywistego układu przeglądarki.
- `node --check app.js`: OK.
- `car-search.py validate`: OK, 16 modeli i 26 źródeł.
- Walidacja ofert: 16 plików, 109 ofert, 0 błędów, 77 ostrzeżeń historycznych.
- Przeliczono raport 109 zapisanych ofert: wszystkie `check`, ze względu na
  brakujące dowody/parametry oraz wymagane decyzje; nie oznacza to 109 nowych
  odczytów ogłoszeń ani potwierdzenia aktualności.
- Podgląd istniejącego pilotażu: 0 zmian ofert i 0 konfliktów. Nie zastosowano go.
- Weryfikacja wizualna nie została ukończona: przeglądarka aplikacji zwróciła
  timeout połączenia z lokalnym serwerem; Computer Use nie otrzymał zgody na Brave.

## Pozostały zakres

Adaptery odczytu portali, automatyczne wyszukiwanie i odświeżanie, profile
modeli i uruchamianie subagentów, wznowienie zadań kolejki z archiwizacją prób,
obliczanie odległości oraz harmonogram nie są jeszcze wdrożone.

Procedura i kontrakt wyników: `docs/import-ofert.md`. Następny etap to pilotaż
adapterów dwóch źródeł, z wynikami przechodzącymi przez nowy importer.
