# Oferty samochodów — osobne JSON dla modeli

## Struktura

- `index.html`, `app.js` — strona GitHub Pages, bez logowania, synchronizacji i oznaczania ofert.
- `offers/toyota-corolla-e210.json` — 44 istniejące oferty Corolli z ostatniego pliku.
- `offers/<model>.json` — kolejny model i jego oferty.
- `models.json` — indeks zakładek, generowany automatycznie przez GitHub Actions.
- `.github/workflows/update-models.yml` — aktualizacja indeksu po dodaniu/zmianie plików w `offers/`.

## Pierwsze wdrożenie

1. Wgraj **całą zawartość** ZIP do głównego katalogu repozytorium na gałęzi `main`, zachowując katalogi (również ukryty `.github`).
2. Usuń stary główny `offers.json` (nie jest już używany).
3. W **Settings → Pages** wybierz `Deploy from a branch`, `main`, `/ (root)`.
4. W **Settings → Actions → General → Workflow permissions** ustaw `Read and write permissions`, jeżeli repozytorium pozwala na zmianę tej opcji. Workflow potrzebuje uprawnienia do zapisu `models.json`.
5. Sprawdź **Actions → Aktualizuj indeks modeli**. Jeżeli pierwszy push nie uruchomił akcji, użyj `Run workflow`.

Uwaga: ochrona gałęzi `main` może blokować automatyczny commit. Wtedy trzeba dopuścić zapis przez Actions albo generować `models.json` lokalnie i commitować razem z ofertami.

## Dodanie nowej zakładki

Dodaj plik `offers/toyota-auris.json` z zawartością:

```json
{
  "version": 1,
  "updatedAt": "2026-11-06",
  "model": {
    "key": "toyota-auris",
    "name": "Toyota Auris",
    "description": "Hatchback / Touring Sports",
    "requirements": null
  },
  "offers": []
}
```

Do `offers` dopisuj oferty w dotychczasowym formacie (`id`, `vin`, `listingIds`, `urls`, `title`, `verdict`, `html`).

Po `git push` workflow wykryje plik i dopisze model do `models.json`. Po zakończeniu akcji i publikacji GitHub Pages odśwież stronę. Nowa zakładka pojawi się automatycznie. Zmiana istniejącego pliku ofert nie wymaga edycji `models.json`.

**Ważne:** Samo wrzucenie pliku nie wystarczy, dopóki GitHub Actions nie wygeneruje indeksu i GitHub Pages nie opublikuje zmiany. Zwykle następuje to po krótkim czasie, niekoniecznie natychmiast.

## Aktualizacja ofert

Zastąp wyłącznie odpowiedni plik w `offers/`. Nie zmieniaj innych modeli. Możesz użyć `python scripts/generate-models.py` lokalnie, aby odtworzyć indeks bez GitHub Actions.

Specyfikacja na stronie jest obecnie skonfigurowana tylko dla Corolli (`requirements: "corolla"`). Inne modele mają `requirements: null`, czyli bez tego panelu. Kolorowe oceny `verdict` pozostają częścią opisu ogłoszeń.
