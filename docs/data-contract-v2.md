# Kontrakt danych CarOffers v2

Etap 1, 2026-11-08. Kontrakt opisuje obecny format i nie migruje danych.
Frontend, pliki ofert, indeks oraz workflow pozostają bez zmian.

## Schematy i uruchamianie

- `schemas/offers-v2.schema.json`: dokument ofert, JSON Schema draft 2020-12.
- `schemas/models-v1.schema.json`: osobny kontrakt indeksu; jego wersja 1 jest prawidłowa.
- `scripts/validate-offers.py`: walidacja schematów oraz relacji między plikami.
- `tests/test_validate_offers.py`: testy w izolowanych katalogach tymczasowych.

Wymagany Python 3.10 lub nowszy; wyłącznie biblioteka standardowa, bez instalacji.
Polecenia z katalogu repozytorium:

```powershell
python -B scripts/validate-offers.py
python -B scripts/validate-offers.py --json
python -B scripts/validate-offers.py --strict
python -B -m unittest discover -s tests -v
```

`--root KATALOG` pozwala sprawdzić inny katalog danych przy użyciu schematów
dołączonych do walidatora. Domyślny katalog nie zależy od bieżącego katalogu powłoki.
Walidator niczego nie zapisuje, nie uruchamia generatora indeksu i nie wykonuje żądań sieciowych.
Raport tekstowy lub JSON trafia na stdout. Kod wyjścia 0 oznacza brak błędów
krytycznych; 1 oznacza błędy albo ostrzeżenia przy `--strict`.
Opcja `-B` zapobiega tworzeniu `__pycache__` podczas uruchomień.

## Wymagane pola

| Obiekt | Pola wymagane |
|---|---|
| Dokument ofert | `version` równe 2, `updatedAt`, `model`, `offers`; opcjonalnie `archivedOffers` |
| `model` | `key`, `name` |
| Oferta | `id`, `title`, `urls` |
| Element `urls` | `url` |
| Indeks | `version` równe 1, niepusta tablica `models` |
| Element indeksu | `key`, `name`, `file` |

`updatedAt` to istniejąca data kalendarzowa `YYYY-MM-DD`.
`key` jest małymi literami ASCII i cyframi, z pojedynczymi łącznikami między członami.
Nazwa i tytuł muszą zawierać przynajmniej jeden znak inny niż biały.
Puste `offers` jest dozwolone. `urls: []` jest dozwolone dla historycznego rekordu
bez zachowanego adresu, ale powoduje ostrzeżenie. Brak samego pola `urls` jest błędem.
`archivedOffers` przechowuje rekordy wycofane z aktywnej listy w tym samym formacie oferty,
z dodatkowym obiektem `archive` zawierającym status (`closed` lub `unverified`), przyczynę i datę archiwizacji.
Status `unverified` oznacza archiwizację administracyjną bez potwierdzenia zamknięcia oferty.
Archiwum nie jest wczytywane do aktywnej listy strony.

## Parametry opcjonalne

| Pole oferty | Typ i ograniczenia |
|---|---|
| `modelKey` | Poprawny klucz modelu; jeśli podany, musi zgadzać się z plikiem |
| `vin` | `null` albo 17 znaków ASCII, bez I, O, Q; wielkość liter dowolna |
| `listingIds` | Tablica niepustych identyfikatorów tekstowych |
| `photos` | Opcjonalna tablica adresów HTTPS zdjęć z ogłoszenia; zapisujemy URL-e, nie pliki. Instrukcja zbierania ogranicza ją do 12 adresów. Frontend ładuje zdjęcia leniwie i pokazuje pierwsze jako miniaturę. Adres może wygasnąć lub portal może blokować osadzanie; wtedy pozostaje placeholder i link do ogłoszenia. |
| `price` | `null` albo nieujemna, skończona liczba; kwoty ułamkowe dozwolone |
| `mileage` | `null` albo nieujemna liczba całkowita w kilometrach |
| `year` | `null` albo liczba całkowita od 1886 do 2100 |
| `lastVerifiedAt` | ISO timestamp ostatniego udanego potwierdzenia statusu ogłoszenia; błąd dostępu go nie zmienia |
| `lastAttemptAt` | ISO timestamp ostatniej próby odczytu, także nieudanej |
| `verdict` | `match`, `check`, `fail`, historyczny alias `review` |
| `specs`, `details` | Obiekty z dowolnymi kluczami i wartościami tekstowymi lub `null` |
| `priceLabel`, `mileageLabel`, `engine`, `body`, `transmission`, `seller`, `subtitle`, `priority`, `verdictTitle`, `verdictNote` | Tekst albo `null` |
| `firstRegistrationDate` | Data pierwszej rejestracji `YYYY-MM-DD` albo `null`; nie zastępuje roku produkcji. |
| `offerType` | `private`, `company`, `leasing_return`, `unknown` albo `null`; zapisuj wyłącznie na podstawie źródła. |

