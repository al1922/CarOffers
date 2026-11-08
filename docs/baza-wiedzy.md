# Baza wiedzy o modelach

Przegląd: 2026-11-08. Utworzono 16 kart w `knowledge/models/`, po jednej na aktywny klucz modelu. Karty zawierają fakty ze źródeł producentów, jawne pytania do dalszego badania i oceny wariantów silników. Karty nadal mają status `partial`, a dokumenty katalogowe nie są same w sobie oceną niezawodności.

## Jak korzystać

Każde ustalenie (`claims`) ma własne źródła (`sourceIds`), zakres (`scope`), pewność i uwagi. Pewność `high` oznacza, że przytoczone źródło jasno potwierdza fakt w zapisanym zakresie. Nie oznacza pewności, że dane ogłoszenie ma takie wyposażenie albo jest sprawne.

- Konfiguracja wyszukiwania opisuje wybory kupującego. Karta wiedzy opisuje fakty i nie rozszerza samodzielnie listy dozwolonych napędów.
- Regułę z karty można zastosować tylko po dopasowaniu nadwozia, rynku, rocznika/model year i napędu. Nieznany zakres oznacza konieczność sprawdzenia.
- Data produkcji, rok modelowy i data pierwszej rejestracji to osobne informacje.
- Kamera jako standard w katalogu jest wskazówką; obecność i działanie wymagają zdjęcia, dokumentu wyposażenia lub oględzin konkretnego auta.
- Możliwość montażu kamery pozostaje nieustalona do czasu ustalenia radia, instalacji, rozwiązania i kosztu dla danego egzemplarza.
- `openQuestions` i `inspectionChecklist` są pytaniami kontrolnymi, nie listą stwierdzonych wad modelu.
- Nie podano wymyślonych kodów silników, kosztów napraw, realnego spalania ani rankingów awaryjności. Puste obszary pozostają otwarte.

## Co już wychwycono

