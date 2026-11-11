# CarOffers — instrukcje wyszukiwania

Mapa odpowiedzialności modułów i rutyna pracy nad kodem są w
`docs/architektura-dla-agenta.md`. Ten plik pozostaje źródłem szczegółowych zasad
wyszukiwania, dowodów, importu i koordynacji.

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
Zbieraj również bezpośrednie adresy zdjęć widoczne na karcie ogłoszenia i zapisuj
je jako opcjonalną tablicę `photos` z URL-ami HTTPS. Zapisuj tylko zdjęcia danego
auta osadzone w ogłoszeniu, maksymalnie 12, bez pobierania plików. Nie wyciągaj
ze zdjęć faktów o stanie, wyposażeniu ani uszkodzeniach. Jeśli portal nie ujawnia
bezpośrednich adresów, zdjęcie jest niedostępne albo link nie jest HTTPS, pomiń je.

## Praca równoległa

Gdy użytkownik w czacie prosi o analizę „top modeli”, „polecane modele” lub
podobny ranking, uruchom agentowy, dwuetapowy przebieg rekomendacji. Nie wymagaj
od użytkownika ręcznego uruchamiania poleceń CLI.

1. Koordynator uruchamia `python -B scripts/car-search.py recommend-plan --run
   <run-id> --agents <liczba>` i rozdziela zadania `recommendation_model` między
   dostępnych subagentów. Etap obejmuje wszystkie aktywne modele z przynajmniej
   jednym kwalifikującym się ogłoszeniem HTTPS. Każdy agent ocenia jeden model
   na podstawie jego karty wiedzy, ofert i źródeł internetowych. Nie otwiera
   jeszcze wszystkich kart ogłoszeń. Wnioski muszą cytować źródła i jawnie
   oznaczać niepewność.
2. Koordynator nadzoruje wyniki, zapisuje je przez standardowe `finish`, a po
   zakończeniu etapu uruchamia `recommend-select`. Wagi: bezpieczeństwo rodzinne
   30, niezawodność 25, bagażnik 20, moc i użytkowanie miasto/trasa 20, kamera 5.
   Status `confirmed` otrzymuje pełne punkty, `partial` połowę, `unknown` zero.
   Twarde wymagania przypisane do danego modelu nie mogą być skompensowane punktacją.
3. Dla pięciu najwyżej ocenionych modeli koordynator rozdziela po jednym zadaniu
   `recommendation_listing` na model. Agent sprawdza kandydatów po kolei; przy
   zakończonej lub niedostępnej karcie przechodzi do następnej oferty tego samego
   modelu. Weryfikuje bieżącą dostępność, warunki ceny, dokładny wariant auta,
   wyposażenie i pozostałe pola po karcie oraz dokładne specyfikacje po źródłach.
   Nie analizuje zdjęć ani nie wyciąga z nich faktów. Jeśli karta pokazuje
   bezpośrednie adresy HTTPS zdjęć danego auta, zapisuje do 12 w `photos`;
   w przeciwnym razie pomija pole. Teksty widoczne w rankingu pisze po polsku.
4. Po `finish` wszystkich pięciu zadań koordynator uruchamia
   `recommend-finalize`. Wynik trafia do `reports/recommendations.json`, skąd
   zakładka „Polecane modele” ładuje ranking. Nie importuj rekomendacji do
   `offers/*.json` i niczego nie publikuj.

Koordynator sam wykonuje `recommend-plan`, `claim`, `finish`, `recommend-select`
i `recommend-finalize`; agenci nie zmieniają kolejki. Utrzymuj najwyżej jedno
aktywne zadanie na subagenta. Zachowuj wyniki fazy modelowej i listingowej w
`runs/<run-id>/results/`; nie nadpisuj dowodów bez zachowania kopii.

Gdy użytkownik prosi o szukanie nowych ofert, uruchom oddzielny przebieg `plan`
bez ograniczeń `--model` i `--source`: obejmuje wszystkie aktywne modele oraz
wszystkie aktywne, nieaukcyjne portale, które mają zgodny zakres marki. Nie
zmieniaj ograniczeń modelu/portalu ani zakazu aukcji. Koordynator wybiera kolejność
i grupowanie zadań według obciążenia; używa `claim` bez `--source`, aby przydział
pozostał elastyczny, chyba że specjalizacja portalowa faktycznie poprawi pracę.
Zadania nadal mają osobną odpowiedzialność portal × model i są przydzielane
szeregowo przez koordynatora.

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
Jeśli użytkownik wyraźnie prosi o pełne odświeżenie danych, użyj zamiast tego
`refresh-plan` i jego reguł.

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
  "coverage": {"searchUrls": [], "pagesChecked": 0, "remaining": "opis nieprzeszukanego zakresu", "searchResults": [], "listingUrlsChecked": []},
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
dedykowanego adaptera kategorii. Wspólny czytnik zapisuje tylko migawkę
widocznych wyników i pozostawia `offers` puste, więc wykonawca nadal musi
otworzyć kandydatów, sprawdzić karty oraz przygotować standardowy wynik.
Nie uznawaj wyniku `partial` za pełne pokrycie. Blokady i błędy TLS kończ jako
`blocked` lub `partial`; nie omijaj ich i nie zwracaj `no_matches`.
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

