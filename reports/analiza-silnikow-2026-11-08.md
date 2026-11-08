# Analiza wariantów silnikowych — stan i metoda

Data rozpoczęcia: 2026-11-08. Zakres: 10 aktywnych modeli CarOffers; celem jest
ograniczenie wyszukiwania do silników z uzasadnieniem, a nie przepisanie dawnych
filtrów jako rekomendacji.

## Uzupełnienie po otrzymaniu szczegółowej listy użytkownika

Karty pięciu dodanych modeli wzbogacono o źródła producentów i przypisane do nich
ustalenia. Wprowadzono następujące korekty zakresów:

- **Scala:** aktywny filtr zawiera 1.0 TSI 115 KM. Twierdzenia o 110 KM nie
  potwierdziły przejrzane dokumenty Škody; usunięto je z aktywnego filtra.
- **Avensis III Wagon:** aktywny wybór ograniczono do 1.8 Valvematic 147 KM.
  2.0 Valvematic 152 KM występuje w niektórych danych gamy, ale nie udało się
  potwierdzić go dla wskazanego polskiego nadwozia i roczników. Pozostał jako
  kwestia do weryfikacji, poza aktywnym filtrem.
- **Golf Sportsvan:** nadwozie oznaczono osobno jako minivan. Źródło VW pokazuje
  nowszy 1.5 TSI ACT przy aktualizacji z 2017 r.; obecność 1.4 TSI dla konkretnego
  MY2017–2018 należy potwierdzić datą produkcji i VIN-em.
- **Superb Combi:** dokument Škody potwierdza 1.4 TSI ACT 110 kW w danych Combi
  z 2017 r. Potwierdzenie specyfikacji nie jest jeszcze rekomendacją trwałości.
- **Passat B8 Variant:** archiwum VW Polska potwierdza 1.4 TSI ACT 110 kW przed
  2019 r.; konfigurację ograniczono do 2017–2018 i dodano regułę sprawdzającą.
- **Golf VII Variant:** dodano profil fabryczny VW: 1.4 TSI do 2018, a 1.5 TSI
  ACT od 2017. Wariant 1.4 nie przechodzi automatycznie jako rocznik 2019–2020.
- **Corolla E210:** dołączono gamę premierową Toyoty, która oddziela nadwozie
  sedan od Touring Sports; 1.6 Valvematic z sedana nie jest traktowany jako
  wariant kombi bez oddzielnego dowodu.

Źródła potwierdzają występowanie i parametry jednostek w określonych zakresach.
Nie znaleziono w tym przebiegu wystarczających danych porównawczych o awaryjności,
kosztach napraw i długoterminowej niezawodności dla wszystkich silników. Dlatego
żaden z tych faktów katalogowych sam w sobie nie oznacza „polecany”. Karty nadal
jasno pokazują tę lukę.

## Kryteria dopuszczenia

Wariant trafia do `allowedEngineVariants` dopiero po sprawdzeniu: (1) dokładnej
jednostki i mocy na danym rynku, (2) okresu produkcji w wybranym nadwoziu,
(3) współpracy ze skrzynią, (4) wiarygodnych informacji o trwałości oraz
charakterystycznych kosztownych usterkach i (5) przydatności do profilu użytkowania.
Każde kryterium ma mieć dowód, źródło, zakres i poziom pewności.

Katalog producenta potwierdza występowanie wariantu, ale sam nie dowodzi
niezawodności. Ankieta, forum lub pojedyncza historia naprawy wskazuje na pytanie
kontrolne, nie na częstość awarii. Brak dobrych danych oznacza „nierozstrzygnięty”,
nie „polecany”. Kod silnika należy w miarę możliwości potwierdzić VIN-em lub
dokumentem pojazdu; nie wyprowadzać go z samej nazwy handlowej.

## Stan przed oceną

Dziesięć obecnych modeli miało dziedziczone etykiety silników w
`config/search-models.json`. Karty techniczne mają `partial`, a więc nie dostarczały
jeszcze rzetelnych porównań niezawodności dla pełnej listy. Jeden udokumentowany
konflikt jest istotny: karta Golfa VII podaje produkcję 1.4 TSI Variant do 2018,
mimo filtra modelu do 2020. Karta Corolli ostrzega, że materiał premierowy
przypisuje 1.6 132 KM do sedana, nie Touring Sports. Są to sygnały, by wariant
sprawdzić, nie wystarczające porównanie wszystkich silników.

## Zmiana w bieżącym przebiegu

