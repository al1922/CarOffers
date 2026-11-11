# Encyklopedia CarOffers

Indeks dokumentacji projektu. Każdy temat ma jedno główne hasło; przed zmianą
danych sprawdź wskazane pliki konfiguracyjne, bo dokumentacja opisuje zasady,
a nie zastępuje bieżących danych.

## Zacznij tutaj

- **Jak działa projekt i gdzie zmienić kod:** [architektura](architektura-dla-agenta.md).
- **Założenia zakupowe i stan prac nad modelami:** [porządek projektu](porzadek-projektu.md).
- **Wyszukiwanie i aktualizacja ofert:** [obsługa wyszukiwania](obsluga-wyszukiwania.md).
- **Ocena wiarygodności konkretnej oferty:** [kontrakt danych](data-contract-v2.md) oraz [import i historia](import-ofert.md).
- **Wiedza techniczna o modelach:** [baza wiedzy](baza-wiedzy.md), [metoda oceny silników](metoda-oceny-silnikow.md) i karty `knowledge/models/*.json`.

## Hasła tematyczne

| Temat | Główne źródło | Dodatkowa dokumentacja |
|---|---|---|
| Wymagania i aktywne modele | `config/search-models.json` | `config/requirements.json` jest tylko szablonem; [założenia](porzadek-projektu.md) wyjaśniają decyzje zakupowe. |
| Portale i zakres wyszukiwania | `config/sources.json`, `config/portal-adapters.json` | [rejestr źródeł](rejestr-zrodel.md), [obsługa wyszukiwania](obsluga-wyszukiwania.md). |
| Fakty o modelach i silnikach | `knowledge/models/*.json` | [baza wiedzy](baza-wiedzy.md), [metoda oceny](metoda-oceny-silnikow.md). |
| Oferty, obserwacje i daty | `offers/*.json`, `schemas/offers-v2.schema.json` | [kontrakt danych](data-contract-v2.md), [import i historia](import-ofert.md). |
| Widok strony | `index.html`, `app.js`, `assets/` | [mapa modułów](architektura-dla-agenta.md). |
| Lokalizacje i odległość | `data/cities-pl.json`, `data/verified-locations.json`, `data/offer-locations.json` | [lokalizacje](lokalizacje.md). |
| Organizacja zadań wyszukiwania | `scripts/car-search.py`, `scripts/offer_import.py` | [plan organizacji](plan-organizacji-wyszukiwania.md), [obsługa wyszukiwania](obsluga-wyszukiwania.md). |
| Wpływ zmian na powiązane pliki | Źródło prawdy dla danego obszaru | [przegląd wpływu zmiany](agent/change-impact.md). |

## Jak rozumieć dokumenty

- Bieżące ustawienia i rekordy są w plikach konfiguracyjnych, ofertach i kartach
  wiedzy. Raport ani opis w Markdown nie zmienia automatycznie tych danych.
- `docs/agent/` zawiera procedury dla agenta; otwieraj tylko poradnik potrzebny
  do bieżącego zadania, zgodnie z indeksem w `AGENTS.md`.
- Pliki `reports/*` oraz dokumenty z datą w nazwie są zapisem konkretnego audytu,
  importu lub stanu prac. Traktuj je jako historyczne, dopóki ich ustalenia nie
  zostaną potwierdzone w źródle bieżących danych.
- Gdy dwa dokumenty opisują ten sam proces, stosuj plik wskazany wyżej jako
  **główne źródło**; pozostałe traktuj jako kontekst lub historię.

## Audyty i raporty

- [Audyt strony i plan przebudowy](audyt-i-plan-przebudowy-strony-2026-11-08.md)
- Raporty audytów, walidacji, wdrożeń i analiz modeli znajdują się w `reports/`.
  Ich daty i zakres są częścią znaczenia raportu; nie są instrukcjami bieżącego
  przebiegu.

