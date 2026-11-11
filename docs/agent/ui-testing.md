# Lokalna kontrola interfejsu

Używaj tego poradnika przy zmianach HTML, CSS, JavaScript widoku, dostępności
klawiaturowej lub responsywności. **Nie otwieraj osobistego profilu przeglądarki
użytkownika i nie proś o dostęp, jeśli kontrolę można wykonać lokalnie.**

## Środowisko

- Użyj Playwright z `node_modules` i dostępnej lokalnej przeglądarki headless
  (na tym komputerze działa Microsoft Edge). Nie używaj profilu ani sesji Brave,
  Edge, Chrome lub innej przeglądarki użytkownika.
- Twórz jednorazowy profil w katalogu tymczasowym wewnątrz workspace; usuń go po
  kontroli. Nie przechowuj cookies, historii ani danych testowych w repozytorium.
- Serwuj pliki statycznie lub przechwytuj lokalne żądania przez Playwright.
  Blokuj żądania do obcych hostów: test nie potrzebuje kontaktu z portalami.
  Zablokowane zewnętrzne zdjęcia mogą pokazać placeholdery.
- Jeśli dostępna przeglądarka headless odmawia startu w sandboxie, spróbuj
  zatwierdzonego uruchomienia lokalnego, nadal headless i z izolowanym profilem.
  Jeśli reviewer je odrzuci, opisz ograniczenie; nie przełączaj się na prywatną
  przeglądarkę użytkownika.

## Szybka kontrola

Sprawdź co najmniej szerokości `1280×900`, `640×900` i `390×844`:

- brak globalnego poziomego przewijania strony;
- przewijanie tabeli może pozostać wewnątrz jej kontenera;
- szczegóły mieszczą się na szerokości ekranu i przewijają się pionowo;
- widoczny fokus po Tab, działanie pominięcia do treści, otwieranie szczegółów
  Enterem, zamknięcie Escape i powrót fokusu do przycisku otwierającego;
- brak błędów JavaScript; obejrzyj zrzuty listy i szczegółów w wąskim widoku.

Raportuj pomiary i ograniczenia osobno. Kontrola DOM lub sam test CSS nie zastępuje
obejrzenia rzeczywistego zrzutu, jeśli zadanie dotyczy wyglądu.
