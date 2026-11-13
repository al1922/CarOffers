# Wyszukiwanie, dostępność, odświeżanie i import

## Dane wejściowe

Przed pracą przeczytaj `config/requirements.json` jako szablon domyślny,
`config/search-models.json` z wymaganiami per model, `config/sources.json` oraz
odpowiednie `knowledge/models/*.json`. Wyszukiwanie i ocena używają
`models[].requirements`; szablon nie nadpisuje ustawień modelu.
Uruchom `python -B scripts/car-search.py validate`. Konfiguracja jest nadrzędna
wobec historycznych tekstów i ocen w ofertach. Nie rozluźniaj wymagań samodzielnie.
Wymagania budżetu, rodziny, przebiegu, kamery, LPG i sprzedaży są określone
oddzielnie przy każdym modelu; bieżące wartości startowe są takie same.
Warunki finansowania nie wpływają na kwalifikację ceny brutto. LPG musi być
oznaczone zgodnie z wymaganiami modelu i sprawdzone pod kątem dokumentów
instalacji/zbiornika. Zapisuj `saleType`
oraz `lpgInstalled`; nie utożsamiaj samego silnika benzynowego z brakiem LPG.
Zapisuj opcjonalne `publicationDate` (`YYYY-MM-DD`) tylko gdy portal jawnie
podaje datę publikacji; nie wyprowadzaj jej z czasu odczytu ani `firstSeenAt`.
Zbieraj również bezpośrednie adresy zdjęć widoczne na karcie ogłoszenia i zapisuj
je jako opcjonalną tablicę `photos` z URL-ami HTTPS. Zapisuj tylko zdjęcia danego
auta osadzone w ogłoszeniu, maksymalnie 12, bez pobierania plików. Nie wyciągaj
ze zdjęć faktów o stanie, wyposażeniu ani uszkodzeniach. Jeśli portal nie ujawnia
bezpośrednich adresów, zdjęcie jest niedostępne albo link nie jest HTTPS, pomiń je.

## Dostęp sieciowy dla wszystkich flow

Wyszukiwanie, `availability-plan`, `archive-availability-plan` i `refresh-plan`
odczytują portale na żywo. Uruchamiaj ich czytniki Playwright w środowisku z
dostępem do sieci zewnętrznej. Jeśli wiele niezależnych domen kończy się
`getaddrinfo ENOTFOUND`, `ERR_NAME_NOT_RESOLVED` lub `EAI_AGAIN` i nie ma kodu
HTTP, najpierw sprawdź ograniczenie DNS środowiska uruchomieniowego. Nie
interpretuj takiego wyniku jako blokady poszczególnych portali ani jako braku,
zamknięcia lub niedostępności ofert.

Jeśli platforma udostępnia zatwierdzone uruchomienie poza sandboxem, ponów w nim
ten sam dozwolony checker (`search:portal`, `availability-check.mjs` lub
czytnik refresh), zachowując zwykłe reguły źródła, `robots.txt` i dowodów. Jeśli
nie ma takiej możliwości, zatrzymaj część online, zachowaj diagnostykę i nie
importuj serii błędów DNS jako wyników flow. Pojedynczy błąd dla jednej domeny
może być jej własną awarią; traktuj go jako problem środowiska dopiero wtedy,
gdy obejmuje kilka niezależnych domen. Nie zmieniaj DNS, nie używaj proxy i nie
omijaj blokad ani CAPTCHA.

Przed dużym przebiegiem wykonaj tani preflight DNS: `npm run search:preflight
-- --run <run-id>`. Polecenie rozwiązuje hosty źródeł z kolejki i nie wysyła
żądań HTTP do portali. Przy `environment_dns_failure` przenieś ten sam dozwolony
checker do zatwierdzonego środowiska sieciowego; nie zaczynaj masowego `claim` i
nie zapisuj błędów DNS jako wyniku portalu. Poprawny DNS jest tylko warunkiem
wstępnym, nie dowodem dostępu HTTP ani dostępności ofert.

