import * as THREE from './vendor/three.module.js';

function mat(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, ...extra });
}

function part(geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Losowość oczu; ustawiana przed budową każdej postaci (ziarno z jej id)
let eyeRng = Math.random;

// Oczy losowane per postać: rozmiar, rozstaw, zez, styl i brwi
// red: czerwone, świecące oczy (np. Myszka)
function addEyes(g, y, z, spread = 0.15, size = 0.085, { red = false } = {}) {
  const r = eyeRng;
  const between = (a, b) => a + r() * (b - a);
  const white = red
    ? mat(0xd50000, { roughness: 0.2, emissive: 0x7f0000, emissiveIntensity: 0.8 })
    : mat(0xffffff, { roughness: 0.25 });
  const black = mat(0x151515, { roughness: 0.2 });
  // googly: duże białka i małe źrenice, beady: same paciorki, derp: zwykłe z zezem
  const style = ['googly', 'beady', 'derp', 'derp'][Math.floor(r() * 4)];
  const sp = spread * between(0.75, 1.3);
  const base = size * (style === 'googly' ? 1.4 : style === 'beady' ? 0.65 : 1);
  for (const s of [-1, 1]) {
    const sz = base * between(0.8, 1.4);
    const ey = y + between(-0.035, 0.035);
    if (style === 'beady') {
      g.add(part(new THREE.SphereGeometry(sz, 7, 5), red ? white : black, s * sp, ey, z));
      continue;
    }
    const eye = part(new THREE.SphereGeometry(sz, 7, 5), white, s * sp, ey, z);
    const a = r() * Math.PI * 2;
    const off = style === 'googly' ? between(0.2, 0.5) : between(0.1, 0.4);
    const pk = style === 'googly' ? between(0.3, 0.45) : between(0.45, 0.6);
    eye.add(part(new THREE.SphereGeometry(sz * pk, 7, 5), black, Math.cos(a) * off * sz, Math.sin(a) * off * sz, sz * 0.62));
    g.add(eye);
  }
  // brwi: groźne, smutne albo krzywe
  if (r() < 0.55) {
    const mood = between(-0.5, 0.5);
    for (const s of [-1, 1]) {
      const brow = part(new THREE.BoxGeometry(size * 1.6, size * 0.3, size * 0.3), black,
        s * sp, y + size * between(1.6, 2.1), z + size * 0.2);
      brow.rotation.z = s * mood + between(-0.15, 0.15);
      g.add(brow);
    }
  }
}

// ---------- Styl „Really3D” ----------
// Celowo toporne modele: mało wielokątów, pogniecione powierzchnie z płaskim
// cieniowaniem i krzywo poprzyklejane części. Ziarno zależy od postaci,
// więc każda wygląda tak samo przy każdym uruchomieniu i u każdego gracza.

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noise3(x, y, z, k) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + k * 19.3) * 43758.5453;
  return h - Math.floor(h);
}

function seedOf(text) {
  let h = 7;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

function really3d(root, seed) {
  const r = rng(seed);
  root.traverse(o => {
    if (!o.isMesh) return;
    const geo = o.geometry.clone();
    geo.computeBoundingSphere();
    const amp = geo.boundingSphere.radius * 0.12;
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      // przesunięcie zależy od położenia wierzchołka, więc szwy siatki się nie rozchodzą
      const x = Math.round(p.getX(i) * 1e4) / 1e4;
      const y = Math.round(p.getY(i) * 1e4) / 1e4;
      const z = Math.round(p.getZ(i) * 1e4) / 1e4;
      p.setXYZ(i,
        x + (noise3(x, y, z, seed) - 0.5) * amp,
        y + (noise3(y, z, x, seed + 1) - 0.5) * amp,
        z + (noise3(z, x, y, seed + 2) - 0.5) * amp);
    }
    geo.computeVertexNormals();
    o.geometry = geo;
    Object.assign(o.material, { flatShading: true, roughness: 0.95, metalness: 0 });
    o.material.needsUpdate = true;
    o.rotation.x += (r() - 0.5) * 0.14;
    o.rotation.z += (r() - 0.5) * 0.14;
  });
  return root;
}

