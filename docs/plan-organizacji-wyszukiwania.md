# CarOffers — organizacja wyszukiwania

Data: 2026-11-08. Propozycja organizacji projektu na podstawie przekazanych założeń i obecnych plików. To plan wdrożenia, nie gotowy mechanizm wyszukiwania ani zweryfikowany katalog techniczny.

Aktualizacja po wdrożeniu podstaw: konfiguracja, rejestr źródeł, karty modeli,
walidacja i kolejka zostały utworzone. Stan i ograniczenia opisuje
`reports/wdrozenie-2026-11-08.md`, a obsługę `docs/obsluga-wyszukiwania.md`.
Użytkownik dodatkowo potwierdził 12–15 tys. km rocznie, około 30 minut jazdy
miejskiej, dopuszczenie LPG z oznaczeniem oraz wykluczenie aukcji. Odpowiednie
punkty otwarte w pierwotnym planie poniżej są już rozstrzygnięte.

## 1. Ustalenia i punkty otwarte

Potwierdzone przez użytkownika:

- Maksymalna cena zakupu: **55 000 zł brutto dla wszystkich modeli**.
- Limit dotyczy samego zakupu. Serwis początkowy i montaż kamery to osobne koszty.
- Historyczny limit Corolli 60 000 zł jest nieaktualny.

Pozostałe wymagania przenosimy z przekazanego opisu jako punkt wyjścia:

| Parametr | Zasada początkowa |
|---|---|
| Rok produkcji | Od 2017; model może mieć węższy zakres |
| Przebieg | Do 150 000 km preferowane; wyższy nie odrzuca automatycznie |
| Użytkowanie | 2 dorosłych i dziecko; około 50% miasto / 50% trasa |
| Bagażnik | Wózek i bagaże; wymaga oceny praktycznej |
| Skrzynia | Manualna lub automatyczna |
| Kamera | Obecna albo potwierdzona możliwość dołożenia do danej konfiguracji |
| Przednie czujniki | Preferowane |
| Lokalizacja / pochodzenie | Cała Polska; krajowe i importowane |
| Historia | Bez poważnych szkód konstrukcyjnych; kosmetyka dopuszczalna |
| Priorytety | Stan, serwis, trwałość napędu, wyposażenie, opłacalność |

Do uzupełnienia przed finalną konfiguracją: przebieg roczny i długość typowej jazdy miejskiej, dopuszczone paliwa/napędy i LPG, tolerancja przebiegu ponad 150 000 km, akceptacja aukcji, wymiar wózka, czy kamera musi być gotowa przy odbiorze. Nie przypisujemy odpowiedzi za użytkownika.

## 2. Oddzielne miejsca dla czterech rodzajów informacji

Proponowany układ nowych danych:

```text
config/
  requirements.json          wymagania kupującego
  sources.json               rejestr źródeł
  search-models.json         aktywne modele i wybrane warianty
knowledge/
  models/<model-key>.json    fakty techniczne z dowodami
runs/<run-id>/
  snapshot.json              konfiguracja i wersja wiedzy użyta w przebiegu
  tasks.json                 przydziały i stan realizacji
  results/<task-id>.json     osobne wyniki każdego zadania
  report.md                  pokrycie źródeł, wyniki i ograniczenia
```

To planowane pliki. Obecne `offers/*.json` pozostają warstwą publikowanych danych, a `models.json` indeksem strony. Generator obecnie tworzy indeks z plików ofert, więc ręczne zmiany samego indeksu nie ustanowią trwałej konfiguracji wyszukiwania. Docelowo opisy wymagań publikowane przy modelach należy generować z centralnej konfiguracji i synchronizować z indeksem.

## 3. Rejestr portali

Nie tworzymy rozłącznych kategorii „prywatne / poleasingowe / wszystkie”. Prywatny to rodzaj sprzedawcy, poleasingowy to historia auta, a ogólny portal może obejmować oba przypadki.

Każde źródło opisują osobne pola:

- **Typ serwisu:** portal ogólny, platforma remarketingowa/poleasingowa, dealer/komis, program producenta, aukcje, inne.
- **Rodzaje sprzedawców:** osoby prywatne, dealerzy, komisy, firmy leasingowe/flotowe; lista może mieć kilka pozycji.
- **Pochodzenie oferowanych aut:** mieszane, leasing, wynajem, flota — gdy źródło rzeczywiście pozwala to ustalić.
- **Zakres i warunki:** marki, modele, sprzedaż detaliczna lub aukcja, dostępność dla osoby prywatnej, cena brutto/netto, opłaty i warunek finansowania.
- **Obsługa wyszukiwania:** adres strony i wyszukiwarki, obsługiwane filtry, metoda odczytu, ograniczenia dostępu.
- **Sterowanie:** stałe ID, włączone/wyłączone, priorytet, szacowany nakład pracy.
- **Weryfikacja:** ostatnia próba, ostatnia udana próba, wynik i opis problemu.

