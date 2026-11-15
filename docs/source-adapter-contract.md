# Kontrakt adaptera źródła

Każdy portal ma osobny adapter w `src/search/direct/adapters/`. Adapter odpowiada za odczyt strony lub odpowiedzi portalu i dekodowanie jej do kształtu kandydata źródłowego. Wspólna część nie interpretuje nazw pól z JSON-u portalu.

## Wymagane metody

- `id` musi odpowiadać identyfikatorowi źródła z konfiguracji.
- `extractListings(page)` zwraca tablicę kandydatów listy.
- `extractDetail(page)` zwraca dane pojedynczej karty.
- Hooki filtrów, oczekiwania na odpowiedź, paginacji i przechwytywania są opcjonalne; runner korzysta z nich tylko wtedy, gdy adapter je implementuje.

Runner sprawdza ten kontrakt przy starcie wyszukiwania i normalizuje wyniki obu metod. Niezgodny adapter kończy się czytelnym błędem zamiast niejawnego pominięcia danych. Po odczycie uruchamia współdzielony ekstraktor pól przed kwalifikacją; opis ekstrakcji i format wyników znajduje się w [direct-search.md](direct-search.md).

## Kandydat listy

Każdy wynik `extractListings()` i `extractApiListings()` ma wspólne minimum:

```js
{
  url: "https://portal.example/oferta/...",
  title: "Tytuł ogłoszenia",
  visibleText: "Tekst widoczny przy wyniku", // opcjonalny
  sourceFields: { /* wybrane pola odczytane przez adapter portalu */ },
  sourceEvidence: { /* ślad odczytu z portalu, jeśli jest dostępny */ }
}
```

`url` musi być bezpiecznym adresem HTTPS. Jeśli adapter nie ma osobnego tytułu, runner wyprowadza go z pierwszej linii `visibleText`; po tej próbie tytuł musi być niepusty. Adapter może zwrócić dodatkowe wskazówki, takie jak cena odczytana z danych strukturalnych i `apiEvidence`. Część wspólna łączy duplikaty z listy i danych strukturalnych po URL-u, zachowując pola adaptera.

## Kandydat karty

`extractDetail()` zwraca obiekt zawierający `bodyText` oraz, jeśli są dostępne, `title`, `fields`, `structuredData`, `ctas`, `photos`, `sourceFields` i `sourceEvidence`. Pola `fields` i `structuredData` są wejściem do dalszej wspólnej analizy. `sourceFields` pozostaje projekcją danego adaptera i nie jest jeszcze wspólnym rekordem oferty.

Adapter powinien wybierać dane związane z ogłoszeniem. Nie przekazuje pełnych odpowiedzi sieciowych, stanu sesji ani danych technicznych do `sourceFields`. Przechwycone odpowiedzi pozostają osobną diagnostyką przebiegu.

## Wynik przebiegu

Kandydat zapisany w wyniku wyszukiwania ma `sourceId` oraz `sourcePayload` z przestrzenią nazw portalu:

```json
{
  "sourcePayload": {
    "otomoto": {
      "listingFields": { "productionYear": 2021 },
      "detailFields": {},
      "listingEvidence": {},
      "detailEvidence": {}
    }
  }
}
```

W ten sposób pola OTOMOTO i AAA AUTO nie zlewają się w jeden bezźródłowy słownik. Ten tymczasowy ładunek przebiegu nie zastępuje `listings[].facts` ani `listings[].sourceExtensions` w kontrakcie ofert v3. Mapper importu wybiera z niego wspólne fakty i dodatkowe pola do przestrzeni nazw portalu.

## Obecny zakres

OTOMOTO i AAA AUTO zachowują własne parsowanie listy i karty. Wspólny runner waliduje kształt kandydata i dalej przekazuje pola adaptera do obecnej kwalifikacji. Kontrakt nie zmienia jeszcze reguł wyciągania danych z opisu ani decyzji o odrzuceniu; to kolejne etapy.
