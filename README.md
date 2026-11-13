# CarOffers — osobista baza ofert samochodów

Statyczna aplikacja działająca na GitHub Pages, bez backendu, frameworka,
zewnętrznych fontów i zależności produkcyjnych. Nie wymaga `npm install` ani
budowania. JavaScript korzysta z natywnych modułów ES; wszystkie ścieżki są
względne, więc aplikacja działa również pod adresem `użytkownik.github.io/repo/`.

## Co można zrobić na stronie

- Przeglądać wszystkie modele lub wybrać kilka, korzystać z kart i tabeli.
- Przeglądać aktywne oferty osobno od archiwum zamkniętych, niezweryfikowanych
  i ręcznie wykluczonych aut; archiwum nie wchodzi do kolejki sprawdzania.
- Filtrować cenę, przebieg, roczniki, nadwozie, skrzynię, silnik, źródło, kamerę,
  LPG, zgodność, dostępność, datę odczytu i własny status.
- Odtworzyć filtry z URL lub zapisać wyszukiwanie pod własną nazwą.
- Zapisywać ulubione, porównywać do 4 aut, dodawać notatki i własne statusy.
- Eksportować/importować kopię własnych danych w JSON. Dane nie synchronizują
  się automatycznie między przeglądarkami, urządzeniami ani różnymi adresami strony.
- Przeglądać wiedzę o modelach i źródła twierdzeń oraz raport pokrycia portali.
- Obliczyć odległość w linii prostej od jednego z 39 dużych miast lub własnego punktu, wyłącznie dla ofert
  z udokumentowanymi współrzędnymi. Brak danych nie jest odległością zero.
- Korzystać z jasnego i ciemnego motywu oraz układu mobilnego.

Strona nie sprawdza sama ogłoszeń na portalach. „Wczytaj dane ponownie” pobiera
zapisane pliki JSON. Karty pokazują status dostępności bez dokładnej daty odczytu;
daty znajdują się w szczegółach oferty. „Dodano do bazy” oznacza pierwszy zapis
oferty w bazie, a nie datę jej publikacji. Ostatni udany odczyt, ostatnia próba
i przeliczenie oceny to osobne zdarzenia; data oceny ani data raportu nie
potwierdzają aktualności ogłoszenia. Daty i godziny są wyświetlane w strefie
Europe/Warsaw. Lokalizacje z historycznych tytułów są oznaczone jako historyczne.
Odległość dotyczy punktu miejscowości, nie adresu samochodu ani trasy dojazdu.
Brak miejscowości lub niejednoznaczne współrzędne są pokazane jawnie.

## Pliki aplikacji

| Plik | Odpowiedzialność |
|---|---|
| `index.html` | Dostępna struktura strony i formularze |
| `app.js` | Sterowanie widokami, URL, interakcje i uruchomienie |
| `assets/styles.css` | Układ responsywny i oba motywy |
| `assets/core.mjs` | Filtry, normalizacja wyświetlania, daty, duplikaty i odległość |
| `assets/data.mjs` | Odczyt plików i kontrola aktualności oceny |
| `assets/storage.mjs` | Prywatne dane lokalne i kopie zapasowe |
| `assets/views.mjs` | Karty, tabela, porównanie, szczegóły, wiedza i aktualizacje |
| `models.json`, `offers/*.json` | Indeks modeli, aktywne oferty i oddzielna kolekcja `archivedOffers` |
| `data/*.json` | Katalog miast, udokumentowane lokalizacje i dowody odczytu |
| `config/*.json`, `knowledge/models/*.json` | Wymagania, wybrane modele, źródła i wiedza |
| `reports/current-assessment.json` | Wyniki lokalnego silnika oceny |
| `reports/dashboard.json` | Statyczne podsumowanie przebiegów wyszukiwania |

Filtry wyświetlania grupują historyczne opisy typu „manualna” i „Manualna,
6 biegów”. Nie stają się przez to potwierdzonymi polami technicznymi oferty.
Własny status, np. „Oględziny”, nie zmienia wyniku `match/check/fail`.

