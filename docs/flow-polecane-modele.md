# Agentowy flow „Polecane modele”

Flow uruchamia główny agent po prośbie w czacie o analizę lub ranking modeli.
Nie wymaga od użytkownika ręcznego uruchamiania poleceń. Koordynator używa
standardowej kolejki CarOffers, dzieli pracę między subagentów i zapisuje
końcowy raport `reports/recommendations.json`. Oferty źródłowe pozostają bez
zmian; nic nie jest publikowane.

## Etap 1: analiza wszystkich modeli

Koordynator przygotowuje przebieg:

```powershell
python -B scripts/car-search.py recommend-plan --run polecane-2026-11-09 --agents 3
```

Powstaje osobne zadanie `recommendation_model` dla każdego aktywnego modelu,
który ma co najmniej jedną kwalifikującą się ofertę z adresem HTTPS. Zadania
zawierają kartę wiedzy, lokalne podsumowania ofert oraz instrukcje analizy
źródłowej. Główny agent przydziela je subagentom przez standardowe `claim` i
`finish`, dynamicznie, po jednym aktywnym zadaniu na wykonawcę. Agenci oceniają
model i oferty na podstawie źródeł, ale nie otwierają jeszcze wszystkich kart.

Każdy wynik fazy modelowej trafia do `runs/<run-id>/results/<task-id>.json`:

```json
{
  "taskId": "recommend-model--model-key",
  "outcome": "complete",
  "checkedAt": "2026-11-09T12:00:00+01:00",
  "modelKey": "model-key",
  "summary": "Zwięzły wniosek o dopasowaniu i ograniczeniach danych.",
  "research": {
    "safety": {"status": "partial", "note": "Zakres i ustalenie", "evidence": [{"title": "Źródło", "url": "https://example.org/safety", "checkedAt": "2026-11-09T12:00:00+01:00"}]},
    "reliability": {"status": "unknown", "note": "Brak niezależnych danych dla wariantu", "evidence": []},
    "luggage": {"status": "confirmed", "note": "Pojemność dla nadwozia", "evidence": [{"title": "Źródło", "url": "https://example.org/boot", "checkedAt": "2026-11-09T12:00:00+01:00"}]},
    "power_and_use": {"status": "confirmed", "note": "Wariant i użytkowanie", "evidence": [{"title": "Źródło", "url": "https://example.org/engine", "checkedAt": "2026-11-09T12:00:00+01:00"}]},
    "camera": {"status": "unknown", "note": "Opcjonalny atut, brak danych", "evidence": []}
  }
}
```

Koordynator kończy zadanie przez standardowe `finish --result complete`. Po
zebraniu wszystkich wyników wybiera pięć modeli według wag: bezpieczeństwo 30,
niezawodność 25, bagażnik 20, moc i miasto/trasa 20, kamera 5. `confirmed` daje
pełne punkty, `partial` połowę, `unknown` zero. Wagi nie zmieniają twardych
wymagań kupującego.

```powershell
python -B scripts/car-search.py recommend-select --run polecane-2026-11-09
```

Polecenie dopisuje pięć zadań `recommendation_listing` do tej samej kolejki.

## Etap 2: pięć aktualnych ogłoszeń

Subagenci dostają po jednym wybranym modelu i uporządkowaną listę jego
ogłoszeń. Otwierają karty po kolei; gdy oferta jest zakończona lub nie można jej
odczytać, próbują następną ofertę tego modelu. Dla pierwszej dostępnej karty
potwierdzają dokładny wariant, moc, rocznik produkcji, cenę brutto i jej warunki,
przebieg, skrzynię, nadwozie, wyposażenie, LPG, lokalizację oraz dostępne
informacje o sprzedawcy. Źródła specyfikacji i ustalenia rankingowe zapisują z
tytułem, adresem HTTPS i czasem sprawdzenia. Nie analizują zdjęć.

Wynik fazy ogłoszenia ma `taskId`, `outcome: complete`, `checkedAt`, `triedUrls`,
`availability`, `selectedOffer` (z `offerId`, `url`, `title`, `facts`) i te same
pięć obiektów `research`. Przy braku dostępnych kandydatów `selectedOffer` ma
wartość `null`, `availability: none_available`, a `triedUrls` obejmuje wszystkie
kandydackie URL-e. Po sprawdzeniu koordynator zatwierdza wynik standardowym
`finish --result complete`.

Gdy wszystkie pięć zadań zostanie zakończonych:

```powershell
python -B scripts/car-search.py recommend-finalize --run polecane-2026-11-09
```

Ranking zapisuje się w `reports/recommendations.json`; strona wczytuje go w
zakładce „Polecane modele”. Jeśli żaden kandydat dla któregoś modelu nie jest
dostępny, raport pokaże mniej niż pięć aut i zachowa tę informację jawnie.
Flow nie zmienia `offers/*.json`, nie importuje obserwacji do bazy i nie publikuje.
