# Obsługa konfiguracji i zadań

## Gdzie zmieniać ustawienia

- `config/requirements.json`: `purchase.maxPriceGrossPln` to limit ceny zakupu;
  `mileage.preferredMaxKm` to preferencja, `hardMaxKm: null` oznacza brak twardego limitu.
- `config/search-models.json`: aktywność, nadwozia, silniki, priorytet i lata każdego modelu.
  Identyfikatory silników są lokalnymi etykietami wyszukiwania, nie kodami producenta.
- `config/sources.json`: aktywność i priorytety portali. `brands: []` oznacza brak ograniczenia marki.
- `knowledge/models/`: fakty techniczne z odnośnikami i jawnymi lukami.

Potwierdzone: rocznie 12–15 tys. km, typowa jazda miejska około 30 minut,
LPG dopuszczone i oznaczane, zakup aukcyjny wykluczony. Czasu nie przeliczamy na
niepodaną odległość. Pozostałe pola `openQuestions` czekają na uzupełnienie. Zakres silników
jest przeniesiony z dotychczasowego projektu i wymaga przeglądu na podstawie kart.

## Polecenia z katalogu projektu

```powershell
python -B scripts/car-search.py validate
python -B scripts/car-search.py sync
python -B scripts/validate-offers.py
python -B scripts/car-search.py assess
```

`sync` aktualizuje wyłącznie teksty wymagań przy modelach w plikach ofert oraz
indeks strony. Nie przepisuje danych ani historycznych ocen samochodów.
`assess` zapisuje `reports/current-assessment.json` według bieżącej konfiguracji.
Brak nowych pól dowodowych w historycznej ofercie skutkuje `check`, a nie
domniemanym spełnieniem warunków. Raport nie sprawdza aktualności ogłoszeń w sieci.
Warianty mają dodatkowe reguły powiązane ze źródłami, np. rozbieżność daty produkcji
Golfa 1.4 TSI lub nadwozia Corolli 1.6 wymaga wyjaśnienia. LPG trafia do uwag oceny;
oferta aukcyjna jest odrzucana. Dla nowych wyników zapisuj `saleType: fixed_price|auction`
i `lpgInstalled: true|false`, a dla nieustalonej instalacji `null`.
Zmiana budżetu wymaga ponownego `sync` i `assess`; strona nie wykonuje tych operacji sama.

## Przygotowanie przebiegu

```powershell
python -B scripts/car-search.py plan --run nowe-oferty-2026-11-08 --agents 3
python -B scripts/car-search.py claim --run nowe-oferty-2026-11-08 --worker agent-1
```

`plan` tworzy kolejkę portal × model z gotowym profilem wyszukiwania w każdym
zadaniu (adres, dostępne i ręcznie sprawdzane filtry, rocznik, silniki, cena,
przebieg, nadwozie, lokalizacja i wykluczenie aukcji), kopię konfiguracji i kart
wiedzy oraz ich skrót SHA-256. Profil zawiera też `queryPlan`: portalowe filtry,
zapytanie bazowe i zapytania dla wariantów silnika wraz z aliasami. Najpierw
stosuj dostępne filtry portalu, a potem wykonuj przygotowane zapytania.
Profil zawiera też `candidateScreening`: twarde
granice rocznika produkcji, ceny, przebiegu, nadwozia, wariantu silnika i typu
sprzedaży dla danej pary portal–model. Używaj ich do odsiewania listy wyników
przed otwieraniem kart. Odrzucaj tylko widoczne, jednoznaczne naruszenia; brak
albo niejasność pola oznacza sprawdzenie karty, jeśli pozostałe dane pasują.
Źródło markowe dostaje zadanie tylko dla pasującej marki; wyłączone i aukcyjne
źródła nie trafiają do kolejki. Nie przeszukuje
sieci ani nie uruchamia agentów. Kolejny przebieg
wymaga nowego ID, co chroni poprzednie wyniki. Wybór marek źródła ogranicza kolejkę.
Pole `--agents` oznacza planowaną liczbę subagentów; koordynator nie jest wliczany.

