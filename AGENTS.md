# CarOffers — instrukcje wyszukiwania

## Dane wejściowe

Przed pracą przeczytaj `config/requirements.json`, `config/search-models.json`,
`config/sources.json` oraz odpowiednie `knowledge/models/*.json`.
Uruchom `python -B scripts/car-search.py validate`. Konfiguracja jest nadrzędna
wobec historycznych tekstów i ocen w ofertach. Nie rozluźniaj wymagań samodzielnie.
Budżet dotyczy pełnej kwoty brutto zakupu bez obowiązkowego finansowania.
Użytkowanie: 12–15 tys. km rocznie, typowy przejazd miejski około 30 minut.
LPG jest dopuszczone, lecz musi być oznaczone przy ofercie i sprawdzone pod kątem
dokumentów instalacji/zbiornika. Zakup aukcyjny jest wykluczony. Zapisuj `saleType`
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
   Twarde wymagania z `requirements.json` nie mogą być skompensowane punktacją.
3. Dla pięciu najwyżej ocenionych modeli koordynator rozdziela po jednym zadaniu
   `recommendation_listing` na model. Agent sprawdza kandydatów po kolei; przy
   zakończonej lub niedostępnej karcie przechodzi do następnej oferty tego samego
   modelu. Weryfikuje bieżącą dostępność, warunki ceny, dokładny wariant auta,
   wyposażenie i pozostałe pola po karcie oraz dokładne specyfikacje po źródłach.
   Nie analizuje zdjęć.
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
silnika, cena brutto lub aukcyjny typ sprzedaży). Nieznane albo niejednoznaczne
pola nie są powodem do odrzucenia, jeśli pozostałe dane pasują — wtedy otwórz
kartę i sprawdź brakujące fakty. Snippet wyszukiwarki nie potwierdza dostępności,
pełnej ceny bez finansowania ani wyposażenia egzemplarza. Nie utożsamiaj roku
pierwszej rejestracji z rokiem produkcji. Filtry portalu zawężają wyniki, ale
nie zastępują kontroli karty i nie zmieniają zakresu wymagań. Dla ceny stosuj
wyjątki z profilu; kwota ponad limit wymaga jawnej zgody użytkownika i nie może
być potraktowana jako zaakceptowana automatycznie.

W przebiegu wyszukiwania dodawaj tylko nowe, dostępne rekordy. Jeśli tożsamość
pasuje do aktywnej oferty, pomiń ją — jej odświeżanie należy do osobnego flow.
Jeśli dostępne nowe ogłoszenie pasuje do auta w archiwum, przywróć rekord do
aktywnej listy. Po podglądzie bez konfliktów zastosuj lokalne zmiany, przelicz
oceny i zwaliduj dane; nie generuj raportu pokrycia dla użytkownika. Na końcu
pokaż wyłącznie nowe/przywrócone oferty widoczne w aktywnej bazie. Nie publikuj.

Gdy użytkownik prosi w języku naturalnym o „weryfikację wszystkich aktualnych
ofert”, uruchom pełny przebieg odświeżania wszystkich rekordów w aktywnej bazie
(`refresh-plan` bez filtrów). Koordynator dzieli zadania między subagentów według
portali, nadzoruje każdy wynik i po zakończeniu przygotowuje podgląd importu.
Jeśli podgląd nie zawiera konfliktów ani błędów walidacji, zastosuj zmiany
lokalnie, przelicz ocenę (`assess`), wygeneruj podsumowanie przebiegów i uruchom
walidację ofert. Konflikty, błędy oraz URL-e bez
jednoznacznego aktywnego portalu pozostaw do raportu i nie nazywaj całego
przebiegu pełną weryfikacją. Nigdy nie publikuj wyników.

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
(URL strony, czas, opcjonalne `queryId`, widoczne listings z tytułem, URL-em i
polami). To migawka listy, nie dowód z karty. `claim` może przekazać
`sharedResultsCache` z wynikami innych zadań tego samego portalu i przebiegu.
Wykorzystuj go, aby nie otwierać ponownie identycznych stron i URL-i kart już
odczytanych. Cache i snippets służą do wskazania kandydatów, nie potwierdzają
dostępności ani faktów z karty i nie przenoszą kwalifikacji między modelami.
Każdy bezpośredni URL karty, której otwarcie próbowano (także z błędem), wpisz
do `coverage.listingUrlsChecked`.
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
- Błąd otwarcia nie oznacza sprzedaży. Nie usuwaj historycznych ofert z tego powodu.
- Po `available`, `sold` lub `removed` można zapisać `lastVerifiedAt`; po `access_error`
  zmieniaj tylko `lastAttemptAt` i nie odświeżaj daty ostatniej udanej weryfikacji.
- W przebiegu odświeżania zweryfikuj każdy URL w `refreshTargets`. Koordynator
  archiwizuje rekord auta dopiero po potwierdzeniu zamknięcia każdego jego URL-a.
  Archiwizacja zachowuje historię; błędy dostępu i nieustalone statusy blokują
  archiwizację. Nowa obserwacja dostępnego ogłoszenia może przywrócić auto z archiwum.
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
- Pola do lokalnej oceny: `priceBasis: gross_unconditional_total`, `bodyCode`,
  `engineVariant` z katalogu, `transmissionCode: manual|automatic`,
  `cameraStatus: installed_confirmed|retrofit_confirmed|not_installable|unknown`,
  `structuralDamageStatus: confirmed|independently_checked_clear|unknown`,
  `familyFitConfirmed`. Statusów potwierdzenia używaj tylko z zapisanym dowodem.
- Ocena `match` dotyczy zapisanych warunków i dowodów, nie zastępuje oględzin.

Agenci nie modyfikują bezpośrednio `offers/*.json`. Koordynator przygotowuje
scalenie i walidację. Nie publikuj ani nie wysyłaj zmian do repozytorium bez
akceptacji użytkownika. Lokalne przygotowanie konfiguracji i raportów jest dozwolone.