Warto poprawnie rozdzielić zakres lat modelu i okres konkretnego silnika. Archiwum Volkswagena podaje końcowy rok 2018 dla Golfa VII Variant 1.4 TSI; istniejący filtr modelu do 2020 nie może zastąpić identyfikacji jednostki i roku produkcji. [Volkswagen — dane archiwalne](https://www.volkswagen-newsroom.com/en/vehicle-data-golf-7-variant-profile-20042).

Corolla wymaga osobnych reguł dla sedana i Touring Sports. Materiał premierowy Toyoty przypisuje benzynę 1.6 132 KM sedanowi, więc nie wolno przenosić jej automatycznie do kombi. Dane 1.5 125 KM wymagają dodatkowej weryfikacji. [Toyota — gama premierowa 2019](https://newsroom.toyota.eu/2019-the-toyota-corolla/).

W specyfikacji Leona ST ekstrakcja tabeli bagażnika daje niejednoznaczny kontekst kolumn. Karta zapisuje konflikt zamiast utrwalać jedną liczbę dla wszystkich konfiguracji. [SEAT — specyfikacja ST](https://www.seat-cupra-mediacenter.com/content/dam/seat-media-center/Documents/2016/Technical-Specifications-New-SEAT-Leon-ST2016EN.pdf).

## Pilotaż: Hyundai i30 III Wagon

Oceny wariantów napędu prowadzi się według wspólnej metody z
`docs/metoda-oceny-silnikow.md`. Wyniki pilotażu i30 oraz jego ograniczenia
zapisano w `reports/analiza-hyundai-i30-silnikow-2026-11-08.md`; statusy są też
widoczne przy modelu w `config/search-models.json`. „Warunkowo polecany” nie
oznacza gwarancji bezawaryjności, a status wstrzymany nie jest równoznaczny
z odrzuceniem wariantu.

Najbardziej rozbudowana karta obejmuje gamę premierową, napęd 1.5 DPi z modernizacji 2020, bagażnik i wymiary, dostępność kamery oraz odniesienie do interwału serwisowego. Źródła są europejskie, słowackie i polskie. Każde ma zapisany ograniczony zakres, w tym wstępny charakter dokumentu z lutego 2020.

## Oceny wariantów silników — wszystkie aktywne modele

Po pilotażu i30 tę samą metodę zastosowano do pozostałych 15 modeli. Status i
krótkie uzasadnienie każdego wariantu znajdują się w `engineReview` przy modelu
w `config/search-models.json`; dowody, ograniczenia i kontrole egzemplarza są w
kartach wiedzy. Zestawienia zbiorcze:

- `reports/analiza-hyundai-i30-silnikow-2026-11-08.md` — pilotaż i30,
- `reports/analiza-silnikow-batch-a-2026-11-08.md` — Kia, SEAT i Škoda,
- `reports/analiza-silnikow-batch-b-2026-11-08.md` — Suzuki i Toyota,
- `reports/analiza-silnikow-batch-c-2026-11-08.md` — Volkswagen, Škoda Superb i Mazda.

Żaden wariant nie osiągnął pełnego progu „polecany”. Większość jest oceniona
warunkowo; wstrzymane pozycje mają wypisany konkretny powód, np. konflikt
rocznika z datą wprowadzenia silnika, zbyt krótki okres obserwacji albo
niekorzystny sygnał dotyczący całego auta. Nie przenosić takiego sygnału na
awaryjność samego silnika. Przed decyzją o konkretnej ofercie potwierdzić kod,
rynek i datę produkcji po VIN. LPG, skrzynie automatyczne i kampanie serwisowe
oceniać odrębnie od werdyktu silnika.

Polski cennik PY2020 odnaleziony na serwerze zasobów Hyundai dotyczy **hatchbacka**. Zachowano go jako kontekst dalszego badania z wyraźnym zastrzeżeniem, że nie ustanawia reguł wyposażenia Wagon. [Hyundai — polski cennik Hatchback PY2020](https://s7g10.scene7.com/is/content/hyundaiautoever/Cennik_Nowy_i30_Hatchback_PY2020pdf).

Dodatkowo odczytano archiwalne polskie dokumenty producenta dla właściwego nadwozia Wagon:

| Dokument | Wybrane silniki i kamera |
|---|---|
| Rocznik 2018, edycja go!/go! PLUS, cennik od 2 lutego 2018 | 1.4 T-GDi 140 KM: 6MT/7DCT w go! PLUS i Premium; obie wersje mają w tabeli nawigację 8 cali z kamerą. Nie jest to pełna oferta wszystkich edycji 2018. |
| PY2021 | 1.5 DPi 110 KM: Classic Plus lub Comfort, 6MT; kamera w tabeli Comfort, brak w Classic Plus. |

[Archiwalny dokument Wagon 2018](https://serwer1455298.home.pl/wp-content/uploads/2018/03/Cennik_i30_wagon_2018_GO.pdf), [dokument Wagon PY2021 u dealera Auto-Mobil](https://www.auto-mobil.pl/wp-content/uploads/2021/05/Cennik_Nowy_i30_Wagon_PY2021pdf.pdf).

Te dwa dokumenty odczytano jako zindeksowaną treść PDF. Render stron nie był dostępny: link Auto-Mobil zwrócił przy tej próbie 404, kopia 2018 błąd pamięci podręcznej. Dlatego ustalenia mają pewność `medium`, zastrzeżenie dostępu i wymagają ponownego potwierdzenia. Nie ogłoszono pełnego sprawdzenia oryginalnych plików. W tabeli Wagon PY2021 przednie czujniki wymieniono jako standard tylko w Premium; to kolejny powód, aby nie przenosić tabel hatchbacka do kombi.

Przykładowa droga dołożenia kamery prowadzi przez kompatybilną stację multimedialną. Autoradex opisuje takie rozwiązanie dla i30 2018–2023 ze zwykłym radiem bez nawigacji, ale nie potwierdza zgodności dla nawigacji fabrycznej i wyklucza wskazany wzmacniacz premium. To informacja wykonawcy wymagająca sprawdzenia konkretnego auta. [Autoradex — warunki kompatybilności](https://autoradex.pl/stacje-multimedialne-dedykowane/2385-stacja-multimedialna-hyundai-i30-2018-2023-gms-7785tq-navix-5902738800134.html).

Osobny przykład kosztu to 650 zł brutto za kamerę z montażem do zgodnej stacji/modułu, według cennika Audio Car z 28 października 2026. Nie obejmuje zakupu stacji lub modułu, a instalacja do fabrycznego ekranu wymaga osobnej wyceny. Nie jest to potwierdzona całkowita cena doposażenia i30 ani wspólna oferta obu firm. [Audio Car — zakres ceny](https://audio-car.pl/poradnik/ile-kosztuje-kamera-cofania/).

## Następne uzupełnienia

1. Archiwalne polskie cenniki i katalogi właściwych nadwozi; tabela kamera/czujniki według roczników i wersji.
2. Kody silników i skrzyń oraz daty zmian w każdym modelu, z uwzględnieniem rynku.
3. Udokumentowane akcje serwisowe i problemy techniczne; oddzielenie pojedynczych zgłoszeń od danych o częstości awarii.
4. Procedury sprawdzenia napędów, w tym baterii hybrydowej i skrzyń automatycznych.
5. Lokalne koszty serwisu, montażu kamery i napraw z datą oraz zakresem ceny.

Nie należy uznawać karty za `verified`, dopóki kluczowe dla wyszukiwania obszary są otwarte. Pojedyncze zweryfikowane ustalenia mogą już pomagać w identyfikacji ofert, ale nie zastępują brakującej wiedzy o ich trwałości.