function buildApple() {
  const g = new THREE.Group();
  // Nadgryzienie bez CSG: kula, której biegun obracamy w stronę ugryzienia (d: prawo,
  // lekko przód i w górę; oczy są na +Z). Wierzchołki leżące w „kuli zębów” (środek
  // d*D, promień rb) przesuwamy promieniowo na jej powierzchnię -> wklęsły dołek w jednej
  // siatce, bez szwów i dziur (ok też przy przecinaniu z DoubleSide). Pierścienie
  // wierzchołków wokół bieguna dają kolisty dołek, a kolorowanie trójkątów po liczbie
  // „ugryzionych” wierzchołków robi ząbkowaną krawędź jak ślady zębów.
  const R = 0.46, rb = 0.3, D = 0.54;
  const d = new THREE.Vector3(0.95, 0.28, 0.14).normalize();
  const C = d.clone().multiplyScalar(D);
  const geo = new THREE.SphereGeometry(R, 10, 12);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d));
  const flat = geo.toNonIndexed();
  const p = flat.attributes.position;
  const v = new THREE.Vector3();
  const bitten = [];
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const inBite = v.distanceTo(C) < rb;
    if (inBite) {
      // promień ze środka jabłka: pierwszy punkt przecięcia z kulą zębów
      v.normalize();
      const b = v.dot(C);
      const t = b - Math.sqrt(Math.max(0, b * b - D * D + rb * rb));
      v.multiplyScalar(t);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    bitten.push(inBite);
  }
  const red = new THREE.Color(0xd83a2e), flesh = new THREE.Color(0xfff1c9);
  const colors = [];
  for (let i = 0; i < p.count; i += 3) {
    const k = bitten[i] + bitten[i + 1] + bitten[i + 2];
    const c = k >= 2 ? flesh : red;
    for (let j = 0; j < 3; j++) colors.push(c.r, c.g, c.b);
  }
  flat.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  flat.computeVertexNormals();
  const body = part(flat, mat(0xffffff, { vertexColors: true }), 0, 0.52, 0);
  body.scale.set(1, 0.92, 1);
  g.add(body);
  // pestki na dnie ugryzienia
  const seedMat = mat(0x3e2412);
  const side = new THREE.Vector3(-d.z, 0, d.x).normalize();
  for (const s of [-1, 1]) {
    const pos = d.clone().multiplyScalar(D - rb + 0.03).addScaledVector(side, s * 0.045);
    const seed = part(new THREE.SphereGeometry(0.032, 6, 4), seedMat, pos.x, pos.y, pos.z);
    seed.scale.set(0.7, 1.35, 0.7);
    seed.rotation.z = s * 0.3;
    body.add(seed);
  }
  g.add(part(new THREE.CylinderGeometry(0.03, 0.04, 0.22, 7), mat(0x6d4c2f), 0.02, 1.0, 0));
  const leaf = part(new THREE.SphereGeometry(0.12, 7, 5), mat(0x43a047), 0.13, 1.02, 0);
  leaf.scale.set(1, 0.35, 0.55);
  leaf.rotation.z = 0.5;
  g.add(leaf);
  addEyes(g, 0.6, 0.4, 0.13);
  return g;
}

function buildCarrot() {
  const g = new THREE.Group();
  const body = part(new THREE.ConeGeometry(0.38, 1.0, 6), mat(0xff8f00), 0, 0.55, 0);
  body.rotation.x = Math.PI;
  g.add(body);
  const green = mat(0x43a047);
  for (const a of [-0.4, 0, 0.4]) {
    const leaf = part(new THREE.ConeGeometry(0.07, 0.45, 6), green, Math.sin(a) * 0.12, 1.25, 0);
    leaf.rotation.z = -a;
    g.add(leaf);
  }
  addEyes(g, 0.75, 0.22, 0.12, 0.075);
  return g;
}