## Dowody i ocena

- Nie dopisuj brakujących danych. Oddzielaj opis sprzedawcy od niezależnych dowodów.
- Rocznik produkcji, rok modelowy i pierwsza rejestracja nie są zamienne.
- Kamera dostępna w wersji nie oznacza kamery w egzemplarzu. Montaż wymaga dowodu zgodności.
- Status `partial` karty wiedzy oznacza jawne luki. Nie przedstawiaj odziedziczonych
  filtrów silników jako potwierdzonych zaleceń technicznych.
- Błąd otwarcia nie jest dowodem sprzedaży. W zwykłym przebiegu wyszukiwania nie
  usuwaj historycznych ofert z tego powodu. W przebiegu `availability` przenieś
  auto do `archivedOffers` ze statusem `unverified`, jeśli żaden z jego URL-i nie
  pokazał dostępnej karty, a każdy URL został sprawdzony i ma `sold`, `removed`
  albo `access_error`. Zachowaj w historii właściwy wynik `access_error`; nie
  zapisuj go jako `sold` ani `removed`. Jeżeli choć jeden URL pokazuje auto,
  pozostaw rekord aktywny.
- Po `available`, `sold` lub `removed` można zapisać `lastVerifiedAt`; po `access_error`
  zmieniaj tylko `lastAttemptAt` i nie odświeżaj daty ostatniej udanej weryfikacji.
- W przebiegu `refresh` zweryfikuj każdy URL w `refreshTargets`. Koordynator
  archiwizuje rekord auta po potwierdzeniu zamknięcia każdego URL-a; błędy dostępu
  blokują tę archiwizację. W przebiegu `availability` stosuj odrębną regułę
  archiwum `unverified` opisaną powyżej. Archiwizacja zachowuje historię, a nowa
  obserwacja dostępnego ogłoszenia może przywrócić auto ze statusem `closed` lub
  `unverified`. Rekord ze statusem `excluded` pozostaje poza aktywną listą.
- Zapisuj URL źródła każdej istotnej obserwacji i czas sprawdzenia.
- `photos` zawiera wyłącznie bezpośrednie adresy HTTPS zdjęć z karty danego auta;
  adres zdjęcia nie zastępuje URL-a ogłoszenia ani źródła dowodów. Nie pobieraj,
  nie osadzaj lokalnie i nie używaj zdjęć do potwierdzania danych oceny.
- Deduplikuj według VIN, identyfikatorów i URL. Konflikty tożsamości sprawdzaj ręcznie.
- Każda nowa oferta ma zawierać `location`. Jeśli portal podaje miejsce, ustaw
  `status: available` i zapisuj kraj, województwo oraz miejscowość. Gdy miejsca
  brak, ustaw `status: not_provided`; późniejsza karta ma pokazać „Brak danych o
  lokalizacji — nie można obliczyć odległości”. Kod pocztowy i współrzędne
  zapisuj wyłącznie ze wskazanym źródłem; nie zgaduj ani nie wyprowadzaj ich
  z nazwy sprzedawcy. Pełny adres nie jest wymagany.
- Pola do lokalnej oceny: `priceBasis: gross_total`, `bodyCode`,
  `engineVariant` z katalogu, `transmissionCode: manual|automatic`,
  `cameraStatus: installed_confirmed|retrofit_confirmed|not_installable|unknown`,
  `structuralDamageStatus: confirmed|independently_checked_clear|unknown`,
  `familyFitConfirmed`. Statusów potwierdzenia używaj tylko z zapisanym dowodem.
- Ocena `match` dotyczy zapisanych warunków i dowodów, nie zastępuje oględzin.

Agenci nie modyfikują bezpośrednio `offers/*.json`. Koordynator przygotowuje
scalenie i walidację. Nie publikuj ani nie wysyłaj zmian do repozytorium bez
akceptacji użytkownika. Lokalne przygotowanie konfiguracji i raportów jest dozwolone.
