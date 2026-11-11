# Import wyników i historia ofert

Pierwszy etap implementacji, 8 listopada 2026. Proces działa lokalnie i nie
wykonuje zapytań do portali ani publikacji. Istniejące `plan`, `claim`, `finish`
pozostają narzędziami koordynatora. Nie uruchamiają subagentów.

## Polecenia

Po zakończeniu partii zadań i sprawdzeniu ich wyników można przygotować podgląd;
nie trzeba czekać na koniec całego przebiegu:

```powershell
python -B scripts/car-search.py import-preview --run IDENTYFIKATOR
```

Powstają `runs/IDENTYFIKATOR/import-preview.json` i czytelny `import-preview.md`.
Podgląd pokazuje nowe i aktualizowane oferty, zmiany pól, status obserwacji,
ocenę, konflikty oraz liczbę zadań pominiętych z poszczególnych powodów. Nie
zmienia ofert. Zadania oczekujące i działające są
pomijane. Wynik `partial` może dostarczyć oferty, ale nie staje się przez to
pełnym przeszukaniem. `blocked` i `no_matches` nie mogą zawierać ofert.

Wyniki można importować etapami w ramach tego samego przebiegu. Po zastosowaniu
bezkonfliktowego podglądu `import-preview` można uruchomić ponownie, gdy dojdą
nowe zakończone zadania. `data/import-state.json` zapobiega ponownemu importowi
tych samych wyników. Każdy etap wymaga osobnego podglądu, kontroli konfliktów,
`import-apply`, `assess` i walidacji ofert. Nie uruchamiaj checkpointu, gdy
wykonawca właśnie zapisuje wynik.

Po przejrzeniu podglądu koordynator stosuje zmiany lokalnie:

```powershell
python -B scripts/car-search.py import-apply --run IDENTYFIKATOR
python -B scripts/car-search.py assess
python -B scripts/validate-offers.py
```

`import-apply` korzysta z przygotowanego podglądu, nie przelicza go po cichu.
Zmiana wejściowych danych, konfiguracji, kart wiedzy lub schematu wymaga nowego
podglądu. Ocena podczas importu używa bieżącej konfiguracji; ustawienia użyte
do wyszukiwania pozostają w snapshotcie. Obie wersje są oznaczone w podglądzie.

Importer nie zmienia katalogu modeli, więc nie wymaga regeneracji indeksu.
Po zmianach konfiguracji nadal obowiązują `validate`, `sync` i `assess`.
Żadne z tych poleceń nie publikuje zmian. Publikacja wymaga zgody użytkownika.

## Obserwacja w wyniku pracownika

Wynik zachowuje strukturę z `AGENTS.md`. Dla wyników zawierających oferty
`checkedAt` ma zawierać rzeczywisty czas z godziną i strefą. Przykład poniżej
jest wyłącznie fikcyjnym przykładem kontraktu, nie rzeczywistą ofertą:

```json
{
  "taskId": "otomoto--hyundai-i30-iii-wagon",
  "outcome": "partial",
  "checkedAt": "2026-11-07T12:00:00+01:00",
  "coverage": {
    "searchUrls": ["https://example.com/search"],
    "pagesChecked": 1,
    "remaining": "Dalsze strony wyników",
    "searchResults": [{
      "url": "https://example.com/search",
      "checkedAt": "2026-11-07T11:50:00+01:00",
      "queryId": "base",
      "listings": [{"title": "Przykład", "url": "https://example.com/listing/123", "year": 2020, "price": 50000}]
    }],
    "listingUrlsChecked": ["https://example.com/listing/123"]
  },
  "offers": [{
    "id": "listing:example:123",
    "title": "Przykład kontraktu",
    "urls": [{"url": "https://example.com/listing/123"}],
    "photos": ["https://example.com/images/123-main.jpg"],
    "listingIds": ["example:123"],
    "price": 50000,
    "year": 2020,
    "saleType": "fixed_price",
    "lpgInstalled": null,
    "location": {"status": "not_provided"},
    "observation": {
      "url": "https://example.com/listing/123",
      "checkedAt": "2026-11-07T11:55:00+01:00",
      "availability": "available",
      "note": "Odczytano kartę; podano cenę zakupu 50 000 zł. Warunki ceny wymagają potwierdzenia.",
      "evidence": []
    }
  }],
  "errors": [{"url": "https://example.com/search", "note": "Pozostała jedna nieodczytana karta."}]
}
```

Każdy element `errors` jest obiektem z niepustym `note` albo `error`; opcjonalny
`url` musi być poprawnym adresem HTTP(S). `finish` sprawdza ten kontrakt oraz
każdą obserwację przed zapisaniem stanu zadania.