function buildEggplant() {
  const g = new THREE.Group();
  // smukły, wyprostowany „emoji” bakłażan: walcowaty trzon, bulwiasty czubek pod
  // szypułką, lekko przechylony na bok (cała bryła w podgrupie obróconej wokół stóp)
  const shaft = new THREE.Group();
  shaft.rotation.z = -0.1;
  g.add(shaft);
  const purple = mat(0x6a1b9a, { roughness: 0.35 });
  shaft.add(part(new THREE.CapsuleGeometry(0.26, 0.6, 3, 7), purple, 0, 0.59, 0));
  const bulb = part(new THREE.SphereGeometry(0.31, 7, 5), purple, 0, 1.12, 0);
  bulb.scale.set(1, 0.85, 1);
  shaft.add(bulb);
  // połysk
  const shine = part(new THREE.SphereGeometry(0.07, 7, 5), mat(0xb98ae0, { roughness: 0.2 }), -0.15, 1.2, 0.22);
  shine.scale.set(0.6, 1.4, 0.5);
  shaft.add(shine);
  // zielona czapeczka: stożek, opadające listki kielicha i ogonek
  const green = mat(0x558b2f);
  shaft.add(part(new THREE.ConeGeometry(0.24, 0.14, 6), green, 0, 1.4, 0));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const sepal = part(new THREE.SphereGeometry(0.1, 7, 5), green, Math.sin(a) * 0.2, 1.33, Math.cos(a) * 0.2);
    sepal.scale.set(0.6, 0.3, 1.2);
    sepal.rotation.order = 'YXZ';
    sepal.rotation.y = a;
    sepal.rotation.x = 0.5;
    shaft.add(sepal);
  }
  shaft.add(part(new THREE.CylinderGeometry(0.045, 0.06, 0.16, 7), green, 0.02, 1.52, 0));
  addEyes(shaft, 0.95, 0.24, 0.12);
  return g;
}

function buildBanana() {
  const g = new THREE.Group();
  const yellow = mat(0xf6d43a);
  const arc = Math.PI * 0.8;
  const banana = part(new THREE.TorusGeometry(0.5, 0.18, 4, 12, arc), yellow);
  banana.rotation.z = -arc / 2;
  const holder = new THREE.Group();
  holder.add(banana);
  holder.rotation.y = Math.PI / 2;
  holder.position.set(0, 0.62, 0.5);
  g.add(holder);
  const endZ = 0.5 - 0.5 * Math.cos(arc / 2);
  const endY = 0.5 * Math.sin(arc / 2);
  g.add(part(new THREE.SphereGeometry(0.18, 7, 5), yellow, 0, 0.62 + endY, endZ));
  g.add(part(new THREE.SphereGeometry(0.18, 7, 5), yellow, 0, 0.62 - endY, endZ));
  g.add(part(new THREE.CylinderGeometry(0.05, 0.07, 0.16, 7), mat(0x5d4037), 0, 0.62 + endY + 0.2, endZ + 0.02));
  addEyes(g, 0.72, 0.15, 0.1, 0.075);
  return g;
}

function buildBroccoli() {
  const g = new THREE.Group();
  g.add(part(new THREE.CylinderGeometry(0.17, 0.22, 0.55, 7), mat(0x9ccc65), 0, 0.3, 0));
  const dark = mat(0x2e7d32, { roughness: 0.9 });
  const mid = mat(0x388e3c, { roughness: 0.9 });
  const florets = [
    [0, 0.85, 0, 0.34, dark], [0.27, 0.76, 0.08, 0.22, mid], [-0.27, 0.76, 0.08, 0.22, mid],
    [0.16, 0.98, -0.15, 0.22, mid], [-0.16, 0.98, -0.15, 0.22, mid], [0, 0.74, 0.24, 0.2, mid],
  ];
  for (const [x, y, z, r, m] of florets) g.add(part(new THREE.SphereGeometry(r, 7, 5), m, x, y, z));
  addEyes(g, 0.42, 0.17, 0.08, 0.06);
  return g;
}

function buildSausage() {
  const g = new THREE.Group();
  g.add(part(new THREE.CapsuleGeometry(0.28, 0.6, 3, 7), mat(0xb5523b, { roughness: 0.4 }), 0, 0.62, 0));
  // przypieczone paski z grilla
  const grill = mat(0x5a2412, { roughness: 0.8 });
  for (const y of [0.4, 0.58]) {
    const mark = part(new THREE.BoxGeometry(0.34, 0.045, 0.04), grill, 0, y, 0.265);
    mark.rotation.z = 0.4;
    g.add(mark);
  }
  g.add(part(new THREE.SphereGeometry(0.07, 7, 5), mat(0x7a3b22), 0, 1.22, 0));
  addEyes(g, 0.82, 0.25, 0.1, 0.07);
  return g;
}