### Lokalizacja oferty i późniejsze wyliczenie odległości

Nowe rekordy powinny zawierać obiekt `location`. Jeśli portal podaje miejsce,
ustaw `status: "available"` i zapisz miejscowość, województwo oraz kraj; kod
pocztowy i współrzędne zapisuj wyłącznie, gdy zostały podane lub ustalone ze
wskazanym źródłem. Jeśli miejsce nie jest podane albo nie da się go ustalić,
ustaw `status: "not_provided"`. Starsze rekordy bez `location` należy traktować
tak samo. Późniejszy widok ma pokazać „Brak danych o lokalizacji — nie można
obliczyć odległości”, zamiast ukrywać ten fakt. Pełny adres sprzedawcy nie jest
potrzebny. Nie wyprowadzaj miejscowości z samej nazwy sprzedawcy ani nie zgaduj
współrzędnych.

Przykład:

```json
"location": {
  "status": "available",
  "countryCode": "PL",
  "voivodeship": "małopolskie",
  "city": "Kraków",
  "postalCode": null,
  "latitude": null,
  "longitude": null,
  "precision": "city",
  "source": "listing",
  "geoSource": null,
  "checkedAt": "2026-11-08"
}
```

Późniejszy widok może dopasować miejscowość do lokalnego katalogu współrzędnych
i liczyć w przeglądarce odległość w linii prostej od wybranego miasta lub punktu.
Nie wymaga to agentów ani zapytania do usługi tras dla każdej oferty. Jeśli
zostanie pokazany także dystans drogowy szacowany współczynnikiem około 1,2–1,4,
ma być podpisany jako szeroki szacunek, nie nawigacyjna trasa. Brak lub niska
dokładność lokalizacji musi być widoczna zamiast pozornie dokładnej liczby.

Pola opcjonalne mogą być pominięte. Nieznane `vin`, `price`, `mileage`, `year`
wywołują ostrzeżenie, a nie odrzucenie rekordu. Nieznana ocena powinna być
pominięta; `verdict: null` i dowolne nieobsługiwane wartości są błędem.
Brak `modelKey` to ostrzeżenie — model można odczytać z obiektu nadrzędnego.

Nie stosujemy zamkniętych słowników silnika, nadwozia, skrzyni i tekstowego priorytetu:
obecny frontend oraz historyczne dane używają różnych etykiet. Normalizacja to kolejny etap.
Cena 0 wymaga ostrzeżenia; nie zastępuje nieznanej ceny. Cena i przebieg są ograniczone
do 9007199254740991, granicy bezpiecznych liczb całkowitych JavaScript, aby odrzucić
niepraktyczne wartości i przepełnienia frontendu. Nie jest to limit budżetu kupującego.
Zgodnie z JSON Schema zapis `2020.0` reprezentuje liczbę całkowitą; bool nie jest liczbą.

`model.description` jest opcjonalnym tekstem, a `model.requirements` tekstem albo `null`.
Pola `normalized` i `label` w linku są opcjonalne; jeśli istnieją, są tekstami.
`normalized` podlega takim samym kontrolom URL jak `url`.
Nieznane dodatkowe pola są dozwolone i raportowane jako ostrzeżenia, zamiast odrzucania rozszerzeń.
Pola pomocnicze `isNew` i `duplicateCount` wylicza frontend; nie są częścią zapisywanego kontraktu.