Plan, przydział, `finish` i import pozostają lokalne. Gdy zatwierdzone środowisko
sieciowe współdzieli ten sam checkout, można przekazać claim przez
`npm run search:network-worker -- --claim-stdin`. Gdy checkout nie jest
współdzielony, użyj przenośnego pakietu worker. Pakiet przenosi claim, cache
odczytów kart, listę aktywnych URL-i ogłoszeń oraz — przy kontynuacji — wynik
źródłowej próby. Nie przenosi `tasks.json` ani plików `offers/*.json`.

Przykładowy przepływ pakietowy w PowerShell:

```powershell
$runId = "<run-id>"
$worker = "network-1"
$claimJson = python -B scripts/car-search.py claim --run $runId --worker $worker
$claim = $claimJson | ConvertFrom-Json
$taskId = $claim.id
python -B scripts/car-search.py export-worker --run $runId --task $taskId
# Skopiuj katalog runs/$runId/worker-bundles/$taskId do zgodnego checkoutu
# w zatwierdzonym środowisku sieciowym, zachowując tę samą ścieżkę względną.
# W tym checkout, z zainstalowanymi zależnościami i przeglądarką Playwright:
npm run search:network-worker -- --bundle "runs/$runId/worker-bundles/$taskId"
# Skopiuj cały katalog pakietu z powrotem do lokalnego checkoutu.
python -B scripts/car-search.py collect-worker --run $runId --task $taskId
$resultPath = "runs/$runId/results/$($claim.id).json"
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
python -B scripts/car-search.py finish --run $runId --task $taskId --result $result.outcome
```

Pakiet zawiera manifest z SHA-256 plików wejściowych i używanego kodu,
konfiguracji, wiedzy modeli oraz definicji zależności. Worker odmawia pracy, gdy
checkout się różni. Środowisko sieciowe musi mieć zgodne pliki projektu,
zależności npm i przeglądarkę Playwright. Odbiór sprawdza manifest, wynik,
tożsamość zadania i aktualny lokalny przydział; dopiero potem zapisuje wynik
lokalnie. Następnie koordynator wykonuje lokalne `finish`, a później
`import-preview` i dalsze kroki według reguł importu. Worker ma domyślne limity
2 stron i 20 nowych odczytów kart na zadanie. Można je jawnie zmienić flagami
`--max-pages` (1–20) i `--max-cards` (1–200), np. gdy przegląd przebiegu pokaże
powtarzalne ucięcie wyników. Jeśli nie ma
zatwierdzonego uruchomienia poza sandboxem, użyj
widocznej, odizolowanej przeglądarki Codexa jako ograniczonej próby ręcznej:
wykonaj jedno zapytanie w publicznym interfejsie, otwórz pasujące karty i
zapisz wyłącznie potwierdzone dane. Niepełna paginacja lub brak dowodu z karty
pozostawia `partial`; CAPTCHA, odmowa dostępu i ograniczenie `robots.txt`
kończą tę próbę bez obchodzenia zabezpieczeń. Nie przypisuj ofert znalezionych
przez portal pośredniczący do niewłaściwego źródła — zapisuj rzeczywistą domenę
karty.

## Ulepszanie jakości wyszukiwania

Po przebiegu wygeneruj lokalny, tylko-odczytowy przegląd:
`npm run search:review -- --run <run-id>`. Raport `search-review.md` i
`search-review.json` zapisują się w katalogu przebiegu. Grupują wyniki według
portalu i rozdzielają sygnały DNS, odmów dostępu, błędów czytnika, błędów
adaptera oraz limitów pokrycia. Pokazują również medianę i p95 czasu czytnika,
czas od `claim` do `finish` oraz czas czytnika przypadający na zapisaną ofertę.
Czas `claim`–`finish` obejmuje przekazanie i oczekiwanie koordynatora; używaj
czasu czytnika do porównań wydajności portali. Raport wskazuje też zadania
`pending`/`running` i źródła pominięte, bo ich adapter jest oznaczony jako
`blocked`. Porównuj te pomiary przed podnoszeniem limitów stron/kart lub
równoległości.