// Kurczak z rożna: nadziany na pręt, chodzi na własnych udkach
function buildChicken() {
  const g = new THREE.Group();
  const roast = mat(0xc9822e, { roughness: 0.45 });
  const crisp = mat(0x8d4b14, { roughness: 0.6 });
  const bone = mat(0xf5f0e1, { roughness: 0.6 });
  const steel = mat(0x9e9e9e, { roughness: 0.3 });

  const body = part(new THREE.SphereGeometry(0.42, 7, 5), roast, 0, 0.74, 0);
  body.scale.set(1, 1.1, 0.95);
  g.add(body);
  // przypieczone plamy
  for (const [x, y, z] of [[0.2, 0.95, 0.3], [-0.28, 0.62, 0.26], [0.3, 0.55, -0.2], [-0.15, 1.05, -0.3]]) {
    const spot = part(new THREE.SphereGeometry(0.1, 7, 5), crisp, x, y, z);
    spot.scale.set(1, 0.6, 0.4);
    spot.lookAt(0, 0.74, 0);
    g.add(spot);
  }

  // rożen przebijający kurczaka od góry, z uchwytem
  g.add(part(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 7), steel, 0, 1.05, 0));
  const handle = part(new THREE.TorusGeometry(0.09, 0.025, 4, 12), steel, 0, 1.68, 0);
  g.add(handle);

  // skrzydełka jako ręce
  for (const s of [-1, 1]) {
    const wing = part(new THREE.SphereGeometry(0.2, 7, 5), roast, s * 0.42, 0.78, 0.02);
    wing.scale.set(0.45, 1, 0.7);
    wing.rotation.z = s * 0.35;
    g.add(wing);
  }

  // udka zamiast nóg; kostki to stopy postaci
  for (const s of [-1, 1]) {
    g.add(part(new THREE.CylinderGeometry(0.13, 0.07, 0.28, 7), roast, s * 0.18, 0.34, 0.04));
    g.add(part(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 7), bone, s * 0.18, 0.14, 0.04));
  }

  addEyes(g, 0.86, 0.37);
  return g;
}

function buildOnion() {
  const g = new THREE.Group();
  const skin = mat(0x9c3d6e, { roughness: 0.35 });
  const body = part(new THREE.SphereGeometry(0.45, 7, 5), skin, 0, 0.5, 0);
  body.scale.set(1, 0.95, 1);
  g.add(body);
  g.add(part(new THREE.ConeGeometry(0.12, 0.35, 6), skin, 0, 1.06, 0));
  // jaśniejsze linie warstw
  const line = mat(0xc56a96, { roughness: 0.4 });
  for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
    const ring = part(new THREE.TorusGeometry(0.452, 0.012, 4, 12), line, 0, 0.5, 0);
    ring.scale.y = 0.95;
    ring.rotation.y = a;
    g.add(ring);
  }
  addEyes(g, 0.58, 0.41);
  return g;
}

// Donut: stojący pierścień z dziurką, różowy lukier i posypka z przodu
function buildDonut() {
  const g = new THREE.Group();
  const R = 0.36, cy = 0.58;
  g.add(part(new THREE.TorusGeometry(R, 0.2, 6, 14), mat(0xd9984a, { roughness: 0.7 }), 0, cy, 0));
  const glaze = part(new THREE.TorusGeometry(R, 0.21, 6, 14), mat(0xf48fb1, { roughness: 0.25 }), 0, cy, 0.05);
  glaze.scale.z = 0.6;
  g.add(glaze);
  const colors = [0xffeb3b, 0x4fc3f7, 0x81c784, 0xffffff, 0xff7043];
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + 0.2;
    if (Math.abs(a - Math.PI / 2) < 0.55) continue; // miejsce na oczy
    const rr = R + ((i * 7) % 5 - 2) * 0.04;
    const s = part(new THREE.BoxGeometry(0.07, 0.022, 0.022), mat(colors[i % colors.length]),
      Math.cos(a) * rr, cy + Math.sin(a) * rr, 0.19);
    s.rotation.z = i * 1.3;
    g.add(s);
  }
  addEyes(g, cy + R + 0.02, 0.19, 0.12, 0.075);
  return g;
}