Domyślny przebieg obejmuje wszystkie aktywne modele oraz wszystkie aktywne,
nieaukcyjne portale, których zakres marki pasuje do modelu. Zadania pozostają
osobne dla par portal × model. Dla krótszego przebiegu koordynator przydziela
każdemu wykonawcy stały portal lub małą grupę portali przez `claim --source`;
ten sam wykonawca pobiera następny model z tego zakresu po zapisaniu i kontroli
poprzedniego wyniku. Przydziały i zakończenia kolejki wykonuj szeregowo, a strony
w ramach jednego zadania przeglądaj w jednym ciągłym przebiegu. Ogranicza to
przełączanie kontekstu i reaktywowanie bezczynnych wykonawców. Każdy wykonawca
może mieć najwyżej jedno aktywne zadanie. `--agents` nie uruchamia subagentów ani
nie zwiększa limitów sesji; liczbę aktywnych wykonawców dopasuj do dostępnych
miejsc w sesji.

Wyszukiwanie dodaje tylko nowe dostępne oferty. Aktywny duplikat jest pomijany
— jego odświeżanie należy do osobnego przepływu. Dostępna oferta pasująca do auta
w archiwum może przywrócić je do aktywnej bazy. Nieznane pola pozostają jawnie
nieznane, a ocena nowej oferty może mieć status `check`.

Przy zadaniu wyszukiwania `claim` dołącza `sharedResultsCache` ze stronami wyników,
snippetami widocznych ofert i URL-ami kart sprawdzonymi wcześniej w tym samym
przebiegu i portalu. Użyj go do pominięcia ponownego otwierania tych samych stron
i kart. Migawka listy nie zastępuje otwarcia karty ani dowodów i nie potwierdza,
że oferta nadal jest dostępna. Każdą sprawdzoną stronę wyników zapisz jako
`coverage.searchResults`, wraz z widocznymi listingami i ich URL-ami. Każdą próbę
otwarcia karty zapisz w `coverage.listingUrlsChecked`, także gdy wystąpił błąd.
Jeśli strona pokazuje link do następnej strony, zachowaj jego dokładny adres w
`nextUrl`, żeby cache mógł wznowić paginację bez konstruowania URL-a.

### Szybszy odczyt w Playwright

Projekt udostępnia narzędzie `scripts/playwright-pages.mjs`, które odwiedza
podane adresy w jednej przeglądarce i kontekście, bez ponownego uruchamiania
Chromium dla każdej strony. Zwraca tekst i linki z renderowanej strony oraz
metadane XHR/Fetch. Przykład:

```powershell
npm run browse:pages -- --url "https://sprzedajemy.pl/motoryzacja/samochody-osobowe/hyundai/i30" --url "https://sprzedajemy.pl/motoryzacja/samochody-osobowe/hyundai/i30?offset=30"
```

Gdy portal ma widoczny link do kolejnej strony, można podać jego selektor i
limit, np. `--next-selector "a.next" --max-pages 5`. Narzędzie przechodzi wtedy
po `href` linku w tej samej sesji i pomija URL-e już odwiedzone. `--max-pages`
przyjmuje wartości 1–100; wartość ponad 1 wymaga `--next-selector`. Dla
paginacji JavaScriptowej lub niestandardowej podaj jawne URL-e albo skorzystaj
z interfejsu portalu.

Przy stronie ładowanej dynamicznie podaj `--ready-selector "<selektor wyników>"`.
`--include-api-json` dołącza JSON z odpowiedzi XHR/Fetch, jeśli odpowiedź ma do
2 MB; domyślnie narzędzie zapisuje tylko ich URL, status i typ treści. Opcje
`--block-types image,font,media` są dobrowolne i wymagają pomiaru dla źródła.
Bez opcji paginacji narzędzie odwiedza wyłącznie podane URL-e; z `--next-selector`
przechodzi też po widocznych linkach `href` do wskazanego limitu stron. Nie klika
filtrów, nie loguje się, nie ponawia żądań i nie zapisuje ofert do bazy.

