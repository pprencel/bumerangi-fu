# Bumerangi Fu

Przeglądarkowa gra imprezowa w stylu Boomerang Fu: do 6 graczy (plus 8 widzów) rzuca bumerangami na małych arenach, z botami albo przez sieć. Three.js, czysty JavaScript, serwer w Node bez zależności.

Gra działa pod adresem https://bumerangi-fu.fly.dev.

## Uruchomienie lokalne

```bash
node server.mjs            # http://localhost:8080
node server.mjs --tunnel   # dodatkowo adres w internecie przez cloudflared
```

Wymagany Node 18 lub nowszy. Gra z botami działa w jednej karcie, gra w sieci wymaga serwera: gospodarz zakłada pokój, reszta dołącza przez adres, który pokazuje panel pokoju.

## Sterowanie

WASD lub strzałki: ruch, spacja lub Enter: rzut (przytrzymaj, żeby naładować) i cios, Shift: unik, T: taniec. Celować można też myszą. Pełna ściąga pod klawiszem H w grze.

## Wdrożenie na Fly.io

```bash
fly deploy --ha=false --remote-only
```

Jedna maszyna, bo pokój żyje w pamięci serwera. Szczegóły budowy gry i sieci: [ARCHITEKTURA.md](ARCHITEKTURA.md).
