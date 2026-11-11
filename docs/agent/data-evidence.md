# Dowody i ocena danych ofert

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
