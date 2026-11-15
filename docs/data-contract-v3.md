# Kontrakt danych ofert v3

Każdy aktywny model ma osobny plik `offers/<model-key>.json`, publikowany razem ze statyczną stroną.

## Rekord auta

`offers[]` przechowuje rekord grupujący linki do źródłowych ogłoszeń tego samego auta:

- `id`, `identityKey`, `modelKey` — stabilna tożsamość rekordu;
- `primaryListingKey` — pierwsze źródło danych i domyślny link karty;
- `firstSeenAt`, `lastUpdatedAt` — daty rekordu;
- `listings[]` — osobny adres, portal i odczyt każdego ogłoszenia. To na poziomie pojedynczego ogłoszenia zachowujemy jego znormalizowane fakty, rozszerzenia portalu i dowody ekstrakcji.

Fakty wspólne są zapisywane w `listings[].facts`, dzięki czemu można zachować rozbieżności między portalami bez nadpisywania danych głównego źródła.

`listings[].sourceExtensions` jest opcjonalnym słownikiem przestrzeni nazw źródeł, np. `sourceExtensions.otomoto` albo `sourceExtensions.aaaauto`. Przechowuje istotne pola źródłowe, które nie mają jeszcze wspólnego odpowiednika lub są potrzebne do późniejszego przetwarzania. Brak rozszerzenia nie blokuje zapisu ani kwalifikacji. Nie kopiujemy tu technicznych odpowiedzi niezwiązanych z ogłoszeniem, takich jak sesje, telefony kontaktowe czy metadane żądań.

`listings[].fieldEvidence` opcjonalnie opisuje, skąd pochodzi znormalizowana wartość. Klucz mapy jest nazwą wspólnego pola, a wartość listą dowodów z polami `source`, `sourcePath` i `method`. Metoda może oznaczać odczyt pola strukturalnego, pary etykieta-wartość, regułę tekstową, analizę AI lub korektę ręczną. Dla wartości wyciągniętej przez AI wymagany jest krótki cytat źródłowy w `excerpt`.

Przykład pojedynczego wpisu źródłowego (wartości ilustracyjne):

```json
{
  "key": "otomoto:https://otomoto.pl/osobowe/oferta/kia-ceed-ID6IhlU2.html",
  "sourceId": "otomoto",
  "sourceName": "OTOMOTO",
  "sourceListingId": "6150000000",
  "url": "https://otomoto.pl/osobowe/oferta/kia-ceed-ID6IhlU2.html",
  "lastCheckedAt": "2026-11-15T12:00:00.000Z",
  "facts": {
    "title": "Kia Ceed 1.5 T-GDI",
    "price": 49900,
    "priceBasis": "unknown",
    "year": 2022,
    "mileage": 122579,
    "engine": "1.5 T-GDI 160 KM",
    "engineVariant": "1.5-tgdi-160",
    "vin": null,
    "firstRegistrationDate": null,
    "transmission": "manual",
    "body": "wagon",
    "location": { "city": "Katowice", "region": "Śląskie" },
    "fuel": "petrol"
  },
  "sourceExtensions": {
    "otomoto": {
      "listing": {
        "versionCode": "ver-1-5-t--gdi",
        "categoryId": "29"
      },
      "detail": {
        "priceBadges": ["INVOICE_ISSUED"]
      }
    }
  },
  "fieldEvidence": {
    "engineVariant": [
      {
        "source": "otomoto",
        "sourcePath": "detail.bodyText / opis",
        "method": "text_rule",
        "excerpt": "1.5 T-GDI 160 KM"
      }
    ]
  }
}
```

## Scalanie i aktualizacja

- Rekordy z różnych portali łączą się automatycznie wyłącznie wtedy, gdy mają taki sam poprawny, 17-znakowy VIN.
- Bez VIN każde ogłoszenie pozostaje osobnym autem, nawet jeśli opis i cena są podobne.
- Pierwsze źródło zachowuje priorytet. Jeśli nie zwróci konkretnego pola, strona może wyświetlić pierwszą dostępną wartość z kolejnego źródła.
- Jeżeli znane wartości pól różnią się między źródłami, karta pokazuje „Rozbieżność pól”.
- Pełny odczyt zastępuje poprzedni zestaw faktów dla tego linku. Brak pola w nowym odczycie czyści poprzednią wartość. Nieudany odczyt nie zmienia danych.
- Obsługa potwierdzonej nieaktywności jest osobnym przyszłym procesem. Nie jest częścią wyszukiwania ani tej migracji.

## Pola widoku

- **Wymagane do kwalifikacji nowej oferty:** pola z `fields.required`; obecnie `price`, `year`, `mileage`, `engineVariant`.
- `price` oznacza kwotę podaną w ogłoszeniu. Limity modelu porównujemy z tą kwotą niezależnie od tego, czy portal oznacza ją jako netto lub brutto. `priceBasis` jest informacją pomocniczą i nie blokuje kwalifikacji.
- **Półwymagane:** pola z `fields.semiRequired`; obecnie `vin`, `firstRegistrationDate`, `transmission`, `body`. UI pokazuje ich brak jako `-` z wyróżnieniem.
- **Opcjonalne:** pola z `fields.optional`; obecnie `location`, `photos`, `cameraStatus`, `fuel`, `engineCapacity`, `enginePower`. UI pokazuje je tylko, jeśli odczytano wartość.

Brak wymaganego pola w odpowiedzi strukturalnej źródła nie powoduje natychmiastowego odrzucenia. Najpierw źródłowy adapter i ekstraktory sprawdzają pola szczegółów, tytuł, opis oraz pozostały tekst ogłoszenia. Dopiero gdy wymagana wartość nadal nie ma potwierdzenia, kandydat jest odrzucany z przyczyną. Wartości odczytane skryptem lub AI powinny zachować dowód w `fieldEvidence`.

Wynik bezpośredniego wyszukiwania przechowuje robocze `extraction.facts`, `extraction.fieldEvidence`, listę konfliktów, `missingRequired` i `unresolvedRequired`. Po sprawdzeniu wszystkich źródeł kwalifikacja odrzuca kandydata z brakującą lub sprzeczną wartością wymaganą. Na tym etapie ekstrakcja jest deterministyczna i nie woła zewnętrznego modelu AI. Importer przenosi dowody dostępnych wspólnych pól do `listings[].fieldEvidence`.

Mapper ofert przenosi wartości wspólne do `listings[].facts`, a rozpoznane dodatkowe pola portalu pod `listings[].sourceExtensions.<sourceId>`. Usuwa z rozszerzeń pola już odwzorowane na wspólne fakty i dane techniczne, takie jak sesje, nagłówki, telefony i dane kontaktowe. Rozszerzenia listy i karty pozostają w osobnych gałęziach. Każdy import aktualizuje pełny odczyt konkretnego ogłoszenia przez istniejącą ścieżkę `npm run cars -- import --run <run-id>`.

Stary format v2 jest konwertowany przez `npm run cars -- migrate-offers`. Kontrakt ma maszynowy opis w `schemas/offers-v3.schema.json`.
