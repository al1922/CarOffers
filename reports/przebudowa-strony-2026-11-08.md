# Przebudowa strony CarOffers

8 listopada 2026. Lokalna implementacja audytu, z zachowaniem GitHub Pages.
Nie publikowano, nie wykonywano commitów ani push. Nie zmieniano wymagań,
katalogu silników ani danych ofert w ramach przebudowy interfejsu.

## Wdrożone

- Nowy wygląd: jasny i ciemny motyw, nawigacja, podsumowanie, krótkie kryteria,
  rozwijane filtry, czytelne karty i tabela z własnym przewijaniem.
- Wszystkie modele lub wybór wielu; liczniki i wyszukiwarka modeli.
- Filtry kamery, LPG, źródła, dostępności, daty odczytu i własnego statusu;
  ujednolicenie opisów skrzyń/nadwozi wyłącznie na potrzeby wyświetlania.
- Stan w URL, starsze linki do modeli, zapamiętanie widoku i zapisane wyszukiwania.
- Ulubione, porównanie maksymalnie 4 aut, notatki i osobiste statusy.
- Wersjonowany magazyn lokalny, eksport/import JSON, zachowanie notatek przy
  scalaniu tożsamości i kopii, jawne błędy zapisu i ochrona uszkodzonego magazynu.
- Rozdzielenie aktualnej oceny, danych egzemplarza, historii i dawnych opisów.
- Konflikty VIN, modelu, rocznika i ustrukturyzowanego wariantu/nadwozia nie są
  ukrywane przez deduplikację interfejsu. Query URL pozostaje częścią tożsamości.
- Daty Europe/Warsaw i sortowanie według rzeczywistych dat; nieznane na końcu.
- Odległość w linii prostej od własnego punktu, tylko dla udokumentowanych
  współrzędnych; brak danych pozostaje widoczny.
- Widok wiedzy o modelach: warianty, ograniczenia, twierdzenia, zakres i źródła.
- Widok aktualizacji i źródeł; nowy generator `scripts/generate-dashboard.py`.
- Podział na `app.js` i moduły `assets/*.mjs`, osobny CSS, lokalny SVG i `.nojekyll`.
  Brak zależności do instalacji, zewnętrznych fontów, backendu i etapu budowania.

## Sprawdzenie

- 69 testów Python: OK.
- 22 testy JavaScript: OK.
- Walidacja konfiguracji: 16 modeli, 26 źródeł, OK.
- Rzeczywista przeglądarka: karty, tabela, widok wiedzy, raport aktualizacji,
  ulubione, zapis notatki i statusu oraz zachowanie po odświeżeniu.
- Filtry dwóch modeli, cena i skrzynia: po odświeżeniu odtworzono 5 wyników
  z tym samym zakresem. Zapis i usunięcie testowego wyszukiwania działały.
- Porównanie dwóch aut działało; piąte auto było blokowane; 4 pozycje
  przetrwały odświeżenie. Testowe wybory i notatkę przywrócono do pustego stanu.
- Układ przy szerokościach 390, 640 i 1440 px; brak poziomego przepełnienia
  dokumentu. Wąska tabela przewija się we własnym kontenerze.
- Jasny i ciemny motyw sprawdzono w przeglądarce.
- Ścieżki statycznych zasobów i odczyt JSON są względne wobec położenia modułu;
  publiczne wdrożenie GitHub Pages nie było częścią tej sesji.

## Ograniczenia wynikające z danych i hostingu

109 dotychczasowych ofert nie ma ustrukturyzowanej lokalizacji, daty odczytu
ani historii. Interfejs nie dopisuje ich na podstawie nazw sprzedawców lub
historycznych tytułów. Odległości dla tych ofert pozostają nieznane.

Strona nie uruchamia Python ani subagentów. Ponowne wczytanie plików nie oznacza
sprawdzenia portali. Raport aktualizacji jest statyczny i wymaga ponownego
wygenerowania po zmianie zadań. Notatki nie synchronizują się między urządzeniami.

Przed publikacją przygotuj aktualne raporty i zaakceptuj wysłanie zmian zgodnie
z AGENTS.md. Instrukcja plików i poleceń jest w README.md.
