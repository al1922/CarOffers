# Lokalizacje i odległości

Aplikacja oblicza dystans w linii prostej lokalnie w przeglądarce. Punkt startowy
można wybrać z katalogu 39 dużych miast Polski lub podać własne współrzędne.
Wybór zostaje w localStorage. Obliczenia nie wysyłają punktu do zewnętrznego API.
Odległość prowadzi do punktu miejscowości, nie do adresu auta. Można sortować
oferty od najbliższej i ograniczyć promień; brak współrzędnych nie oznacza zera.

Stan przygotowany 8 listopada 2026: 77 ofert, 43 z miejscowością, 24 z punktem
do obliczenia odległości. Dwie lokalizacje odczytano z ogłoszeń podczas tej sesji;
pozostałe zachowują oznaczenie historycznego tytułu wymagającego potwierdzenia.
Liczby są zapisane w `reports/location-migration.json`.

## Pochodzenie danych

- `data/cities-pl.json`: miejscowości liczące co najmniej 100 tys. mieszkańców
  według wykorzystanego zbioru GeoNames; dzielnice Warszawy wykluczono.
- `data/verified-locations.json`: odczyty ogłoszeń z URL, cytatem i czasem.
- `data/offer-locations.json`: uzupełnienia do wyświetlania, źródła i precyzja.
  Są stosowane tylko przy zgodności identyfikatora, tytułu i źródłowego URL;
  nie zastępują istniejącej ustrukturyzowanej lokalizacji.
- `reports/location-evidence/`: zachowane tytuły i URL będące podstawą migracji.

Nie zmieniano źródłowych `offers/*.json` w celu dopisania lokalizacji. Skrypt
odczytuje miejscowości jawnie podane po separatorze w historycznych tytułach;
nie wyprowadza miejsca z nazwy sprzedawcy. Niejednoznaczne nazwy pozostają bez
współrzędnych. Data geokodowania nie jest datą ponownego odczytu ogłoszenia.

Punkty miejscowości pochodzą z [GeoNames](https://download.geonames.org/export/dump/),
licencja [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Pliki wynikowe zachowują źródło i sumę kontrolną archiwum; strona pokazuje atrybucję.

## Odtwarzanie

Umieść pobrany z powyższego katalogu plik `PL.zip` pod nazwą
`.cache/geonames-PL.zip`, a następnie uruchom:

```powershell
python -B scripts/generate-locations.py
```

Skrypt działa bez sieci. Archiwum jest pomijane przez Git; gotowe pliki `data/`
muszą trafić na GitHub Pages razem z aplikacją. Po zmianie ofert uruchom generator
ponownie i sprawdź raport. Nowe odczyty ogłoszeń wymagają rzeczywistego sprawdzenia
źródła i zapisania dowodu; nie zmieniaj daty odczytu przy samym przeliczeniu.
