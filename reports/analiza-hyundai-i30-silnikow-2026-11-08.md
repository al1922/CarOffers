# Hyundai i30 III Wagon — pilotażowa analiza silników

Data sprawdzenia: 8 listopada 2026. Zakres: trzy warianty z listy użytkownika.
Zakres lat wyszukiwania modelu: 2018–2023. Paliwo LPG dozwolone i oznaczane.

## Wniosek

Żaden wariant nie spełnia jeszcze pełnego progu kategorii **polecany** z
`docs/metoda-oceny-silnikow.md`: brakuje niezależnych danych o naprawach
wewnętrznych silnika, powtarzalności kosztownych usterek oraz porównywalnych
kosztów napraw w Polsce. Znalazłem natomiast przydatny, liczny zbiór czeskich
badań technicznych przypisanych do kodów silników. To dobry sygnał przesiewowy,
ale bada cały pojazd, a nie sam silnik. Nie wolno z niego wyliczać ryzyka awarii
silnika.

Wstępna kolejność dopasowania do profilu:

1. **1.5 DPi 110 KM (G4LG) — warunkowo polecany jako spokojny, prostszy wariant.**
   Silnik wolnossący z wtryskiem pośrednim, skrzynia 6MT. Najlepszy sygnał w
   znalezionych danych STK oraz polskie źródło opisujące instalację LPG dla
   konkretnego i30 2022/G4LG. Ograniczenie: najmłodszy wariant i niższy średni
   przebieg badanych aut, więc jego długoterminowa trwałość jest słabiej
   sprawdzona.
2. **1.4 T-GDI 140 KM (G4LD) — warunkowo polecany, szczególnie z 6MT.**
   Ma wyraźnie większy zapas mocy do rodzinnego kombi i korzystny sygnał w
   porównaniu badań STK. Turbo i bezpośredni wtrysk oznaczają większą złożoność;
   nie znalazłem wiarygodnej polskiej bazy kosztów typowych napraw tego kodu.
   Wersję 7DCT trzeba oceniać osobno, w tym sprzęgła i zachowanie w manewrach.
3. **1.4 MPI 100 KM (G4LC) — wstrzymany jako domyślna rekomendacja; nie
   odrzucony.** Konstrukcyjnie prostszy i wolnossący, ale dane kodu G4LC w
   badaniach STK są znacznie mniejsze (707 kontroli), a 100 KM/134 Nm i 12,7 s
   do 100 km/h dają najmniejszy zapas przy obciążonym kombi. Może pozostać
   rozsądną opcją dla spokojnej jazdy po próbie z pasażerami i bagażem. Nie mam
   dostatecznej dokumentacji, by uznać LPG w tym dokładnym wariancie za
   potwierdzone — wymaga sprawdzenia zestawu i homologacji u montażysty.

To są statusy pilotażowe, nie gwarancja trwałości. Zostawiam wszystkie trzy
w aktywnej liście użytkownika; nie ma dowodu, który uzasadniałby trwałe
odrzucenie któregoś wariantu. Zmieniłem status i30 na przegląd pilotażowy,
ale katalog pozostałych modeli nadal oczekuje na ocenę.

## Tożsamość i parametry

| Wariant | Kod używany w danych | Potwierdzone cechy | Dostępna skrzynia w przejrzanych specyfikacjach |
|---|---|---|---|
| 1.4 MPI, 100 KM | G4LC; potwierdzać po VIN | 1 368 cm³, wtrysk wielopunktowy, wolnossący, 134 Nm; rozrząd łańcuchowy | 6MT |
| 1.4 T-GDI, 140 KM | G4LD; potwierdzać po VIN | 1 353 cm³, turbo i wtrysk bezpośredni, 242 Nm; rozrząd łańcuchowy | 6MT lub 7DCT |
| 1.5 DPi, 110 KM | G4LG; potwierdzać po VIN | 1 498 cm³, wolnossący, wtrysk DPi, 144 Nm | 6MT |

Dokument Hyundaia dla i30 2017 potwierdza parametry i konstrukcję 1.4 MPI/T-GDI,
a komunikat dotyczący Wagon potwierdza dostępność tych dwóch silników w tym
nadwoziu. Dokument techniczny z 2020 r. potwierdza dla gamy i30 1.5 DPi 110 KM,
144 Nm i 6MT; polski cennik Wagon PY2021 także wymienia 1.5 DPi. Dokładny kod
silnika konkretnego auta nadal należy potwierdzić po VIN/dokumentach.

## Dane o badaniach technicznych — właściwe ograniczenia

Zestawienie Karambol.cz przypisuje wyniki STK do i30 III i kodu silnika. W
kontrolach z 2026 r. podaje:

| Kod / wariant | Kontrole STK | „Częściowo zdolne” | Różnica od aut tego samego wieku | Średni przebieg |
|---|---:|---:|---:|---:|
| G4LG / 1.5 DPi 110 | 3 443 | 1,8% | −0,9 p.p. | 58 925 km |
| G4LD / 1.4 T-GDI 140 | 2 930 | 3,8% | +0,1 p.p. | 97 311 km |
| G4LC / 1.4 MPI 100 | 707 | 4,2% | +0,8 p.p. | 78 239 km |

„Niezdolne” wyniosło odpowiednio 0,06%, 0,07% i 0,14%. Różne przebiegi,
roczniki i liczebność próby ograniczają porównanie. Wynik kontroli technicznej
obejmuje hamulce, zawieszenie, światła i inne podzespoły pojazdu; nie dowodzi,
że określony odsetek silników uległ awarii.