// Brzoskwinia jak z emoji: dwa okrągłe płaty z rowkiem pośrodku, od przodu
function buildPeach() {
  const g = new THREE.Group();
  const skin = mat(0xffa577, { roughness: 0.8 });
  const blushMat = mat(0xf26b5b, { roughness: 0.8 });
  for (const s of [-1, 1]) {
    const lobe = part(new THREE.SphereGeometry(0.33, 7, 5), skin, s * 0.17, 0.48, 0);
    lobe.scale.set(1, 1.05, 1.15);
    g.add(lobe);
    // rumieńce na pośladkach
    const blush = part(new THREE.SphereGeometry(0.16, 7, 5), blushMat, s * 0.24, 0.42, 0.3);
    blush.scale.set(1, 1, 0.5);
    g.add(blush);
  }
  // ciemniejszy rowek między płatami
  const cleft = part(new THREE.BoxGeometry(0.035, 0.5, 0.1), mat(0xd9653f, { roughness: 0.8 }), 0, 0.46, 0.31);
  g.add(cleft);
  g.add(part(new THREE.CylinderGeometry(0.03, 0.04, 0.16, 7), mat(0x6d4c2f), 0, 0.88, -0.02));
  const leaf = part(new THREE.SphereGeometry(0.14, 7, 5), mat(0x43a047), -0.13, 0.9, 0);
  leaf.scale.set(1, 0.3, 0.5);
  leaf.rotation.z = -0.5;
  g.add(leaf);
  addEyes(g, 0.66, 0.35, 0.17);
  return g;
}

// Sanic: memowa, koślawa parodia niebieskiego jeża; kolce do tyłu, wielkie oczy, czerwone buty
function buildSanic() {
  const g = new THREE.Group();
  const blue = mat(0x1e5bd6, { roughness: 0.5 });
  const tan = mat(0xf2c99a);
  g.add(part(new THREE.SphereGeometry(0.4, 7, 5), blue, 0, 0.62, 0));
  // kolce sterczące do tyłu
  for (const [y, x, tilt] of [[0.9, 0, 0.9], [0.7, -0.18, 1.2], [0.7, 0.18, 1.2], [0.5, 0, 1.5], [1.0, 0, 0.5]]) {
    const spike = part(new THREE.ConeGeometry(0.13, 0.55, 5), blue, x, y, -0.35);
    spike.rotation.x = -tilt;
    g.add(spike);
  }
  const belly = part(new THREE.SphereGeometry(0.22, 7, 5), tan, 0, 0.5, 0.25);
  belly.scale.set(1, 1.2, 0.6);
  g.add(belly);
  const muzzle = part(new THREE.SphereGeometry(0.14, 7, 5), tan, 0, 0.62, 0.34);
  muzzle.scale.set(1.3, 0.8, 0.8);
  g.add(muzzle);
  g.add(part(new THREE.SphereGeometry(0.05, 7, 5), mat(0x111111), 0, 0.68, 0.46));
  addEyes(g, 0.82, 0.3, 0.12, 0.13);
  return g;
}

// Myszka: szara, z długim pyszczkiem, różowymi uszami i ogonem oraz czerwonymi oczami
function buildMouse() {
  const g = new THREE.Group();
  const fur = mat(0x9e9e9e, { roughness: 0.9 });
  const pink = mat(0xf48fb1, { roughness: 0.6 });
  const body = part(new THREE.SphereGeometry(0.32, 7, 5), fur, 0, 0.38, -0.05);
  body.scale.set(0.9, 0.85, 1.25);
  g.add(body);
  // spiczasty pyszczek z różowym noskiem
  const head = part(new THREE.ConeGeometry(0.2, 0.42, 7), fur, 0, 0.55, 0.3);
  head.rotation.x = Math.PI / 2;
  g.add(head);
  g.add(part(new THREE.SphereGeometry(0.045, 7, 5), pink, 0, 0.55, 0.52));
  // okrągłe uszy z różowym środkiem
  for (const s of [-1, 1]) {
    const ear = part(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 7), fur, s * 0.15, 0.78, 0.16);
    ear.rotation.x = Math.PI / 2;
    ear.rotation.z = s * 0.3;
    g.add(ear);
    const inner = part(new THREE.CylinderGeometry(0.085, 0.085, 0.02, 7), pink, s * 0.15, 0.78, 0.18);
    inner.rotation.x = Math.PI / 2;
    inner.rotation.z = s * 0.3;
    g.add(inner);
  }
  // wąsy
  const dark = mat(0x424242);
  for (const s of [-1, 1]) {
    for (const k of [-1, 0, 1]) {
      const w = part(new THREE.BoxGeometry(0.22, 0.008, 0.008), dark, s * 0.13, 0.54 + k * 0.025, 0.45);
      w.rotation.z = k * 0.2 * s;
      w.rotation.y = -s * 0.25;
      g.add(w);
    }
  }
  // długi, zakręcony ogon
  let prev = new THREE.Vector3(0, 0.3, -0.42);
  for (let i = 0; i < 4; i++) {
    const next = new THREE.Vector3(Math.sin(i * 0.9) * 0.15, 0.3 + i * 0.12, -0.42 - 0.15 - i * 0.08);
    const seg = part(new THREE.CylinderGeometry(0.02, 0.025, prev.distanceTo(next), 5), pink);
    seg.position.copy(prev).add(next).multiplyScalar(0.5);
    seg.lookAt(next);
    seg.rotateX(Math.PI / 2);
    g.add(seg);
    prev = next;
  }
  addEyes(g, 0.63, 0.32, 0.1, 0.05, { red: true });
  return g;
}

