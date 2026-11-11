# Audyt i plan przebudowy CarOffers

> **Dokument historyczny — stan na 8 listopada 2026 r.** To zapis audytu i planu
> z tamtego dnia, a nie opis bieżącej aplikacji. Liczby i obserwacje poniżej są
> historyczne; przed podjęciem decyzji należy porównać je z aktualnym kodem,
> konfiguracją i danymi. Późniejsza walidacja konfiguracji (11 listopada 2026 r.)
> wykazała 12 modeli, 24 źródła i 20 aktywnych adapterów.

Zakres zatwierdzony przez użytkownika: audyt i plan, bez implementacji przebudowy.
Przejrzano działającą stronę we wbudowanej
przeglądarce, karty i tabelę, szczegóły oferty, kod oraz konfigurację.
Walidacja: OK, 16 modeli i 26 zarejestrowanych źródeł. Liczba źródeł nie oznacza
liczby działających adapterów ani pełnego pokrycia portali.

## 1. Obecne możliwości

| Obszar | Stan |
|---|---|
| Modele | 16 modeli w przewijanym poziomo pasku; jeden model naraz; wybór w URL |
| Lista | Karty i tabela; tabela zmienia układ przy szerokości do 760 px |
| Filtry | Tekst, maksymalna cena i przebieg, minimalny rocznik, silnik, nadwozie, skrzynia, ocena |
| Sortowanie | Cena, rocznik, przebieg, ocena oraz lokalne oznaczenie nowości |
| Szczegóły | Opisy, VIN jeśli podany, linki do portali, uzasadnienie oceny |
| Motyw | Jasny/ciemny, zapamiętany lokalnie |
| Nowości | Identyfikatory porównywane z poprzednim otwarciem modelu w tej przeglądarce |
| Deduplikacja | Grupowanie po VIN, ID i URL; przełącznik ukrywania duplikatów |
| Wymagania | Tekst z generowanego indeksu modeli |
| Ocena | Raport sprawdzany względem konfiguracji i pól oferty; nieaktualny raport daje check |
| Nowy kontrakt | Strona potrafi wyświetlać historię, dowody, LPG i statusy poszczególnych ogłoszeń |
| Aktualizacja danych | Importer CLI ma podgląd i lokalne zastosowanie; brak panelu aktualizacji na stronie |

## 2. Ograniczenia danych

W 109 zapisanych ofertach brak pól `location`, `history`, `listingStates`,
`lastCheckedAt`, `cameraStatus`, `engineVariant`, `transmissionCode`, `saleType`,
`lpgInstalled` i `priceBasis`. Część informacji występuje w historycznych tekstach,
ale nie jest przez to potwierdzonym polem kontraktu. Raport oceny obejmuje
109 wyników `check`; 16 kart wiedzy ma status `partial`.

Wniosek: obecna baza nie pozwala uruchomić użytecznej mapy, rankingu aktualności
ani historii zmian samą przebudową interfejsu. Trzeba zbierać obserwacje zgodne
z kontraktem. Nie uzupełniać danych przez zgadywanie lub interpretację nazwy firmy.

## 3. Problemy wymagające poprawy

1. Nawigacja po 16 modelach wymaga przewijania poziomego paska. Brak wyszukiwarki
   modeli, liczników ofert przy modelach i wspólnego widoku wszystkich aut.
2. Blok wymagań i rozbudowane filtry odsuwają oferty daleko od początku strony.
   W wąskim panelu zajmują znaczną część przewijania. Potrzebne krótkie podsumowanie
   wymagań i rozwijane filtry zaawansowane.
3. Wszystkie oferty wyglądają podobnie pod względem oceny. Brak odróżnienia
   brakujących danych, konfliktu wariantu i decyzji dotyczącej budżetu.
4. Stare opisy wyposażenia i ocen sąsiadują z bieżącą oceną. Np. tekst mówi
   o potwierdzonej kamerze, a silnik oceny wymaga jej sprawdzenia. Trzeba oznaczyć
   pochodzenie i wiek tekstu oraz oddzielić deklarację sprzedawcy od dowodu.
5. Filtry skrzyni mają warianty etykiet typu `manualna`, `Manualna` i
   `Manualna, 6 biegów`. Filtry nadwozia rozdzielają `Kombi` i `Kombi / Wagon`.
   Należy filtrować po ujednoliconych kodach, pozostawiając oryginalne opisy.
6. Przełączenie modelu resetuje część filtrów. Brak zapamiętanych ustawień i
   adresu pozwalającego odtworzyć wyszukiwanie. W URL zapisany jest tylko model.
7. Sortowanie „Najnowsze w zestawieniu” porównuje wyłącznie flagę `isNew`,
   a nie daty znalezienia. Nazwa obiecuje więcej niż obecne zachowanie.
8. Maksymalna cena lub przebieg nie wykluczają ofert z nieznaną wartością.
   To może być poprawne, ale wymaga jawnego przełącznika i objaśnienia.
9. Interfejs scala duplikaty bez osobnego ostrzeżenia o sprzecznych VIN-ach
   w grupie. Importer ma kontrole konfliktów, lecz widok musi chronić również
   historyczne rekordy i pokazywać, które ogłoszenia zostały połączone.
10. Brak podsumowania aktualności i pokrycia. Pusta lista modelu nie informuje,
    czy nie znaleziono ofert, nie wykonano wyszukiwania, czy dostęp był zablokowany.
11. Data przeliczenia oceny pokazuje surowy zapis ISO/UTC. Potrzebna czytelna
    data w Europe/Warsaw, odrębna od daty odczytu i daty ogłoszenia.