Użyj zaleceń do wybrania małego, mierzalnego następnego kroku: uruchomienia
dozwolonego czytnika w zatwierdzonej sieci przy błędach DNS, pilota adaptera przy
powtarzalnych problemach selektorów albo kontynuacji od udokumentowanego
dozwolonego `nextUrl` przy osiągniętym limicie. Raport niczego nie ponawia, nie zmienia
`tasks.json`, konfiguracji ani ofert. `403`, CAPTCHA i odmowa `robots.txt`
oznaczają zatrzymanie prób dla danego zakresu, nie sugestię obejścia.

Po wyniku `partial` z dozwolonym, zapisanym `nextUrl` można uruchomić dokładnie
jedną kontynuację:

```powershell
$runId = "<run-id>"
$taskId = "<partial-task-id>"
$claimJson = python -B scripts/car-search.py continue-search --run $runId --task $taskId --worker network-1
$claim = $claimJson | ConvertFrom-Json
$taskId = $claim.id
python -B scripts/car-search.py export-worker --run $runId --task $taskId
# Przenieś katalog pakietu do zgodnego checkoutu sieciowego i uruchom tam:
npm run search:network-worker -- --bundle "runs/$runId/worker-bundles/$taskId"
# Przenieś pakiet z powrotem, następnie lokalnie:
python -B scripts/car-search.py collect-worker --run $runId --task $taskId
$resultPath = "runs/$runId/results/$($claim.id).json"
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
python -B scripts/car-search.py finish --run $runId --task $taskId --result $result.outcome
```

`continue-search` tworzy osobne zadanie kontynuacyjne z tym samym zamrożonym
profilem, wybiera zapisaną następną stronę i dołącza identyfikator źródłowego
wyniku. Czytnik przed nawigacją ponownie sprawdza `robots.txt`, HTTPS i tę samą
domenę. Wynik kontynuacji zachowuje wcześniejsze strony i odczyty kart; do
importu przekazuje tylko nowe oferty. Jeśli URL nie jest dozwolony, dostał już
odmowę albo nie ma wiarygodnego `nextUrl`, polecenie odmawia kontynuacji. Dalsze
strony pozostawiają `partial`, dopóki kolejna kontynuacja nie wyczerpie
paginacji i nie zostaną rozstrzygnięci kandydaci.

## Praca równoległa

Gdy użytkownik prosi o szukanie nowych ofert, uruchom oddzielny przebieg `plan`
bez ograniczeń `--model` i `--source`: obejmuje wszystkie aktywne modele oraz
wszystkie aktywne, nieaukcyjne portale, które mają zgodny zakres marki. Portale,
których adapter ma jawny tryb `blocked`, są zapisywane w `excludedSources` i nie
otrzymują zadań, dopóki konfiguracja adaptera nie zostanie zmieniona. Nie zmieniaj
ograniczeń modelu/portalu ani zakazu aukcji.

`plan --agents N` ustawia limit aktywnych workerów wyszukiwania. Koordynator
wykonuje `claim` i `finish` lokalnie, jeden po drugim; `claim` odmawia przydziału
ponad limit i pomija zadania z hosta, na którym już działa wyszukiwanie. W ten
sposób można równolegle uruchamiać różne portale, utrzymując najwyżej jedno
zadanie wyszukiwania na host. Worker nie może sam zmieniać `tasks.json` ani
wywoływać `claim`/`finish`. Jeden worker obsługuje najwyżej jedno aktywne zadanie.
Nie uruchamiaj kilku koordynatorów zapisujących tę samą kolejkę; plik kolejki nie
ma blokady między procesami.

Przykładowo `plan --agents 3` dopuszcza do trzech aktywnych zadań. Koordynator
wykonuje do trzech lokalnych `claim` dla odrębnych workerów, eksportuje osobne
pakiety i przekazuje je zatwierdzonym workerom sieciowym. Po powrocie zbiera
każdy wynik przez `collect-worker`, a następnie wykonuje lokalne `finish`.
Claimy wybiera kolejno; aktywny host jest pomijany, więc równoległe zadania
dotyczą różnych hostów. `--agents` ogranicza liczbę przydzielonych zadań, ale
nie uruchamia workerów automatycznie.