### Adapter Sprzedajemy

`scripts/sprzedajemy-search.mjs` jest pierwszym adapterem źródłowym. Na podstawie
aktywnego `modelKey` odczytuje widoczne linki marki i modelu w kategoriach
portalu, buduje filtrowany URL bez zgadywania slugów, pobiera widoczne karty z
listy i przechodzi po linku „Następna”. Przy kilku kluczach modeli współdzieli
odczyt stron kategorii marek w jednej sesji:

```powershell
npm run search:sprzedajemy -- --model-key hyundai-i30-iii-wagon --max-pages 2
```

Można powtórzyć `--model-key` dla kolejnych aktywnych modeli. Wynik jest migawką
kandydatów w JSON na standardowym wyjściu, a nie plikiem wynikowym zadania:
adapter nie otwiera kart, nie potwierdza dostępności i nie filtruje rocznika,
ceny, przebiegu, nadwozia ani silnika. Przekaż kandydatów do zwykłego
`candidateScreening` i kontroli kart. Nie używaj tej migawki bezpośrednio w
`finish` ani imporcie. `--max-pages` domyślnie wynosi 1; niewczytane strony są
jawnie wskazane w polu `remaining`.

W aktywnym przebiegu użyj wejścia z `claim`, żeby adapter korzystał z profilu
zamrożonego w zadaniu zamiast z bieżącej konfiguracji:

```powershell
python -B scripts/car-search.py claim --run <run-id> --worker <worker-id> --source sprzedajemy |
  node scripts/sprzedajemy-search.mjs --claim-stdin --max-pages 2
```

W tym trybie adapter wymaga zadania `kind: search`, `state: running` i
`sourceId: sprzedajemy`. Zwraca `taskId` oraz `coverage` (`searchUrls`,
`pagesChecked`, `searchResults`, `listingUrlsChecked`) do wykorzystania przy
przygotowaniu standardowego wyniku zadania. Dokładnie pasującą stronę z
`sharedResultsCache` wykorzystuje zamiast ponownego wejścia; jej `nextUrl` jest
przenoszony do cache kolejnego zadania, by można było kontynuować paginację bez
odgadywania adresu. Cache nadal jest tylko migawką wyników. Adapter sam nie
wywołuje `finish` i nie zapisuje plików w `runs/`.

Wykonawca powinien utrzymywać jedną przeglądarkę i kontekst Playwright przez
cały przydzielony zakres portalu. Dla stron wyników używaj nawigacji
`waitUntil: "domcontentloaded"`, a następnie czekaj na selektor wyników lub
odpowiedź danych, zamiast czekać na `networkidle`. Blokowanie fontów, mediów lub
obrazów włączaj tylko wtedy, gdy pomiar dla danego portalu potwierdzi krótszy
czas i zachowanie kompletności wyników. Przy otwieraniu kart odczytaj widoczne
bezpośrednie URL-e HTTPS zdjęć; nie używaj samych zdjęć jako dowodu. Jeśli
strona już pobrała XHR/Fetch z listą wyników, przetwarzaj tę odpowiedź z bieżącej
sesji zamiast powtarzać to samo żądanie.

### Pilotaż czytnika portali

Po zmianie wspólnego czytnika można wykonać jednozapytaniowy, tylko odczytowy
pilotaż dla wszystkich aktywnych źródeł:

```powershell
npm run pilot:portals
```