12. Wyszukiwanie tekstowe nie obejmuje ustrukturyzowanego pola `location.city`.
    Przy nowych ofertach miasto może więc nie być wyszukiwalne mimo obecności danych.

## 4. Proponowana organizacja strony

- **Oferty:** wspólny widok wszystkich modeli oraz wybór jednego lub wielu;
  krótkie podsumowanie wyników, filtry, karty/lista, zapisane wyszukiwania.
- **Zapisane i porównanie:** ulubione, własne statusy i notatki; porównanie
  2–4 aut także z różnych modeli. Status własny nie zastępuje oceny zgodności.
- **Modele i wiedza:** dozwolone warianty, ograniczenia roczników i nadwozi,
  wiedza o kamerze i serwisie, źródła oraz jawne luki.
- **Aktualizacje:** daty odczytów, nowe auta i zmiany cen, pokrycie portali,
  zadania częściowe i problemy dostępu. Początkowo panel tylko do odczytu.

Na komputerze: lista modeli i filtry przy wynikach. W wąskim panelu/telefonie:
wybór modeli i filtry w rozwijanym panelu. Podsumowanie wyników i najważniejsze
akcje powinny być dostępne bez przewijania długiej specyfikacji.

## 5. Docelowa karta i szczegóły auta

Karta: krótka nazwa, cena z warunkami zakupu, rok produkcji, przebieg, wariant
silnika, skrzynia, lokalizacja, data ostatniego udanego odczytu, krótki powód
oceny i akcje zapisz/porównaj/ogłoszenie. Kamerę i LPG pokazywać także przy
braku danych, z jawnym statusem „nie ustalono”. Nie pokazywać nieustalonej
instalacji jako braku LPG.

Szczegóły: wymagania spełnione/niespełnione/do wyjaśnienia; deklaracje
sprzedawcy; niezależne dowody; historia cen i obserwacji; wszystkie linki
do tego auta; pytania do sprzedawcy. Wyposażenie dostępne w katalogu nie
potwierdza instalacji w egzemplarzu.

Odległość: użytkownik wybiera miasto lub punkt startowy; wynik w linii prostej
z opisem metody i dokładności. Współrzędne lokalizacji auta muszą mieć źródło.
Przy braku miejsca obowiązuje komunikat wymagany przez AGENTS.md. Czas dojazdu
wymaga osobnego źródła tras i nie wynika z samej odległości.

## 6. Kolejność wdrożenia i kryteria odbioru

| Etap | Zakres | Warunek odbioru |
|---|---|---|
| 1. Wiarygodność | Aktualność i pochodzenie danych, rozdzielenie ocen/opisów, normalizacja filtrów, konflikty duplikatów, daty, sortowanie | Stare deklaracje nie wyglądają jak nowe potwierdzenia; sortowanie odpowiada etykietom; konflikty nie są ukrywane |
| 2. Przeglądanie | Wszystkie modele, wybór wielu, nowa nawigacja, zwijane wymagania/filtry, URL filtrów i zapamiętanie widoku | Da się znaleźć i ponownie otworzyć ten sam zestaw wyników, także w wąskim panelu |
| 3. Decyzje | Zapisane auta, porównanie, status kontaktu/oględzin/odrzucenia, notatki | Dane własne pozostają po odświeżeniu i po imporcie aktualizacji; nie zmieniają match/check/fail |
| 4. Dane i odległości | Rzeczywiste obserwacje z pilotażu, lokalizacje, historia, pokrycie, odległość | Brak źródła nie daje wymyślonego statusu, współrzędnych ani odległości |
| 5. Wiedza i obsługa | Widok wiedzy modeli, czytelny raport aktualizacji, testy pełnych scenariuszy | Źródła i luki są dostępne, obsługa klawiatury i układ wąski/szeroki przechodzą kontrolę |

Migracja danych i pilotaż zbierania obserwacji mogą postępować równolegle
z przebudową interfejsu, ale nie wymagają automatycznej publikacji.

## 7. Technologia i przechowywanie

Pozostawić statyczny hosting oraz Python do importu i oceny. Podzielić frontend
na warstwy odczytu danych, filtrów/stanu, widoków oraz przechowywania ustawień.
Nie ma obecnie konieczności wprowadzania frameworka ani backendu.

Własne statusy, notatki i ulubione zapisywać osobno od danych ofert, po stabilnym
ID z uwzględnieniem aliasów po scaleniu. Na początek localStorage z wersją danych
oraz eksportem/importem kopii. Brak synchronizacji między urządzeniami musi być
jawny. Jeśli synchronizacja stanie się wymaganiem, dopiero wtedy zaprojektować
backend, logowanie i reguły konfliktów.

Strona statyczna sama nie uruchomi lokalnego skryptu Python ani agentów.
Przycisk „Odśwież dane strony” może ponownie pobrać JSON, ale nie może sugerować,
że sprawdził portale. Uruchamianie wyszukiwania z panelu wymaga osobnej usługi
wykonawczej lub integracji; nie jest częścią pierwszego etapu przebudowy.

## 8. Sprawdzenie po implementacji

Testy filtrów i ich odtwarzania, dat i sortowania, konfliktów duplikatów,
zachowania notatek po scaleniu, nieaktualnej oceny i brakujących danych.
Rzeczywista przeglądarka: panel około 640 px, telefon około 390 px i szeroki
ekran; karty, tabela, szczegóły, klawiatura, focus i stany błędów. Sprawdzić
brak globalnego poziomego przewijania i czytelność obu motywów.

Nie wdrożono żadnej z powyższych zmian podczas audytu. Nie zmieniano ofert,
konfiguracji, kodu strony ani stanu publikacji. Powstał wyłącznie ten dokument.