Tryb `--claim-stdin` wymaga współdzielonego checkout i kolejki z bieżącym
przydziałem. Tryb `--bundle` nie potrzebuje lokalnego `tasks.json` ani wyników
przebiegu; wymaga zgodnego checkoutu projektu i zainstalowanych zależności.
W obu trybach worker sieciowy zapisuje wyłącznie wynik swojej pracy, nie zmienia
lokalnego `tasks.json` ani ofert. Nie uruchamiaj kilku koordynatorów zapisujących
do tej samej lokalnej kolejki.

Przed otwieraniem kart wykonawca stosuje `searchProfile.candidateScreening` do
widocznych wyników: pomija tylko auta, których widoczne dane jednoznacznie łamią
twardy warunek (np. rocznik produkcji, maksymalny przebieg, nadwozie, wariant
silnika, cena brutto, aukcyjny typ sprzedaży lub jawna informacja o uszkodzeniu,
gdy `structuralDamageAllowed` jest `false`). Nieznane albo niejednoznaczne
pola nie są powodem do odrzucenia, jeśli pozostałe dane pasują — wtedy otwórz
kartę i sprawdź brakujące fakty. Snippet wyszukiwarki nie potwierdza dostępności,
ceny całkowitej ani wyposażenia egzemplarza. Warunki finansowania nie wpływają na
kwalifikację ceny brutto. Nie utożsamiaj roku
pierwszej rejestracji z rokiem produkcji. Filtry portalu zawężają wyniki, ale
nie zastępują kontroli karty i nie zmieniają zakresu wymagań. Dla ceny stosuj
wyjątki z profilu; kwota ponad limit wymaga jawnej zgody użytkownika i nie może
być potraktowana jako zaakceptowana automatycznie.

W przebiegu wyszukiwania dodawaj tylko nowe, dostępne rekordy. Jeśli tożsamość
pasuje do aktywnej oferty, pomiń ją — jej odświeżanie należy do osobnego flow.
Jeśli dostępne nowe ogłoszenie pasuje do auta w archiwum ze statusem `closed` lub
`unverified`, przywróć rekord do aktywnej listy. Rekord `excluded` wymaga jawnej
decyzji użytkownika i nie może być przywrócony automatycznie. Po podglądzie bez konfliktów zastosuj lokalne zmiany, przelicz
oceny i zwaliduj dane; nie generuj raportu pokrycia dla użytkownika. Na końcu
pokaż wyłącznie nowe/przywrócone oferty widoczne w aktywnej bazie. Nie publikuj.