Drugi serwis, Poruchovost.cz, również przetwarza czeskie oficjalne dane STK i
podaje dla i30 1.4 103 kW 15 176 kontroli, o 14% mniej poważnych usterek niż
średnia aut tego samego wieku i paliwa; dla 1.5 81 kW 6 647 kontroli, o 21%
mniej. Ponieważ podstawą są te same czeskie badania techniczne, nie liczę tego
jako niezależnego potwierdzenia Karambol.cz. Klasyfikacja 1.4/73 kW na poziomie
całego modelu obejmuje też starsze generacje, dlatego nie przypisuję jej
bezpośrednio do G4LC w i30 III.

ADAC podaje dla całego i30, bez rozbicia na silniki, głównie awarie akumulatora
rozruchowego. To przydatna wskazówka do kontroli auta, ale nie rozstrzyga
porównania trzech silników.

## Akcje przywoławcze i LPG

- UOKiK opisał i30 wyprodukowane w Czechach od 25.10.2018 do 15.07.2020 z
  możliwym problemem filtra kanału olejowego pompy podciśnienia i zwiększonym
  oporem pedału hamulca. Komunikat nie identyfikuje wprost w tym wpisie kodu
  silnika. Dla każdego auta z tego okresu sprawdzić status kampanii po VIN;
  nie przypisywać usterki wszystkim trzem wariantom.
- Gazeo.pl opisuje konwersję i30 2022 z G4LG 1.5 DPi na LPG oraz konkretne
  rozwiązanie LandiRenzo. To potwierdza istnienie dopasowanego rozwiązania,
  nie automatyczną zgodność każdej instalacji ani poprawność montażu.
- Dla 1.4 MPI i 1.4 T-GDI nie ustaliłem w tym przeglądzie wystarczającego
  źródła homologacji instalacji LPG dla konkretnej polskiej wersji. Nie
  obiecywać konwersji bez pisemnego potwierdzenia warsztatu dla kodu i VIN.

## Wymagane kontrole konkretnego egzemplarza

- Potwierdzić VIN, kod silnika, moc, rok produkcji, rynek i nadwozie.
- Sprawdzić faktury i interwały oleju; specyfikacja z 2017 r. podaje dla benzyny
  15 000 km lub 12 miesięcy, lecz pierwszeństwo ma instrukcja właściwa dla VIN.
- Sprawdzić otwarte kampanie Hyundai po VIN, zwłaszcza auta wyprodukowane
  2018–2020.
- Posłuchać zimnego rozruchu i sprawdzić historię ubytków oleju/płynu; to
  kontrole ogólne, nie twierdzenie, że dany egzemplarz ma znaną wadę.
- Dla 1.4 T-GDI sprawdzić doładowanie i błędy sterownika; dla 7DCT wykonać
  diagnostykę oraz próbę ruszania, cofania i jazdy w korku.
- Dla LPG porównać kod silnika z dokumentacją homologacji, fakturą montażu,
  wpisem w dokumentach i terminem zbiornika.
- Wykonać jazdę próbną z typowym obciążeniem i ocenić, czy 1.4 MPI zapewnia
  wystarczający zapas przy włączaniu się do ruchu i wyprzedzaniu.

## Luki przed statusem „polecany”

Nie znalazłem porównywalnej polskiej bazy napraw/gwarancji dla G4LC, G4LD i G4LG,
wiarygodnej częstości usterek wewnętrznych silnika ani aktualnych kosztów
napraw dla tych kodów. Z tego powodu rekomendacje są warunkowe. Następny przegląd
powinien dołączyć dane z dokumentacji serwisowej producenta, TDT/UOKiK po
zakresie VIN, wiarygodne dane warsztatowe i co najmniej dwie polskie wyceny
istotnych napraw, jeśli wystąpią w źródłach.

## Źródła

- Hyundai, dane techniczne i30 2017: https://www.hyundai.news/newsroom/dam/de/Pressemappen/i30/i30-2017-3-technische-daten.pdf
- Hyundai, i30 Wagon — gama silników: https://www.hyundai.news/uk/articles/press-releases/new-generation-hyundai-i30-wagon-elegance-meets-versatility.html
- Hyundai, dane techniczne i30 2020: https://www.hyundai.news/newsroom/dam/eu/press-kits/20200226_i30/20200226_i30_Technical_Data_preliminary_Update.pdf
- Karambol.cz, czeskie badania STK według kodu silnika: https://www.karambol.cz/auta/hyundai/i30/
- Poruchovost.cz, metodologia i wyniki z czeskich STK: https://poruchovost.cz/metodika/ oraz https://poruchovost.cz/hyundai/i30/
- UOKiK, akcja Hyundai i30/Tucson: https://uokik.gov.pl/bip/samochody-marki-hyundai-modele-tucson-oraz-i30
- ADAC, i30 Kombi 1.4 T-GDI — dane i awarie całego modelu: https://www.adac.de/rund-ums-fahrzeug/autokatalog/marken-modelle/hyundai/i30/3generation/287719/
- Gazeo.pl, i30 2022 1.5 DPi/G4LG i LPG: https://gazeo.pl/lpg/jaka-instalacje-gazowa-wybrac-lpg-problemy/hyundai-i30-2022,o,11641.html
