# Toyota Corolla E210 — zestawienie ofert

Statyczna strona GitHub Pages. Dane ofert są w `offers.json`, decyzje i komentarze w `decisions.json`. `index.html` i `app.js` zawierają wyłącznie interfejs i logikę.

## Publikacja

1. Utwórz repozytorium GitHub, najlepiej osobne dla tego zestawienia.
2. Wgraj do katalogu głównego pliki `index.html`, `app.js`, `offers.json`, `decisions.json` (oraz ten README).
3. W **Settings → Pages → Build and deployment** ustaw **Deploy from a branch**, gałąź `main`, katalog `/ (root)`.
4. Otwórz adres GitHub Pages wyświetlany w ustawieniach. Strona pobiera oferty z `offers.json`.

## Zapisywanie statusów na GitHub

GitHub Pages **nie obsługuje zapisu plików samodzielnie**. Aplikacja zapisuje lokalnie w przeglądarce, a po autoryzacji aktualizuje `decisions.json` przez GitHub REST API (Contents API).

1. Utwórz **fine-grained personal access token** na GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
2. Ogranicz token do **jednego repozytorium**. Nadaj **Repository permissions → Contents: Read and write**. Ustaw datę wygaśnięcia.
3. Na stronie rozwiń **Synchronizacja decyzji z GitHub**, wpisz właściciela, nazwę repozytorium i gałąź (`main`), wklej token i wybierz **Połącz i pobierz decyzje**.
4. Zmieniaj statusy (`Bez decyzji`, `Do sprawdzenia`, `Interesująca`, `Odrzucona`) i dodawaj komentarze. Zmiany zapisują się lokalnie od razu; przy połączeniu z GitHub są automatycznie wysyłane z krótkim opóźnieniem. Możesz też kliknąć **Zapisz decyzje na GitHub**.
5. Na drugim urządzeniu otwórz stronę i połącz się ponownie, aby pobrać zapisane decyzje.

**Bezpieczeństwo i ograniczenia:**

- **Nie wpisuj tokenu do kodu, plików repozytorium ani `offers.json`/`decisions.json`.** Token jest przechowywany tylko w pamięci otwartej karty; po odświeżeniu trzeba go podać ponownie. Token ma uprawnienia zapisu do zawartości wskazanego repozytorium, więc nie udostępniaj go innym.
- Przy publicznym repozytorium **`decisions.json` jest publiczny** — komentarze będą widoczne dla każdego, kto ma dostęp do repozytorium. Nie wpisuj tam danych poufnych.
- Bez połączenia z GitHub decyzje są przechowywane tylko w `localStorage` bieżącej przeglądarki. Eksportuj je jako kopię zapasową. Czyszczenie danych przeglądarki może je usunąć.
- Konflikty między urządzeniami są łączone według `updatedAt` (nowsza decyzja wygrywa). Dwa urządzenia edytujące równocześnie mogą wymagać ponownej synchronizacji.
- Zapis do GitHub zależy od uprawnień tokenu i dostępności API; błędy są pokazywane w panelu. Po błędzie dane lokalne zostają zachowane.

## Aktualizacja ofert

Edytuj **tylko** `offers.json`, zachowując strukturę obiektów `offers` oraz pola identyfikacyjne: `id`, `vin`, `listingIds`, `urls`. Strona nie przechowuje decyzji wewnątrz ofert, dlatego wymiana `offers.json` nie kasuje odrzuceń.

Dopasowanie do wcześniejszych decyzji odbywa się po: VIN, ID ogłoszenia i znormalizowanych adresach URL. W razie braku tych danych ponownie wystawione ogłoszenie pod innym URL może nie zostać rozpoznane automatycznie. Warto zbierać VIN przy kolejnych aktualizacjach.

**Uwaga:** 36 ofert przeniesiono z ostatniego pliku HTML. Nie przeprowadzano nowej kontroli ich dostępności w tej operacji.

## Uruchomienie lokalne

Nie otwieraj `index.html` bezpośrednio jako `file://` — przeglądarka może zablokować odczyt JSON. W katalogu projektu uruchom np. `python -m http.server 8000`, następnie otwórz `http://localhost:8000`.
