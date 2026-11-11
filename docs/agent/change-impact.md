# Przegląd wpływu zmiany

Stosuj ten poradnik przy zmianie zachowania, konfiguracji, formatu danych,
przepływu ofert, modelu lub portalu. Celem jest znalezienie odbiorców zmiany,
nie masowa edycja wszystkich plików, w których pojawia się podobne słowo.

## Przed edycją

1. Sprawdź `git status --short` i `git diff --stat`; oddziel bieżące zadanie od
   istniejących zmian.
2. Ustal źródło prawdy, odbiorców, dane pochodne, walidatory, testy oraz główny
   dokument tematu. Zacznij od [indeksu dokumentacji](../README.md) i
   [architektury](../architektura-dla-agenta.md).
3. Wyszukaj użycia zmienianych nazw pól, funkcji, ścieżek i poleceń przez `rg`.
   Otwórz kontekst użycia — trafienie tekstowe samo nie dowodzi zależności.
4. Zaplanuj aktualizacje i regenerację przed edycją. Nie zmieniaj historycznych
   raportów, chyba że użytkownik prosi o korektę historii; popraw bieżące źródła
   i oznacz raporty jako historyczne, gdy ich treść mogłaby wprowadzać w błąd.

## Macierz zależności

| Rodzaj zmiany | Źródło prawdy | Odbiorcy i dane pochodne | Kontrola zależności |
|---|---|---|---|
| Kryterium zakupu, silnik lub roczniki modelu | `config/search-models.json`; szablon dla nowego modelu: `config/requirements.json` | `scripts/search_core.py` (plan i ocena), profile nowych zadań, opisy wymagań w `offers/*.json`, `models.json`, `reports/current-assessment.json`, widok filtrów i oceny | `sync`, `validate`, `assess`, `validate-offers.py`; sprawdź dokument założeń i metodę oceny, jeśli zmieniła się reguła. |
| Dodanie lub usunięcie modelu | `config/search-models.json` oraz jawnie wskazane `offersFile` i `knowledgeFile` | Plik oferty, karta `knowledge/models/`, indeks `models.json`, raport oceny, filtry, raporty zależne od liczby modeli | Sprawdź kompletność w obu kierunkach: każdy wpis konfiguracji ma pliki, a każdy `offers/*.json` ma wpis konfiguracji. Po zmianie uruchom `sync`, potem `validate`. Raportów datowanych nie usuwaj jako części zwykłego porządkowania. |
| Portal lub sposób odczytu portalu | `config/sources.json`, `config/portal-adapters.json` | Adapter/czytnik w `scripts/`, zakres zadań, identyfikatory obserwacji i instrukcje wyszukiwania | `python -B scripts/car-search.py validate`; sprawdź testy adaptera i [rejestr źródeł](../rejestr-zrodel.md). Nie zmieniaj przepływu dostępności podczas zmiany samego wyszukiwania. |
| Pole lub znaczenie danych oferty | `schemas/offers-v2.schema.json` i reguły biznesowe w `scripts/offer_import.py` / `scripts/search_core.py` | Import i historia, normalizacja `assets/core.mjs`, ładowanie `assets/data.mjs`, widoki `assets/views.mjs`, istniejące rekordy oraz raport oceny | Sprawdź walidator ofert, testy importu i UI; zaktualizuj główny [kontrakt danych](../data-contract-v2.md) i [import/historię](../import-ofert.md), jeśli zmienił się ich temat. Nie migruj historycznych rekordów domysłem. |
| Status dostępności, próba albo archiwizacja | Kontrakt oferty, obserwacje importowane przez `scripts/offer_import.py` | `offers/*.json` (`listingStates`, `history`, `archivedOffers`), reguły `availability`/`refresh`, etykiety i daty w szczegółach | Sprawdź niezależnie wynik dostępności, ostatnią udaną weryfikację, ostatnią próbę i warunki archiwizacji/przywracania. Zaktualizuj dokumentację operacji i dowodów. |
| Lokalizacja lub obliczanie odległości | `data/cities-pl.json`, dane z `data/verified-locations.json` i `data/offer-locations.json`, generator `scripts/generate-locations.py` | `assets/data.mjs`, `assets/core.mjs`, filtry i szczegóły w `assets/views.mjs`, `reports/location-evidence/` | Sprawdź pochodzenie danych, `docs/lokalizacje.md`, walidator oraz testy lokalizacji. Wygenerowane katalogi odtwarzaj skryptem, nie edytuj kopii ręcznie. |
| Widok, dostępność lub responsywność | `index.html`, `app.js`, `assets/*.mjs`, `assets/styles.css` | Klawiatura, focus, dialogi, karty i tabela, szerokości mobilne, wersje cache-busting w URL-ach statycznych, opisy funkcji w README | Użyj poradnika [UI](ui-testing.md); sprawdź klawiaturę i widok na wymaganych szerokościach. Aktualizuj wersję zasobu, gdy sposób cache'owania tego wymaga. |
| Kontrakt albo walidator | `schemas/*.schema.json`, `scripts/validate-offers.py`, `scripts/search_core.py` | Import, dane historyczne, komunikaty walidacji i wszystkie tworzące je testy | Sprawdź poprawny i błędny przypadek dla zmienionej reguły oraz wpływ na stare dane. Walidator powinien odrzucać sprzeczność, a nie po cichu przepisywać źródło. |

## Dane pochodne i kolejność

- `models.json` jest indeksem strony generowanym z plików ofert przez
  `scripts/car-search.py sync` lub `scripts/generate-models.py`. Nie edytuj go
  ręcznie. `validate` sprawdza, czy indeks, konfiguracja i pliki ofert są zgodne.
- Zmiana wymagań może wymagać `sync` oraz `assess`; sama zmiana tekstu widoku nie
  zmienia reguł oceny. `reports/current-assessment.json` jest wynikiem, nie źródłem
  wymagań.
- `reports/dashboard.json` odtwarza stan zapisanych przebiegów przez
  `scripts/generate-dashboard.py`. Generuj go, gdy zmienił się stan zadań lub ich
  wyników; nie uruchamiaj tego tylko dlatego, że zmienił się wygląd strony.
- Po zmianie importowanych rekordów sprawdź właściwą sekwencję importu, oceny i
  walidacji z `docs/import-ofert.md`; nie uruchamiaj `assess` dla samej kontroli
  dostępności, jeśli procedura tego zabrania.

## Po edycji

1. Ponownie wyszukaj zmienione nazwy i sprawdź wszystkie trafienia istotne dla
   zachowania. W razie usunięcia funkcji/modelu sprawdź również stare nazwy i
   pliki osierocone.
2. Regeneruj tylko pochodne, które zależą od zmienionego źródła. Uruchom właściwe
   walidatory i testy zgodne z prośbą użytkownika oraz instrukcjami projektu.
3. Porównaj zmienione pliki z macierzą: kod, dane, generaty, dokumentacja i
   wdrożenie. Zaktualizuj jeden główny dokument tematu; pozostałe niech wskazują
   do niego albo jawnie zachowują datowany kontekst historyczny.
4. W odpowiedzi podaj, co zaktualizowano, co sprawdzono i które zależności nie
   wymagały zmiany. Nie przedstawiaj raportów historycznych jako bieżącego stanu.

