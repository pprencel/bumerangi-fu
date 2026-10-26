// Tańce do emotki /dance — celowo koślawe, w stylu Really3D.
// Wszystko deterministyczne z czasu t (te same ruchy u wszystkich graczy).

const TAU = Math.PI * 2;
const FOOT_X = 0.18;
const FOOT_Y = 0.06;
const FOOT_Z = 0.04;

// Deterministyczny hash liczby całkowitej -> [0, 1)
function hash(n) {
  let h = (Math.floor(n) | 0) * 374761393;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
// Czas „schodkowy” — aktualizacja pozy tylko fps razy na sekundę
const step = (t, fps) => Math.floor(t * fps) / fps;
// Fala trójkątna 0..1..0
const tri = x => 1 - Math.abs(((x % 2) + 2) % 2 - 1);

// Pozycja neutralna — ustawiana co klatkę przed tańcem, więc tańce dodają tylko odchyłki
export function resetDance(f) {
  f.wrap.position.set(0, 0, 0);
  f.wrap.rotation.set(0, f.facing || 0, 0);
  f.wrap.scale.set(1, 1, 1);
  f.body.position.set(0, 0, 0);
  f.body.rotation.set(0, 0, 0);
  f.body.scale.set(1, 1, 1);
  f.feet.forEach((ft, i) => {
    ft.position.set(i ? FOOT_X : -FOOT_X, FOOT_Y, FOOT_Z);
    ft.rotation.set(0, 0, 0);
  });
  f.held.position.set(0.5, 0.55, 0);
  f.held.rotation.set(0.3, 0, 1.2);
  f.held.scale.setScalar(0.7);
  // części poruszane osobno (np. pierogi w misce) wracają na swoje miejsca
  for (const p of f.body.userData.dancers || []) p.position.y = p.userData.baseY;
}

const yaw = (f, a) => { f.wrap.rotation.y = (f.facing || 0) + a; };

const DANCES = {
  // Jabłko: robot — 8 fps, obroty o 90° co takt, ramię z bumerangiem jak szlaban
  apple(f, t) {
    const s = step(t, 8);
    const beat = Math.floor(t * 2);
    yaw(f, (beat % 4) * Math.PI / 2);
    f.body.position.y = (beat % 2) * 0.12;
    f.body.rotation.z = Math.sign(Math.sin(s * TAU)) * 0.15;
    f.held.rotation.z = 1.2 + (Math.floor(s * 4) % 3 - 1) * 1.1;
    f.held.position.y = 0.55 + (Math.floor(s * 4) % 2) * 0.3;
    f.feet[beat % 2].position.y = FOOT_Y + 0.15;
  },

  // Marchewka: robak — kładzie się na brzuch i faluje, czasem wstaje jak deska
  carrot(f, t) {
    const c = t % 6;
    const lie = c < 0.4 ? c / 0.4 : c < 5 ? 1 : c < 5.15 ? 1 - (c - 5) / 0.15 : 0;
    const wave = Math.sin(t * 9);
    f.body.rotation.x = lie * (1.45 + wave * 0.25);
    f.body.position.y = lie * (0.25 + Math.max(0, wave) * 0.35);
    f.body.position.z = lie * (-0.6 + Math.sin(t * 1.2) * 0.3);
    f.held.position.y = 0.55 + lie * 0.6 * wave;
    f.feet.forEach((ft, i) => { ft.position.z = FOOT_Z - lie * (0.5 + 0.2 * Math.sin(t * 9 + i)); });
  },

  // Bakłażan: moonwalk — stopy sunięte do tyłu, ciało sztywne, co cykl teleport na start
  eggplant(f, t) {
    const c = (t % 3) / 3;
    f.wrap.position.z = 0.6 - c * 1.4;
    f.feet.forEach((ft, i) => {
      const ph = (t * 2 + i * 0.5) % 1;
      ft.position.z = FOOT_Z + 0.25 - ph * 0.5;
      ft.position.y = FOOT_Y + (ph > 0.85 ? 0.12 : 0);
      ft.rotation.x = ph > 0.85 ? -0.6 : 0;
    });
    f.body.rotation.x = -0.12;
    if (c > 0.93) f.body.scale.set(1.4, 0.6, 1.4); // glitch przy teleporcie
    f.held.rotation.z = 1.2 + Math.sin(t * 3) * 0.2;
  },

  // Banan: squash & stretch ponad wszelki rozsądek
  banana(f, t) {
    const k = Math.sin(t * 7);
    const sy = 1 + k * 0.7 + (hash(t * 3) > 0.85 ? 0.5 : 0);
    const sxz = 1 / Math.sqrt(Math.max(0.3, sy));
    f.body.scale.set(sxz, sy, sxz);
    f.body.rotation.z = Math.sin(t * 3.5) * 0.4;
    f.held.position.y = 0.55 * sy;
    f.held.position.x = 0.5 * sxz;
    f.held.rotation.x = 0.3 + t * 6;
    f.feet.forEach((ft, i) => { ft.position.x = (i ? 1 : -1) * FOOT_X * sxz * 1.5; });
  },

  // Brokuł: headbang metalowy z drgawkami i nagłymi stop-klatkami
  broccoli(f, t) {
    const frozen = hash(t * 1.5) > 0.8;
    const tt = frozen ? step(t, 1.5) : t;
    const bang = Math.pow(Math.abs(Math.sin(tt * 8)), 3);
    f.body.rotation.x = 0.1 + bang * 0.75;
    f.body.position.x = frozen ? 0 : (hash(t * 30) - 0.5) * 0.08;
    f.body.position.z = bang * 0.15;
    f.held.rotation.z = 1.2 - bang * 1.5;
    f.held.position.y = 0.55 + bang * 0.4;
    f.feet[1].position.y = FOOT_Y + (bang > 0.9 ? 0.1 : 0);
  },

  // Kiełbasa: helikopter — bumerang wiruje nad głową, unosi się i spada jak zgliczowana
  sausage(f, t) {
    const c = t % 5;
    const up = c < 3 ? c / 3 : c < 3.1 ? 1 : 0; // nagły spadek do zera
    f.wrap.position.y = up * 0.9 + (c > 3 && c < 3.4 ? -0.15 : 0);
    yaw(f, t * up * 4);
    f.held.position.set(0, 1.5, 0);
    f.held.rotation.set(Math.PI / 2, 0, t * 25);
    f.held.scale.setScalar(0.7 + up * 0.3);
    f.body.rotation.z = Math.sin(t * 2) * 0.1 * up;
    f.feet.forEach((ft, i) => { ft.position.y = FOOT_Y - up * 0.05 * (i ? 1 : -1); });
  },

  // Kurczak: taniec kurczaka — machanie skrzydłem, dziobanie, jedna stopa w podłodze
  chicken(f, t) {
    const s = step(t, 10);
    const ph = Math.floor(t * 1.5) % 4;
    f.body.position.x = (hash(s * 10) - 0.5) * 0.05;
    if (ph < 2) {
      f.held.rotation.z = 1.2 + Math.sign(Math.sin(t * 22)) * 0.8;
      f.body.rotation.z = Math.sign(Math.sin(t * 11)) * 0.12;
    } else {
      f.body.rotation.x = tri(t * 6) * 0.6;
      f.body.position.y = -tri(t * 6) * 0.1;
    }
    f.feet[0].position.y = -0.12; // stopa przenika przez podłogę
    f.feet[1].position.y = FOOT_Y + tri(t * 4) * 0.2;
    yaw(f, Math.sin(step(t, 4)) * 0.5);
  },

  // Cebula: egzorcyzm — opętane drgawki, stanie na głowie, teleporty i bumerang na orbicie
  onion(f, t) {
    const c = t % 6;
    const tick = Math.floor(t * 10);
    // drgawki przez cały taniec
    f.body.position.x = (hash(tick) - 0.5) * 0.12;
    f.body.position.z = (hash(tick + 7) - 0.5) * 0.12;
    // warstwy „oddychają” w przypadkowych osiach
    f.body.scale.set(1 + (hash(tick * 3) - 0.5) * 0.6, 1 + (hash(tick * 5) - 0.5) * 0.6, 1 + (hash(tick * 7) - 0.5) * 0.6);
    // bumerang krąży wokół jak opętany
    const orbit = t * 9;
    f.held.position.set(Math.cos(orbit) * 0.7, 0.7 + Math.sin(t * 13) * 0.3, Math.sin(orbit) * 0.7);
    f.held.rotation.set(t * 20, t * 7, t * 31);
    if (c < 2) {
      // głowa obraca się w kółko, coraz szybciej
      f.body.rotation.y = c * c * 6;
      f.body.rotation.z = Math.sin(t * 25) * 0.2;
    } else if (c < 3.5) {
      // stoi na głowie i podskakuje, stopy machają w powietrzu
      f.body.rotation.x = Math.PI;
      f.body.position.y = 1.1 + Math.abs(Math.sin(t * 12)) * 0.15;
      f.feet.forEach((ft, i) => {
        ft.position.y = 1.15 + Math.sin(t * 18 + i * 3) * 0.12;
        ft.rotation.x = Math.PI;
      });
    } else {
      // teleporty po okręgu co 0,25 s, za każdym razem obrócona w inną stronę
      const jump = Math.floor(t * 4);
      const a = hash(jump) * TAU;
      f.wrap.position.set(Math.cos(a) * 0.7, hash(jump + 3) > 0.7 ? 0.5 : 0, Math.sin(a) * 0.5);
      yaw(f, hash(jump + 11) * TAU);
      f.body.rotation.z = (hash(jump + 5) - 0.5) * 1.6;
    }
  },

  // Pączek: toczy się na boki jak koło, które zgubiło oś
  donut(f, t) {
    const x = Math.sin(t * 1.6);
    f.wrap.position.x = x * 0.7;
    f.body.rotation.z = -x * 2.4;
    f.body.position.y = Math.abs(Math.sin(t * 1.6 * 2)) * 0.25;
    f.held.rotation.z = 1.2 + t * 8;
    f.feet.forEach((ft, i) => {
      ft.position.x = (i ? FOOT_X : -FOOT_X) - x * 0.3;
      ft.position.y = FOOT_Y + (hash(t * 4 + i) > 0.7 ? 0.1 : 0);
    });
  },

  // Papież: najpierw „Take the L” (jak w Fortnite), potem sztywne błogosławieństwo z lewitacją
  pope(f, t) {
    if (t < 4) {
      // „L” z bumerangu przy czole, podskoki z nogi na nogę z wymachem drugiej stopy w bok
      const s = step(t, 12);
      const hop = Math.floor(s * 2.6); // numer podskoku
      const side = hop % 2 ? 1 : -1;
      const ph = (s * 2.6) % 1; // faza jednego podskoku
      yaw(f, side * 0.45);
      f.body.position.y = Math.sin(ph * Math.PI) * 0.22;
      f.body.rotation.z = side * 0.12;
      f.held.position.set(-0.2, 1.16 + Math.sin(ph * Math.PI) * 0.22, 0.3); // „L” na środku czoła
      f.held.rotation.set(Math.PI / 2, 0, 0.8);
      f.held.scale.setScalar(0.85);
      const kick = f.feet[side > 0 ? 1 : 0];
      kick.position.x = side * 0.42;
      kick.position.y = FOOT_Y + 0.25 * Math.sin(ph * Math.PI);
      kick.rotation.z = side * 0.6;
      f.feet[side > 0 ? 0 : 1].position.y = FOOT_Y + Math.sin(ph * Math.PI) * 0.18;
      return;
    }
    t -= 4;
    const c = t % 8;
    const lev = c < 6 ? c / 6 : c < 6.1 ? 1 : 0;
    f.wrap.position.y = lev * 0.8 + Math.sin(t * 1.3) * 0.03;
    yaw(f, Math.sin(t * 0.5) * 0.4);
    const bless = Math.floor(t * 3) % 4; // krzyż w 4 schodkach
    f.held.position.set(0.35 + (bless === 1 ? 0.25 : bless === 3 ? -0.25 : 0),
      1.0 + (bless === 0 ? 0.3 : bless === 2 ? -0.2 : 0), 0.3);
    f.held.rotation.set(0.3, 0, Math.PI / 2);
    f.body.rotation.x = -0.05;
    f.feet.forEach(ft => { ft.position.y = FOOT_Y - lev * 0.04; });
  },

  // Sanic: bieg w miejscu tak szybki, że stopy kręcą się w kółko; gotta go fast
  sanic(f, t) {
    const a = t * 40;
    f.feet.forEach((ft, i) => {
      const ph = a + i * Math.PI;
      ft.position.y = FOOT_Y + 0.12 + Math.sin(ph) * 0.12;
      ft.position.z = FOOT_Z + Math.cos(ph) * 0.18;
    });
    f.body.rotation.x = 0.45;
    f.body.position.y = 0.08 + (hash(t * 30) - 0.5) * 0.06;
    f.held.position.set(-0.45, 0.55, -0.2); // ręce w tył jak w biegu
    f.held.rotation.set(0.3, 0, -1.2 + Math.sin(t * 40) * 0.6);
    if ((t % 3) > 2.7) yaw(f, Math.PI); // nagły glitch: odwraca się na chwilę
  },

  // Myszka: goni własny ogon w kółko, z przerwami na nerwowe węszenie
  mouse(f, t) {
    const c = t % 3;
    if (c < 2) {
      yaw(f, -c * c * 5); // coraz szybciej za ogonem
      f.body.rotation.z = 0.3;
      f.body.position.y = Math.abs(Math.sin(t * 20)) * 0.06;
      f.feet.forEach((ft, i) => { ft.position.y = FOOT_Y + (Math.floor(t * 16 + i) % 2) * 0.08; });
    } else {
      // węszenie: drgawki z 15 fps, pyszczek w górę
      const s = step(t, 15);
      f.body.rotation.x = -0.35 + (hash(s * 15) - 0.5) * 0.2;
      f.body.position.x = (hash(s * 15 + 3) - 0.5) * 0.05;
    }
    f.held.rotation.z = 1.2 + Math.sin(t * 14) * 0.4;
  },

  // Pieróg: galaretowate drżenie, podskok i przewrotka jak naleśnik na patelni
  pierogi(f, t) {
    const c = t % 2.5;
    const wob = Math.sin(t * 18) * 0.12;
    f.body.scale.set(1 + wob, 1 - wob, 1 + wob);
    if (c > 1.6) {
      const p = (c - 1.6) / 0.9; // 0..1 lotu
      f.body.position.y = Math.sin(p * Math.PI) * 0.8;
      f.body.rotation.x = p * TAU; // pełna przewrotka w powietrzu
      if (p > 0.95) f.body.scale.set(1.5, 0.5, 1.5); // plask o patelnię
    }
    f.held.rotation.z = 1.2 + Math.sin(t * 6) * 0.5;
  },

  // Brzoskwinia: twerk tyłem do widowni, z glitchowym obrotem co kilka sekund
  peach(f, t) {
    const c = t % 4;
    yaw(f, c > 3.6 ? step(t, 10) * 9 : Math.PI);
    f.body.rotation.x = 0.45; // pochylona
    const shake = Math.sin(t * 22);
    f.body.position.y = Math.abs(shake) * 0.1;
    f.body.rotation.z = shake * 0.12;
    f.body.scale.set(1 + Math.abs(shake) * 0.08, 1 - Math.abs(shake) * 0.08, 1);
    f.feet.forEach((ft, i) => { ft.position.x = (i ? 1 : -1) * (FOOT_X + 0.08); });
    f.held.position.set(0.45, 0.85, 0.1);
    f.held.rotation.z = 1.2 + shake * 0.6;
  },

  // Kebab: kręci się jak rożen, stopy stoją; co pół obrotu zacięcie
  kebab(f, t) {
    const turn = t * 2.4;
    const stall = (turn % Math.PI) < 0.35;
    f.body.rotation.y = stall ? Math.floor(turn / Math.PI) * Math.PI : turn;
    f.body.position.y = stall ? 0.02 : 0;
    f.held.position.y = 0.55 + Math.sin(t * 3) * 0.1;
  },
};

// Domyślny taniec: bujanie z drganiem
function generic(f, t) {
  const s = step(t, 8);
  f.body.position.y = tri(s * 4) * 0.2;
  f.body.rotation.z = Math.sin(s * 5) * 0.3;
  f.held.rotation.z = 1.2 + Math.sin(s * 9) * 0.9;
  f.feet[Math.floor(t * 4) % 2].position.y = FOOT_Y + 0.12;
}

// Długość jednego pełnego tańca (sekundy); po niej postać wraca do zwykłej pozy
const LENGTHS = {
  apple: 4, carrot: 6, eggplant: 3, banana: 3.6, broccoli: 4, sausage: 5, chicken: 5.3,
  onion: 6, donut: 4, pope: 10, sanic: 3, mouse: 3, pierogi: 2.5, kebab: 5.2, peach: 4,
};

export function danceLength(f) {
  return LENGTHS[f.char && f.char.id] || 3;
}

export function applyDance(f, t) {
  resetDance(f);
  (DANCES[f.char && f.char.id] || generic)(f, Math.max(0, t));
}
