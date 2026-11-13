# Mapa projektu dla agenta AI

Ten plik opisuje granice kodu i kolejność sprawdzania danych. Szczegółowe reguły
operacyjne wyszukiwania i importu są w `docs/agent/search-operations.md`;
`AGENTS.md` jest krótkim indeksem i zawiera zasady zawsze obowiązujące.

## Zasada nadrzędna

CarOffers składa się z dwóch części: statycznej strony do przeglądania zapisanych
danych oraz lokalnych narzędzi, którymi agent przygotowuje i waliduje te dane.
Strona nie przeszukuje portali. Narzędzia lokalne nie publikują zmian.

Przy rozbieżności źródeł danych stosuj tę kolejność:

1. `config/search-models.json` — aktywne modele, wymagania per model i warianty.
2. `config/sources.json` oraz `config/portal-adapters.json` — portale i ich obsługa.
3. `knowledge/models/*.json` — twierdzenia techniczne ze źródłami i jawne luki.
4. `offers/*.json` — zapisane obserwacje ogłoszeń; nie nadpisuj braków domysłami.
5. `models.json`, raporty i teksty widoku — indeksy lub wyniki pochodne, nie źródło
   reguł wyszukiwania.

`config/requirements.json` jest szablonem dla nowych modeli. Ocena i wyszukiwanie
korzystają z `requirements` przypisanych do danego modelu w `search-models.json`.

## Mapa kodu

| Obszar | Pliki | Odpowiedzialność |
|---|---|---|
| Strona statyczna | `index.html`, `app.js`, `assets/*.mjs`, `assets/styles.css` | Widoki, filtry, URL, lokalne preferencje i odczyt statycznych JSON-ów. |
| Konfiguracja i kontrakty | `config/*.json`, `schemas/*.json` | Zakres wyszukiwania, źródła, adaptery i walidacja struktury danych. |
| Wyszukiwanie i koordynacja | `scripts/car-search.py`, `scripts/search-review.py` | CLI koordynatora: planowanie, przydziały, zakończenia, ocena/import oraz tylko-odczytowa analiza skuteczności przebiegów. Nie otwiera stron portali. |
| Reguły wspólne | `scripts/search_core.py` | Odczyt konfiguracji, walidacja ustawień, wymagania i ocena oferty. |
| Import | `scripts/offer_import.py` | Walidacja wyników agentów, podgląd scalenia i lokalne zastosowanie zmian. |
| Odczyt portali | `scripts/portal-search.mjs`, `scripts/portal-candidates.mjs`, `scripts/sprzedajemy-search.mjs` | Punkty wejścia czytników stron i widocznych wyników. |
| Przesiew i karta | `scripts/portal-screening.mjs`, `scripts/portal-card-classifier.mjs`, `scripts/sprzedajemy-verify.mjs` | Czysta logika dopasowania, przesiew widocznych wyników oraz klasyfikacja danych karty. |
| Dostępność i nawigacja | `scripts/availability-check.mjs`, `scripts/portal-robots.mjs`, `scripts/playwright-pages.mjs` | Kontrola URL-i, reguły nawigacji i narzędzia Playwright. |
| Generowane dane | `scripts/generate-*.py`, `reports/current-assessment.json`, `reports/dashboard.json`, `models.json` | Pochodne indeksy i raporty. Generuj je ich narzędziem, nie edytuj ręcznie bez powodu. |
| Przebiegi | `runs/<run-id>/` | Lokalne migawki, kolejki i wyniki; katalog jest wykluczony z Gita. |
| Testy | `tests/` | Testy strony, konfiguracji, importu, walidatora i adapterów portali. |

`portal-candidates.mjs` jest nadal koordynatorem generic-adaptera; wydzielaj z niego
czyste reguły do małych modułów, ale utrzymuj dotychczasowe eksporty i polecenie
`npm run search:portal`.

## Przepływy pracy

- **Nowe oferty:** koordynator tworzy `plan`; wykonawcy zapisują wyniki w
  `runs/<run-id>/results/`; koordynator waliduje, robi `import-preview`, a dopiero
  przy braku konfliktów wykonuje `import-apply`, `assess` i walidację ofert.
- **Odświeżenie / dostępność:** zadanie ogranicza się do URL-i migawki. Nie
  rozszerzaj go na nowe wyszukiwanie; nieczytelny URL nie oznacza sprzedanego auta.
- **Widok strony:** dane pochodzą z istniejących plików JSON. Zmiana strony nie
  aktualizuje wymagań ani nie potwierdza aktualności ogłoszeń.

Dokładne kontrakty wyników i zasady przydziału znajdują się w
`docs/agent/search-operations.md`; nie twórz alternatywnego przepływu ani
drugiego formatu wyników.

## Rutyna przed zmianą kodu

1. Sprawdź `git status --short` i `git diff --stat`; traktuj istniejące lokalne
   zmiany jako pracę do zachowania.
2. Przy zmianie przekrojowej najpierw użyj macierzy w
   `docs/agent/change-impact.md`, aby ustalić odbiorców i pliki pochodne.
3. Przeczytaj ten przewodnik, `AGENTS.md` oraz tylko poradnik i pliki
   konfiguracji/wiedzy potrzebne do bieżącego zadania. Nie wczytuj wszystkich
   dokumentów z `docs/agent/` naraz.
4. Uruchom `python -B scripts/car-search.py validate` przed pracą zależną od
   zakresu modeli lub portali.
5. Zmień możliwie najmniejszą granicę modułu. Nie przemianowuj ścieżek publicznych,
   skryptów CLI ani formatów wyników bez aktualizacji wszystkich wywołań.
6. Uruchom testy dotyczące zmienionego modułu. Pełny zestaw:
   `npm test` oraz `python -B -m unittest discover -s tests -v`.
7. Po zmianie konfiguracji uruchom walidację konfiguracji i walidator ofert.
   Nie uruchamiaj importu ani nie publikuj bez wyraźnego celu użytkownika.

## Reguły zmian

- Nie zmieniaj ustawień modeli, zakresu źródeł ani kryteriów, gdy zadanie dotyczy
  wyłącznie kodu lub organizacji projektu.
- Nie edytuj `offers/*.json` bez przepływu importu i wymaganych dowodów.
- Nie traktuj raportu, cache, snippetu ani indeksu modeli jako dowodu z karty.
- Przy ekstrakcji modułu zachowaj publiczne eksporty; testy i istniejące polecenia
  często importują punkt wejścia bez uruchamiania go jako procesu.
- Nie dodawaj zależności produkcyjnych do statycznej strony. Playwright jest
  zależnością narzędzi lokalnych.
- Przebiegi i wyniki robocze pozostaw w `runs/`; nie wprowadzaj ich do repozytorium.
