# Wyszukiwanie bezpośrednie

## Polecenie

```powershell
npm run cars -- search --source otomoto
npm run cars -- search --source aaaauto --model kia-xceed
npm run cars -- search --source otomoto --model kia-xceed --no-import
npm run cars -- search --source otomoto --filters-only
```

Identyfikator źródła jest obowiązkowy. Brak `--model` wybiera wszystkie aktywne modele, które mają `supported: true` w mapowaniu podanego portalu. Model bez gotowego mapowania jest pomijany; jawne wskazanie takiego modelu kończy się czytelnym błędem.

Domyślny przebieg uruchamia widoczne Chromium, respektuje `robots.txt`, zatrzymuje się przy 401/403/429 lub challenge, otwiera znalezione karty, kwalifikuje dane i importuje spełniające kryteria rekordy. `--headless` ukrywa okno. `--no-import` zachowuje wynik do ręcznego wglądu; `--filters-only` audytuje filtry bez importu.

OTOMOTO domyślnie sprawdza szczegóły wszystkich kart z pobranych stron; nie ma limitu `maxCards`. `--max-cards` nadal pozwala ustawić ręczny limit, a inne źródła mogą mieć własny limit w konfiguracji. `maxPages` osobno ogranicza liczbę pobieranych stron. OTOMOTO używa czterech równoległych kart szczegółów; limity pozostałych źródeł są niezależne. Po imporcie skrócone pomiary są dopisywane do lokalnego pliku `runs/direct-search-history.jsonl`.

Po pobraniu listy dla kolejnego modelu rozpoczyna się ono równolegle z analizą szczegółów poprzedniego modelu; pule kart szczegółów nie nakładają się między modelami. Na kartach OTOMOTO pomijane są pobrania obrazów, fontów i multimediów oraz znane żądania API niezwiązane z danymi auta. Skrypty, style, wymagane dane oferty i odczyt adresów zdjęć pozostają dostępne.

Import udanego częściowego przebiegu może zapisać już odczytane zgodne karty. Błąd źródła, brak dostępu i challenge nie zmieniają zapisanych ofert. Po udanym imporcie tymczasowe artefakty przebiegu są usuwane.

Adapter OTOMOTO sprawdza `robots.txt`, otwiera skonfigurowany URL filtrowania i audytuje faktyczne żądanie listy. Adapter AAA Auto odczytuje dane listy i karty z JSON osadzonego na renderowanej stronie (`#ng-state`); nie buduje niepotwierdzonych endpointów API.

Każde źródło ma osobny adapter odczytu. Runner wymaga wspólnego minimum kandydata listy i karty, sprawdza je w `src/search/direct/adapter-contract.mjs`, a wybrane pola portalu zachowuje w wyniku pod `sourcePayload.<sourceId>`. Szczegóły kontraktu: [source-adapter-contract.md](source-adapter-contract.md).

Przed klasyfikacją `src/search/shared/candidate-field-extractor.mjs` sprawdza pola adaptera, etykiety i wartości z karty, dane JSON-LD, tytuł oraz pełny widoczny tekst ogłoszenia. Szuka między innymi ceny, rocznika, przebiegu, VIN-u, daty pierwszej rejestracji i wariantu silnika z aliasów danego modelu. Wynik kandydata zawiera `extraction.facts`, dowody `extraction.fieldEvidence`, konflikty wartości, `missingRequired` i `unresolvedRequired` (brakujące lub sprzeczne pola wymagane) oraz listę sprawdzonych źródeł. Ekstrakcja tekstowa jest regułowa; nie jest podłączony zewnętrzny dostawca AI.

Po ekstrakcji `requireConfiguredCriteria()` odrzuca kandydata, gdy wymagane pole nie zostało znalezione albo ma sprzeczne odczyty. Następnie sprawdza wymagane kryteria modelu, w tym dozwolone warianty silnika i limity ceny, rocznika oraz przebiegu. Cena jest porównywana z kwotą ogłoszenia niezależnie od podstawy VAT. Niepewne pola półwymagane i opcjonalne nie blokują kwalifikacji.