Dla zadań `search` `finish` wymaga `searchResults` i `listingUrlsChecked`.
Migawki listingów dokumentują sprawdzone strony i pomagają ograniczyć powtórną
pracę w jednym przebiegu; nie potwierdzają dostępności ani danych oferty. URL
obserwacji każdego kandydata w `offers` musi być ujęty w `listingUrlsChecked`.

Nowa oferta wymaga `id`, `title`, niepustego `urls`, `location`, `saleType` i
`lpgInstalled`. Nieznane LPG zapisujemy jako `null`. Nieznany rodzaj sprzedaży
można zapisać jako `null`; ocena wymaga wtedy wyjaśnienia. Nie przypisujemy
`gross_total` dla widocznej ceny brutto; finansowanie ani jego warunki nie wpływają
na kwalifikację ceny. Kwota netto nie spełnia limitu budżetu brutto.
`photos` jest opcjonalną tablicą maksymalnie 12 bezpośrednich URL-i HTTPS zdjęć
auta z karty ogłoszenia. Zapisujemy same adresy, nie pliki. Nie interpretujemy
zdjęć jako dowodu stanu, wyposażenia ani szkód. Podczas odświeżenia, gdy nie
odczytano nowych URL-i zdjęć, pomiń pole `photos`; pustą tablicę przekaż tylko,
gdy źródło jawnie potwierdza brak zdjęć i koordynator chce usunąć stare adresy.

Przy odświeżaniu można przekazać tylko identyfikator, zmienione pola i obserwację.
URL obserwacji musi należeć do oferty. Brak pola albo `null` nie usuwa znanej
wartości. `location.status=not_provided` nie kasuje znanej wcześniej lokalizacji;
nowy brak pozostaje zapisany w `history[].reportedFields`. Poprawki wymagające
usunięcia błędnych danych trzeba obecnie rozstrzygać ręcznie z zachowaniem śladu.
Przy `available` w odświeżeniu przekaż na poziomie oferty `saleType` oraz
`lpgInstalled` (`null`, jeśli karta tego nie rozstrzyga). Wartości bieżące, takie
jak `price`, `year` i `mileage`, również zapisuj na poziomie oferty; obserwacja
zachowuje opis i dowody, ale nie zastępuje pól używanych przez ocenę.

Przed `finish` koordynator waliduje każdą ofertę i obserwację. Dla odświeżenia
wynik `complete`, `partial` lub `blocked` musi zawierać dokładnie jedną
obserwację dla każdego przypisanego targetu, również `access_error` tam, gdzie
karta była niedostępna. Powtórzone obserwacje lub URL spoza zakresu blokują
zamknięcie. `complete` dodatkowo wymaga odczytu wszystkich kart bez błędu dostępu.

`availability`: `available`, `sold`, `removed`, `access_error`. Sprzedaż i
usunięcie wymagają jawnego komunikatu źródła opisanego w `note`. W zwykłym
odświeżaniu sam HTTP 404/410, brak wyniku wyszukiwarki i błąd otwarcia oznaczają
`access_error`. Wyjątkiem jest osobny przebieg `availability`: HTTP 410 jest
zapisywany jako `removed`, 403 jako `access_error`, a sam 404 nadal jako
`access_error`. Brak wyniku wyszukiwarki i blokada nie potwierdzają zamknięcia.
Importer sprawdza strukturę dowodu; prawdziwość i adekwatność sprawdza koordynator.
`errors` na poziomie zadania nie zmieniają statusów ofert. Aby zapisać próbę
odświeżenia konkretnego ogłoszenia, dodaj jego obserwację `access_error`.

Potwierdzenia kamery, szkody i dopasowania rodzinnego wymagają `evidence`:

```json
{
  "fields": ["structuralDamageStatus"],
  "url": "https://example.com/inspection/123",
  "checkedAt": "2026-11-07T11:00:00+01:00",
  "kind": "independent",
  "note": "Opis niezależnej kontroli i jej zakresu; samo oświadczenie sprzedawcy nie wystarcza."
}
```

`kind` przyjmuje `seller`, `technical`, `independent`.
`independently_checked_clear` wymaga dowodu `independent`. Dostępność wyposażenia
w katalogu nie potwierdza instalacji w egzemplarzu. Importer nie czyta semantycznie
dokumentów, dlatego kontrola koordynatora jest nadal niezbędna.

Lokalizacja `available` wymaga kraju, województwa i miejscowości z portalu.
Nie zgadujemy brakującego województwa; niepełny zakres trzeba uzupełnić ze źródłem
przed importem. Kod pocztowy i współrzędne wymagają URL-a w `geoSource`.
Samą miejscowość można pokazać bez współrzędnych; obliczanie odległości nie jest
jeszcze wdrożone.