Gdy użytkownik pyta, czy aktualne oferty nadal istnieją lub są dostępne, uruchom
lekki przebieg `availability-plan` dla wszystkich aktywnych URL-i. Nie używaj
`refresh-plan`, jeśli użytkownik nie prosi o aktualizację danych auta. Dla każdej
karty sprawdź tylko, czy zawiera ofertę auta, jawny komunikat o zamknięciu, czy
nie da się jej otworzyć. Użyj `scripts/availability-check.mjs`, które sprawdza
maksymalnie 4 karty równolegle; nie otwieraj kart ręcznie i nie analizuj ceny,
przebiegu ani wyposażenia. `available` wymaga bieżącego HTTP 2xx i wyrenderowanej
karty z dopasowaniem tytułu, ceną oraz aktywną kontrolką kontaktu. Sam tytuł,
cache lub wspólny element strony nie potwierdzają dostępności. `finish` odrzuca
`available` bez kodu HTTP i wszystkich trzech sygnałów. Koordynator pobiera zadania, a subagenci mogą równolegle
przetwarzać osobne zadania portal/model. Po zakończeniu wykonaj `import-preview`,
`import-apply` i walidację ofert; dla samej dostępności nie uruchamiaj `assess`.
Zakładka „Archiwum” wyświetla wyłącznie `archivedOffers`; nie dodawaj tych URL-i
do kolejki. Dotyczy to zarówno `availability-plan`, jak i `refresh-plan`; import
wyników tych przebiegów pomija też rekord, który trafił do archiwum już po
utworzeniu planu. Żaden z tych przebiegów nie przywraca ofert z archiwum.
Każdy aktywny rekord, którego wszystkie URL-e sprawdzono i żaden nie
potwierdził dostępności, przenieś do archiwum: `closed` tylko przy potwierdzonym
zamknięciu wszystkich adresów, w pozostałych przypadkach `unverified`. Rekordy
`excluded` pozostają tam i nie są przywracane automatycznie.
Jeśli użytkownik wyraźnie prosi o pełne odświeżenie danych, użyj zamiast tego
`refresh-plan` i jego reguł.
Gdy użytkownik prosi o sprawdzenie dostępności ofert w archiwum, uruchom
`archive-availability-plan`. Sprawdzaj wyłącznie `archivedOffers` ze statusem
`closed` lub `unverified`; status `excluded` pomijaj. Ten przebieg nie aktualizuje
danych auta i nie dotyka aktywnych ofert. Importuj z niego tylko potwierdzone
`available`; taki rekord przenieś do `offers`, usuń z `archivedOffers` i zachowaj
historię. Dodatkowo napraw starsze błędne archiwizacje: rekord `unverified` z
zapisanym stanem ogłoszenia `available` przywróć do `offers`, jeżeli późniejsza
próba miała wyłącznie `access_error`; zachowaj błąd próby i nie odświeżaj
`lastVerifiedAt`. Nie przywracaj `excluded`. Jeśli przebieg potwierdzi `sold` lub
`removed` dla każdego URL-a oferty, ustaw archiwum na `closed`; każdy błąd dostępu
lub brak obserwacji blokuje takie potwierdzenie. Błędy i nieustalone statusy nie
są dowodem zamknięcia.

Koordynator przygotowuje przebieg poleceniem `plan` i tylko on zmienia `tasks.json`.
Główny agent koordynuje kilku wykonawców; zadania pozostają osobne dla pary
portal × model. Bez `--source` `claim` przydziela dowolne następne zadanie i nie
przypina wykonawcy portalu, co pozwala koordynatorowi dynamicznie równoważyć
obciążenie. Gdy portalowa specjalizacja ma sens, użyj `claim --source <portal>`
(opcję można powtórzyć dla kilku portali); wtedy zakres zapisuje się w
`workerAssignments` i nie może być rozszerzany w trakcie przebiegu.
Pracownicy nie wywołują `claim` ani nie zmieniają `tasks.json`; koordynator wykonuje
wszystkie przydziały i zakończenia. Kolejka nie ma blokady do niezależnego zapisu
procesów. Liczbę pracowników ogranicz do możliwości sesji. Jeden wykonawca może
mieć najwyżej jedno aktywne zadanie naraz. Nie przydzielaj jednego zadania dwóm
aktywnym wykonawcom.

Agent pracuje według `runs/<run-id>/snapshot.json`, a nie zmieniających się
ustawień bieżących. Zapisuje tylko `results/<task-id>.json`. Wynik zawiera:
Każdy element `offers` może zawierać opcjonalne pole `photos` zgodnie z regułami
poniżej; koordynator importuje je razem z pozostałymi polami oferty.

```json
{
  "taskId": "source--model (or refresh--source--model for refresh)",
  "outcome": "partial",
  "checkedAt": "data i czas faktycznego sprawdzenia",
  "coverage": {"searchUrls": [], "pagesChecked": 0, "remaining": "opis nieprzeszukanego zakresu", "searchQueries": [], "searchResults": [], "listingUrlsChecked": []},
  "offers": [],
  "errors": []
}
```