## ID i URL

Obsługiwane ID ofert:

- `listing:portal:identyfikator` — preferowane dla ogłoszeń;
- `listing:identyfikator` — historyczny format zgodny z obecnymi rekordami;
- `vin:VIN` — VIN o poprawnym formacie;
- `url:http(s)://...` — historyczny format, dopuszczony z ostrzeżeniem.

Identyfikatory `listing:` i `listingIds` składają się z liter i cyfr ASCII,
rozdzielanych pojedynczymi znakami `.`, `_`, `:`, `-`.
Brak nazwy portalu w `listingIds` jest ostrzeżeniem. Nie wymuszamy równoważności
`id` z jednym `listingIds`, ponieważ historia konwersji zawiera aliasy.
Globalna unikalność ID oferty jest wymagana, również między różnymi modelami.
Porównanie ignoruje wielkość liter, tak jak aktualny frontend.
Jeżeli `id` zawiera VIN, a pole `vin` jest znane, muszą być zgodne.

URL musi być bezwzględnym adresem HTTP lub HTTPS, z poprawnym hostem i portem,
bez danych logowania, białych znaków, znaków sterujących, odwrotnych ukośników,
niepoprawnych sekwencji procentowych i niedozwolonych niekodowanych znaków.
HTTP jest zachowany dla danych historycznych, ale powoduje ostrzeżenie: obecny
frontend udostępnia linki wyłącznie HTTPS. Poprawność składni nie potwierdza
istnienia strony, aktualności oferty ani poprawności normalizacji względem portalu.

Wspólne VIN, `listingIds` i adresy między różnymi rekordami są ostrzeżeniem
`SHARED_IDENTITY`, nie krytycznym duplikatem `id`: kilka ogłoszeń może dotyczyć jednego auta.
Klucz porównawczy URL zachowuje zapytanie i wielkość liter ścieżki;
usuwa fragment, `www.`, domyślny port i końcowy ukośnik ścieżki.
To tylko wskazówka do późniejszej deduplikacji, bez automatycznego scalania.

## Spójność całego repozytorium

Walidator sprawdza:

- zgodność `model.key` z nazwą pliku oraz `offer.modelKey` z modelem nadrzędnym;
- unikalność kluczy modeli, ścieżek indeksu i ID ofert;
- obecność każdego pliku ofert w indeksie i istnienie plików wymienionych w indeksie;
- identyczność `key`, `name`, `description`, `requirements` między ofertami i indeksem;
- zgodne z generatorem wartości domyślne: brak `description` to `""`, brak `requirements` to `null`;
- błędy JSON, powtórzone nazwy pól i niedozwolone stałe NaN/Infinity;
- daty aktualizacji w przyszłości i podejrzanie odległe roczniki jako ostrzeżenia.

Nie sprawdza warunków zakupu, autentyczności VIN, sumy kontrolnej VIN, historii auta,
osiągalności URL, zgodności ceny z opisowym `priceLabel` ani deklaracji sprzedawcy.
Nie narzuca jednej normy sumy kontrolnej VIN wszystkim rynkom.

## Zakres silnika schematów

Walidator odczytuje oba schematy; reguły typów nie są skopiowane do osobnego kontraktu w Pythonie.
Implementuje użyty podzbiór draft 2020-12: lokalne `$ref` do `$defs`, `type`, `required`,
`properties`, `additionalProperties`, `items`, `minItems`, `minLength`, `minimum`, `maximum`,
`pattern`, `format`, `enum`, `const` oraz metadane `title`, `description`, `$schema`.
`format` jest wymuszany dla dat i adresów HTTP(S), z lokalną polityką opisaną wyżej.
To nie jest uniwersalna implementacja JSON Schema ani walidator dowolnych schematów.
Nieznane słowa kluczowe lub formaty w schemacie powodują błąd, aby nowa reguła
nie została po cichu pominięta. Dodając słowa kluczowe, trzeba rozszerzyć silnik i testy.