Pilotaż korzysta z profili z anulowanego przebiegu jako zamrożonych szablonów,
ale nie zmienia kolejki. Dla każdego portalu otwiera stronę wyników, próbuje
jedno zapytanie i zapisuje wyłącznie liczbę widocznych kandydatów, stan odczytu
i błędy do `reports/portal-adapter-pilot.json`. Nie otwiera kart, nie tworzy
ofert ani nie potwierdza kompletności wyszukiwania. Wyniki służą do wskazania
portali wymagających osobnego selektora lub adaptera.

Zweryfikowane selektory tekstowego pola wyszukiwania są zapisane w
`config/portal-adapters.json`. Brak wpisu oznacza, że adapter nie wpisuje
zapytania w zgadywane pole; najpierw używa już widocznych wyników. Gdy strona
pokazuje wyłącznie konfigurację lub blokadę, pozostawia zakres niepełny.

Strukturę publicznie widocznych formularzy, selektorów kart i paginacji można
zebrać poleceniem `npm run inspect:portals`. Raport zapisuje nazwy i liczniki
elementów DOM oraz metadane odpowiedzi XHR/Fetch; nie zapisuje ofert.

Po pilotażu wyników można sprawdzić niewielką próbkę kart przez
`npm run pilot:cards`. Polecenie wybiera tylko wcześniejsze próbki spoza aktywnej
i archiwalnej bazy, odczytuje widoczne etykiety pól i nie wyciąga wniosków ze
zdjęć. Raport trafia do `reports/portal-card-pilot.json`.

Po kolejnych pilotażach czasy można porównać offline poleceniem
`npm run compare:portal-pilots`. Czytnik czeka teraz na widoczne karty zamiast
zawsze odczekiwać stałe 900 ms. Obrazy, fonty i media pozostają włączone, bo
wcześniejszy pomiar Sprzedajemy nie wykazał zysku z ich blokowania.

W pilotażu na publicznych wynikach Sprzedajemy wykonano siedem naprzemiennych
prób każdego wariantu. Mediana nawigacji `domcontentloaded` wyniosła około
1,72 s bez blokowania zasobów i 1,79 s z blokowaniem obrazów/fontów/mediów;
różnica nie potwierdza korzyści z blokowania. To pomiar jednego portalu i nie
przewiduje zachowania pozostałych źródeł.

Te zasady ograniczają zbędne oczekiwanie, ale nie zmieniają zakresu wyszukiwania
ani wymagań dowodowych. Przy CAPTCHA, błędzie certyfikatu, `robots.txt` lub
odmowie dostępu nie próbuj obchodzić blokady; zapisz błąd i użyj właściwego
statusu częściowego albo zablokowanego.

Po zapisaniu wyniku zgodnego z formatem w `AGENTS.md`:

```powershell
python -B scripts/car-search.py finish --run proba-i30 --task otomoto--hyundai-i30-iii-wagon --result partial --note "Sprawdzono pierwszą stronę"
```

`finish` waliduje cały plik wyniku i obserwacje przed zmianą stanu zadania.
Jeśli walidacja się nie powiedzie, zadanie pozostaje `running`, a odrzucona wersja
wyniku trafia do `runs/<run-id>/results/rejected/`. Popraw wynik, zachowując
odrzuconą kopię, i ponów `finish`.

Przy długim wyszukiwaniu kończ partię zadań, a przed kolejnymi przydziałami
uruchamiaj checkpoint importu:

```powershell
python -B scripts/car-search.py import-preview --run nowe-oferty-2026-11-08
python -B scripts/car-search.py import-apply --run nowe-oferty-2026-11-08
python -B scripts/car-search.py assess
python -B scripts/validate-offers.py
```

`import-preview` uwzględnia zakończone zadania, a pomija oczekujące i działające.
Po zastosowaniu podglądu można kontynuować ten sam przebieg i powtórzyć
checkpoint; rejestr importu pomija wyniki już zastosowane. Stosuj tylko podgląd
bez konfliktów. Nie uruchamiaj checkpointu podczas zapisu wyniku przez wykonawcę.
Jeśli pojawi się konflikt, zatrzymaj import, zachowaj wynik i rozwiąż konflikt
przed zastosowaniem zmian.

