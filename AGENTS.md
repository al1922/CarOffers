# CarOffers — wskazówki dla agenta

Ten plik jest krótkim punktem wejścia. **Nie wczytuj wszystkich poradników naraz**;
otwórz tylko ten, który dotyczy bieżącego zadania.

## Zasady stałe

- Przed zmianą kodu sprawdź `git status --short` i `git diff --stat`. Zachowaj
  istniejące zmiany użytkownika.
- Konfiguracja jest nadrzędna wobec opisów historycznych. Nie dopowiadaj brakujących
  danych i nie edytuj bezpośrednio `offers/*.json`; używaj przepływu importu.
- Nie commituj, nie pushuj ani nie publikuj bez wyraźnej zgody użytkownika.
- Przy kontroli UI preferuj lokalny, izolowany Playwright headless. Nie proś o dostęp
  do osobistej przeglądarki, jeśli zadanie da się sprawdzić lokalnie.
- Strona jest statyczna: ponowne wczytanie plików JSON nie sprawdza portali.
- Nie przeglądaj historycznych czatów rutynowo: to zwiększa niepotrzebny kontekst.
  Sięgaj do nich tylko, gdy bieżące zadanie odwołuje się do wcześniejszych ustaleń
  albo brakuje ważnej preferencji; zacznij od podsumowania i czytaj tylko potrzebne
  fragmenty. Trwałe zasady zapisuj tutaj lub w odpowiednim poradniku.

## Menu `/flow`

Jeśli użytkownik wyśle samo `/flow` albo poprosi o dostępne flow, pokaż menu i
poczekaj na wybór. Nie uruchamiaj przebiegu przed wyborem:

1. **Szukaj nowych ofert** — wszystkie aktywne modele i portale.
2. **Sprawdź dostępność** — aktywne ogłoszenia.
3. **Sprawdź archiwum** — archiwalne ogłoszenia.
4. **Odśwież dane ofert** — ponowny odczyt zapisanych kart i potwierdzonych danych.

Zwykłe prośby wykonuj bez wymagania komendy `/flow`.

## Poradniki — otwieraj tylko w razie potrzeby

- Wyszukiwanie, dostępność, odświeżanie, przydziały i import: [search-operations.md](docs/agent/search-operations.md).
- Dowody, wiarygodność i ocena ofert: [data-evidence.md](docs/agent/data-evidence.md).
- Lokalna kontrola klawiatury i układu UI: [ui-testing.md](docs/agent/ui-testing.md).
- Status zmian, commity i push: [git-workflow.md](docs/agent/git-workflow.md).
- Zmiany przekrojowe i zależne pliki: [change-impact.md](docs/agent/change-impact.md).
- Granice modułów i kolejność źródeł danych: [architektura-dla-agenta.md](docs/architektura-dla-agenta.md).

Przed planowaniem zależnym od konfiguracji sprawdź jej poprawność poleceniem
`python -B scripts/car-search.py validate`. Po edycji konfiguracji najpierw
uruchom `sync`, potem `validate`, zgodnie z [poradnikiem wyszukiwania](docs/agent/search-operations.md).