## Uruchomienie lokalne

Z katalogu projektu:

```powershell
python -B -m http.server 8000 --bind 127.0.0.1
```

Otwórz `http://127.0.0.1:8000/`. Nie korzystaj z `file://`, ponieważ przeglądarka
może blokować moduły i odczyt JSON. Lokalne narzędzia w sandboxie mogą wymagać
osobnej zgody na uruchomienie serwera poza ograniczeniami sieciowymi.

## Aktualizowanie danych

Konfiguracja jest nadrzędna wobec historycznych opisów. Główne pliki:
`config/requirements.json`, `config/search-models.json`, `config/sources.json`.
Nie zmieniaj wyłącznie opisów na stronie, aby zmieniać reguły wyszukiwania.

Po zmianie ustawień:

```powershell
python -B scripts/car-search.py sync
python -B scripts/car-search.py validate
python -B scripts/car-search.py assess
python -B scripts/generate-dashboard.py
python -B scripts/validate-offers.py
```

Po sprawdzeniu wyników pracowników:

```powershell
python -B scripts/car-search.py import-preview --run IDENTYFIKATOR
python -B scripts/car-search.py import-apply --run IDENTYFIKATOR
python -B scripts/car-search.py assess
python -B scripts/generate-dashboard.py
python -B scripts/validate-offers.py
```

`generate-dashboard.py` nie przeszukuje internetu. Odczytuje `runs/*/tasks.json`
i wyniki zadań, zachowując rozróżnienie przeszukania częściowego, blokady,
braku dopasowań i zadań niezakończonych. Uruchom go po zmianie stanów/wyników.

Dokumentacja jest zebrana w [indeksie tematów](docs/README.md). Szczegóły:
[obsługa wyszukiwania](docs/obsluga-wyszukiwania.md),
[import i historia](docs/import-ofert.md), [kontrakt danych](docs/data-contract-v2.md),
[założenia](docs/porzadek-projektu.md).

Instrukcje dla agenta: [punkt wejścia](AGENTS.md), [mapa projektu](docs/architektura-dla-agenta.md)
i poradniki zależne od zadania w [`docs/agent/`](docs/agent/).

Lokalizacje i ich odtwarzanie opisuje [dokumentacja lokalizacji](docs/lokalizacje.md).

## Testy

```powershell
npm test
python -B -m unittest discover -s tests -v
```

`npm test` uruchamia oba zestawy testów JavaScript zdefiniowane w `package.json`;
instalacja pakietów nie jest do nich potrzebna. Testy jednostkowe nie zastępują
sprawdzenia rzeczywistego układu w przeglądarce.

## GitHub Pages

Publikuj zawartość katalogu projektu w katalogu głównym repozytorium i wybierz
odpowiednią gałąź oraz `/ (root)` w ustawieniach Pages. Zachowaj `assets/`,
`config/`, `data/`, `knowledge/`, `offers/`, `reports/`, `models.json`, `app.js`, `index.html`
i `.nojekyll`. Samo podmienienie HTML nie wystarczy.

Nie są wymagane klucze API, Node na serwerze, rewrites ani obsługa tras backendu.
Nawigacja używa fragmentu `#`, więc odświeżenie podstrony nie powoduje 404.
Zachowano obsługę starszych linków `#hyundai-i30-iii-wagon`.

Istniejący workflow `.github/workflows/update-models.yml` generuje indeks modeli
po zmianach ofert. Raport oceny i raport aktualizacji należy przygotować przed
publikacją; workflow indeksu nie uruchamia wyszukiwania.

Kod, konfiguracja i pliki raportów wdrożone na publicznym GitHub Pages są publiczne.
Prywatne notatki i punkt startowy pozostają w localStorage, dopóki sam użytkownik
nie wyeksportuje i nie udostępni kopii. Nie umieszczaj kopii osobistych w repozytorium.

Zmiany w tej sesji przygotowano lokalnie. Publikacja i wysłanie zmian do repozytorium
wymagają osobnej akceptacji użytkownika.
