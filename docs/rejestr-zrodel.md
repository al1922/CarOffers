# Rejestr źródeł CarOffers

Sprawdzenie: 2026-11-08. Rejestr zawiera 26 źródeł. Pełnego wyszukiwania według wszystkich modeli i filtrów nie wykonano.

## Co zostało sprawdzone

Przy pomocy narzędzia web odczytano oficjalne strony lub katalogi. Część odpowiedzi pochodzi z indeksu/cache narzędzia: otwarcie karty nie gwarantuje aktualności ogłoszenia w chwili zakupu. Nie wykonano pełnego wyszukiwania wszystkich modeli ani filtrów użytkownika. Dlatego każde `lastSuccessfulSearchAt` ma wartość `null`. `checkedAt` oznacza datę tej próby odczytu, nie datę publikacji ogłoszenia.

`enabled` oznacza, że koordynator może przydzielić źródło do sprawdzenia. Nie oznacza udanego dostępu. Problemy dostępu i niepełne wyniki muszą trafić do raportu.

Poziomy dostępu:

- `landing_verified`: odczytano stronę informacyjną.
- `results_read`: odczytano listę ofert, bez pełnego sprawdzenia kart.
- `listing_read`: otwarto przykładową kartę. To test dostępu, nie rekomendacja auta.
- `partial`: katalog lub karta nie zostały poprawnie odczytane; źródło wymaga próby w przeglądarce.

## Źródła i wynik próby