// Pieróg ruski: jeden duży, stojący półksiężyc z falbanką brzegu i przysmażoną cebulką
function buildPierogi() {
  const g = new THREE.Group();
  const dough = mat(0xf3e0b5, { roughness: 0.8 });
  // górna półkula spłaszczona od przodu = półksiężyc z płaskim spodem
  const shell = part(new THREE.SphereGeometry(0.45, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2), dough, 0, 0.08, 0);
  shell.scale.set(1.2, 1.15, 0.6);
  g.add(shell);
  const base = part(new THREE.CircleGeometry(0.45, 9), dough, 0, 0.08, 0);
  base.rotation.x = Math.PI / 2;
  base.scale.set(1.2, 0.6, 1);
  g.add(base);
  // zawijany brzeg: falbanka wzdłuż łuku
  const crimp = mat(0xe6c98f, { roughness: 0.8 });
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI;
    const b = part(new THREE.SphereGeometry(0.075, 7, 5), crimp, Math.cos(a) * 0.54, 0.08 + Math.sin(a) * 0.52, 0);
    b.scale.set(1, 1, 0.7);
    b.rotation.z = a;
    g.add(b);
  }
  // przysmażona cebulka na wierzchu
  const fried = mat(0xc8902e, { roughness: 0.9 });
  for (const [x, z] of [[-0.12, 0.12], [0.1, 0.14], [0.02, -0.12], [-0.2, -0.05], [0.22, 0.02]]) {
    const k = part(new THREE.BoxGeometry(0.08, 0.025, 0.04), fried, x, 0.6 - Math.abs(x) * 0.6, z);
    k.rotation.set(x * 9, x * 13, z * 7);
    g.add(k);
  }
  addEyes(g, 0.38, 0.21, 0.13, 0.075);
  return g;
}

