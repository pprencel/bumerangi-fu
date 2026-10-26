# Bumerangi Fu – architektura

Przeglądarkowa gra w stylu Boomerang Fu. Three.js (kopia w `js/vendor/`), czysty JavaScript (moduły ES), bez bundlera, bez zależności npm i bez odwołań do internetu (czcionki w `fonts/`).

## Pliki

| Plik | Rola |
|---|---|
| `index.html` | Cały interfejs (ekrany, HUD, nakładki) i style. Three.js i czcionki ładuje z plików projektu. |
| `js/main.js` | Silnik gry: scena, areny, fizyka, walka, boty, przebieg rund, menu, lobby, logika sieci gospodarza i gościa. |
| `js/characters.js` | Postacie budowane z prostych brył, styl „Really3D” (`really3d()`), oczy, bumerangi. |
| `js/dance.js` | Tańce postaci (T), deterministyczne względem czasu. |
| `js/audio.js` | Dźwięki generowane w WebAudio (bez plików audio). |
| `js/net.js` | Klient WebSocket: łączenie, ponawianie, wysyłanie i odbiór wiadomości. |
| `server.mjs` | Serwer Node: pliki statyczne + przekaźnik WebSocket (bez zależności). |

## Tryby gry

- **Z botami:** wszystko działa lokalnie w jednej karcie, serwer nie jest potrzebny (wystarczy dowolny serwer plików).
- **W sieci:** wymaga `node server.mjs`. Na jednym urządzeniu gra jedna osoba, w pokoju nie ma botów. Do 6 graczy i 8 widzów.
- **Widz:** gość bez miejsca w grze („Oglądaj jako widz”). Dostaje te same migawki, co gracze, ale nie wysyła sterowania. W lobby może zająć wolne miejsce („Chcę grać”), a gracz może zostać widzem („Tylko oglądam”).

## Model sieciowy

```
 gość ──input──▶ ┌─────────┐ ──input──▶ gospodarz (przeglądarka)
 gość ◀─stan──── │ server  │ ◀─stan──── liczy całą symulację
                 │ .mjs    │
                 └─────────┘   tylko przekazuje wiadomości
```

- **Gospodarz jest autorytatywny.** Jego karta liczy fizykę, trafienia i punkty, a ok. 30 razy na sekundę rozsyła migawki stanu (`snap`) i zdarzenia (`kill`, `sfx`, `board`, `end`…).
- **Goście** wysyłają tylko sterowanie (`i`) i akcje w lobby (`join`, `char`, `ready`, `dance`, `role`). Wyświetlają stan od gospodarza z interpolacją.
- **Serwer** przekazuje wiadomości gości wyłącznie gospodarzowi (biała lista typów, pole `from` nadaje serwer), a wiadomości gospodarza do wszystkich albo do jednego (`to`). Informuje też niepołączonych o otwartym pokoju (`room`) i usuwa martwe połączenia (ping co 5 s).
- Jeden pokój na serwer. Karta gospodarza musi być na wierzchu, bo symulacja chodzi na `requestAnimationFrame`.

## Pętla gry (`main.js`)

Stany: `menu` → `countdown` → `play` → `roundOver` → `roundResult` → (`matchEnd`). Punkt jest za każde zabójstwo. Mecz wygrywa samodzielny lider, który osiągnął próg punktów.

## Dodawanie postaci

1. Funkcja `buildX()` w `characters.js` (bryły + `addEyes`) i wpis w tablicy `CHARACTERS` (`id`, `name`, `gender`, `height`, `juice`, `feet`, opcjonalnie `death`, `speed`, `locked`).
2. Taniec w `DANCES` i długość w `LENGTHS` (`dance.js`).
3. Opcjonalny efekt śmierci: `killVisuals` / `deathExtras` w `main.js`.

## Uruchomienie

```bash
node server.mjs   # http://localhost:8080, adres w sieci wypisuje serwer
```

## Hosting na Fly.io

`Dockerfile` i `fly.toml` opisują wdrożenie: jedna maszyna (`shared-cpu-1x`, 256 MB) w regionie Frankfurt (Warszawa jest w Fly wycofana), gaszona, gdy nikt nie jest połączony, i budzona przy pierwszym wejściu. Musi działać dokładnie jedna maszyna, bo pokój żyje w pamięci serwera.

```bash
fly auth login
fly apps create bumerangi-fu    # tylko za pierwszym razem, nazwa z fly.toml
fly deploy --ha=false           # każde kolejne wdrożenie
```

Na Fly serwer dostaje zmienną `FLY_APP_NAME`: wtedy podaje graczom adres `https://<aplikacja>.fly.dev`, nie wysyła adresów LAN i nie uruchamia tunelu. To samo daje `HOSTED=1` z `PUBLIC_URL=…` na innym hostingu.