## Tożsamość, historia i odtwarzanie

- Dopasowanie odbywa się przez VIN, ID oferty, ID ogłoszenia i URL. Parametry
  zapytania URL są zachowywane, ponieważ mogą identyfikować ogłoszenie. Przy
  scalaniu ten sam URL z różnymi metadanymi nie jest dopisywany drugi raz.
- Więcej niż jedno dopasowanie, inny VIN, inny model, sprzeczny rok produkcji,
  wariant silnika lub nadwozie albo starsza obserwacja
  powodują konflikt. Podgląd z konfliktami nie może zostać zastosowany.
- Oryginalne ID auta pozostaje stabilne. Kolejne ogłoszenia otrzymują oddzielne
  wpisy `listingStates`, więc usunięcie jednego nie zamyka pozostałych.
- `history` zapisuje poprzednie i nowe wartości, zgłoszone pola, dowody, URL,
  czas oraz przebieg. `firstSeenAt` dotyczy pierwszego importu do nowego mechanizmu,
  nie daty publikacji ogłoszenia.
- `lastAttemptAt` zapisuje także błędy. `lastCheckedAt` i `lastVerifiedAt` zmieniają
  się wyłącznie po udanym ustaleniu statusu. Nie oznaczają niezależnych oględzin auta.
- `data/import-state.json` identyfikuje przetworzone wyniki i obserwacje.
  Nie należy usuwać tego pliku przy zachowaniu zaimportowanych ofert.
- Zmiana już zaimportowanego wyniku jest blokowana. Zachowaj poprzedni plik
  i przygotuj nowy przebieg. Ponowienie identycznej obserwacji nie dubluje historii.
- Kopie sprzed zapisu, przygotowane pliki, dziennik i potwierdzenie są w
  `runs/IDENTYFIKATOR/imports/<sha256>/`. Zapisy pojedynczych plików są atomowe.
  Cały zestaw plików nie jest jedną transakcją systemu plików: po przerwaniu
  ponów to samo `import-apply`. Wznowienie jest blokowane, jeśli pliki zostały
  w międzyczasie niezależnie zmienione. Niedokończony import blokuje nowy podgląd.
- Tylko jeden koordynator zapisuje dane; nie uruchamiaj importów równolegle.
- W przebiegu `refresh` rekord trafia do `archivedOffers` tylko wtedy, gdy każdy
  powiązany URL ma potwierdzony status `sold` lub `removed`. W lekkim przebiegu
  `availability` archiwizuj jako `unverified`, gdy wszystkie URL-e zostały
  sprawdzone, żaden nie jest `available`, a co najmniej jeden ma `access_error`.
  To wycofanie z aktywnej listy, nie dowód sprzedaży. Nieznany URL blokuje
  archiwizację; jeśli choć jedna karta jest dostępna, rekord pozostaje aktywny.
  W archiwum zachowaj cały rekord i historię. Ponowna obserwacja `available`
  dopasowanego auta ze statusem `closed` lub `unverified` przywraca je do aktywnej
  listy `offers`. Ręczne wykluczenie zapisuj jako `excluded`; import nie przywraca
  takiego rekordu bez jawnej decyzji koordynatora.

## Strona i ocena

`assess` generuje raport z czasem i wartościami pól użytych do oceny. Strona
używa raportu wyłącznie, jeśli jego konfiguracja wymagań i modeli odpowiada
aktualnym plikom oraz pola konkretnej oferty nadal pasują. W innym przypadku
pokazuje `check`, a ocenę z importu albo ocenę historyczną opisuje jako poprzednią.
Warianty silników o statusie `hold...` wymagają wyjaśnienia, nawet jeśli ich
identyfikator pozostaje na liście dopuszczonej do wyszukiwania.

Szczegóły pokazują historię cen, źródła obserwacji i dowodów, lokalizację,
LPG oraz statusy poszczególnych ogłoszeń. Historia może być długa; osobny,
stronicowany magazyn historii będzie potrzebny dopiero przy większym wolumenie.

## Następne etapy

1. Adaptery odczytu dwóch portali i pilotaż z rzeczywistymi obserwacjami.
2. Obsługa odświeżania i wznawiania zadań w kolejce, z archiwizacją prób.
3. Profile wykonawców i orkiestracja modeli subagentów z zapisem użytego modelu.
4. Odległości, filtry aktualności i podsumowanie pokrycia wyszukiwania.
5. Rozszerzenie źródeł i dopiero potem harmonogram pracy.
