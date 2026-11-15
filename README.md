# CarOffers

CarOffers to statyczny katalog ofert samochodów publikowany na GitHub Pages oraz lokalne narzędzie do bezpośredniego przeszukiwania portali. Obecnie skonfigurowane źródła to OTOMOTO i AAA Auto. Aplikacja strony nie łączy się z portalami — pokazuje dane z plików JSON.

## Strona

Strona pokazuje wyłącznie karty ofert. Można wyszukiwać tekstem, filtrować po modelu, roczniku, cenie i przebiegu oraz sortować wyniki. Karta zawsze pokazuje cenę, rok produkcji, przebieg i silnik. Pola VIN, pierwszej rejestracji, skrzyni i nadwozia są widoczne również wtedy, gdy źródło ich nie podało; brak jest wyróżniony. Lokalizacja, zdjęcia, kamera i paliwo pojawiają się tylko wtedy, gdy są dostępne.

Gdy dokładny VIN łączy ogłoszenia z kilku portali, karta zachowuje osobne linki i pozwala wybrać źródło. Bez zgodnego VIN ogłoszenia pozostają odrębnymi rekordami. Różnice w odczytanych polach są oznaczane na karcie.

## Uruchamianie narzędzi

Wymagane są Node.js, zależność Playwright i Chromium. Zainstalowanie przeglądarki wykonuje się raz:

```powershell
npm install
npm run install:browser
```

Lokalny podgląd statycznej strony uruchom poleceniem `npm run preview`, a następnie otwórz `http://127.0.0.1:4173`. Serwer działa tylko lokalnie; port można zmienić przez ustawienie zmiennej środowiskowej `PORT`.

Najważniejsze polecenia:

```powershell
npm run cars -- validate
npm run cars -- sync
npm run cars -- models
npm run cars -- models --source otomoto
npm run cars -- urls --source otomoto [--model kia-xceed]
npm run cars -- search --source otomoto
npm run cars -- search --source aaaauto --model kia-xceed
npm run cars -- import --run <run-id>
```

W wyszukiwaniu źródło jest obowiązkowe. Bez `--model` narzędzie uruchamia wszystkie aktywne modele z włączonym mapowaniem dla źródła. Domyślnie wyszukiwanie działa w widocznym Chromium i zapisuje zgodne wyniki do katalogu ofert. Do podglądu bez importu służy `--no-import`; `--filters-only` sprawdza konfigurację filtrów.

Wyniki techniczne przebiegu są tymczasowe. Po udanym imporcie katalog wyników jest czyszczony. Przy braku sieci, błędzie portalu, timeout, blokadzie lub challenge oferty nie są usuwane ani uznawane za nieaktywne.

## Konfiguracja

- `config/models/<model>.json` — tożsamość modelu, kryteria oraz wymagane, półwymagane i opcjonalne pola.
- `config/sources/<source>.json` — portal, adapter, adres wyszukiwania, limity i ustawienia adaptera.
- `config/source-mappings/<source>/<model>.json` — nazwy, identyfikatory i wyjątki filtrów konkretnego portalu dla konkretnego modelu.
- `config/search-runtime.json` — domyślne limity przebiegu.
- `knowledge/models/<model>.json` — źródła wiedzy i aliasy silników; nie zastępuje kryteriów wyszukiwania.

Dodanie modelu zaczyna się od:

```powershell
npm run cars -- model add --key nowy-model --name "Marka Model" --brand Marka --model Model --year-min 2019 --price-min 30000 --price-max 55000 --mileage-max 170000 --engines "1.5-turbo-150,2.0-hybrid-180"
```

Polecenie tworzy profil kryteriów i pól, kartę wiedzy, pusty plik ofert i wyłączone mapowania. URL można obejrzeć bez połączenia z portalem. Mapowanie źródła włącza się dopiero po sprawdzeniu filtrów i adresu na portalu:

```powershell
npm run cars -- urls --source otomoto --model nowy-model
npm run cars -- model mapping --source otomoto --model nowy-model --set generationUrlValue=gen-iii
npm run cars -- model mapping --source otomoto --model nowy-model --set supported=true
npm run cars -- model criteria --model nowy-model --set maximumAdvertisedPricePln=60000 --set yearMin=2020
npm run cars -- model fields --model kia-xceed --set optional='["location","photos","fuel"]'
npm run cars -- sync
npm run cars -- validate
```

Każdy nowy portal wymaga adaptera w `src/search/direct/adapters/`, konfiguracji źródła i mapowań modeli. Konfiguracje źródeł są niezależne, dzięki czemu przyszłe portale nie wymagają zmiany profili kryteriów.

Szkielet nowego, wyłączonego źródła i mapowań tworzy:

```powershell
npm run cars -- source add --id nowy-portal --name "Nowy portal" --adapter nowy-portal --search-url https://example.pl/samochody
```

Po dodaniu adaptera, który czyta ustawienia źródła i `adapterOptions.modelMappings`, zweryfikuj generowanie URL-i, włącz źródło poleceniem `npm run cars -- source activate --id nowy-portal`, a następnie włącz wybrane mapowania modeli.

## Dane ofert

`offers/<model>.json` jest statycznym wejściem strony. Kontrakt v3 przechowuje jeden rekord auta z listą źródłowych ogłoszeń i osobnymi faktami z każdego źródła. Rekordy scala się automatycznie wyłącznie po zgodnym VIN. Dane pierwszego źródła pozostają nadrzędne; przy jego usunięciu wybrano by pierwsze aktywne źródło jako zastępcze. Pełny ponowny odczyt zastępuje poprzednie fakty danego linku i czyści pola, których portal już nie zwrócił.

Nie edytuj `offers/*.json` ręcznie. Używaj wyszukiwania i importera. Migracja z wcześniejszego formatu jest dostępna przez `npm run cars -- migrate-offers`.

Sprawdzenie danych i konfiguracji:

```powershell
npm run cars -- validate
```

## Mapa kodu

- `scripts/cars.mjs` — jedyne wejście CLI; `src/cli/` rozdziela obsługę konfiguracji, modeli, źródeł i wyszukiwania.
- `src/config/` — wczytywanie profili, źródeł i mapowań.
- `src/search/direct/` — orkiestracja przebiegu, kryteria, dane kart i adaptery portali.
- `src/search/shared/` — odczyt i kwalifikowanie kart źródłowych.
- `src/offers/` — normalizacja, migracja oraz tworzenie, aktualizacja i usuwanie baz ofert.
- `assets/` i `app.js` — statyczny interfejs kart.
- `schemas/` — aktualne kontrakty profilu, źródła, mapowania, wiedzy, indeksu v2 i ofert v3.
- `models.json` — wygenerowany indeks statycznej strony.

Szczegóły opisują [architektura](docs/architecture.md), [wyszukiwanie](docs/direct-search.md) i [kontrakt danych](docs/data-contract-v3.md).

Testy jednostkowe bez połączeń z portalami uruchomisz poleceniem `npm test`.