„Wszystkie źródła” to widok rejestru, nie dodatkowa kategoria. Status włączenia nie oznacza, że źródło zostało sprawdzone.

Rejestr zbieramy w dwóch krokach: lista kandydatów, a następnie próba znalezienia i otwarcia aktualnej oferty. Otomoto, OLX i Autoplac to kandydaci wymienieni w założeniach; ten dokument nie potwierdza ich aktualnej dostępności ani możliwości filtrów. Dalsze nazwy i adresy wymagają sprawdzenia w sieci.

## 4. Wymagania kupującego i sposób oceny

Każda reguła ma identyfikator, wartość, jednostkę, poziom: twarda / preferowana / wyjątek oraz informację, jak traktować brak danych.

- Cena to pełna kwota brutto zakupu dostępnego bez obowiązkowego finansowania; miesięczna rata i cena netto nie zastępują ceny zakupu. Nieznana cena lub nieznane opłaty oznaczają potrzebę weryfikacji.
- Oferta za ponad 55 000 zł odpada z aktualnego wyszukiwania. Nie zakładamy przyszłej negocjacji.
- Model może zawężać wymagania globalne, np. podnosić minimalny rocznik. Rozluźnienie wymaga jawnego wyjątku od użytkownika; obecnie brak wyjątku cenowego.
- Brak informacji o kamerze, silniku albo historii nie jest dowodem spełnienia ani niespełnienia wymagania.
- „Możliwy montaż kamery” wymaga zgodności z konkretną jednostką multimedialną lub określonego rozwiązania niezależnego; zapisujemy podstawę i koszt, jeśli ustalony.
- Deklaracje sprzedawcy oznaczamy jako deklaracje. Odczyt ogłoszenia nie potwierdza faktycznej bezwypadkowości ani stanu technicznego.

Ocena ma trzy wyniki: zgodna według dostępnych dowodów, wymaga wyjaśnienia, niezgodna. Najpierw sprawdzamy warunki twarde, potem kompletność danych, a dopiero potem preferencje. Punktacja nie może kompensować przekroczonego budżetu. Nieustalone wagi rankingu pozostają otwarte.

Zmiana ceny w konfiguracji wpływa na kolejne wyszukiwania i ponowną ocenę zapisanych ofert. Sama edycja pliku nie zmieni automatycznie strony — trzeba wdrożyć przeliczenie i publikację.

## 5. Katalog modeli

Punktem wyjścia jest 10 istniejących modeli. Zachowujemy ich obecne klucze i powiązania z plikami ofert:

1. Hyundai i30 III Wagon.
2. Kia Ceed III Sportswagon.
4. SEAT Leon III ST.
5. Škoda Octavia III Combi.
6. Suzuki SX4 S-Cross.
7. Suzuki Vitara II.
8. Toyota Auris II Touring Sports.
9. Toyota Corolla E210 — obecnie sedan i kombi; przydatność obu nadwozi do potrzeb rodziny wymaga decyzji.
10. Volkswagen Golf VII Variant.

Katalog zawiera ID, markę, generację, dozwolone nadwozia, status aktywny, priorytet, wybrane silniki i skrzynie, ograniczenia roczników, odnośnik do wiedzy i plik ofert. Osobno zapisujemy zakres produkcji generacji i zakres lat wybrany do wyszukiwania.

Istniejące opisy silników i lat to dotychczasowe filtry, nie dowód rekomendacji technicznej. Przy przenoszeniu zachowujemy je jako dane zastane z oznaczeniem „do weryfikacji”. Dodanie modelu nie oznacza automatycznie, że wszystkie jego silniki są dopuszczone.

## 6. Karta wiedzy modelu

Jedna karta na generację, z rozróżnieniem nadwozi, rynku, dat produkcji, silników, skrzyń i wyposażenia:

| Obszar | Zawartość |
|---|---|
| Identyfikacja | Generacja, lifting, produkcja i rok modelowy, rynek |
| Napędy | Kod silnika, pojemność, moc, paliwo, okres stosowania, dostępne skrzynie |
| Ocena | Zalecany / warunkowy / wykluczony / nierozpoznany; powód i dowody |
| Roczniki | Udokumentowane zmiany, zakres ich zastosowania, ograniczenia identyfikacji |
| Kamera i czujniki | Standard/opcja/niedostępne/nieustalone według rynku i wersji; warunki montażu |
| Rodzina | Bagażnik z metodą pomiaru i wariantem napędu, ISOFIX, praktyczne ograniczenia |
| Serwis | Typowe usterki, objawy, co sprawdzić, zalecenia producenta, orientacyjne koszty z datą |
| Weryfikacja auta | Pytania do sprzedawcy, dokumenty, zdjęcia, oględziny |

