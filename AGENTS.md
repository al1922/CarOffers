# CarOffers — wskazówki dla agenta

## Zasady stałe

- Przed zmianami sprawdź `git status --short` i `git diff --stat`; zachowaj istniejące zmiany.
- Konfiguracja i `offers/*.json` są źródłem bieżących danych. Nie edytuj plików ofert bezpośrednio — zmiany zapisuj przez importer.
- Nie commituj, nie pushuj ani nie publikuj bez wyraźnej zgody użytkownika.
- Nie uruchamiaj testów ani przeszukiwania live, jeśli użytkownik o to nie poprosił.
- Błędy sieci, timeouty, blokady i CAPTCHA nie oznaczają nieaktywnej oferty. Nie obchodź zabezpieczeń portali ani `robots.txt`.
- Wyszukiwanie OTOMOTO wykonuj przez `npm run cars -- search --source otomoto`; jego przepływ respektuje `robots.txt` i zatrzymuje się przy blokadzie.
- Przeglądarka strony pokazuje pliki JSON; odświeżenie strony nie sprawdza portali.
- Przed planowaniem opartym o konfigurację uruchom `npm run cars -- validate`. Po edycji profilu lub mapowania uruchom najpierw `npm run cars -- sync`, potem `npm run cars -- validate`.

## Uruchamianie

- `npm run cars -- search --source <id> [--model <key>]` — bezpośredni odczyt. Źródło jest obowiązkowe; pominięty model oznacza wszystkie aktywne modele skonfigurowane dla źródła.
- Gdy użytkownik prosi o live search OTOMOTO z widocznym Chromium, uruchamiaj tę samą komendę przez hostowy `pwsh.exe` poza sandboxem (`exec_command` z `sandbox_permissions: "require_escalated"`). Sprawdzony wzorzec:
  ```powershell
  & 'C:\Program Files\WindowsApps\OpenAI.CodexPrimaryRuntime.v26-1111-570-0_26.1111.570.0_x64__3k8sg7r9htsxt\dependencies\native\powershell\pwsh.exe' -Command 'npm run cars -- search --source otomoto'
  ```
  Nie dodawaj `--headless`; CLI domyślnie uruchamia widoczne Chromium. Zwykłe sandboxowe wywołanie w tym środowisku kończyło się `ERR_NAME_NOT_RESOLVED` i nie pokazywało okna, podczas gdy powyższa ścieżka otworzyła Chromium i połączyła się z portalem. Jeśli ścieżka `pwsh.exe` zmieni się po aktualizacji Codex, użyj aktualnego hostowego `pwsh.exe` z runtime Codex.
- `npm run cars -- models [--source <id>]` — lista profili albo modeli dostępnych w portalu.
- `npm run cars -- validate` — sprawdzenie profili, źródeł, mapowań i ofert v3.
- `npm run cars -- sync` — wygenerowanie `models.json` ze źródłowych profili.
- `npm test` — lokalne testy jednostkowe; nie wykonują połączeń z portalami.

## Granice modułów

- `config/models/` — osobne kryteria każdego modelu.
- `config/sources/` — niezależne ustawienia portali.
- `config/source-mappings/<source>/` — portalowe URL-e, nazwy i wyjątki dla modelu.
- `src/search/direct/adapters/` — adapter jednego portalu.
- `src/search/shared/` — współdzielony odczyt i kwalifikacja kart.
- `src/offers/` — wspólny rekord, migracja oraz import ofert.
- `knowledge/models/` — wiedza konkretnego modelu używana przy rozpoznawaniu wariantów silnika.
- `assets/`, `app.js` — tylko statyczny interfejs kart.

Cykl ponownego sprawdzania aktywności ofert nie jest obecnie podłączony. Nie usuwaj ofert poza odczytem konkretnego ogłoszenia, który jednoznacznie potwierdza archiwizację lub brak danych auta.