Stan `complete` dotyczy zadania, nie zakupu auta ani publikacji. Koordynator
sprawdza `import-preview`; jeśli nie ma konfliktów ani błędów walidacji, stosuje
nowe wpisy lokalnie przez `import-apply`, a potem uruchamia `assess` i walidację.
Użytkownik dostaje wyłącznie listę nowych albo przywróconych ofert, bez końcowego
raportu pokrycia. Publiczna strona GitHub Pages wymaga osobnej akceptacji publikacji.
Pełny kontrakt: [import ofert](import-ofert.md).

## Weryfikacja wszystkich zapisanych ogłoszeń

`refresh-plan` bez dodatkowych filtrów tworzy zadania dla wszystkich URL-i ofert
z aktywnej bazy. Oferta z archiwum nie jest odświeżana. Można zawęzić przebieg do
modeli/portali, wybrać konkretne ID-y albo ograniczyć go do ofert starszych niż
podany wiek. Przykłady:

```powershell
python -B scripts/car-search.py refresh-plan --run weryfikacja-2026-11-08 --agents 3
python -B scripts/car-search.py refresh-plan --run audyt-zdjec --photo-audit --offer listing:otomoto:ID6IjeFS
python -B scripts/car-search.py refresh-plan --run stare-oferty --older-than-days 7 --model hyundai-i30-iii-wagon
python -B scripts/car-search.py refresh-plan --run odswiez-wybrane --offer listing:otomoto:ID6IjeFS
python -B scripts/car-search.py claim --run weryfikacja-2026-11-08 --worker agent-1 --source otomoto
```

Plan próbuje przypisać każdy URL do portalu na podstawie hosta; nierozpoznane,
wyłączone lub niejednoznaczne źródła zapisuje w `unmappedTargets` i pokazuje
w podglądzie jako pominięte. Taki przebieg nie jest pełną weryfikacją. Dla
rozpoznanych stron plan
uwzględnia także rekordy, które wcześniej miały status `sold` lub `removed`, aby
potwierdzić zamknięcie i przenieść je do archiwum. Filtr wieku opiera się na dacie
ostatniego udanego odczytu konkretnego URL-a; brak historii oznacza, że oferta
kwalifikuje się do sprawdzenia. Każde zadanie zawiera listę
`refreshTargets` z ID oferty, adresem i poprzednią ceną. Samo przygotowanie planu
nie odwiedza stron.

`--photo-audit` wymaga dla każdego targetu jawnego `observation.photoCheck`.
Status `found` wymaga co najmniej jednego bezpośredniego URL-a HTTPS w `photos`;
`no_direct_https` oznacza, że karta nie udostępnia takiego adresu, a
`access_error` jest wymagany przy błędzie odczytu. Dzięki temu pominięcie pola
`photos` nie ukrywa już faktu, że zdjęć nie sprawdzono.

Subagent sprawdza wyłącznie wskazane karty i zapisuje obserwację dla każdego
targetu w zwykłym `results/<task-id>.json`. `complete` wymaga odczytu każdego
URL-a oraz wyniku obserwacji dla każdego targetu. Błąd dostępu nie jest
potwierdzeniem sprzedaży i nie aktualizuje daty ostatniej weryfikacji. Zadanie
odświeżania nie używa `no_matches`, bo znane ogłoszenia już istnieją.
Także wynik `partial` lub `blocked` zapisuje jedną obserwację dla każdego
targetu, z `availability: access_error` dla kart, których nie udało się otworzyć.
`finish` sprawdza zakres, kompletność i duplikaty obserwacji przed zamknięciem.