// Kebab w picie: kieszeń z pity zawinięta w papier, z wystającym mięsem i warzywami
function buildKebab() {
  // całość podniesiona, żeby wyższa kieszeń z pity nie wchodziła w podłogę
  const root = new THREE.Group();
  const g = new THREE.Group();
  g.position.y = 0.15;
  root.add(g);
  // dolna połowa kuli = kieszeń z pity: zaokrąglona od dołu, otwarta u góry
  const pocket = (r, from, color) => {
    const m = part(new THREE.SphereGeometry(r, 9, 5, 0, Math.PI * 2, from, Math.PI - from),
      mat(color, { roughness: 0.85, side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.12 }), 0, 0.75, 0);
    m.scale.set(1.0, 1.9, 0.5);
    return m;
  };
  g.add(pocket(0.45, Math.PI / 2, 0xf0cf98));
  g.add(pocket(0.465, Math.PI / 2 + 0.5, 0xf5f5f5)); // papier na dole
  const print = part(new THREE.TorusGeometry(0.4, 0.015, 4, 14), mat(0xd32f2f), 0, 0.3, 0);
  print.rotation.x = Math.PI / 2;
  print.scale.set(0.96, 0.48, 1);
  g.add(print);

  // mięso z rożna: cienkie, poskręcane paski
  const meats = [mat(0x7b4a24, { roughness: 0.9 }), mat(0x9c5b2b, { roughness: 0.9 })];
  for (let i = 0; i < 9; i++) {
    const a = i * 2.39;
    const s = part(new THREE.BoxGeometry(0.2, 0.025, 0.07), meats[i % 2], Math.cos(a) * 0.17, 0.78 + (i % 3) * 0.05, Math.sin(a) * 0.08);
    s.rotation.set(0.6 + (i % 4) * 0.4, a, 0.5 - (i % 3) * 0.4);
    g.add(s);
  }
  // sałata, czerwona kapusta, pomidor, krążki cebuli
  const lettuce = mat(0x8bc34a);
  for (const [x, z] of [[-0.3, 0.03], [0.28, -0.04], [0.05, 0.1], [-0.08, -0.1]]) {
    const l = part(new THREE.SphereGeometry(0.1, 7, 5), lettuce, x, 0.86, z);
    l.scale.set(1.3, 0.35, 1);
    l.rotation.z = x * 2;
    g.add(l);
  }
  const cabbage = mat(0x7b1fa2);
  for (const [x, z] of [[0.18, 0.07], [-0.18, -0.06], [0.0, -0.08]]) {
    const c = part(new THREE.BoxGeometry(0.12, 0.02, 0.03), cabbage, x, 0.9, z);
    c.rotation.y = x * 9;
    g.add(c);
  }
  for (const x of [-0.14, 0.14]) {
    const tm = part(new THREE.CylinderGeometry(0.07, 0.07, 0.025, 7), mat(0xe53935), x, 0.9, 0.08);
    tm.rotation.x = 1.2;
    g.add(tm);
  }
  const ring = part(new THREE.TorusGeometry(0.055, 0.013, 4, 10), mat(0xf3f0e6), 0.22, 0.93, 0.02);
  ring.rotation.x = 1.3;
  g.add(ring);
  // sos czosnkowy na wierzchu i cieknący po przodzie
  const sauce = mat(0xfaf8f0, { roughness: 0.3 });
  const blob = part(new THREE.SphereGeometry(0.12, 7, 5), sauce, -0.05, 0.92, 0.1);
  blob.scale.set(1.4, 0.4, 0.9);
  g.add(blob);
  const drip = part(new THREE.CapsuleGeometry(0.03, 0.18, 3, 7), sauce, -0.12, 0.72, 0.25);
  drip.rotation.x = -0.35;
  g.add(drip);

  addEyes(g, 0.53, 0.21, 0.11, 0.07);
  return root;
}

function buildPope() {
  const g = new THREE.Group();
  const white = mat(0xf7f4ec, { roughness: 0.7 });
  const gold = mat(0xf2c230, { metalness: 0.6, roughness: 0.3 });
  const skin = mat(0xf2c9a5);

  // sutanna, pas i pelerynka
  g.add(part(new THREE.CylinderGeometry(0.26, 0.44, 0.8, 7), white, 0, 0.4, 0));
  g.add(part(new THREE.CylinderGeometry(0.372, 0.384, 0.07, 7), gold, 0, 0.28, 0));
  g.add(part(new THREE.CylinderGeometry(0.25, 0.4, 0.22, 7), white, 0, 0.72, 0));

  // krzyż na piersi
  g.add(part(new THREE.BoxGeometry(0.045, 0.18, 0.03), gold, 0, 0.5, 0.34));
  g.add(part(new THREE.BoxGeometry(0.12, 0.045, 0.03), gold, 0, 0.54, 0.34));

  for (const s of [-1, 1]) g.add(part(new THREE.SphereGeometry(0.075, 7, 5), skin, s * 0.38, 0.48, 0.1));

  g.add(part(new THREE.SphereGeometry(0.23, 7, 5), skin, 0, 0.98, 0));
  addEyes(g, 1.0, 0.2, 0.08, 0.055);

  // mitra
  const mitre = new THREE.Group();
  mitre.position.y = 1.1;
  const capHolder = new THREE.Group();
  capHolder.scale.z = 0.7;
  const cap = part(new THREE.ConeGeometry(0.21, 0.55, 4), white, 0, 0.32, 0);
  cap.rotation.y = Math.PI / 4;
  capHolder.add(cap);
  mitre.add(capHolder);
  mitre.add(part(new THREE.BoxGeometry(0.31, 0.06, 0.22), gold, 0, 0.07, 0));
  const crossV = part(new THREE.BoxGeometry(0.035, 0.14, 0.015), gold, 0, 0.24, 0.075);
  const crossH = part(new THREE.BoxGeometry(0.1, 0.035, 0.015), gold, 0, 0.26, 0.072);
  crossV.rotation.x = crossH.rotation.x = -0.19;
  mitre.add(crossV, crossH);
  g.add(mitre);
  return g;
}