Każde istotne twierdzenie ma własne źródło, tytuł dokumentu, datę publikacji (jeśli znana), datę sprawdzenia, zakres obowiązywania, poziom pewności i ewentualny konflikt źródeł. Jeden link na końcu karty nie wystarcza.

Wyposażenie sprawdzamy przede wszystkim w katalogach/cennikach producenta dla danego rynku i roku. Problemy techniczne i zalecenia opieramy na źródłach adekwatnych do twierdzenia; doświadczenia użytkowników zapisujemy jako sygnały, nie statystykę awaryjności. „Dobry rocznik” wymaga konkretnego uzasadnienia technicznego. Kamera dostępna w roczniku nie dowodzi obecności w egzemplarzu, a polska wersja wyposażenia nie opisuje automatycznie auta importowanego.

Karty mają datę przeglądu. Ponownie sprawdzamy wiedzę przy zmianie zakresu wyszukiwania, nowym wariancie lub sprzecznych informacjach; nie powtarzamy całego badania przy każdym uruchomieniu.

## 7. Podział między agentów

Koordynator tworzy kolejkę zadań: **źródło × model × zestaw filtrów**. Drobne zadania można grupować dla jednego agenta. Priorytet i nakład pracy mają większe znaczenie niż jednakowa liczba portali.

Przykład organizacyjny: przy 12 źródłach i 3 agentach każdy pobiera następne wolne zadanie po skończeniu poprzedniego. Wolne źródło nie zatrzymuje całej grupy. Liczba agentów jest ograniczona możliwościami danej sesji i dostępnymi limitami; konfiguracja nie gwarantuje dowolnej równoległości.

Koordynator zapisuje identyfikator zadania, przydział, stan, próby i wynik. Jedno zadanie ma jednego aktywnego wykonawcę. Przy ponowieniu zachowujemy identyfikatory ofert, żeby nie dublować wyników. Dwa portale mogą zawierać to samo auto — to deduplikacja wyników, a nie błąd przydziału.

Agent zapisuje wyłącznie osobny wynik roboczy. Koordynator scala wyniki, sprawdza tożsamość pojazdów i zgodność z konfiguracją. Wspólny VIN jest mocniejszą przesłanką niż podobna cena, zdjęcia lub opis; konflikty wymagają wyjaśnienia, nie ślepego scalenia.

Każdy przebieg zapisuje kopię ustawień i wersji wiedzy. Raport odróżnia: znalezione oferty, brak ofert, brak dostępu i przeszukanie częściowe. Błąd dostępu nie oznacza sprzedaży auta. Przy ograniczonym czasie zapisujemy sprawdzone strony i filtry oraz pozostały zakres; nie nazywamy wyniku kompletnym.

## 8. Kolejność wdrożenia i kryteria gotowości

1. **Wymagania i katalog modeli:** uzupełnić otwarte decyzje, zapisać centralne reguły, rozstrzygnąć dane zastane. Gotowe, gdy nie ma sprzecznych aktywnych limitów i każdy model ma jawny zakres.
2. **Rejestr źródeł:** zebrać kandydatów, sklasyfikować i sprawdzić dostęp. Gotowe, gdy każde aktywne źródło ma metodę wyszukiwania, wynik próby oraz warunki zakupu.
3. **Pierwsza pełna karta wiedzy:** proponowany i30 III Wagon jako pilotaż, potem pozostałe modele. Gotowe, gdy kluczowe filtry mają źródła, a luki są jawne. To wybór pilotażowy, nie rekomendacja zakupu.
4. **Konfiguracja i walidacja:** dodać schematy nowych plików, kontrolę odwołań, regułę pierwszeństwa ustawień oraz generowanie opisów dla strony. Istniejący walidator ofert nie sprawdza jeszcze tych nowych danych.
5. **Próba wyszukiwania:** jeden model i 2–3 źródła; sprawdzić kolejkę, kompletność, braki danych, duplikaty i ponowne przetworzenie tych samych wyników.
6. **Rozszerzenie:** uzupełnić karty pozostałych modeli, dodać historię weryfikacji i cen, uruchamiać wszystkie aktywne zakresy. Publikować dopiero po walidacji i akceptacji zgodnie z założeniami projektu.

Najbliższy rezultat prac to trzy małe rejestry i jedna kompletna, sprawdzona karta modelu. Nie trzeba od razu budować backendu ani badać od nowa wszystkich modeli podczas każdego wyszukiwania.
