# Wdrożenie podstaw wyszukiwania — 2026-11-08

## Wykonane

- Centralne wymagania: 55 000 zł brutto na zakup każdego modelu, rok od 2017
  lub węższy zakres modelu, 150 000 km jako preferencja, kamera obecna lub
  potwierdzona możliwość montażu. Rocznie 12–15 tys. km; miasto około 30 minut.
  LPG dopuszczone i oznaczane; aukcje wykluczone.
- Katalog 10 modeli z identyfikatorami, aktywnością, nadwoziami, latami i silnikami.
  Zakresy odziedziczono z projektu, bez udawania zweryfikowanych rekomendacji.
- 19 źródeł; wszystkie dostępne do przydziału poza kategorią aukcyjną. Oficjalne strony, stopień dostępu i warunki zakupu
  opisano osobno. Źródła aukcyjne wyklucza również mechanizm kolejki.
- 10 kart wiedzy, łącznie 39 ustaleń ze źródłami; i30 ma 15 ustaleń.
  Każda karta nadal ma status `partial` z jawną listą braków.
- Schematy i walidacja odwołań, lokalna ocena zapisanych ofert, synchronizacja
  opisów wymagań ze stroną, kolejka i kopie konfiguracji/kart dla każdego przebiegu.
- Instrukcje koordynatora i agentów w `AGENTS.md` oraz instrukcja obsługi.

## Sprawdzenie

- 51 testów zakończonych powodzeniem. Obejmują zmianę budżetu, brak dowodów,
  preferowany i twardy przebieg, LPG, aukcje, montaż kamery, normalizację marek,
  rozbieżne warianty, jednoznaczny przydział i niezależność przebiegu od późniejszych ustawień.
- Walidacja konfiguracji: 10 modeli i 20 źródeł, bez błędów.
- Walidacja 109 ofert: 0 błędów, 77 ostrzeżeń: 69 braków danych,
  3 historyczne identyfikatory portali, 5 historycznych ID opartych na URL.
- Porównano tablice ofert z wersją HEAD: wszystkie 109 zapisanych rekordów
  samochodów pozostało identycznych. Zmieniono wyłącznie opisy wymagań przy
  modelach oraz indeks, w tym usunięto nieaktualny limit Corolli 60 000 zł.
- Osobny raport `current-assessment.json`: 30 ofert niezgodnych, 79 do sprawdzenia,
  0 uznanych za w pełni zgodne. Powodem braku pełnego potwierdzenia są m.in.
  brakujące pola dowodowe; nie jest to stwierdzenie, że żadne auto nie pasuje.
- Pilotaż i30 na Otomoto/OLX zapisany w `runs/pilot-i30-2026-11-08/`.
  Dwa zadania częściowe; nie dodano ofert. Odczyt listy nie zastępuje sprawdzenia kart.

## Pozostałe prace

- Uzupełnienie luk kart: udokumentowana niezawodność poszczególnych napędów,
  koszty, kompletne archiwalne wyposażenie i zgodność montażu kamer.
  Część dokumentów i30 odczytano z indeksu; ograniczenia podano przy źródłach.
- Pełne wyszukiwanie z pokryciem filtrów/stron i przeglądarką dla niedostępnych kart.
- Automatyczny importer/scalanie nowych ofert i historia cen nie są jeszcze wdrożone.
  Kolejka wspiera ręcznie uruchamianych agentów Codex; sama ich nie uruchamia.
- Lokalny raport oceny nie nadpisuje historycznych ocen wyświetlanych na stronie.
  Publikacja wymaga osobnej walidacji i akceptacji użytkownika. Nie wykonano publikacji.