Jeśli zadanie ma `kind: refresh`, sprawdzaj wyłącznie adresy z `refreshTargets`.
Każdy target to konkretne ogłoszenie i portal; aktualizuj wynik przez zapis
obserwacji z tym samym `offerId` oraz URL-em. Zapisuj też osobną obserwację
`access_error` dla targetu, którego karty nie udało się odczytać, aby próba była
widoczna przy konkretnej ofercie. Nie przeszukuj w tym zadaniu innych aut. Dla
`complete` pokrycie musi zawierać wszystkie URL-e targetów i każda karta musi być
odczytana; przy niepełnym dostępie użyj `partial` lub `blocked`, nigdy `no_matches`.
Porównaj zapisane i odczytane dane z wymaganiami oraz kartą z `snapshot.json`;
zapisuj potwierdzone zmiany ze źródłem, a brakujące fakty zostaw jako nieznane.
Zapisuj znalezione bezpośrednie adresy zdjęć w `photos` również podczas refresh;
jeśli nie udało się ich odczytać, pomiń pole zamiast wysyłać pustą tablicę, aby
zachować dotychczasowe adresy. Zmiana `photos` nie jest dowodem żadnego faktu o aucie.
Przy przebiegu `refresh-plan --photo-audit` każda obserwacja musi zawierać
`photoCheck: {status, note}`: `found` z co najmniej jednym nowym URL-em w `photos`,
`no_direct_https` gdy karta nie ujawnia bezpośredniego URL-a HTTPS, albo
`access_error` przy błędzie odczytu karty. Nie oznaczaj jako `found` bez URL-a.

Jeśli zadanie ma `kind: search`, przeszukuj pełny zakres portalu/modelu zgodnie
z profilem zadania. Wykorzystuj `searchProfile.queryPlan`: filtry portalu,
zapytanie bazowe, następnie warianty silnika. Zapisuj faktycznie odwiedzone
URL-e wyników w `coverage.searchUrls`, a z każdej strony utrwalaj `coverage.searchResults`
(URL strony, czas, widoczny `nextUrl` jeśli istnieje, opcjonalne `queryId`,
widoczne listings z tytułem, URL-em i polami). To migawka listy, nie dowód z karty. `claim` może przekazać
`sharedResultsCache` z wynikami innych zadań tego samego portalu i przebiegu.
Wykorzystuj go, aby nie otwierać ponownie identycznych stron i URL-i kart już
odczytanych. Cache i snippets służą do wskazania kandydatów, nie potwierdzają
dostępności ani faktów z karty i nie przenoszą kwalifikacji między modelami.
Po `claim` wspólny czytnik Playwright można uruchomić przez
`npm run search:portal -- --claim-stdin`; przy źródle Sprzedajemy użyj jego
dedykowanego adaptera kategorii. Bez `--verify-cards` wspólny czytnik zapisuje
migawkę wyników i nie potwierdza kart ani dostępności. Pełny wynik wymaga
`--verify-cards`, zakończenia wszystkich zapytań i paginacji oraz odczytu każdej
karty, która przeszła screening. Limit stron/kart, nieudane zapytanie, błąd karty,
niejednoznaczna karta lub nieukończona paginacja muszą pozostawić `partial` (albo
`blocked` przy jawnej blokadzie). `no_matches` wolno zwrócić dopiero po pełnym
pokryciu i rozstrzygnięciu wszystkich kwalifikujących się kandydatów.
Nie uznawaj wyniku `partial` za pełne pokrycie. Blokady i błędy TLS kończ jako
`blocked` lub `partial`; nie omijaj ich i nie zwracaj `no_matches`. Jeśli
wystąpi `ENOTFOUND`, `ERR_NAME_NOT_RESOLVED` lub `EAI_AGAIN`, wynik wspólnego
czytnika jest `partial` z diagnostyką DNS, nie `blocked` ani `no_matches`.
`attemptElapsedMs` w kolejce mierzy czas zegarowy od `claim` do `finish` (wraz
z pracą wykonawcy i ewentualnym oczekiwaniem koordynatora), a
`diagnostics.elapsedMs` w wyniku czytnika mierzy lokalny czas procesu czytnika,
włącznie z uruchomieniem przeglądarki i kontrolą kart.
Każdy bezpośredni URL karty, której otwarcie próbowano (także z błędem), wpisz
do `coverage.listingUrlsChecked`.

