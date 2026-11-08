# CarOffers — założenia i kolejność prac

Stan: 8 listopada 2026. Ten dokument jest krótkim przewodnikiem po aktualnych
ustaleniach. Konfiguracje JSON pozostają źródłem danych dla narzędzi.

## Ustalone założenia kupującego

- Budżet bazowy: maksymalnie 55 000 zł brutto za sam zakup, bez obowiązkowego
  finansowania. Niewielkie przekroczenie może być rozważone tylko przy wyjątkowo
  dobrej ofercie i po Twojej zgodzie; kwota nie jest z góry ustalona. System musi
  zatrzymać taką ofertę do ręcznej decyzji, nie może oznaczyć jej automatycznie
  jako zgodnej.
- Rocznik: od 2017; wyjątki wynikające z konkretnego zakresu modelu są zapisane przy modelu.
- Przebieg do 150 000 km jest preferowany, a nie twardym limitem. Oceniać go razem
  z rokiem produkcji, udokumentowanym rodzajem użytkowania i historią serwisową.
  Dla aut prywatnych przyjęto robocze 10–15 tys. km/rok, dla intensywnie używanych
  aut flotowych 20–30 tys. km/rok. To wskazówki do kontroli, nie dowód przebiegu.
- Auto dla dwóch dorosłych i dziecka; wózek i bagaże muszą się zmieścić. Udział
  miasta i trasy jest w przybliżeniu równy; przebieg roczny 12–15 tys. km.
- Skrzynia manualna i automatyczna są równie akceptowalne. Czujniki przednie są
  atutem, nie warunkiem.
- Przy nowej ofercie zapisuj dostępne miejsce sprzedawcy w ustrukturyzowanym polu
  lokalizacji, aby później strona mogła wyliczyć orientacyjną odległość od
  wybranego miasta lub punktu. Jeśli miejsca brak, oznacz ofertę jako
  `not_provided`; widok ma pokazać, że odległości nie można obliczyć.
- Kamera cofania jest wymagana w docelowym aucie, ale może zostać dołożona po
  potwierdzeniu kompatybilności. Brak i status montażu trzeba jawnie oznaczać.
- Import jest akceptowany. Poważne uszkodzenia konstrukcyjne są wykluczone;
  naprawy kosmetyczne mogą być oceniane indywidualnie.
- Wszystkie paliwa są dopuszczone wyłącznie w ramach wybranych wariantów silników.
  LPG jest dozwolone; oznaczyć instalację i sprawdzić dokumenty oraz zbiornik.
- Zakupy aukcyjne są wykluczone.
- Aktywne modele i warianty silników są zamkniętą listą z
  `config/search-models.json`. Nie dodawać kolejnych modeli ani silników bez
  aktualizacji tej listy.

## Status katalogu

Katalog ma 16 aktywnych modeli: 15 dotychczasowych oraz dodaną Mazdę 6 III Wagon.
Silniki z pliku użytkownika oceniono według wspólnej metody; warianty warunkowe
pozostają dopuszczone do dalszego rozważenia, a przypadki konfliktu zakresu lub
istotnej luki są oznaczone jako wstrzymane. **Żaden z 16 modeli nie osiągnął
pełnego progu „polecany”** z powodu braku dwóch niezależnych, długoterminowych
źródeł awaryjności konkretnych jednostek i porównywalnych polskich kosztów
napraw. Wstrzymanie nie oznacza automatycznego odrzucenia silnika. Metoda:
`docs/metoda-oceny-silnikow.md`.

Raporty z przeglądu: `reports/analiza-hyundai-i30-silnikow-2026-11-08.md`,
`reports/analiza-silnikow-batch-a-2026-11-08.md`,
`reports/analiza-silnikow-batch-b-2026-11-08.md` oraz
`reports/analiza-silnikow-batch-c-2026-11-08.md`. Werdykty wariantów są również
wpisane do `engineReview` przy każdym modelu w `config/search-models.json`.

Do jawnego sprawdzenia przed zatwierdzeniem filtrów pozostają co najmniej:

- Škoda Scala 1.0 TSI 110 KM: wariant 81 kW potwierdzono w danych producenta,
  ale czeskie STK pokazuje podwyższony sygnał usterek całego auta. Status
  wstrzymany do wyjaśnienia; nie przypisywać go samemu silnikowi.
- Toyota Corolla 1.6 Valvematic 132 KM: dodana do aktywnej listy dla sedana,
  potwierdzona w polskiej gamie MY2019. Nie dotyczy Touring Sports; przy późniejszej
  rejestracji trzeba sprawdzić datę produkcji i VIN. Ocena wstrzymana do zebrania
  danych trwałości dla E210 z tym napędem.
- Toyota Avensis 2.0 Valvematic 152 KM: usunięty z aktywnego filtra, bo źródła
  nie potwierdzają docelowego polskiego kombi z lat 2017–2018. Przywrócić tylko
  po uzyskaniu dowodu dla rynku, nadwozia i daty produkcji.
- Volkswagen Golf VII Variant 1.4 TSI 150 KM: wstrzymany z powodu konfliktu
  zakresu. Archiwum VW wskazuje 1.4/150 do 2016 r., a w latach 2017–2018
  1.5/150; zgodność konkretnego egzemplarza wymaga daty produkcji i VIN.
- Toyota Corolla 1.8 Hybrid 140 KM: potwierdzić dokładny rok modelowy i moc
  systemową dla rynku konkretnego auta.
- Mazda 6 2.0 Skyactiv-G 145/165 KM: karta źródłowa potwierdza europejską gamę
  2018, ale nie ocenia trwałości ani wszystkich polskich roczników.
- Pozostałe warianty: przypisać dokładny kod silnika, okres produkcji, skrzynię,
  typowe usterki i jakość dowodów. Nie przenosić wniosków między mocami,
  nadwoziami, rynkami ani kodami.

## Kolejność następnych prac

1. Rozstrzygnąć warianty oznaczone jako wstrzymane przez dokumenty konkretnego
   auta, datę produkcji, VIN i wersję wyposażenia; nie akceptować ich
   automatycznie po samym roku pierwszej rejestracji.
2. Uzupełnić karty wyposażenia i kamer dla wszystkich aktywnych modeli, z
   rozdzieleniem dostępności w wersji od potwierdzenia wyposażenia konkretnego auta.
3. Dodać widok odległości: katalog większych miast z lokalnymi współrzędnymi,
   wybór miasta lub własnego punktu oraz obliczenie w przeglądarce. Odległość
   w linii prostej pokazywać jako podstawową; ewentualny zakres drogowy oznaczać
   jako przybliżenie.
4. Po zatwierdzeniu katalogu silników i przygotowaniu zbierania lokalizacji
   rozpocząć wyszukiwanie ofert.

## Mapa plików

- `config/requirements.json` — wspólne kryteria kupującego.
- `config/search-models.json` — modele, lata i zamknięta lista silników.
- `config/sources.json` — rejestr portali ogłoszeniowych.
- `knowledge/models/*.json` — fakty, źródła, zakresy i otwarte pytania.
- `offers/*.json` — dane ofert; opisy kryteriów są synchronizowane z konfiguracji.
- `schemas/offers-v2.schema.json` — opcjonalna lokalizacja oferty i jej źródło.
- `docs/rejestr-zrodel.md` — uzasadnienie i status źródeł ogłoszeń.
- `docs/baza-wiedzy.md` — sposób czytania kart technicznych.

Walidację konfiguracji uruchamia się poleceniem `python -B scripts/car-search.py validate`.