export const CHARACTERS = [
  { id: 'apple', name: 'Jabłko', gender: 'n', height: 1.15, juice: [0xd83a2e, 0xfff1c9, 0xfff1c9], feet: 0x5d4037, build: buildApple },
  { id: 'carrot', name: 'Marchewka', gender: 'f', height: 1.45, juice: [0xff8f00, 0xffb74d], feet: 0x5d4037, build: buildCarrot },
  { id: 'eggplant', name: 'Bakłażan', gender: 'm', height: 1.6, juice: [0x6a1b9a, 0xeef5d8], feet: 0x33691e, build: buildEggplant },
  { id: 'banana', name: 'Banan', gender: 'm', height: 1.35, juice: [0xf6d43a, 0xfff8d6], feet: 0x5d4037, build: buildBanana },
  { id: 'broccoli', name: 'Brokuł', gender: 'm', height: 1.3, juice: [0x2e7d32, 0x9ccc65], feet: 0x33691e, build: buildBroccoli },
  // death: dodatkowy efekt śmierci (smoke, bones, tears, sprinkles)
  { id: 'sausage', name: 'Kiełbaska', gender: 'f', height: 1.4, juice: [0xb5523b, 0xf4c7a1], feet: 0x3e2723, death: 'smoke', build: buildSausage },
  { id: 'chicken', name: 'Kurczak', gender: 'm', height: 1.75, juice: [0xc9822e, 0xf2d3a0], feet: 0xf5f0e1, death: 'bones', build: buildChicken },
  { id: 'onion', name: 'Cebula', gender: 'f', height: 1.3, juice: [0x9c3d6e, 0xf3e5f5], feet: 0x5d4037, death: 'tears', build: buildOnion },
  { id: 'donut', name: 'Donut', gender: 'm', height: 1.25, juice: [0xd9984a, 0xf48fb1, 0xfff3e0], feet: 0x5d4037, death: 'sprinkles', build: buildDonut },
  { id: 'peach', name: 'Brzoskwinia', gender: 'f', height: 1.05, juice: [0xffa577, 0xffd59e, 0xf26b5b], feet: 0x5d4037, build: buildPeach },
  { id: 'pierogi', name: 'Pieróg', gender: 'm', height: 0.8, juice: [0xf3e0b5, 0xf5f0dc, 0xd9a441], feet: 0x5d4037, death: 'pierogi', build: buildPierogi },
  { id: 'kebab', name: 'Kebab', gender: 'm', height: 1.2, juice: [0x7cb342, 0xe53935, 0xfaf8f0, 0x8d5524], feet: 0x5d4037, death: 'kebab', build: buildKebab },
  // Sanic z uniwersum Really3D
  { id: 'sanic', name: 'Sanic', gender: 'm', height: 1.25, speed: 1.2, juice: [0x1e5bd6, 0xf2c99a], feet: 0xd32f2f, death: 'spikes', build: buildSanic },
  { id: 'mouse', name: 'Myszka', gender: 'f', height: 1.0, juice: [0x9e9e9e, 0xf48fb1, 0xd50000], feet: 0xf48fb1, build: buildMouse },
  // zablokowany: można go obejrzeć w menu, grać nim tylko w DLC
  { id: 'pope', name: 'Papież', locked: true, gender: 'm', height: 1.8, juice: [0xffffff, 0xf2c230, 0xfff3b0], feet: 0xb71c1c, build: buildPope },
];

for (const c of CHARACTERS) {
  const build = c.build;
  c.build = () => {
    eyeRng = rng(seedOf(c.id) ^ 0x5bd1e995);
    return really3d(build(), seedOf(c.id));
  };
}

export const CHAR_BY_ID = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));

export function makeBoomerangMesh(char, color) {
  const g = new THREE.Group();
  const body = mat(color, { roughness: 0.4 });
  const tip = mat(0xffffff, { roughness: 0.4 });
  for (const s of [-1, 1]) {
    const geo = new THREE.BoxGeometry(0.5, 0.07, 0.15);
    geo.translate(0.25, 0, 0);
    const arm = part(geo, body);
    arm.rotation.y = s * 0.95;
    arm.add(part(new THREE.BoxGeometry(0.1, 0.075, 0.155), tip, 0.47, 0, 0));
    g.add(arm);
  }
  return really3d(g, seedOf(char.id));
}
