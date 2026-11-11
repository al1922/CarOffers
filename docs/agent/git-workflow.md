# Git: przygotowanie, commit i push

Ten poradnik dotyczy lokalnych zmian oraz publikacji ich w repozytorium. Samo
polecenie „zrób commit/push” w poradniku nie jest zgodą na wykonanie tych działań
w konkretnej rozmowie.

## Przed zmianą

1. Sprawdź `git status --short`, `git diff --stat` i bieżącą gałąź.
2. Zachowaj zmiany, które istniały wcześniej. Nie przywracaj plików użytkownika
   tylko po to, by uzyskać czysty status.
3. Pracuj wyłącznie nad plikami objętymi zadaniem; nie dodawaj danych `runs/`,
   sekretów, cache ani przypadkowych artefaktów.

## Przed commitem

1. Przejrzyj `git diff` i `git status --short`; upewnij się, że stage obejmuje
   tylko zamierzone pliki.
2. Uruchom testy i walidatory odpowiednie dla zadania, jeśli użytkownik poprosił
   o weryfikację lub zmiana tego wymaga.
3. Nie rób `commit --amend`, nie przepisuj historii i nie używaj force push bez
   osobnej, wyraźnej zgody.
4. Commituj dopiero po wyraźnej autoryzacji użytkownika. Wcześniejsza zgoda
   obowiązuje w kolejnych turach, jeśli zakres i repozytorium się nie zmieniły.
   Używaj krótkiego, opisowego komunikatu, np. `docs: uporządkuj instrukcje agenta`.

## Push i publikacja

- Pushuj dopiero po wyraźnej autoryzacji użytkownika. Wcześniejsza zgoda
  obowiązuje, dopóki repozytorium i cel pushu pozostają te same. Przed push sprawdź
  remote, gałąź, zakres commitów oraz czy push nie opublikuje cudzych zmian.
- Nie publikuj strony, nie twórz release i nie wysyłaj zmian do repozytorium
  na podstawie samej prośby o edycję plików.
- Po zatwierdzonym pushu podaj gałąź, commit i wynik polecenia. Jeśli zdalne
  repozytorium lub uprawnienia blokują działanie, opisz konkretny błąd.