Nie zawężono dziś listy na podstawie ogólnych reputacji lub niepełnych opisów.
Dotychczasowe warianty zachowano jako odziedziczone filtry, bez statusu
rekomendacji. Dodano tylko techniczne reguły ostrożności dla znanych konfliktów
Golfa i Corolli: rozbieżność nadwozia/okresu kieruje ofertę do sprawdzenia,
a nie do automatycznego `match`. Uzupełniono kartę i30 o ograniczone rynkowo
i rocznikowo źródła wyposażenia, lecz to nie zastępuje porównania niezawodności.

## Macierz decyzji

| Model | Obecny wariant dziedziczony | Decyzja na obecnym materiale |
|---|---|---|
| Hyundai i30 III Wagon | 1.5 DPi 110, 1.4 T-GDi 140 | Nie zatwierdzać jako „najlepszych” bez porównania usterek i serwisu obu jednostek. |
| Kia Ceed III SW | 1.4 MPI 100, 1.4 T-GDi 140 | Do badania; katalogowe występowanie nie rozstrzyga trwałości ani kosztu T-GDi. |
| Renault Mégane IV Grandtour | 1.3 TCe 140 | Do badania po konkretnym kodzie, okresie i skrzyni; rekomendacja nadal niepotwierdzona. |
| SEAT Leon III ST | 1.4 TSI EA211 125/150 | Do badania dla kodu, mocy i skrzyni; nie przenosić oceny między wariantami. |
| Škoda Octavia III Combi | 1.4 TSI EA211 150 | Do badania; walidować kod i skrzynię oraz odróżnić późniejszy 1.5 TSI. |
| Suzuki SX4 S-Cross | 1.4 BoosterJet 140 | Do badania pod kątem osprzętu turbo i skrzyń w poszczególnych latach. |
| Suzuki Vitara II | 1.6 VVT 120, 1.4 BoosterJet 140 | Porównać prostszą wolnossącą jednostkę z turbo; reputacja bez danych to za mało. |
| Toyota Auris II TS | 1.8 Hybrid 136 | Do badania całego układu hybrydowego, baterii, e-CVT i procedury kontroli. |
| Toyota Corolla E210 | 1.5, 1.6 Valvematic, 1.8 Hybrid | Rozdzielić nadwozia i lata; 1.6 sedan nie może przejść automatycznie jako TS. |
| Volkswagen Golf VII Variant | 1.4 TSI EA211 125/150 | Sprawdzić rok produkcji i kod; dokumentowany okres 1.4 kończy się przed końcem filtra modelu. |

Nie ma dziś podstaw, aby przedstawiać powyższe odziedziczone warianty jako
zatwierdzone rekomendacje. Zostawiono je konfigurowalne, aby nie fałszować
wniosków przez ciche skasowanie bez sprawdzenia albo domysł.

## Plan badań kart po jednej jednostce

Dla każdego modelu uzupełnić tabelę: kod/rodzina silnika, moc, paliwo, okres,
skrzynia, kraj, źródła producenta, biuletyny/akcje, awarie z dowodem częstości,
koszt i czas naprawy ze źródłem lokalnym, ryzyko dla 12–15 tys. km rocznie
i około 30-minutowych tras miejskich, werdykt oraz kontrola konkretnego auta.
Osobno oznaczać samochody z LPG i potrzebę weryfikacji dokumentów instalacji.

Priorytet rozpoczęcia: i30, Ceed i oba Suzuki (rodzinne benzynowe warianty),
następnie Mégane, Golf, Leon i Octavia, potem napędy hybrydowe Toyoty oraz
Corolla zależnie od nadwozia. Kolejność to plan pracy, nie ranking rekomendacji.

Po badaniu wariantu dopuszczone jednostki otrzymają status i odwołanie do
twierdzeń wiedzy; warianty nierozstrzygnięte będą jawnie zawieszone. Publikowane
opisy ofert powinny wtedy powstawać z zatwierdzonego katalogu, nie z ręcznego tekstu.

## Aktualizacja katalogu po sprawdzeniu doprecyzowanych założeń

Katalog ma teraz 16 modeli: dotychczasowe 15 oraz Mazda 6 III Wagon z listy
użytkownika. Warianty i roczniki z listy użytkownika zostały scalone w
`config/search-models.json`; zakres skrzyń nie ma preferencji. Zapis wyboru
użytkownika nie oznacza jeszcze, że silnik został niezależnie uznany za polecany.

Do jawnego rozstrzygnięcia przed zatwierdzeniem filtrów pozostają rozbieżności:
Škoda Scala 1.0 TSI 110 KM (dotychczas sprawdzone źródła producenta wskazują
115 KM), Toyota Avensis 2.0 Valvematic 152 KM dla polskiego kombi oraz dokładny
okres i moc systemowa 140 KM Corolli od 2023 r. Karta Mazdy potwierdza europejską
gamę 2018, ale nie stanowi oceny niezawodności. Szczegóły i kolejność prac opisuje
`docs/porzadek-projektu.md`.