| Źródło (oficjalny adres) | Typ | Wynik |
|---|---|---|
| [Otomoto](https://www.otomoto.pl/osobowe) | general | listing_read |
| [OLX](https://www.olx.pl/motoryzacja/samochody/) | general | results_read |
| [Autoplac](https://autoplac.pl/) | general | partial |
| [Motogratka / Gratka](https://motogratka.pl/motoryzacja/osobowe) | general | results_read |
| [Sprzedajemy](https://sprzedajemy.pl/motoryzacja/samochody-osobowe) | general | results_read |
| [Automarket / Masterlease (Grupa PKO BP)](https://www.automarket.pl/samochody-poleasingowe) | fleet | listing_read |
| [Arval AutoSelect](https://www.arval.pl/oferta/auta-poleasingowe/zakup-aut-uzywanych) | fleet | partial |
| [Ayvens — sprzedaż detaliczna](https://usedcars.ayvens.com/pl-pl/samochody) | fleet | results_read |
| [Toyota Pewne Auto](https://www.toyota.pl/oferty-specjalne/auta-uzywane) | manufacturer_program | partial |
| [Kia Używane](https://uzywane.kia.pl/) | manufacturer_program | partial |
| [Škoda Plus / samochody używane](https://www.skoda.pl/samochody-uzywane/skoda-plus-certyfikowane-uzywane) | manufacturer_program | partial |
| [Volkswagen Certyfikowane używane](https://www.volkswagen.pl/pl/osobowe/volkswagen-certyfikowane-uzywane.html) | manufacturer_program | partial |
| [SEAT Certyfikowane używane](https://www.seat.pl/oferta/certyfikowane-uzywane) | manufacturer_program | partial |
| [Suzuki — samochody używane dealerów](https://suzuki.pl/auto/samochody-uzywane) | manufacturer_program | results_read |
| [Hyundai Korea Motors — używane / Promise](https://hyundai.koreamotors.pl/p/program-hyundai-promise) | dealer | results_read |
| [SPOTICAR Polska](https://www.spoticar.pl/) | manufacturer_program | results_read |
| [AAA AUTO Polska](https://www.aaaauto.pl/) | dealer | landing_verified |
| [Autopunkt](https://autopunkt.pl/znajdz-auto) | dealer | listing_read |
| [Allegro Lokalnie](https://allegrolokalnie.pl/oferty/samochody/osobowe-4029) | general | results_read |
| [Autotrader.pl](https://www.autotrader.pl/osobowe/mazowieckie) | general | results_read |
| [Intermoto](https://intermoto.pl/) | general | landing_verified; portal zawiera aukcje, więc licytacje pomijamy |
| [Ford Używane](https://secure.ford.pl/oferta/znajdz/uzywane) | manufacturer_program | results_read |
| [Nissan Intelligent Choice](https://www.nissan.pl/pojazdy/oferty/intelligent-choice.html) | manufacturer_program | landing_verified |
| [Rynek używanych BMW / Premium Selection](https://najlepszeoferty.bmw.pl/uzywane/wyszukaj) | manufacturer_program | results_read |
| [Mercedes-Benz Certified](https://certified.mercedes-benz.pl/vehiclesearch?scroll=1) | manufacturer_program | results_read |

Źródła producentów BMW, Ford, Nissan i Mercedes-Benz pozostają w rejestrze,
ale są wyłączone z planowania: nie ma obecnie modeli tych marek w katalogu.
Pozostałe źródła są włączone, choć status `partial` oznacza, że pierwsza próba
może wymagać ręcznego otwarcia w przeglądarce. Włączenie nie oznacza pełnego
przeszukania ani dopasowania każdej marki.

Każdy wpis ma własne odnośniki dowodowe i opis próby w `verification`. Lista `filters` obejmuje rozpoznane filtry, nie gwarantuje pełnego katalogu możliwości. Pusta lista znaczy „nie sprawdzono”, a nie „brak filtrów”. `brands: []` oznacza brak ustanowionego ograniczenia marek; dla programów marek lista jest celowo zawężona do głównej marki, do czasu sprawdzenia pełnego zakresu.

## Decyzje i ograniczenia

- **Masterlease i Automarket:** oficjalna [strona Masterlease](https://masterlease.pl/samochody-poleasingowe/) kieruje do Automarket. Jeden wpis ogranicza podwójne przeszukiwanie tej samej puli.
- **Das WeltAuto:** [oficjalny wynik strony](https://www.dasweltauto.pl/) informuje o zakończeniu programu z końcem 2023 r.; bezpośrednie otwarcie zwróciło tylko ramę strony. Zamiast dodawać historyczny program do kolejki, wpisano bieżące programy Volkswagen, Škoda i SEAT.
- **Ayvens:** detaliczny [katalog używanych](https://usedcars.ayvens.com/pl-pl/samochody) jest odrębny od [Carmarket](https://carmarket.ayvens.com/pl-pl/saletype/fixedprice/), którego oficjalna strona adresuje sprzedaż do profesjonalnych dealerów. Carmarket nie dodano jako źródła detalicznego.
- **Kia:** [strona programu](https://uzywane.kia.pl/) działa, lecz przejście do `kiauzywane.pl` zwróciło 502. Próba w przeglądarce pozostaje do wykonania.
- **Toyota, Volkswagen, Škoda, SEAT:** programy zostały potwierdzone, ale pełny odczyt ich katalogów w narzędziu web był ograniczony. Nie raportować „zero ofert”.
- **Hyundai:** dodano konkretną sieć Korea Motors z ofertą używanych i stroną Promise. Nie jest to zastępstwo wszystkich dealerów Hyundai w Polsce. Dalszych dealerów można dodawać jako osobne źródła.
- **SPOTICAR i renew:** odczytane katalogi zawierają różne marki. Nie ograniczamy ich do głównych marek grupy.
- **Allegro Lokalnie:** aktywna kategoria samochodów osobowych z prywatnymi sprzedawcami. Sprawdzać pełne warunki i aktualność konkretnej oferty.
- **Autotrader.pl:** odczytano regionalne listy i paginację. To rozszerzenie kanału ogłoszeniowego; duplikaty względem innych portali są prawdopodobne.
- **Zasięg Autotradera:** link testowy jest dla Mazowsza. Zadanie wymaga iteracji województw; samo otwarcie tego adresu nie pokrywa całej Polski.
- **Intermoto:** kategoria osobowa i różne typy sprzedawców są widoczne, ale serwis obejmuje też aukcje. W rejestrze pozostaje jako portal ogłoszeniowy; agent ma odrzucać pozycje licytowane zgodnie z zakazem aukcji.
- **Ford, Nissan, BMW i Mercedes-Benz:** dodano oficjalne programy producentów. Obecnie nie pasują do marek z aktywnego katalogu 15 modeli, więc nie otrzymają zadań dla tych modeli; mogą się przydać przy przyszłym rozszerzeniu katalogu.
- **GetAuto.pl:** znaleziono portal, ale próba odczytu strony przekroczyła limit czasu. Nie dodano go do aktywnego rejestru, dopóki nie da się potwierdzić użytecznej listy ofert i filtrów.

Typ serwisu, typ sprzedawcy i pochodzenie auta to osobne osie. Pole `origins` opisuje profil źródła, nie potwierdzoną historię każdego auta. Marketingowe zapewnienia portalu nie są niezależną weryfikacją samochodu.

## Sposób pracy agenta

1. Odczytaj aktualne wymagania i profil modelu, nie kopiuj stałego budżetu do adresu źródła.
2. Otwórz `searchUrl`, ustaw dostępne filtry i zapisz rzeczywiście użyte kryteria. Filtry nieobsługiwane sprawdzaj w karcie.
3. Otwórz każdą potencjalnie pasującą kartę i sprawdź pełną cenę brutto, nadwozie, napęd, rok, przebieg, kamerę i warunki zakupu.
4. Zachowaj źródłowy URL/ID oraz braki informacji. Nie kontaktuj się ze sprzedawcą ani nie zakładaj konta.
5. Raportuj zakres przeszukania, strony wyników, błędy i pozostały zakres. Przykładowe karty z rejestru nie stają się automatycznie ofertami w bazie.