Po imporcie `lastVerifiedAt` aktualizuje się tylko po udanym ustaleniu statusu.
Jeśli każde ogłoszenie powiązane z autem zostało potwierdzone jako sprzedane lub
usunięte, cały rekord trafia z `offers` do `archivedOffers`; historia i dowody
zostają zachowane. Jeśli choć jeden portal ma status dostępny albo nieustalony,
rekord pozostaje aktywny. Oferta nadal dostępna, ale niezgodna z kryteriami,
pozostaje aktywna z wynikiem `fail` — nie jest mylona ze sprzedażą. Nowa
obserwacja `available` dla zarchiwizowanego auta
przywraca je do `offers`. Koordynator używa `import-preview`, przegląda zmiany,
a potem `import-apply` oraz walidację.

## Walidacja i publikacja

### Kontrola dostępności źródeł i Playwright

Po `npm install` pobierz Chromium do lokalnego cache projektu i sprawdź strony
wszystkich aktywnych portali:

```powershell
npm run install:browser
npm run check:sources
```

Kontrola zwraca status HTTP, adres końcowy, tytuł, widoczność tekstu oraz
metadane odpowiedzi XHR/Fetch. Nie zapisuje ofert, nie loguje się i nie omija
blokad. `200` oznacza, że załadowała się strona, a nie że wyniki konkretnego
modelu zostały przeszukane. `403`, błąd TLS lub strona wyzwania oznacza
`blocked`; takiego źródła nie oznaczaj jako `no_matches`.

Po udanym `claim` można uruchomić `npm run search:portal -- --claim-stdin` dla
wspólnego odczytu widocznych kart wyników. Adapter wykonuje zapytania tekstowe
z zamrożonego `queryPlan`, próbuje widocznej paginacji i zwraca wyłącznie
`coverage.searchResults`; nie otwiera kart i nie potwierdza dostępności, ceny
ani wyposażenia. Wynik pozostaje `partial`, dopóki wykonawca nie sprawdzi ofert.
Dla portalu o innej strukturze dodaj dedykowaną strategię zamiast rozszerzać
heurystykę tak, by zgadywała pola. Sprzedajemy zachowuje osobny adapter kategorii.

```powershell
python -B -m unittest discover -s tests -v
node --test tests/test_app.cjs
```

Nowe schematy są sprawdzane tym samym ograniczonym silnikiem JSON Schema co
dotychczasowe oferty. Walidacja sprawdza typy i odwołania, nie prawdziwość źródeł.
Nie publikowano zmian. Przed publikacją potrzebna jest walidacja ofert oraz
akceptacja użytkownika zgodnie z założeniami projektu.

### Pilotaż adapterów i pomiar czasu

`npm run pilot:portals` wykonuje ograniczony, tylko do odczytu pilotaż dla aktywnych źródeł. Raport zapisuje liczbę widocznych kandydatów, pokrycie pól i czasy, ale nie tworzy zadań ani nie importuje ofert. `npm run inspect:portals` zapisuje strukturę kontrolek i kształt odpowiedzi JSON; sama obecność odpowiedzi API nie oznacza, że zawiera ona oferty. `npm run pilot:cards` sprawdza próbki kart z poprzednich wyników, o ile nie ma ich już w aktywnej bazie ani archiwum. Raport podaje sygnały obecności pól, nie potwierdza faktów o aucie.

`npm run compare:portal-pilots` porównuje bazowy odczyt z adaptacyjnym oczekiwaniem na widoczne wyniki. W pilotażu z 9 listopada 2026 r. liczba kandydatów pozostała taka sama dla wszystkich 21 źródeł; dla 14 źródeł z kandydatami mediana czasu adaptera spadła z 2448 ms do 1635 ms. To pojedynczy pomiar stron wyników, nie gwarancja skrócenia pełnego wyszukiwania. Nie zidentyfikowano jeszcze sprawdzonego API z kompletnymi ofertami, więc adapter pozostaje oparty na widocznej stronie. Zasoby obrazów, fontów i mediów nie są blokowane, bo dotychczasowy test Sprzedajemy nie wykazał zysku z ich blokowania.