Przy odczycie przez Playwright utrzymuj jedną instancję przeglądarki i kontekst
na wykonawcę oraz używaj ich dla kolejnych stron tego portalu. Nawiguj z
`waitUntil: "domcontentloaded"`, a potem czekaj na element wyników albo konkretne
żądanie danych; nie czekaj na `networkidle`, bo analityka i reklamy mogą
utrzymywać połączenia bez końca. Blokowanie obrazów, fontów i mediów włączaj
tylko po pomiarze potwierdzającym krótsze ładowanie bez utraty danych wyników;
przed odczytem kart odczytaj widoczne bezpośrednie adresy HTTPS zdjęć. Odczytuj
odpowiedzi XHR/Fetch z tej samej normalnej sesji portalu zamiast ponownie wysyłać
już zaobserwowane żądania. Dla seryjnego odczytu znanych URL-i możesz użyć
`npm run browse:pages -- --url <https-url>`, które współdzieli kontekst i zapisuje
zrzut renderowanej strony oraz metadane XHR/Fetch; JSON odpowiedzi włączaj tylko
gdy jest potrzebny przez `--include-api-json`. Zwykłą paginację po widocznym
linku można przejść przez `--next-selector <css> --max-pages <limit>`; narzędzie
deduplikuje odwiedzone URL-e.
Portal `sprzedajemy` obsługuje wspólny punkt wejścia `npm run search:portal`;
koordynator używa `claim` z `--source sprzedajemy`, a adapter wybiera się
automatycznie z profilu zadania. Wynik migawki nie jest dowodem z karty: stosuj
screening, otwieraj pasujące karty, uzupełnij coverage i zapisz standardowy
plik `results/<task-id>.json`.
Dokładne strony z `sharedResultsCache` adapter ponownie wykorzystuje, a `nextUrl`
zachowuje w `coverage.searchResults` do dalszej paginacji.
Nie omijaj logowania, CAPTCHA, blokad, `robots.txt` ani ograniczeń dostępu; przy
blokadzie zapisz jej status i zakończ próbę dla tego zakresu.

Nie aktualizuj znalezionej aktywnej oferty; zapisz ją jako
kandydata, a koordynator pominie istniejącą tożsamość podczas importu. Nowe
oferty muszą mieć potwierdzoną dostępność i dowody z karty. Braki pól nie są
dopowiadane; kandydat pozostaje `check` przy lokalnej ocenie. `no_matches` wolno
zwrócić wyłącznie po pełnym pokryciu wszystkich stron i filtrów tego zadania.
W każdym nowym kandydacie dodaj `photos: ["https://…"]`, jeśli karta udostępnia
bezpośrednie adresy zdjęć; gdy ich brak, pole może być pominięte. Zapisz do 12
adresów zdjęć, bez lokalnego kopiowania plików.

Wyniki: `complete`, `partial`, `blocked`, `no_matches`. `no_matches` wymaga
faktycznego przeszukania zakresu; blokada dostępu nie oznacza braku ofert.
Przed `finish` koordynator uruchamia walidację całego wyniku: kontraktu JSON,
obserwacji, dowodów, lokalizacji i wymaganych pól nowej oferty. Przy błędzie
zadanie pozostaje `running`, a odrzucony plik wynikowy zostaje zachowany w
`results/rejected/`; popraw wynik i ponów `finish`. Nie nadpisuj dowodów bez
zachowania kopii.
Koordynator kontroluje wynik i zapisuje zakończenie poleceniem `finish`.
Po awarii koordynator może jawnie przywrócić zadanie do `pending`, zachowując
historię próby i odrębny plik poprzedniego wyniku. Nie nadpisuj dowodów bez śladu.

Przy dłuższym wyszukiwaniu koordynator zapisuje wyniki partiami, po zakończeniu
wybranej grupy zadań i przed kolejnymi przydziałami: `import-preview`, kontrola
konfliktów, a przy podglądzie bez konfliktów `import-apply`, `assess` i
`validate-offers.py`. Podgląd pomija zadania `pending` i `running`; późniejszy
podgląd tego samego przebiegu uwzględnia nowe zakończone zadania, a rejestr
importu pomija już zastosowane wyniki. Nie stosuj podglądu z konfliktami. Nie
uruchamiaj importu, gdy inny wykonawca zapisuje plik wyniku.