Przed zaakceptowaniem karty `src/search/shared/vehicle-condition.mjs` sprawdza pola stanu/uszkodzeń, dane strukturalne oraz jednoznaczne wzmianki o uszkodzeniu w tytule i widocznym tekście ogłoszenia. Rozpoznane uszkodzenie odrzuca kandydata, a podstawa decyzji trafia do `conditionAssessment` i notatki klasyfikacji. Sformułowania oznaczające brak uszkodzeń są rozpoznawane jako negacja; ogólna wzmianka o zestawie naprawczym nie oznacza uszkodzenia. Nieznany stan pozostaje nieznany i sam w sobie nie odrzuca ogłoszenia. Importer wykonuje tę kontrolę ponownie, więc zapisany wcześniej przebieg nie ominie filtra.

Przy imporcie `src/offers/mapper.mjs` łączy fakty kwalifikowanego kandydata z ekstrakcją. Wspólne wartości trafiają do `listings[].facts`, dowody do `listings[].fieldEvidence`, a dodatkowe pola specyficzne dla portalu do `listings[].sourceExtensions.<sourceId>`. Mapper pomija pola już obecne we wspólnym kontrakcie oraz dane techniczne i kontaktowe. Importer ponownie sprawdza nierozwiązane pola wymagane i kryteria modelu przed zapisem.

Jeśli wyszukiwanie uruchomiono z `--no-import`, można później przekazać zachowany wynik do importera: `npm run cars -- import --run <run-id>`.

Wyczyszczenie wszystkich zapisanych ofert z zachowaniem baz i profili modeli wykonuje `npm run cars -- offers clear`.

## Dodanie modelu

```powershell
npm run cars -- model add --key nowy-model --name "Marka Model" --brand Marka --model Model --year-min 2019 --price-min 30000 --price-max 55000 --mileage-max 170000 --engines "1.5-turbo-150"
```

Polecenie tworzy profil, kartę wiedzy, pustą bazę ofert i wyłączone mapowania wszystkich skonfigurowanych źródeł. Przed włączeniem portalu sprawdź jego URL i filtry bezpośrednio w tym portalu, zgodnie z zasadami dostępu. Właściwe wyjątki zapisuje się przy danym modelu i portalu:

```powershell
npm run cars -- urls --source otomoto --model nowy-model
npm run cars -- model mapping --source otomoto --model nowy-model --set generationUrlValue=gen-iii
npm run cars -- model mapping --source otomoto --model nowy-model --set supported=true
npm run cars -- sync
npm run cars -- validate
```

Wartości mapowania nie są zgadywane automatycznie. `makeSlug`, `modelSlug` oraz portalowe identyfikatory (gdy portal ich używa) trafiają do mapowania źródło/model. Zasady tworzenia URL-i i wyjątków znajdują się w `src/search/direct/adapters/<source>.mjs`.

## Zmiana kryteriów

Edytuj `config/models/<key>.json` albo użyj `model criteria` / `model fields`, a następnie:

```powershell
npm run cars -- sync
npm run cars -- validate
```

Podstawowe wartości profilu można zmienić z CLI, np.:

```powershell
npm run cars -- model criteria --model kia-xceed --set maximumAdvertisedPricePln=60000 --set yearMin=2020
npm run cars -- model fields --model kia-xceed --set optional='["location","photos","fuel"]'
npm run cars -- sync
npm run cars -- validate
```

Limity `minimumPricePln` i `maximumAdvertisedPricePln` są porównywane z kwotą podaną w ogłoszeniu, niezależnie od tego, czy portal oznacza ją jako netto czy brutto. Rozpoznana podstawa ceny może być zapisana jako informacja, ale nie blokuje kwalifikacji oferty.

Użyj `npm run cars -- model deactivate --model <key>`, aby wstrzymać profil bez usuwania danych. `model remove` usuwa profil, jego mapowania i bazę ofert danego modelu.

## Dodanie portalu

```powershell
npm run cars -- source add --id nowy-portal --name "Nowy portal" --adapter nowy-portal --search-url https://example.pl/samochody
```

Polecenie tworzy wyłączoną konfigurację i wyłączone mapowania dla profili modeli. Dodaj adapter do `src/search/direct/adapters/`; nie trzeba zmieniać wspólnego loadera. Adapter dostaje `source.adapterConfig` i per-model `adapterOptions.modelMappings`. Sprawdź `npm run cars -- urls --source nowy-portal --model <key>`, a po weryfikacji portalu włącz źródło i wybrane mapowania:

```powershell
npm run cars -- source activate --id nowy-portal
npm run cars -- model mapping --source nowy-portal --model <key> --set supported=true
npm run cars -- validate
```

`source deactivate` zatrzymuje wyszukiwanie, a `source remove` usuwa konfigurację źródła i mapowania; zapisane oferty i linki pozostają w bazie.
