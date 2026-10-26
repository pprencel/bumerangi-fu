import * as THREE from './vendor/three.module.js';
import { CHARACTERS, CHAR_BY_ID, makeBoomerangMesh } from './characters.js';
import { sfx as localSfx, unlockAudio, getSound, setVolume, setMuted } from './audio.js';
import { net, netConnect, netSend, netOn, netClose } from './net.js';
import { applyDance, resetDance, danceLength } from './dance.js';

// ---------- Stałe i pomocnicze ----------

const SLOT_COLORS = [0xff4d4d, 0x3d8bff, 0x34c759, 0xffc400, 0xb455ff, 0x22d3d3];
const MAX_PLAYERS = SLOT_COLORS.length; // miejsca w grze
const MAX_SPECTATORS = 8;              // widzowie w pokoju (każdy dostaje migawki od gospodarza)
const ARENA_W = 20;
const ARENA_D = 14;
const FIGHTER_R = 0.45;
const BOOM_R = 0.3;
const MOVE_SPEED = 6;
const TAP_TIME = 0.16;   // krótsze wciśnięcie = cios wirowy, dłuższe = rzut
const MAX_CHARGE = 0.7;  // czas pełnego naładowania rzutu
const UP = new THREE.Vector3(0, 1, 0);
const SPAWNS = [[-8, -5], [8, 5], [8, -5], [-8, 5], [0, -5.5], [0, 5.5]];

const css = c => '#' + c.toString(16).padStart(6, '0');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function rotateToward(a, b, maxStep) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + clamp(d, -maxStep, maxStep);
}

const r2 = v => Math.round(v * 100) / 100;

// Host odtwarza dźwięk u siebie i rozsyła go graczom sieciowym
const sfx = new Proxy(localSfx, {
  get: (target, name) => (...args) => {
    target[name](...args);
    if (net.role === 'host') netSend({ t: 'sfx', n: name, a: args });
  },
});

// ---------- Renderer, scena, kamera ----------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.localClippingEnabled = true;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd3ef);
scene.fog = new THREE.Fog(0x9fd3ef, 45, 90);

const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1, 200);
const MENU_CAM = new THREE.Vector3(1, 6.5, 10.5);
const MENU_LOOK = new THREE.Vector3(1, 0.7, 1.2);
const camPos = MENU_CAM.clone();
const camLook = MENU_LOOK.clone();
const tmpV = new THREE.Vector3();
const tmpL = new THREE.Vector3();
let shake = 0;

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

scene.add(new THREE.HemisphereLight(0xffffff, 0x9a8a78, 1.1));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.8);
sun.position.set(-6, 18, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 12, bottom: -12, near: 1, far: 50 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({ color: 0xc49a6c, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.21;
ground.receiveShadow = true;
scene.add(ground);

const arenaGroup = new THREE.Group();
const world = new THREE.Group();
scene.add(arenaGroup, world);

// Rozgrzewka shadera z płaszczyzną cięcia, żeby pierwsze pokrojenie nie przycięło gry
{
  const warm = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 8, 6),
    new THREE.MeshStandardMaterial({ clippingPlanes: [new THREE.Plane(UP, 0)], clipShadows: true, side: THREE.DoubleSide }),
  );
  warm.position.y = -1;
  warm.castShadow = true;
  scene.add(warm);
}

// Zwalnia pamięć GPU obiektu; współdzielonych tekstur i materiałów (kafelki, moce, kłódka) nie rusza
function disposeTree(obj, geometry = true) {
  const geos = new Set(), mats = new Set();
  obj.traverse(o => {
    // sprite'y mają jedną wspólną geometrię
    if (geometry && o.geometry && !o.isSprite) geos.add(o.geometry);
    if (o.material) for (const m of [].concat(o.material)) mats.add(m);
  });
  const sharedMats = Object.values(powerMats);
  const sharedMaps = new Set([lockTexture, ...texCache.values(), ...sharedMats.map(m => m.map)]);
  geos.forEach(g => g.dispose());
  for (const m of mats) {
    if (sharedMats.includes(m)) continue;
    if (m.map && !sharedMaps.has(m.map)) m.map.dispose();
    m.dispose();
  }
}

// ---------- Areny ----------

const colonnade = Array.from({ length: 10 }, (_, i) => {
  const a = (i / 10) * Math.PI * 2 + Math.PI / 10;
  return [Math.cos(a) * 5.4, Math.sin(a) * 3.6, 0.8, 0.8];
});

const LAYOUTS = [
  {
    name: 'Deska do krojenia', tiles: ['#f3e3c3', '#e9d4ab'], wall: 0x8d6e63, block: 0xa1887f, ground: 0xc49a6c,
    blocks: [[0, 0, 2.2, 2.2], [-5, -3, 1.4, 1.4], [5, -3, 1.4, 1.4], [-5, 3, 1.4, 1.4], [5, 3, 1.4, 1.4]],
  },
  {
    name: 'Ogródek', tiles: ['#a8d47c', '#9bc96f'], wall: 0x6d4c41, block: 0x2e7d32, ground: 0x6d8f4e,
    blocks: [[0, -2.6, 6, 0.7], [0, 2.6, 6, 0.7], [-7, 0, 1.2, 1.2], [7, 0, 1.2, 1.2]],
  },
  {
    name: 'Targowisko', tiles: ['#ece6d9', '#dcd3c2'], wall: 0x795548, block: 0xc08a50, ground: 0x9e9e9e,
    blocks: [[-4, -3, 3, 0.8], [4, 3, 3, 0.8], [-4, 3, 0.8, 2.6], [4, -3, 0.8, 2.6], [0, 0, 1.4, 1.4]],
  },
  {
    name: 'Plac Świętego Piotra', tiles: ['#ebe6dc', '#d9d2c4'], wall: 0xcfc6b4, block: 0xf3eee3, ground: 0xbdb6a8,
    blocks: colonnade, pillars: true, obelisk: true,
  },
];

const texCache = new Map();
function tileTexture(a, b) {
  const key = a + b;
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = a;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = b;
  g.fillRect(0, 0, 64, 64);
  g.fillRect(64, 64, 64, 64);
  g.strokeStyle = 'rgba(0,0,0,0.07)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 64, 64);
  g.strokeRect(64, 64, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(ARENA_W / 2, ARENA_D / 2);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

let walls = [];
let layout = null;

function buildArena(lay) {
  layout = lay;
  disposeTree(arenaGroup);
  arenaGroup.clear();
  walls = [];
  ground.material.color.set(lay.ground);

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(ARENA_W, 0.2, ARENA_D),
    new THREE.MeshStandardMaterial({ map: tileTexture(lay.tiles[0], lay.tiles[1]), roughness: 0.85 }),
  );
  floor.position.y = -0.1;
  floor.receiveShadow = true;
  arenaGroup.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ color: lay.wall, roughness: 0.8 });
  const blockMat = new THREE.MeshStandardMaterial({ color: lay.block, roughness: 0.8 });
  const addMesh = (geo, material, x, y, z) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    arenaGroup.add(m);
  };
  const addWall = (cx, cz, w, d, h, material, shape = 'box') => {
    const wall = { minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 };
    // kolumna zderza się jak koło (promień między górą a podstawą)
    if (shape === 'pillar') Object.assign(wall, { cx, cz, r: w / 2 * 1.1 });
    walls.push(wall);
    const geo = shape === 'pillar' ? new THREE.CylinderGeometry(w / 2, w / 2 * 1.12, h, 20) : new THREE.BoxGeometry(w, h, d);
    addMesh(geo, material, cx, h / 2, cz);
  };

  const T = 0.6;
  addWall(0, -ARENA_D / 2 - T / 2, ARENA_W + 2 * T, T, 0.8, wallMat);
  addWall(0, ARENA_D / 2 + T / 2, ARENA_W + 2 * T, T, 0.5, wallMat);
  addWall(-ARENA_W / 2 - T / 2, 0, T, ARENA_D, 0.7, wallMat);
  addWall(ARENA_W / 2 + T / 2, 0, T, ARENA_D, 0.7, wallMat);
  for (const [cx, cz, w, d] of lay.blocks) {
    addWall(cx, cz, w, d, lay.pillars ? 1.6 : 1.0, blockMat, lay.pillars ? 'pillar' : 'box');
  }
  if (lay.obelisk) {
    walls.push({ minX: -0.45, maxX: 0.45, minZ: -0.45, maxZ: 0.45 });
    const stone = new THREE.MeshStandardMaterial({ color: 0xd7ccb7, roughness: 0.9 });
    addMesh(new THREE.BoxGeometry(0.9, 0.3, 0.9), stone, 0, 0.15, 0);
    addMesh(new THREE.CylinderGeometry(0.22, 0.32, 2.6, 4, 1), stone, 0, 1.6, 0);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.35, 4), stone);
    tip.position.y = 3.07;
    tip.castShadow = true;
    arenaGroup.add(tip);
    arenaGroup.children.slice(-2).forEach(m => { m.rotation.y = Math.PI / 4; });
  }
}

// ---------- Kolizje ----------

function collideCircleWalls(p, r) {
  let hit = null;
  for (const w of walls) {
    if (w.r) {
      // okrągła kolumna: wypchnięcie po promieniu
      let dx = p.x - w.cx;
      let dz = p.z - w.cz;
      const rr = r + w.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2);
      if (d > 1e-6) {
        dx /= d;
        dz /= d;
      } else {
        dx = 1;
        dz = 0;
      }
      p.x = w.cx + dx * rr;
      p.z = w.cz + dz * rr;
      hit = { x: dx, z: dz };
      continue;
    }
    const cx = clamp(p.x, w.minX, w.maxX);
    const cz = clamp(p.z, w.minZ, w.maxZ);
    let dx = p.x - cx;
    let dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      dx /= d;
      dz /= d;
      p.x += dx * (r - d);
      p.z += dz * (r - d);
      hit = { x: dx, z: dz };
    } else {
      const l = p.x - w.minX, rr = w.maxX - p.x, t = p.z - w.minZ, b = w.maxZ - p.z;
      const m = Math.min(l, rr, t, b);
      if (m === l) { p.x = w.minX - r; hit = { x: -1, z: 0 }; }
      else if (m === rr) { p.x = w.maxX + r; hit = { x: 1, z: 0 }; }
      else if (m === t) { p.z = w.minZ - r; hit = { x: 0, z: -1 }; }
      else { p.z = w.maxZ + r; hit = { x: 0, z: 1 }; }
    }
  }
  return hit;
}

function pointBlocked(x, z, r) {
  for (const w of walls) {
    if (w.r) {
      const dx = x - w.cx, dz = z - w.cz, rr = r + w.r;
      if (dx * dx + dz * dz < rr * rr) return true;
      continue;
    }
    const dx = x - clamp(x, w.minX, w.maxX);
    const dz = z - clamp(z, w.minZ, w.maxZ);
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

function lineOfSight(ax, az, bx, bz) {
  const d = Math.hypot(bx - ax, bz - az);
  const steps = Math.ceil(d / 0.3);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (pointBlocked(ax + (bx - ax) * t, az + (bz - az) * t, 0.2)) return false;
  }
  return true;
}

// ---------- Cząsteczki ----------

const P_MAX = 900;
const pMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 0.6 }), P_MAX);
pMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
pMesh.setColorAt(0, new THREE.Color());
pMesh.count = 0;
pMesh.frustumCulled = false;
scene.add(pMesh);
let parts = [];
const dummy = new THREE.Object3D();
const pColor = new THREE.Color();

function emitLocal(x, y, z, n, colors, { speed = 4, size = 0.08, life = 1, up = 3, gravity = 14, dir = null } = {}) {
  for (let i = 0; i < n && parts.length < P_MAX; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.3 + Math.random() * 0.7);
    let vx = Math.cos(a) * s;
    let vz = Math.sin(a) * s;
    if (dir) {
      vx += dir.x * speed * 0.8;
      vz += dir.z * speed * 0.8;
    }
    const l = life * (0.6 + Math.random() * 0.4);
    parts.push({
      x, y, z, vx, vz, vy: up * (0.4 + Math.random() * 0.8), life: l, max: l,
      size: size * (0.6 + Math.random() * 0.8), color: pick(colors), g: gravity,
    });
  }
}

// Pojedyncze cząsteczki (smugi) każdy klient robi sam; większe wybuchy rozsyła host
function emit(x, y, z, n, colors, opts) {
  emitLocal(x, y, z, n, colors, opts);
  if (n >= 4 && net.role === 'host') netSend({ t: 'emit', a: [r2(x), r2(y), r2(z), n, colors, opts] });
}

function updateParticles(dt) {
  let n = 0;
  for (let i = 0; i < parts.length;) {
    const p = parts[i];
    // wygasłe usuwamy w miejscu (zamiana z ostatnią), bez nowej tablicy co klatkę
    if ((p.life -= dt) <= 0) {
      parts[i] = parts[parts.length - 1];
      parts.pop();
      continue;
    }
    i++;
    p.vy -= p.g * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    if (p.y < p.size && p.g > 0) {
      p.y = p.size;
      p.vy *= -0.3;
      p.vx *= 0.6;
      p.vz *= 0.6;
    }
    dummy.position.set(p.x, p.y, p.z);
    dummy.scale.setScalar(p.size * Math.min(1, (p.life / p.max) * 3));
    dummy.rotation.set(p.x * 3, p.z * 3, 0);
    dummy.updateMatrix();
    pMesh.setMatrixAt(n, dummy.matrix);
    pMesh.setColorAt(n, pColor.set(p.color));
    n++;
  }
  pMesh.count = n;
  pMesh.instanceMatrix.needsUpdate = true;
  if (pMesh.instanceColor) pMesh.instanceColor.needsUpdate = true;
}

// ---------- Wejście ----------

const keys = new Set();
const KEYS = {
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  attack: ['Space', 'Enter'], dash: ['ShiftLeft', 'ShiftRight'],
};

window.addEventListener('keydown', e => {
  keys.add(e.code);
  if (state !== 'menu' && !e.target.closest?.('select')) e.preventDefault();
  // Ściąga sterowania: H lub ?, Esc zamyka (zamiast pauzy)
  const typing = e.target.closest?.('input, select, textarea');
  if (!typing && !e.repeat && (e.code === 'KeyH' || e.key === '?')) { toggleHelp(); return; }
  // T: taniec (/dance) w menu i w lobby
  if (!typing && !e.repeat && e.code === 'KeyT' && state === 'menu') { toggleDance(); return; }
  // M: wyciszenie dźwięku, na każdym ekranie
  if (!typing && !e.repeat && e.code === 'KeyM') {
    setMuted(!getSound().muted);
    renderSound();
    return;
  }
  if (e.code === 'Escape' && !helpEl.hidden) { toggleHelp(false); return; }
  const inGame = state === 'play' || state === 'countdown' || state === 'roundOver' || state === 'roundResult';
  // gość nie pauzuje: Esc pyta, czy się rozłączyć (przy pauzie hosta opcja jest już na ekranie)
  if (e.code === 'Escape' && net.role === 'client') {
    if (!clientEscEl.hidden) clientEscEl.hidden = true;
    else if (inGame && pauseEl.hidden) {
      clientEscEl.hidden = false;
      keys.clear();
    }
    return;
  }
  if (e.code === 'Escape' && inGame) togglePause();
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function parseCtrl(v) {
  if (v === 'me') return { kind: 'me', tag: myNick() };
  if (v.startsWith('net')) {
    const id = Number(v.slice(3));
    return { kind: 'net', id, tag: peers.get(id)?.name || 'NET' };
  }
  return { kind: 'bot', tag: 'BOT' };
}

// Myszka: celowanie kursorem, LPM atak, PPM zryw
const mouse = { x: 0, y: 0, active: false, down: false, right: false };
const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(UP, -0.5);
const aimHit = new THREE.Vector3();
const canvas = renderer.domElement;
canvas.addEventListener('pointermove', e => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  mouse.active = true;
});
canvas.addEventListener('pointerdown', e => {
  if (e.button === 0) mouse.down = true;
  if (e.button === 2) mouse.right = true;
  mouse.active = true;
});
window.addEventListener('pointerup', e => {
  if (e.button === 0) mouse.down = false;
  if (e.button === 2) mouse.right = false;
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
window.addEventListener('blur', () => { mouse.down = mouse.right = false; });

// Kierunek od postaci do kursora (pełne 360°). Po pierwszym ruchu myszką
// celuje ona zawsze; bez myszki zostaje celowanie kierunkiem klawiszy.
function mouseAim(f) {
  if (!f || !mouse.active) return null;
  raycaster.setFromCamera(mouse, camera);
  if (!raycaster.ray.intersectPlane(aimPlane, aimHit)) return null;
  const dx = aimHit.x - f.x, dz = aimHit.z - f.z;
  return Math.hypot(dx, dz) < 0.2 ? null : [dx, dz];
}

// Jedyny gracz na tym urządzeniu: klawiatura i myszka działają naraz
function readLocal(f) {
  const any = arr => arr.some(k => keys.has(k));
  const inp = {
    mx: (any(KEYS.right) ? 1 : 0) - (any(KEYS.left) ? 1 : 0),
    mz: (any(KEYS.down) ? 1 : 0) - (any(KEYS.up) ? 1 : 0),
    attack: any(KEYS.attack) || mouse.down,
    dash: any(KEYS.dash) || mouse.right,
    dance: keys.has('KeyT'),
    digital: true,
  };
  const aim = mouseAim(f);
  if (aim) [inp.aimX, inp.aimZ] = aim;
  return inp;
}

// ---------- Postacie (wojownicy) ----------

function makeLabel(text, color) {
  const c = document.createElement('canvas');
  c.width = 192;
  c.height = 64;
  const g = c.getContext('2d');
  let size = 40;
  g.font = `bold ${size}px system-ui, sans-serif`;
  while (g.measureText(text).width > 176 && size > 18) {
    size -= 2;
    g.font = `bold ${size}px system-ui, sans-serif`;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.strokeText(text, 96, 34);
  g.fillStyle = css(color);
  g.fillText(text, 96, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(1.35, 0.45, 1);
  s.renderOrder = 10;
  return s;
}

function makeArrow(color) {
  const g = new THREE.Group();
  // mały, zwarty wskaźnik tuż przed postacią (jak w oryginale), lekko rośnie z ładowaniem
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
  const shaft = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 1), m);
  shaft.rotation.x = Math.PI / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-0.16, 0);
  shape.lineTo(0.16, 0);
  shape.lineTo(0, 0.26);
  shape.closePath();
  const head = new THREE.Mesh(new THREE.ShapeGeometry(shape), m);
  head.rotation.x = Math.PI / 2;
  g.add(shaft, head);
  g.position.y = 0.05;
  g.userData.setLen = len => {
    shaft.scale.y = len;
    shaft.position.z = 0.5 + len / 2;
    head.position.z = 0.5 + len;
  };
  return g;
}

class Fighter {
  constructor(slot, char, ctrl) {
    this.slot = slot;
    this.char = char;
    this.ctrl = ctrl;
    this.tag = ctrl.tag;
    this.color = SLOT_COLORS[slot];
    this.score = 0;

    this.root = new THREE.Group();
    this.wrap = new THREE.Group();
    this.wrap.rotation.order = 'YXZ';
    this.root.add(this.wrap);
    this.body = char.build();
    this.wrap.add(this.body);

    const footMat = new THREE.MeshStandardMaterial({ color: char.feet, roughness: 0.6 });
    this.feet = [-1, 1].map(s => {
      const ft = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), footMat);
      ft.scale.set(1, 0.6, 1.4);
      ft.position.set(s * 0.18, 0.06, 0.04);
      ft.castShadow = true;
      this.wrap.add(ft);
      return ft;
    });

    this.held = makeBoomerangMesh(char, this.color);
    this.held.scale.setScalar(0.7);
    this.held.position.set(0.5, 0.55, 0);
    this.held.rotation.set(0.3, 0, 1.2);
    this.wrap.add(this.held);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.52, 0.66, 40),
      new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.015;
    this.root.add(this.ring);

    this.arrow = makeArrow(this.color);
    this.root.add(this.arrow);

    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0x8fe3ff, transparent: true, opacity: 0.28, emissive: 0x2a8fbf, emissiveIntensity: 0.6, depthWrite: false }),
    );
    this.shield.position.y = 0.7;
    this.root.add(this.shield);

    this.label = makeLabel(this.tag, this.color);
    this.label.position.y = char.height + 0.35;
    this.root.add(this.label);

    // plakietka aktywnej mocy nad głową (tekstura ustawiana w animateFighter)
    this.powerBadge = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true }));
    this.powerBadge.scale.set(0.42, 0.42, 1);
    this.powerBadge.position.y = char.height + 0.75;
    this.powerBadge.renderOrder = 11;
    this.powerBadge.visible = false;
    this.root.add(this.powerBadge);

    scene.add(this.root);
    this.reset(0, 0);
  }

  reset(x, z) {
    Object.assign(this, {
      x, z, vx: 0, vz: 0, alive: true, hasBoom: true, pressing: false, pressT: 0,
      prevAttack: false, prevDash: false, charging: false, dashT: 0, dashCd: 0,
      meleeT: 0, meleeCd: 0, meleeA: 0, meleePending: false, stunT: 0, roundKills: 0, power: null, walkT: 0, ai: null,
      emote: false, emoteT: 0, prevDance: false,
    });
    if (this.wasDancing) {
      resetDance(this);
      this.wasDancing = false;
    }
    this.facing = Math.atan2(-x, -z);
    this.aimAngle = this.facing;
    if (this.halo) {
      this.wrap.remove(this.halo);
      disposeTree(this.halo);
      this.halo = null;
    }
    this.root.visible = true;
    this.root.position.set(x, 0, z);
    this.wrap.visible = true;
    this.wrap.rotation.set(0, this.facing, 0);
    this.wrap.scale.set(1, 1, 1);
    this.ring.visible = this.label.visible = true;
    this.arrow.visible = this.shield.visible = false;
  }

  get name() {
    return `${this.char.name} (${this.tag})`;
  }

  dispose() {
    scene.remove(this.root);
    disposeTree(this.root);
  }
}

// ---------- Stan gry ----------

let fighters = [];
let boomerangs = [];
let powerups = [];
let fx = [];
let state = 'menu';
let stateT = 0;
let lastCount = 0;
let slowT = 0;
let paused = false;
let roundNo = 0;
let puTimer = 0;
let matchWinner = null;
let idSeq = 0;

// ---------- Bumerangi ----------

// Szybkość i siła bumerangów wybierana przed meczem.
// speed: tempo lotu i powrotu, range: zasięg rzutu, size: pole trafienia
const BOOM_LEVELS = {
  normal: { label: 'Normalne', speed: 1, range: 1, size: 1 },
  insane: { label: 'Wchuj', speed: 4, range: 1.8, size: 1.4 },
};

const TARGETS = [5, 10, 15];

// Ustawienia meczu od hosta (u gościa); nie trafiają do własnych ustawień gościa
let netMatch = { target: 10, boom: 'normal' };

function matchTarget() {
  return net.role === 'client' ? netMatch.target : setup.target;
}

function boomLevel() {
  const k = net.role === 'client' ? netMatch.boom : setup.boom;
  return Object.hasOwn(BOOM_LEVELS, k) ? BOOM_LEVELS[k] : BOOM_LEVELS.normal;
}

function spawnBoomerang(f, a, power, ghost) {
  const big = f.power?.type === 'big';
  const L = boomLevel();
  const b = {
    id: ++idSeq, owner: f, ghost, big, r: (big ? 0.55 : BOOM_R) * L.size,
    x: f.x + Math.sin(a) * 0.6, z: f.z + Math.cos(a) * 0.6,
    dirX: Math.sin(a), dirZ: Math.cos(a), vx: 0, vz: 0,
    v0: (13 + 11 * power) * L.speed, outTime: (0.32 + 0.45 * power) * L.range / L.speed, t: 0, state: 'out',
    speed: 0, backT: 0, dropT: 0, deflected: false, immune: null, immuneT: 0, clashT: 0,
    noclip: false, dead: false, hitSet: new Set(),
  };
  b.mesh = makeBoomerangMesh(f.char, f.color);
  b.mesh.scale.setScalar((big ? 1.8 : 1) * L.size);
  b.mesh.position.set(b.x, 0.55, b.z);
  world.add(b.mesh);
  boomerangs.push(b);
  return b;
}

function throwBoomerang(f, power) {
  f.hasBoom = false;
  const a = f.aimAngle;
  spawnBoomerang(f, a, power, false);
  if (f.power?.type === 'multi') {
    spawnBoomerang(f, a + 0.32, power, true);
    spawnBoomerang(f, a - 0.32, power, true);
  }
  sfx.throw(power);
}

function stepBoomerang(b, dt) {
  if (b.dead) return;
  b.t += dt;
  b.immuneT -= dt;
  b.clashT -= dt;
  const o = b.owner;

  if (b.state === 'drop') {
    b.dropT += dt;
    b.vx *= 0.9;
    b.vz *= 0.9;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    if (b.dropT > 1.5) b.dead = true;
    return;
  }

  if (b.state === 'out') {
    const sp = b.v0 * Math.max(0.12, 1 - b.t / b.outTime);
    b.vx = b.dirX * sp;
    b.vz = b.dirZ * sp;
    if (b.t >= b.outTime) {
      b.state = 'back';
      b.backT = 0;
      b.speed = sp;
    }
  } else {
    b.backT += dt;
    if (!o.alive) {
      b.state = 'drop';
      return;
    }
    const dx = o.x - b.x, dz = o.z - b.z, d = Math.hypot(dx, dz) || 1;
    const S = boomLevel().speed;
    b.speed = Math.min(b.speed + 30 * S * dt, 20 * S);
    const k = 1 - Math.exp(-8 * S * dt);
    b.vx += (dx / d * b.speed - b.vx) * k;
    b.vz += (dz / d * b.speed - b.vz) * k;
    // wracający bumerang po chwili przenika przez ściany, żeby nigdy nie utknął
    if (b.backT > 1.6) b.noclip = true;
  }

  b.x += b.vx * dt;
  b.z += b.vz * dt;

  if (!b.noclip) {
    const n = collideCircleWalls(b, b.r * 0.7);
    if (n) {
      if (b.state === 'out') {
        const dot = b.dirX * n.x + b.dirZ * n.z;
        b.dirX -= 2 * dot * n.x;
        b.dirZ -= 2 * dot * n.z;
        b.state = 'back';
        b.backT = 0;
        b.speed = Math.hypot(b.vx, b.vz) * 0.6;
        b.vx = b.dirX * b.speed;
        b.vz = b.dirZ * b.speed;
      } else {
        const dot = b.vx * n.x + b.vz * n.z;
        if (dot < 0) {
          b.vx -= dot * n.x;
          b.vz -= dot * n.z;
        }
      }
      emit(b.x, 0.5, b.z, 4, [0xffffff, 0xffe082], { speed: 2, size: 0.04, life: 0.3, up: 2 });
      sfx.wall();
    }
  }

  for (const f of fighters) {
    if (!f.alive) continue;
    const dx = f.x - b.x, dz = f.z - b.z, rr = FIGHTER_R + b.r;
    if (dx * dx + dz * dz > rr * rr) continue;
    if (f === o) {
      if (b.state === 'back') {
        b.dead = true;
        if (!b.ghost) {
          f.hasBoom = true;
          // trzymany atak nie daje od razu pełnej siły: ładowanie od nowa
          if (f.pressing) f.pressT = 0;
          sfx.catch();
        }
      } else if (b.deflected && !(b.immune === f && b.immuneT > 0) && !b.hitSet.has(f)) {
        b.hitSet.add(f);
        hitFighter(f, b.immune || o, b.vx, b.vz);
      }
      continue;
    }
    if (b.immune === f && b.immuneT > 0) continue;
    if (b.hitSet.has(f)) continue;
    b.hitSet.add(f);
    const killer = b.deflected && b.immune ? b.immune : o;
    if (!hitFighter(f, killer, b.vx, b.vz)) {
      // tarcza odbija bumerang
      b.state = 'back';
      b.backT = 0;
      b.speed = 6;
      b.vx = -b.vx * 0.5;
      b.vz = -b.vz * 0.5;
    }
  }
}

function updateBoomerangs(dt) {
  for (const b of boomerangs) {
    // więcej kroków przy szybkich bumerangach i niskim FPS, żeby nie przelatywały przez ściany
    const sp = Math.max(Math.hypot(b.vx, b.vz), b.state === 'out' ? b.v0 : b.speed);
    const steps = Math.min(40, Math.max(Math.ceil(2 * boomLevel().speed), Math.ceil(sp * dt / (b.r * 0.5))));
    for (let i = 0; i < steps; i++) stepBoomerang(b, dt / steps);
    b.mesh.position.set(b.x, b.state === 'drop' ? 0.08 : 0.55, b.z);
    if (b.state !== 'drop') {
      b.mesh.rotation.y += dt * 24;
      if (Math.random() < 0.4) emit(b.x, 0.55, b.z, 1, [b.owner.color], { speed: 0.2, size: 0.05, life: 0.25, up: 0, gravity: 0 });
    }
  }

  // zderzenia bumerangów w powietrzu
  for (let i = 0; i < boomerangs.length; i++) {
    for (let j = i + 1; j < boomerangs.length; j++) {
      const a = boomerangs[i], b = boomerangs[j];
      if (a.dead || b.dead || a.state === 'drop' || b.state === 'drop' || a.owner === b.owner) continue;
      if (a.clashT > 0 || b.clashT > 0) continue;
      const dx = a.x - b.x, dz = a.z - b.z, d = Math.hypot(dx, dz);
      if (d > a.r + b.r || d < 1e-4) continue;
      const nx = dx / d, nz = dz / d;
      for (const [bb, s] of [[a, 1], [b, -1]]) {
        Object.assign(bb, { state: 'back', backT: 0, speed: 8, vx: nx * 8 * s, vz: nz * 8 * s, clashT: 0.3 });
      }
      emit((a.x + b.x) / 2, 0.55, (a.z + b.z) / 2, 14, [0xffffff, 0xffd54f], { speed: 5, size: 0.05, life: 0.4, up: 2 });
      sfx.clash();
      shake = Math.max(shake, 0.12);
    }
  }

  boomerangs = boomerangs.filter(b => {
    if (!b.dead) return true;
    world.remove(b.mesh);
    disposeTree(b.mesh);
    return false;
  });
}

// ---------- Walka ----------

const MELEE_TIME = 0.2;   // cały zamach
const MELEE_HIT_AT = 0.13; // trafienie po krótkim zamachu (okno na parowanie)

// Odrzut: nadaje prędkość i na chwilę odbiera kontrolę
function knockback(f, dx, dz, power, stun) {
  const d = Math.hypot(dx, dz) || 1;
  f.vx = dx / d * power;
  f.vz = dz / d * power;
  f.dashT = 0;
  f.stunT = Math.max(f.stunT, stun);
  f.pressing = f.charging = false;
  // ogłuszony nie kończy rozpoczętego zamachu
  f.meleePending = false;
  f.meleeT = 0;
}

// Cięcie trzymanym bumerangiem w kierunku celowania
function doMelee(f) {
  if (f.meleeCd > 0) return;
  f.facing = f.meleeA = f.aimAngle;
  f.meleeCd = 0.4;
  f.meleeT = MELEE_TIME;
  f.meleePending = true;
  sfx.melee();
  const range = meleeRange(f);
  swooshFx(f, range, f.meleeA);
  if (net.role === 'host') netSend({ t: 'swoosh', s: f.slot, r: range, a: r2(f.meleeA) });
}

function meleeRange(f) {
  return 1.45 + (f.power?.type === 'big' ? 0.35 : 0);
}

function resolveMelee(f) {
  const a = f.meleeA;
  const fx = Math.sin(a), fz = Math.cos(a);
  const range = meleeRange(f);
  const inArc = (dx, dz, d) => d < 0.95 || (dx * fx + dz * fz) / d > 0.35;

  for (const o of fighters) {
    if (o === f || !o.alive) continue;
    const dx = o.x - f.x, dz = o.z - f.z, d = Math.hypot(dx, dz) || 1;
    if (d > range || !inArc(dx, dz, d) || !lineOfSight(f.x, f.z, o.x, o.z)) continue;
    // parowanie: obaj tną w tej samej chwili, twarzą w twarz (cios rywala jeszcze nie zszedł)
    if (o.meleePending && Math.cos(o.meleeA - a) < -0.3) {
      o.meleePending = false;
      knockback(f, -dx, -dz, 12, 0.35);
      knockback(o, dx, dz, 12, 0.35);
      sfx.clash();
      emit((f.x + o.x) / 2, 0.6, (f.z + o.z) / 2, 16, [0xffffff, 0xffd54f], { speed: 5, size: 0.05, life: 0.4, up: 2 });
      shake = Math.max(shake, 0.2);
      continue;
    }
    hitFighter(o, f, dx, dz);
  }

  // odbicie lecących bumerangów tam, gdzie celujemy
  for (const b of boomerangs) {
    if (b.dead || b.state === 'drop' || b.owner === f) continue;
    const dx = b.x - f.x, dz = b.z - f.z, d = Math.hypot(dx, dz) || 1;
    if (d > range + 0.3 || !inArc(dx, dz, d) || !lineOfSight(f.x, f.z, b.x, b.z)) continue;
    Object.assign(b, {
      state: 'out', t: 0, v0: 19 * boomLevel().speed, outTime: 0.45 * boomLevel().range / boomLevel().speed, dirX: fx, dirZ: fz,
      deflected: true, immune: f, immuneT: 0.6, noclip: false, hitSet: new Set(),
    });
    emit(b.x, 0.55, b.z, 10, [0xffffff, 0xffd54f], { speed: 4, size: 0.05, life: 0.35, up: 2 });
    sfx.clash();
  }
}

function hitFighter(v, killer, dx, dz) {
  if (!v.alive) return false;
  if (v.power?.type === 'shield') {
    v.power = null;
    sfx.shield();
    emit(v.x, 0.7, v.z, 18, [0x8fe3ff, 0xffffff], { speed: 4, size: 0.06, life: 0.6 });
    knockback(v, dx, dz, 11, 0.35);
    return false;
  }
  killFighter(v, killer, dx, dz);
  return true;
}

// Wygląd śmierci; wywoływany też u graczy sieciowych po zdarzeniu "kill"
function killVisuals(v, dx, dz) {
  v.alive = false;
  v.charging = false;
  v.ring.visible = v.label.visible = v.arrow.visible = v.shield.visible = v.powerBadge.visible = false;
  v.power = null;
  if (v.char.id === 'pope') ascendFighter(v);
  else if (v.char.death === 'bones') bonesFx(v, dx, dz);
  else sliceFighter(v, dx, dz);
  if (v.char.death === 'spikes') spikesFx(v, dx, dz);
  deathExtras(v);
  shake = Math.max(shake, 0.35);
}

function killFighter(v, killer, dx, dz) {
  const d = Math.hypot(dx, dz) || 1;
  dx /= d;
  dz /= d;
  killVisuals(v, dx, dz);
  // punkt za każde zabójstwo
  if (killer && killer !== v) {
    killer.score++;
    killer.roundKills++;
  }
  if (net.role === 'host') netSend({ t: 'kill', s: v.slot, dx: r2(dx), dz: r2(dz) });
  if (v.char.id === 'pope') sfx.choir();
  else sfx.splat();
  if (v.char.death === 'smoke' || v.char.death === 'kebab') sfx.sizzle();
  emit(v.x, 0.6, v.z, 36, v.char.juice, { speed: 5, size: 0.075, life: 1.6, up: 4, dir: { x: dx, z: dz } });
  updateScoreboard();
  checkRoundOver();
}

// Runda kończy się, gdy na arenie zostaje najwyżej jeden żywy (też po wyjściu gracza)
function checkRoundOver() {
  if (state === 'play' && fighters.filter(f => f.alive).length <= 1) {
    state = 'roundOver';
    stateT = 0;
    slowT = 0.7;
  }
}

// Owoc/warzywo rozpada się na dwie połówki (przycinanie płaszczyzną)
function sliceFighter(f, dirX, dirZ) {
  const nW = new THREE.Vector3(-dirZ, 0, dirX);
  const tiltAxis = new THREE.Vector3(dirX, 0, dirZ);
  for (const s of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(f.x, 0, f.z);
    pivot.rotation.y = f.wrap.rotation.y;
    const clone = f.body.clone(true);
    pivot.add(clone);
    const localPlane = new THREE.Plane(nW.clone().applyAxisAngle(UP, -pivot.rotation.y).multiplyScalar(s), 0);
    const worldPlane = new THREE.Plane();
    clone.traverse(o => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.clippingPlanes = [worldPlane];
      o.material.clipShadows = true;
      o.material.side = THREE.DoubleSide;
    });
    world.add(pivot);
    const vel = new THREE.Vector3(nW.x * s * 2.2 + dirX * 1.5, 3.5, nW.z * s * 2.2 + dirZ * 1.5);
    let tilt = 0;
    const tick = dt => {
      vel.y -= 14 * dt;
      pivot.position.addScaledVector(vel, dt);
      if (pivot.position.y < 0) {
        pivot.position.y = 0;
        vel.y = Math.abs(vel.y) > 2 ? -vel.y * 0.3 : 0;
        vel.x *= 0.7;
        vel.z *= 0.7;
      }
      if (tilt < 1.45) {
        const step = Math.min(1.45 - tilt, dt * 5);
        tilt += step;
        pivot.rotateOnWorldAxis(tiltAxis, s * step);
      }
      pivot.updateMatrixWorld(true);
      worldPlane.copy(localPlane).applyMatrix4(pivot.matrixWorld);
    };
    tick(0);
    fx.push({
      update(dt) { tick(dt); return true; },
      // geometria jest wspólna z ciałem postaci, zwalniamy tylko sklonowane materiały
      remove() {
        world.remove(pivot);
        disposeTree(pivot, false);
      },
    });
  }
  f.wrap.visible = false;
}

// Efekty śmierci zależne od postaci; lokalne, bo killVisuals działa u każdego gracza
function deathExtras(v) {
  const d = v.char.death;
  if (d === 'sprinkles') {
    emitLocal(v.x, 0.8, v.z, 60, [0xf48fb1, 0xffeb3b, 0x4fc3f7, 0x81c784, 0xffffff], { speed: 7, size: 0.05, life: 1.8, up: 7 });
  } else if (d === 'smoke') {
    emitLocal(v.x, 0.8, v.z, 25, [0x9e9e9e, 0xbdbdbd, 0x757575], { speed: 0.8, size: 0.18, life: 1.6, up: 1.5, gravity: -1.2 });
  } else if (d === 'tears') {
    for (const o of fighters) {
      if (o !== v && o.alive && Math.hypot(o.x - v.x, o.z - v.z) < 4) cryFx(o);
    }
  } else if (d === 'pierogi') {
    // farsz ruskich ze skwarkami
    emitLocal(v.x, 0.4, v.z, 30, [0xf5f0dc, 0xefe6c8, 0xd9a441], { speed: 4, size: 0.06, life: 1.4, up: 4 });
  } else if (d === 'kebab') {
    emitLocal(v.x, 0.9, v.z, 40, [0x8bc34a, 0xe53935, 0xfaf8f0, 0x7b4a24, 0x7b1fa2], { speed: 5, size: 0.07, life: 1.6, up: 5 });
    puddleFx(v, 0xfaf8f0);
  }
}

// Kebab: plama sosu zostaje na ziemi do końca rundy
function puddleFx(f, color) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(0.45, 9), new THREE.MeshStandardMaterial({ color, roughness: 0.2 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(f.x + rand(-0.2, 0.2), 0.012, f.z + rand(-0.2, 0.2));
  m.scale.setScalar(0.01);
  world.add(m);
  let t = 0;
  fx.push({
    update(dt) {
      t += dt;
      m.scale.setScalar(Math.min(1, t * 3));
      return true;
    },
    remove() {
      world.remove(m);
      disposeTree(m);
    },
  });
}

// Cebula: postacie w pobliżu przez chwilę płaczą
function cryFx(o) {
  let t = 0;
  fx.push({
    update(dt) {
      t += dt;
      if (Math.random() < 0.6) {
        const s = Math.random() < 0.5 ? -1 : 1;
        const rx = Math.cos(o.facing), rz = -Math.sin(o.facing);
        const fwx = Math.sin(o.facing), fwz = Math.cos(o.facing);
        emitLocal(o.x + rx * s * 0.13 + fwx * 0.35, o.char.height * 0.5, o.z + rz * s * 0.13 + fwz * 0.35, 1,
          [0x4fc3f7, 0x81d4fa], { speed: 0.6, size: 0.045, life: 0.6, up: 1.5 });
      }
      return t < 2.2 && o.alive;
    },
    remove() {},
  });
}

// Kurczak: zamiast połówek zostają same kostki
function bonesFx(f, dx, dz) {
  f.wrap.visible = false;
  const boneMat = new THREE.MeshStandardMaterial({ color: 0xf5f0e1, roughness: 0.6 });
  scatterFx(f, dx, dz, 5, () => {
    const bone = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.32, 8), boneMat);
    shaft.rotation.z = Math.PI / 2;
    bone.add(shaft);
    for (const s of [-1, 1]) {
      for (const k of [-1, 1]) {
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), boneMat);
        knob.position.set(s * 0.17, 0, k * 0.03);
        bone.add(knob);
      }
    }
    return bone;
  });
}

// Sanic: oprócz pokrojenia rozsypuje niebieskie kolce
function spikesFx(f, dx, dz) {
  const blue = new THREE.MeshStandardMaterial({ color: 0x1e5bd6, roughness: 0.5, flatShading: true });
  scatterFx(f, dx, dz, 5, () => {
    const s = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.45, 5), blue);
    s.rotation.z = Math.PI / 2;
    const g = new THREE.Group();
    g.add(s);
    return g;
  });
}

// Wspólna fizyka rozrzucanych kawałków: wylatują, spadają i zostają na ziemi
function scatterFx(f, dx, dz, count, makePiece) {
  const group = new THREE.Group();
  group.position.set(f.x, 0, f.z);
  world.add(group);
  const pieces = [];
  for (let i = 0; i < count; i++) {
    const bone = makePiece(i);
    bone.traverse(o => { o.castShadow = true; });
    bone.position.set(rand(-0.2, 0.2), 0.6 + i * 0.05, rand(-0.2, 0.2));
    bone.rotation.y = rand(0, Math.PI * 2);
    group.add(bone);
    pieces.push({ bone, vx: rand(-2, 2) + dx * 1.5, vy: rand(2, 4.5), vz: rand(-2, 2) + dz * 1.5, spin: rand(-8, 8) });
  }
  fx.push({
    update(dt) {
      for (const p of pieces) {
        if (p.vy === 0 && p.bone.position.y <= 0.05) continue;
        p.vy -= 14 * dt;
        p.bone.position.x += p.vx * dt;
        p.bone.position.y += p.vy * dt;
        p.bone.position.z += p.vz * dt;
        p.bone.rotation.x += p.spin * dt;
        if (p.bone.position.y < 0.05) {
          p.bone.position.y = 0.05;
          p.bone.rotation.x = 0;
          p.vx = p.vy = p.vz = 0;
        }
      }
      return true;
    },
    remove() {
      world.remove(group);
      disposeTree(group);
    },
  });
}

// Papież nie daje się pokroić: wniebowstępuje w snopie światła
function ascendFighter(f) {
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.25, 0.035, 10, 32),
    new THREE.MeshStandardMaterial({ color: 0xffd54f, emissive: 0xffc107, emissiveIntensity: 0.9, metalness: 0.5, roughness: 0.3 }),
  );
  halo.rotation.x = Math.PI / 2;
  halo.position.y = f.char.height + 0.1;
  f.wrap.add(halo);
  f.halo = halo;
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xfff3b0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 7, 24, 1, true), beamMat);
  beam.position.set(f.x, 3.5, f.z);
  world.add(beam);
  let t = 0;
  fx.push({
    update(dt) {
      t += dt;
      f.root.position.y = Math.max(0, t - 0.3) ** 2 * 1.6;
      f.wrap.rotation.y += dt * (1 + t * 2);
      beamMat.opacity = t < 2.5 ? Math.min(0.3, t * 0.5) : Math.max(0, 0.3 - (t - 2.5) * 0.4);
      if (Math.random() < 0.5) emit(f.x + rand(-0.6, 0.6), f.root.position.y + rand(0, 1.5), f.z + rand(-0.6, 0.6), 1, [0xfff3b0, 0xffd54f], { speed: 0.3, size: 0.05, life: 0.8, up: 1, gravity: -1 });
      if (t > 4) f.root.visible = false;
      return t < 5;
    },
    remove() {
      world.remove(beam);
      disposeTree(beam);
    },
  });
}

// Łuk cięcia przed postacią
function swooshFx(f, range, a) {
  const g = new THREE.Group();
  g.rotation.y = a;
  const m = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 1, 32, 1, -Math.PI / 2 - 1.2, 2.4),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }),
  );
  m.rotation.x = -Math.PI / 2;
  g.add(m);
  world.add(g);
  let t = 0;
  fx.push({
    update(dt) {
      t += dt;
      const k = t / 0.24;
      g.position.set(f.x, 0.45, f.z);
      g.scale.setScalar(range * (0.75 + 0.25 * k));
      m.material.opacity = 0.75 * (1 - k);
      return k < 1;
    },
    remove() {
      world.remove(g);
      disposeTree(g);
    },
  });
}

// ---------- Ruch wojownika ----------

function updateFighter(f, inp, dt) {
  f.dashCd -= dt;
  f.meleeCd -= dt;
  f.meleeT -= dt;
  f.stunT -= dt;
  if (f.power && (f.power.t -= dt) <= 0) f.power = null;
  if (f.meleePending && f.meleeT <= MELEE_HIT_AT) {
    f.meleePending = false;
    resolveMelee(f);
  }
  if (f.stunT > 0) inp = { mx: 0, mz: 0, attack: false, dash: false };

  // taniec (T): postać stoi w miejscu; ruch, atak albo zryw go przerywają
  if (inp.dance && !f.prevDance && f.dashT <= 0) {
    f.emote = !f.emote;
    f.emoteT = 0;
  }
  f.prevDance = !!inp.dance;
  if (f.emote) {
    if (Math.hypot(inp.mx, inp.mz) > 0.2 || inp.attack || inp.dash) f.emote = false;
    else inp = { ...inp, mx: 0, mz: 0 };
  }

  let mx = inp.mx, mz = inp.mz, ml = Math.hypot(mx, mz);
  if (ml > 1) {
    mx /= ml;
    mz /= ml;
    ml = 1;
  }
  const moveA = ml > 0.2 ? Math.atan2(mx, mz) : null;
  if (inp.aimX !== undefined) {
    f.aimAngle = Math.atan2(inp.aimX, inp.aimZ);
  } else if (moveA !== null) {
    // klawiatura zna tylko 8 kierunków, więc przy ładowaniu rzutu celownik
    // obraca się płynnie i zostaje pod dowolnym kątem po puszczeniu klawiszy
    f.aimAngle = inp.digital && f.charging ? rotateToward(f.aimAngle, moveA, 4.5 * dt) : moveA;
  }

  if (inp.attack && !f.prevAttack) {
    f.pressing = true;
    f.pressT = 0;
    // atak bez bumerangu w ręce przywołuje go z powrotem
    if (!f.hasBoom) {
      for (const b of boomerangs) {
        if (b.owner === f && b.state === 'out' && !b.deflected) {
          b.state = 'back';
          b.backT = 0;
          b.speed = Math.hypot(b.vx, b.vz);
        }
      }
    }
  }
  if (f.pressing) f.pressT += dt;
  if (!inp.attack && f.prevAttack && f.pressing) {
    f.pressing = false;
    if (f.hasBoom) {
      if (f.pressT <= TAP_TIME) doMelee(f);
      else throwBoomerang(f, clamp((f.pressT - TAP_TIME) / MAX_CHARGE, 0, 1));
    }
  }
  f.prevAttack = inp.attack;
  f.charging = f.pressing && f.hasBoom && f.pressT > TAP_TIME;

  if (inp.dash && !f.prevDash && f.dashCd <= 0 && f.dashT <= 0 && !f.charging) {
    const a = moveA ?? f.facing;
    f.dashT = 0.16;
    f.dashCd = 0.8;
    f.vx = Math.sin(a) * 19;
    f.vz = Math.cos(a) * 19;
    f.facing = a;
    sfx.dash();
    emit(f.x, 0.1, f.z, 8, [0xffffff, 0xe0e0e0], { speed: 2, size: 0.1, life: 0.4, up: 1 });
  }
  f.prevDash = inp.dash;

  if (f.dashT > 0) {
    f.dashT -= dt;
    if (Math.random() < 0.7) emit(f.x, 0.15, f.z, 1, [0xffffff, 0xdddddd], { speed: 0.6, size: 0.1, life: 0.35, up: 0.5, gravity: 0 });
  } else {
    const sp = MOVE_SPEED * (f.char.speed || 1) * (f.power?.type === 'turbo' ? 1.45 : 1) * (f.charging ? 0.35 : 1);
    const k = 1 - Math.exp(-(f.stunT > 0 ? 4 : 14) * dt);
    f.vx += (mx * sp - f.vx) * k;
    f.vz += (mz * sp - f.vz) * k;
  }
  // ruch w krokach co najwyżej 0,2 jednostki, żeby zryw przy niskim FPS nie przenikał przez ściany
  const moveSteps = Math.min(20, Math.max(1, Math.ceil(Math.hypot(f.vx, f.vz) * dt / 0.2)));
  for (let i = 0; i < moveSteps; i++) {
    f.x += f.vx * dt / moveSteps;
    f.z += f.vz * dt / moveSteps;
    const n = collideCircleWalls(f, FIGHTER_R);
    if (n) {
      const dot = f.vx * n.x + f.vz * n.z;
      if (dot < 0) {
        f.vx -= dot * n.x;
        f.vz -= dot * n.z;
      }
    }
  }

  // z myszką postać zawsze patrzy na kursor; bez niej w stronę ruchu
  const want = f.charging || (inp.aimX !== undefined && f.ctrl.kind !== 'bot') ? f.aimAngle : (moveA ?? f.facing);
  if (f.dashT <= 0) f.facing = lerpAngle(f.facing, want, 1 - Math.exp(-16 * dt));
  if (f.power?.type === 'turbo' && ml > 0.2 && Math.random() < 0.3) {
    emit(f.x, 0.2, f.z, 1, [0x66bb6a, 0xc5e1a5], { speed: 0.3, size: 0.06, life: 0.4, up: 0.5, gravity: 0 });
  }
}

function separateFighters() {
  for (let i = 0; i < fighters.length; i++) {
    const a = fighters[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < fighters.length; j++) {
      const b = fighters[j];
      if (!b.alive) continue;
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d >= FIGHTER_R * 2 || d < 1e-4) continue;
      // zryw w przeciwnika odpycha go i ogłusza
      const dasher = a.dashT > 0 && b.dashT <= 0 ? a : b.dashT > 0 && a.dashT <= 0 ? b : null;
      if (dasher) {
        const other = dasher === a ? b : a;
        knockback(other, other.x - dasher.x, other.z - dasher.z, 13, 0.4);
        dasher.dashT = 0;
        dasher.vx *= 0.2;
        dasher.vz *= 0.2;
        sfx.bump();
        emit(other.x, 0.5, other.z, 8, [0xffffff, 0xffe082], { speed: 3, size: 0.06, life: 0.4, up: 2 });
        shake = Math.max(shake, 0.15);
      }
      const push = (FIGHTER_R * 2 - d) / 2;
      a.x -= dx / d * push;
      a.z -= dz / d * push;
      b.x += dx / d * push;
      b.z += dz / d * push;
    }
  }
}

function animateFighter(f, dt, time) {
  if (state === 'menu') {
    if (f.dancing) {
      const t = time - f.danceStart;
      if (t < danceLength(f)) {
        applyDance(f, t);
        f.wasDancing = true;
        return;
      }
      f.dancing = false; // taniec odegrany raz, bez zapętlania
    }
    if (f.wasDancing) {
      resetDance(f);
      f.wasDancing = false;
    }
    f.wrap.rotation.y = Math.sin(time * 0.8 + f.slot) * 0.5;
    f.body.position.y = Math.abs(Math.sin(time * 3 + f.slot)) * 0.06;
    return;
  }
  if (!f.alive) return;
  f.root.position.set(f.x, 0, f.z);
  updatePowerBadge(f, time);
  // taniec w trakcie gry (T) i taniec zwycięzcy
  if (f.emote && f.emoteT + dt >= danceLength(f)) f.emote = false; // jeden taniec, bez zapętlania
  if (f.emote) {
    f.emoteT += dt;
    applyDance(f, f.emoteT);
    f.wasDancing = true;
    f.held.visible = f.hasBoom;
    f.arrow.visible = false;
    f.shield.visible = f.power?.type === 'shield';
    return;
  }
  if (f.wasDancing) {
    resetDance(f);
    f.wasDancing = false;
  }
  const sp = Math.hypot(f.vx, f.vz);
  const moving = clamp(sp / 4, 0, 1);
  f.walkT += dt * (4 + sp * 2.2);
  f.body.position.y = Math.abs(Math.sin(f.walkT)) * 0.09 * moving;
  f.feet[0].position.z = 0.04 + Math.sin(f.walkT) * 0.14 * moving;
  f.feet[1].position.z = 0.04 - Math.sin(f.walkT) * 0.14 * moving;

  // zamach: najpierw odchylenie, potem szybkie cięcie przez łuk
  let swing = 0;
  if (f.meleeT > 0) {
    const p = 1 - f.meleeT / MELEE_TIME;
    swing = p < 0.35 ? 0.9 * (p / 0.35) : 0.9 - 2.2 * Math.min(1, (p - 0.35) / 0.35);
  }
  f.wrap.rotation.y = f.facing + swing;
  f.wrap.rotation.x = f.dashT > 0 ? 0.35 : 0;
  f.wrap.rotation.z = f.stunT > 0 ? Math.sin(time * 30) * 0.15 : 0;

  const charge = f.charging ? clamp((f.pressT - TAP_TIME) / MAX_CHARGE, 0, 1) : 0;
  const sq = 1 - charge * 0.12;
  f.wrap.scale.set(1 + (1 - sq) * 0.5, sq, 1 + (1 - sq) * 0.5);

  f.held.visible = f.hasBoom;
  f.arrow.visible = f.charging;
  if (f.charging) {
    f.arrow.rotation.y = f.aimAngle;
    f.arrow.userData.setLen(0.2 + charge * 0.5);
  }
  f.shield.visible = f.power?.type === 'shield';
  if (f.shield.visible) f.shield.scale.setScalar(1 + Math.sin(time * 6) * 0.04);
}

// ---------- Boty ----------

const BOT_LEVELS = {
  easy: { label: 'Łatwe', react: 0.5, aimErr: 0.35, dodge: 0.1, aggro: 0.45 },
  normal: { label: 'Normalne', react: 0.28, aimErr: 0.17, dodge: 0.35, aggro: 0.7 },
  hard: { label: 'Trudne', react: 0.14, aimErr: 0.06, dodge: 0.7, aggro: 0.95 },
};

function steer(f, gx, gz) {
  const a = Math.atan2(gx - f.x, gz - f.z);
  for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4]) {
    const aa = a + off;
    if (!pointBlocked(f.x + Math.sin(aa) * 1.1, f.z + Math.cos(aa) * 1.1, FIGHTER_R)) return [Math.sin(aa), Math.cos(aa)];
  }
  return [Math.sin(a), Math.cos(a)];
}

function botInput(f, dt) {
  const L = BOT_LEVELS[setup.bot] || BOT_LEVELS.normal;
  const ai = f.ai || (f.ai = { think: rand(0.2, 0.6), mx: 0, mz: 0, hold: 0, err: 0, target: null, dodgeCd: 0, side: Math.random() < 0.5 ? -1 : 1, meleeA: null });
  ai.think -= dt;
  ai.dodgeCd -= dt;
  const inp = { mx: ai.mx, mz: ai.mz, attack: false, dash: false };
  // cios wychodzi przy puszczeniu, więc kąt z błędem celowania trzymamy i na tę klatkę
  if (ai.meleeA !== null) {
    inp.aimX = Math.sin(ai.meleeA);
    inp.aimZ = Math.cos(ai.meleeA);
    ai.meleeA = null;
  }
  const t = ai.target?.alive ? ai.target : null;

  // trwa ładowanie rzutu: celuj z wyprzedzeniem
  if (ai.hold > 0) {
    ai.hold -= dt;
    if (!f.hasBoom) ai.hold = 0;
    inp.attack = ai.hold > 0;
    if (t) {
      const lead = Math.hypot(t.x - f.x, t.z - f.z) / (16 * boomLevel().speed);
      const a = Math.atan2(t.x + t.vx * lead - f.x, t.z + t.vz * lead - f.z) + ai.err;
      inp.aimX = Math.sin(a);
      inp.aimZ = Math.cos(a);
    }
    return inp;
  }

  // unik przed nadlatującym bumerangiem
  if (ai.dodgeCd <= 0 && f.dashCd <= 0) {
    for (const b of boomerangs) {
      // własny bumerang wracający do ręki nie jest groźny (zostanie złapany)
      if (b.dead || b.state === 'drop' || (b.owner === f && (!b.deflected || b.state === 'back'))) continue;
      const rx = f.x - b.x, rz = f.z - b.z, d = Math.hypot(rx, rz);
      if (d > 3.2 || d < 0.01) continue;
      if ((b.vx * rx + b.vz * rz) / d < 5) continue;
      ai.dodgeCd = 0.5;
      if (Math.random() < L.dodge) {
        const vl = Math.hypot(b.vx, b.vz) || 1;
        let px = -b.vz / vl, pz = b.vx / vl;
        if (px * rx + pz * rz < 0) { px = -px; pz = -pz; }
        if (pointBlocked(f.x + px * 1.5, f.z + pz * 1.5, FIGHTER_R)) { px = -px; pz = -pz; }
        inp.mx = px;
        inp.mz = pz;
        inp.dash = true;
        return inp;
      }
      break;
    }
  }

  if (ai.think > 0) return inp;
  ai.think = L.react * rand(0.7, 1.3);

  let best = null, bd = Infinity;
  for (const o of fighters) {
    if (o === f || !o.alive) continue;
    const d = Math.hypot(o.x - f.x, o.z - f.z);
    if (d < bd) { bd = d; best = o; }
  }
  ai.target = best;
  if (!best) {
    ai.mx = ai.mz = inp.mx = inp.mz = 0;
    return inp;
  }

  let gx = best.x, gz = best.z;
  if (f.hasBoom) {
    if (bd < 1.6 && f.meleeCd <= 0 && Math.random() < L.aggro + 0.25) {
      inp.attack = true; // krótkie stuknięcie = cięcie w stronę celu
      const a = Math.atan2(best.x - f.x, best.z - f.z) + rand(-1, 1) * L.aimErr;
      inp.aimX = Math.sin(a);
      inp.aimZ = Math.cos(a);
      ai.meleeA = a;
    } else if (bd < 11 && Math.random() < L.aggro && lineOfSight(f.x, f.z, best.x, best.z)) {
      ai.hold = TAP_TIME + 0.08 + clamp((bd - 2) / 9, 0, 1) * MAX_CHARGE;
      ai.err = rand(-1, 1) * L.aimErr;
      inp.attack = true;
    }
  } else {
    // bez bumerangu: trzymaj dystans, krążąc wokół przeciwnika
    const a = Math.atan2(f.x - best.x, f.z - best.z) + ai.side * 0.9;
    gx = f.x + Math.sin(a) * 3;
    gz = f.z + Math.cos(a) * 3;
    if (Math.random() < 0.1) ai.side *= -1;
  }
  if (!f.power) {
    for (const p of powerups) {
      if (Math.hypot(p.x - f.x, p.z - f.z) < 5) { gx = p.x; gz = p.z; break; }
    }
  }
  const dist = Math.hypot(gx - f.x, gz - f.z);
  const [sx, sz] = steer(f, gx, gz);
  ai.mx = inp.mx = dist > 0.4 ? sx : 0;
  ai.mz = inp.mz = dist > 0.4 ? sz : 0;
  return inp;
}

// ---------- Power-upy ----------

const POWER_TYPES = {
  multi: { name: 'Potrójny rzut', label: 'x3', color: 0xff7043, time: 10 },
  shield: { name: 'Tarcza', label: '+', color: 0x29b6f6, time: Infinity },
  turbo: { name: 'Turbo', label: '>>', color: 0x66bb6a, time: 8 },
  big: { name: 'Wielki bumerang', label: 'XL', color: 0xab47bc, time: 10 },
};

// Plakietka mocy nad głową; miga, gdy zostały ostatnie 2 sekundy
function updatePowerBadge(f, time) {
  const p = f.power;
  const b = f.powerBadge;
  if (!p || !POWER_TYPES[p.type]) {
    b.visible = false;
    return;
  }
  const map = powerMaterial(p.type).map;
  if (b.material.map !== map) {
    b.material.map = map;
    b.material.needsUpdate = true;
  }
  const ending = p.t >= 0 && p.t < 2; // t = -1 lub Infinity: tarcza bez limitu
  b.visible = !ending || Math.sin(time * 18) > 0;
  b.position.y = f.char.height + 0.75 + Math.sin(time * 4) * 0.04;
}

// Moc i pozostały czas na karcie gracza u góry ekranu
function updatePowerHud() {
  for (const f of fighters) {
    const el = scoresEl.querySelector(`[data-slot="${f.slot}"] .pw`);
    if (!el) continue;
    const def = f.alive && f.power && POWER_TYPES[f.power.type];
    el.hidden = !def;
    if (!def) continue;
    el.style.setProperty('--pc', css(def.color));
    el.textContent = `${def.label} ${def.name}` + (Number.isFinite(f.power.t) && f.power.t >= 0 ? ` · ${Math.ceil(f.power.t)} s` : '');
  }
}

const powerMats = {};
function powerMaterial(type) {
  if (powerMats[type]) return powerMats[type];
  const def = POWER_TYPES[type];
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = css(def.color);
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.lineWidth = 10;
  g.strokeRect(8, 8, 112, 112);
  g.fillStyle = '#fff';
  g.font = 'bold 62px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(def.label, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  powerMats[type] = new THREE.MeshStandardMaterial({ map: tex, emissive: def.color, emissiveIntensity: 0.25, roughness: 0.4 });
  return powerMats[type];
}

function spawnPowerup() {
  for (let i = 0; i < 30; i++) {
    const x = rand(-9, 9), z = rand(-6, 6);
    if (pointBlocked(x, z, 0.8)) continue;
    if (fighters.some(f => f.alive && Math.hypot(f.x - x, f.z - z) < 2.5)) continue;
    const type = pick(Object.keys(POWER_TYPES));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), powerMaterial(type));
    mesh.castShadow = true;
    mesh.position.set(x, 0.7, z);
    world.add(mesh);
    powerups.push({ id: ++idSeq, type, x, z, t: 0, mesh });
    return;
  }
}

function updatePowerups(dt) {
  puTimer -= dt;
  if (puTimer <= 0) {
    if (powerups.length < 2) spawnPowerup();
    puTimer = rand(5, 9);
  }
  powerups = powerups.filter(p => {
    p.t += dt;
    p.mesh.position.y = 0.7 + Math.sin(p.t * 3) * 0.12;
    p.mesh.rotation.y += dt * 1.5;
    p.mesh.rotation.x = 0.4;
    p.mesh.scale.setScalar(Math.min(1, p.t * 3));
    const f = fighters.find(o => o.alive && Math.hypot(o.x - p.x, o.z - p.z) < 0.95);
    if (!f) return true;
    const def = POWER_TYPES[p.type];
    f.power = { type: p.type, t: def.time };
    sfx.power();
    emit(p.x, 0.7, p.z, 16, [def.color, 0xffffff], { speed: 3, size: 0.06, life: 0.6 });
    world.remove(p.mesh);
    disposeTree(p.mesh);
    return false;
  });
}

// ---------- UI ----------

const $ = id => document.getElementById(id);
const menuEl = $('menu'), startEl = $('start'), onlineEl = $('online'), hudEl = $('hud'), scoresEl = $('scores'), centerEl = $('center');
const pauseEl = $('pause'), endEl = $('end'), boardEl = $('board');
const clientEscEl = $('clientEsc');
const helpEl = $('help');

function toggleHelp(show = helpEl.hidden) {
  helpEl.hidden = !show;
}

// Dźwięk: głośnik w rogu (wycisz) i suwak głośności
function renderSound() {
  const { volume, muted } = getSound();
  $('sound').classList.toggle('muted', muted || volume === 0);
  $('volume').value = Math.round(volume * 100);
  $('muteBtn').title = muted ? 'Włącz dźwięk (M)' : 'Wycisz dźwięk (M)';
}

$('muteBtn').addEventListener('click', () => {
  unlockAudio();
  setMuted(!getSound().muted);
  renderSound();
  $('muteBtn').blur();
});
$('volume').addEventListener('input', () => {
  unlockAudio();
  setVolume(Number($('volume').value) / 100);
  renderSound();
});
// po przesunięciu suwak oddaje fokus, żeby strzałki znów sterowały postacią
$('volume').addEventListener('change', () => $('volume').blur());
renderSound();

function showCenter(main, sub = '', flash = false) {
  if (net.role === 'host') netSend({ t: 'center', m: main, s: sub, f: flash });
  centerEl.innerHTML = '';
  const big = document.createElement('div');
  big.className = 'big';
  big.textContent = main;
  centerEl.appendChild(big);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'sub';
    s.textContent = sub;
    centerEl.appendChild(s);
  }
  centerEl.className = '';
  void centerEl.offsetWidth;
  centerEl.className = flash ? 'flash' : 'pop';
}

function hideCenter() {
  if (net.role === 'host') netSend({ t: 'hideCenter' });
  centerEl.className = '';
  centerEl.innerHTML = '';
}

function updateScoreboard() {
  scoresEl.innerHTML = '';
  for (const f of fighters) {
    const card = document.createElement('div');
    card.className = 'card' + (f.alive || state === 'menu' ? '' : ' dead');
    card.style.setProperty('--c', css(f.color));
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.innerHTML = `<span class="tag"></span> <b></b>`;
    nm.querySelector('.tag').textContent = f.tag;
    nm.querySelector('b').textContent = f.char.name;
    const pts = document.createElement('div');
    pts.className = 'pts';
    pts.innerHTML = '<b></b><span></span>';
    pts.querySelector('b').textContent = f.score;
    pts.querySelector('span').textContent = ` / ${matchTarget()} pkt`;
    const pw = document.createElement('div');
    pw.className = 'pw';
    pw.hidden = true;
    card.dataset.slot = f.slot;
    card.append(nm, pts, pw);
    scoresEl.appendChild(card);
  }
  updatePowerHud();
}

// ---------- Menu ----------

// Na jednym urządzeniu gra jedna osoba; pozostali to boty albo gracze sieciowi
const CONTROL_OPTIONS = [
  { v: 'me', label: 'Ty (to urządzenie)' },
  { v: 'bot', label: 'Bot' },
  { v: 'off', label: 'Wyłączony' },
];

const DEFAULT_SETUP = {
  slots: [
    { ctrl: 'me', char: 'apple' },
    { ctrl: 'bot', char: 'carrot' },
    { ctrl: 'bot', char: 'banana' },
    { ctrl: 'bot', char: 'eggplant' },
    { ctrl: 'off', char: 'broccoli' },
    { ctrl: 'off', char: 'peach' },
  ],
  target: 10,
  bot: 'normal',
  boom: 'normal',
};

// id postaci może przyjść z sieci: tylko własne klucze (nie __proto__, constructor itp.)
const playable = id => Object.hasOwn(CHAR_BY_ID, id) && !CHAR_BY_ID[id].locked;

// Postać o danym id albo, gdy id nieznane, pierwsza grywalna
function charOr(id) {
  return Object.hasOwn(CHAR_BY_ID, id) ? CHAR_BY_ID[id] : CHARACTERS.find(c => !c.locked);
}

// Postacie użyte w aktywnych wierszach poza wskazanym
function takenChars(exceptIdx, slots = setup.slots) {
  return new Set(slots.filter((s, i) => i !== exceptIdx && s.ctrl !== 'off').map(s => s.char));
}

// Wolna, grywalna postać dla wiersza; preferowana, jeśli nikt jej nie ma
function freeChar(idx, preferred, slots = setup.slots) {
  const taken = takenChars(idx, slots);
  if (playable(preferred) && !taken.has(preferred)) return preferred;
  return CHARACTERS.find(c => !c.locked && !taken.has(c.id))?.id;
}

// Klucze w localStorage; wartości zapisane pod starą nazwą gry przenosimy pod nowe
// (do usunięcia za jakiś czas)
const SETUP_KEY = 'bumerangi-fu-setup';
const NICK_KEY = 'bumerangi-fu-nick';
for (const [oldKey, newKey] of [['smartlunch-fu-setup', SETUP_KEY], ['smartlunch-fu-nick', NICK_KEY]]) {
  try {
    const old = localStorage.getItem(oldKey);
    if (old === null) continue;
    if (localStorage.getItem(newKey) === null) localStorage.setItem(newKey, old);
    localStorage.removeItem(oldKey);
  } catch { /* brak zapisu */ }
}

function loadSetup() {
  try {
    const s = JSON.parse(localStorage.getItem(SETUP_KEY));
    if (Array.isArray(s?.slots) && s.slots.length === 6 && s.slots.every(x => x && typeof x === 'object')) {
      const slots = s.slots.map(x => ({ ctrl: x.ctrl, char: x.char }));
      let me = false;
      for (const x of slots) {
        // starsze zapisy miały kilku graczy lokalnych: zostaje tylko pierwszy
        if (x.ctrl === 'kb0') x.ctrl = 'me';
        else if (!CONTROL_OPTIONS.some(o => o.v === x.ctrl)) x.ctrl = 'off';
        if (x.ctrl === 'me') {
          if (me) x.ctrl = 'bot';
          me = true;
        }
      }
      // nieznana (np. usunięta), zablokowana (Papież z DLC) albo powtórzona postać:
      // tylko ten wiersz dostaje wolną. Papież pojawia się więc wyłącznie po ręcznym
      // przewinięciu do niego, nigdy od razu po uruchomieniu gry.
      slots.forEach((x, i) => {
        const dup = x.ctrl !== 'off' && slots.some((o, j) => j < i && o.ctrl !== 'off' && o.char === x.char);
        if (playable(x.char) && !dup) return;
        const c = freeChar(i, x.char, slots);
        if (c) {
          x.char = c;
        } else {
          x.ctrl = 'off';
          x.char = charOr(x.char).id;
        }
      });
      return {
        slots,
        target: TARGETS.includes(s.target) ? s.target : 10,
        bot: Object.hasOwn(BOT_LEVELS, s.bot) ? s.bot : 'normal',
        boom: Object.hasOwn(BOOM_LEVELS, s.boom) ? s.boom : 'normal',
      };
    }
  } catch { /* brak zapisu */ }
  return structuredClone(DEFAULT_SETUP);
}

// Co zapisać: w pokoju układ sprzed jego założenia (boty, bez gości),
// ale z bieżącą postacią hosta i ustawieniami meczu
function setupToSave() {
  if (net.role !== 'host') return setup;
  const base = slotsBeforeHosting || setup.slots;
  const slots = base.map(x => ({ ctrl: x.ctrl.startsWith('net') ? 'off' : x.ctrl, char: x.char }));
  const meIdx = setup.slots.findIndex(x => x.ctrl === 'me');
  if (meIdx >= 0) {
    for (const x of slots) if (x.ctrl === 'me') x.ctrl = 'off';
    slots[meIdx] = { ctrl: 'me', char: setup.slots[meIdx].char };
  }
  // boty nie mogą mieć postaci, którą host wybrał w pokoju
  slots.forEach((x, i) => {
    if (x.ctrl !== 'bot' || !takenChars(i, slots).has(x.char)) return;
    const c = freeChar(i, x.char, slots);
    if (c) x.char = c;
    else x.ctrl = 'off';
  });
  return { ...setup, slots };
}

function saveSetup() {
  try { localStorage.setItem(SETUP_KEY, JSON.stringify(setupToSave())); } catch { /* bez zapisu */ }
}

const setup = loadSetup();

function setupProblem() {
  const active = setup.slots.filter(s => s.ctrl !== 'off');
  if (active.length < 2) {
    return net.role === 'host' ? 'Czekamy na graczy: potrzebny co najmniej jeden gość.' : 'Potrzeba co najmniej dwóch zawodników.';
  }
  const humans = active.filter(s => s.ctrl !== 'bot').map(s => s.ctrl);
  if (new Set(humans).size !== humans.length) return 'Na tym urządzeniu może grać tylko jedna osoba.';
  const chars = active.map(s => s.char);
  if (new Set(chars).size !== chars.length) return 'Każda postać może wystąpić w meczu tylko raz.';
  const locked = active.find(s => CHAR_BY_ID[s.char].locked);
  if (locked) return `${CHAR_BY_ID[locked.char].name} jest dostępny tylko w DLC. Wybierz inną postać.`;
  const waiting = active
    .filter(s => s.ctrl.startsWith('net') && !peers.get(Number(s.ctrl.slice(3)))?.ready)
    .map(s => peers.get(Number(s.ctrl.slice(3)))?.name || '?');
  if (waiting.length) return `Czekamy na gotowość: ${waiting.join(', ')}.`;
  return '';
}

const LOCK_SVG = '<svg class="lock" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="7" width="10" height="8" rx="2" fill="currentColor"/></svg>';

// Nazwa postaci w wyborze; zablokowana dostaje kłódkę
function setCharName(el, char) {
  el.textContent = char.name;
  el.classList.toggle('locked', !!char.locked);
  el.title = char.locked ? 'Dostępne w DLC' : '';
  if (char.locked) el.insertAdjacentHTML('afterbegin', LOCK_SVG);
}

// Kłódka z napisem nad zablokowaną postacią w podglądzie 3D
let lockTexture = null;
function addLockBadge(f) {
  if (!lockTexture) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 160;
    const g = c.getContext('2d');
    g.lineWidth = 10;
    g.strokeStyle = '#2b1d14';
    g.beginPath();
    g.arc(128, 52, 22, Math.PI, 0);
    g.lineTo(150, 70);
    g.moveTo(106, 52);
    g.lineTo(106, 70);
    g.stroke();
    g.fillStyle = '#f2c230';
    g.strokeStyle = '#2b1d14';
    g.lineWidth = 6;
    g.beginPath();
    g.roundRect(90, 66, 76, 54, 10);
    g.fill();
    g.stroke();
    g.fillStyle = '#2b1d14';
    g.beginPath();
    g.arc(128, 88, 7, 0, Math.PI * 2);
    g.fill();
    g.fillRect(125, 88, 6, 16);
    g.font = 'bold 26px system-ui, sans-serif';
    g.textAlign = 'center';
    g.lineWidth = 7;
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.strokeText('Dostępne w DLC', 128, 148);
    g.fillStyle = '#ffffff';
    g.fillText('Dostępne w DLC', 128, 148);
    lockTexture = new THREE.CanvasTexture(c);
    lockTexture.colorSpace = THREE.SRGBColorSpace;
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: lockTexture, depthTest: false, transparent: true }));
  s.scale.set(1.6, 1.0, 1);
  s.position.y = f.char.height + 0.75;
  s.renderOrder = 11;
  f.label.visible = false;
  f.root.add(s);
}

function renderSeg(el, items, current, onPick) {
  el.innerHTML = '';
  for (const [v, label] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    if (v === current) b.className = 'on';
    b.addEventListener('click', () => onPick(v));
    el.appendChild(b);
  }
}

// Gracze sieciowi pojawiają się jako dodatkowe opcje sterowania
function controlOptions() {
  const nets = [...peers].map(([id, p]) => ({ v: 'net' + id, label: `Sieć: ${p.name}` }));
  // w grze sieciowej nie ma botów
  const rest = CONTROL_OPTIONS.slice(1).filter(o => !(net.role === 'host' && o.v === 'bot'));
  return [CONTROL_OPTIONS[0], ...nets, ...rest];
}

function renderMenu() {
  const slotsEl = $('slots');
  slotsEl.innerHTML = '';
  setup.slots.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'slot' + (s.ctrl === 'off' ? ' off' : '');
    row.style.setProperty('--c', css(SLOT_COLORS[i]));

    const dot = document.createElement('span');
    dot.className = 'dot';
    const sel = document.createElement('select');
    for (const o of controlOptions()) sel.add(new Option(o.label, o.v, false, o.v === s.ctrl));
    sel.addEventListener('change', () => {
      s.ctrl = sel.value;
      // „Ty” może być tylko w jednym wierszu: poprzedni staje się botem (w pokoju wyłączony)
      if (s.ctrl === 'me') {
        for (const o of setup.slots) if (o !== s && o.ctrl === 'me') o.ctrl = net.role === 'host' ? 'off' : 'bot';
      }
      // włączony wiersz nie może mieć postaci zajętej przez inny
      if (s.ctrl !== 'off' && takenChars(i).has(s.char)) s.char = freeChar(i) || s.char;
      onSetupChange();
    });

    const cp = document.createElement('div');
    cp.className = 'charpick';
    const prev = document.createElement('button');
    prev.textContent = '‹';
    prev.setAttribute('aria-label', 'Poprzednia postać');
    const name = document.createElement('span');
    name.className = 'cname';
    setCharName(name, CHAR_BY_ID[s.char]);
    const next = document.createElement('button');
    next.textContent = '›';
    next.setAttribute('aria-label', 'Następna postać');
    // przewijanie pomija postacie zajęte w innych aktywnych wierszach
    const cycle = d => {
      const taken = s.ctrl === 'off' ? new Set() : takenChars(i);
      let idx = CHARACTERS.findIndex(c => c.id === s.char);
      for (let n = 0; n < CHARACTERS.length; n++) {
        idx = (idx + d + CHARACTERS.length) % CHARACTERS.length;
        if (!taken.has(CHARACTERS[idx].id)) break;
      }
      s.char = CHARACTERS[idx].id;
      onSetupChange();
    };
    prev.addEventListener('click', () => cycle(-1));
    next.addEventListener('click', () => cycle(1));
    cp.append(prev, name, next);

    row.append(dot, sel, cp);
    slotsEl.appendChild(row);
  });

  renderSeg($('target'), TARGETS.map(n => [n, String(n)]), setup.target, v => { setup.target = v; onSetupChange(); });
  renderSeg($('botlvl'), Object.entries(BOT_LEVELS).map(([k, v]) => [k, v.label]), setup.bot, v => { setup.bot = v; onSetupChange(); });
  renderSeg($('boomlvl'), Object.entries(BOOM_LEVELS).map(([k, v]) => [k, v.label]), setup.boom, v => { setup.boom = v; onSetupChange(); });

  // w pokoju sieciowym nie ma wierszy z miejscami ani botów: gracze to goście
  const hosting = net.role === 'host';
  $('botlvl').parentElement.hidden = hosting;
  $('slots').hidden = hosting;
  $('hostHint').hidden = $('unhostBtn').hidden = !hosting;
  const problem = setupProblem();
  $('warn').textContent = problem;
  $('play').disabled = !!problem;

  // host rozsyła gościom stan pokoju; podgląd i panel sieciowy też się odświeżają
  if (net.role === 'host') netSend({ t: 'lobbyState', host: myNick(), players: lobbyPlayers(), spectators: lobbySpectators().map(s => ({ name: s.name })) });
  renderLan();
  syncDancing(lobbyPlayers());
}

function onSetupChange() {
  saveSetup();
  renderMenu();
  showPreview();
}

function rebuildFighters() {
  fighters.forEach(f => f.dispose());
  fighters = [];
  setup.slots.forEach((s, i) => {
    if (s.ctrl !== 'off') fighters.push(new Fighter(i, CHAR_BY_ID[s.char], parseCtrl(s.ctrl)));
  });
}

function showPreview() {
  rebuildFighters();
  layoutLineup();
  syncDancing(lobbyPlayers());
}

// Tryb wybrany na ekranie startowym: null (wybór), 'local' (z botami), 'online' (w sieci)
let mode = null;

// Który panel menu widać: start, ekran sieciowy albo ustawienia meczu
function showMenuPanel() {
  const hosting = net.role === 'host';
  const which = hosting || mode === 'local' ? 'menu' : mode === 'online' ? 'online' : 'start';
  startEl.hidden = which !== 'start';
  onlineEl.hidden = which !== 'online';
  menuEl.hidden = which !== 'menu';
  $('lanSection').hidden = !hosting;
  $('menuBack').hidden = hosting;
}

function goToMenu() {
  clearRound();
  // po meczu wszyscy wracają do pokoju niegotowi
  for (const p of peers.values()) p.ready = false;
  state = 'menu';
  paused = false;
  matchWinner = null;
  pauseEl.hidden = endEl.hidden = hudEl.hidden = lobbyEl.hidden = boardEl.hidden = helpEl.hidden = clientEscEl.hidden = true;
  showMenuPanel();
  document.body.classList.remove('net-client');
  if (net.role === 'host') netSend({ t: 'lobby' });
  hideCenter();
  renderLan();
  buildArena({ ...LAYOUTS[0], blocks: [] });
  renderMenu();
  showPreview();
}

// ---------- Przebieg meczu ----------

function clearRound() {
  boomerangs.forEach(b => {
    world.remove(b.mesh);
    disposeTree(b.mesh);
  });
  boomerangs = [];
  powerups.forEach(p => {
    world.remove(p.mesh);
    disposeTree(p.mesh);
  });
  powerups = [];
  fx.forEach(e => e.remove());
  fx = [];
  parts = [];
}

function startMatch() {
  if (setupProblem()) return;
  unlockAudio();
  saveSetup();
  rebuildFighters();
  menuEl.hidden = startEl.hidden = onlineEl.hidden = endEl.hidden = pauseEl.hidden = true;
  hudEl.hidden = false;
  paused = false;
  matchWinner = null;
  roundNo = 0;
  if (net.role === 'host') netSend(rosterMsg());
  newRound();
}

function newRound() {
  // po wyjściu graczy zostało mniej niż dwóch zawodników: koniec meczu
  const present = fighters.filter(f => !f.gone);
  if (present.length < 2) {
    if (present.length) endMatch(present[0]);
    else goToMenu();
    return;
  }
  clearRound();
  hideBoard();
  roundNo++;
  const options = LAYOUTS.filter(l => l !== layout);
  buildArena(roundNo === 1 ? pick(LAYOUTS) : pick(options));
  const spawns = shuffle(SPAWNS.slice());
  fighters.forEach((f, i) => {
    f.reset(spawns[i][0], spawns[i][1]);
    // gracz, który wyszedł w trakcie meczu, już się nie pojawia
    if (f.gone) {
      f.alive = false;
      f.root.visible = false;
    }
  });
  if (net.role === 'host') netSend(roundMsg());
  state = 'countdown';
  stateT = 0;
  lastCount = 4;
  puTimer = rand(4, 7);
  updateScoreboard();
  showCenter(`Runda ${roundNo}`, layout.name);
}

function finishRound() {
  const alive = fighters.filter(f => f.alive);
  const w = alive.length === 1 ? alive[0] : null;
  // ocalały tańczy podczas tablicy wyników
  if (w) {
    w.emote = true;
    w.emoteT = 0;
  }
  hideCenter();
  const best = Math.max(...fighters.map(f => f.roundKills));
  const butcher = best > 0 && fighters.filter(f => f.roundKills === best).length === 1 ? fighters.find(f => f.roundKills === best) : null;
  const data = {
    title: w ? (w.char.id === 'pope' ? 'Deo gratias!' : `${w.char.name} ${{ m: 'przetrwał', f: 'przetrwała', n: 'przetrwało', pl: 'przetrwały' }[w.char.gender] || 'przetrwał'} rundę!`) : 'Nikt nie przetrwał!',
    sub: `Runda ${roundNo}` + (butcher ? ` · najwięcej zabójstw: ${butcher.name}` : ''),
    rows: boardRows(w),
  };
  showBoard(data);
  if (net.role === 'host') netSend({ t: 'board', d: data });
  updateScoreboard();
  state = 'roundResult';
  stateT = 0;
}

// survivor: kto przetrwał rundę (wyróżniony wiersz)
function boardRows(survivor) {
  return [...fighters]
    .sort((a, b) => b.score - a.score || b.roundKills - a.roundKills)
    .map(f => ({ tag: f.tag, name: f.char.name, c: css(f.color), sc: f.score, rk: f.roundKills, w: f === survivor }));
}

function boardTable(rows, showRound = true) {
  const table = document.createElement('table');
  table.className = 'board-table';
  const cols = [['', ''], ['Gracz', ''], ['Postać', 'col-char']];
  if (showRound) cols.push(['W rundzie', 'num']);
  cols.push(['Punkty', 'num']);
  const head = table.createTHead().insertRow();
  for (const [label, cls] of cols) {
    const th = document.createElement('th');
    th.textContent = label;
    th.className = cls;
    head.appendChild(th);
  }
  const body = table.createTBody();
  rows.forEach((r, i) => {
    const tr = body.insertRow();
    if (r.w) tr.className = 'win';
    tr.style.setProperty('--c', r.c);
    tr.insertCell().textContent = `${i + 1}.`;
    const who = tr.insertCell();
    who.className = 'who';
    who.append(document.createElement('i'), r.tag);
    const ch = tr.insertCell();
    ch.className = 'col-char';
    ch.textContent = r.name;
    if (showRound) {
      const rk = tr.insertCell();
      rk.className = 'num';
      if (r.rk > 0) {
        const plus = document.createElement('span');
        plus.className = 'plus';
        plus.textContent = `+${r.rk}`;
        rk.appendChild(plus);
      } else {
        rk.textContent = '–';
      }
    }
    const pts = tr.insertCell();
    pts.className = 'num pts';
    pts.textContent = `${r.sc} / ${matchTarget()}`;
  });
  return table;
}

function showBoard(d) {
  boardEl.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'board-panel';
  const h = document.createElement('h2');
  h.textContent = d.title;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = d.sub;
  panel.append(h, sub, boardTable(d.rows));
  boardEl.appendChild(panel);
  boardEl.hidden = false;
}

function hideBoard() {
  boardEl.hidden = true;
}

function endMatch(w) {
  state = 'matchEnd';
  stateT = 0;
  matchWinner = w;
  w.emote = true;
  w.emoteT = 0;
  hideCenter();
  const rows = boardRows(null);
  showEnd(w, rows);
  if (net.role === 'host') netSend({ t: 'end', s: w.slot, d: rows });
  sfx.win();
  if (w.char.id === 'pope') sfx.choir();
}

function showEnd(w, rows) {
  const pope = w.char.id === 'pope';
  hideBoard();
  $('endTitle').textContent = pope ? 'Habemus Papam!' : `${w.char.name} wygrywa!`;
  $('endSub').textContent = `${w.name} zdobywa ${w.score} pkt.${pope ? ' Nad areną unosi się biały dym.' : ''}`;
  $('endBoard').replaceChildren(boardTable(rows || [], false));
  clientEscEl.hidden = true;
  updateAgain();
  endEl.hidden = false;
}

// Rewanż tylko przy poprawnym składzie; inaczej pod tabelą widać powód
function updateAgain() {
  const problem = net.role === 'client' ? '' : setupProblem();
  $('again').disabled = !!problem;
  const warn = $('endWarn');
  warn.hidden = !problem;
  warn.textContent = net.role === 'host' && problem.startsWith('Czekamy na gotowość')
    ? `${problem} Wróć do pokoju, aby wszyscy zgłosili gotowość.`
    : problem;
}

function togglePause() {
  if (net.role === 'client') return;
  paused = !paused;
  pauseEl.hidden = !paused;
  keys.clear();
}

// ---------- Gra w sieci lokalnej ----------
//
// Host liczy całą rozgrywkę i ~30 razy na sekundę rozsyła stan. Gracze sieciowi
// wysyłają tylko swoje sterowanie i wyświetlają to, co przyszło od hosta.

const lobbyEl = $('lobby');
const peers = new Map();      // host: id gracza sieciowego -> { name }
const netInputs = new Map();  // host: id -> { queue, last }
const cBooms = new Map();     // klient: bumerangi z ostatniego stanu
const cPus = new Map();       // klient: power-upy z ostatniego stanu
const NO_INPUT = { mx: 0, mz: 0, attack: false, dash: false };
let snapAcc = 0;
let mySlot = 0;
let mySpectator = false; // gość: w pokoju jako widz, bez miejsca w grze
let myChar = 'apple';
let myPlayChar = 'apple';
let myName = 'Gość';
let lastSent = '';
let lastBtn = '';
let lastSentT = 0;
let leaving = false;
let serverOk = false;
let netBusy = false;      // czekamy na odpowiedź na „host” albo „join”
let netBusyTimer = 0;

try { myName = localStorage.getItem(NICK_KEY) || myName; } catch { /* brak zapisu */ }
$('nick').value = myName === 'Gość' ? '' : myName;

function sanitizeName(s) {
  return String(s || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 8) || 'Gość';
}

function setLanMsg(text) {
  for (const el of document.querySelectorAll('.lan-msg')) el.textContent = text;
}

// Nick gracza na tym urządzeniu (nad głową i w pokoju)
function myNick() {
  const n = sanitizeName($('nick').value);
  return n === 'Gość' ? 'TY' : n;
}

function nickEntered() {
  return $('nick').value.trim().length > 0;
}

// „graczy: 3, widzów: 1”
function roomCount(room) {
  return `graczy: ${room.players}` + (room.spectators ? `, widzów: ${room.spectators}` : '');
}

function renderLan() {
  const hosting = net.role === 'host';
  // otwarty pokój widać już na ekranie startowym, na karcie „W sieci”
  $('modeRoom').textContent = serverOk && net.room ? `Otwarty pokój: ${net.room.name} (${roomCount(net.room)})` : '';
  if (!hosting) {
    // podpowiedź, czy w sieci jest już czyjś pokój
    const room = net.room;
    const status = $('lanStatus');
    const full = !!room && room.players >= MAX_PLAYERS;
    if (!serverOk) status.textContent = 'Gra w sieci działa po uruchomieniu gry poleceniem: node server.mjs';
    else if (room) status.textContent = `W tej sieci jest pokój gracza ${room.name} (${roomCount(room)}).` + (full ? ' Wszystkie miejsca w grze są zajęte, możesz oglądać.' : '');
    else status.textContent = 'W tej sieci nie ma jeszcze żadnego pokoju.';
    if (serverOk && !nickEntered()) status.textContent += ' Wpisz nick, żeby zagrać w sieci.';
    $('joinBtn').hidden = !serverOk || !room;
    $('joinBtn').textContent = room ? (full ? `Pokój gracza ${room.name} jest pełny (${MAX_PLAYERS}/${MAX_PLAYERS})` : `Dołącz do pokoju gracza ${room.name}`) : '';
    $('spectateBtn').hidden = !serverOk || !room;
    $('hostBtn').hidden = !serverOk || !!room;
    $('joinBtn').disabled = $('hostBtn').disabled = $('spectateBtn').disabled = !nickEntered() || netBusy;
    if (full) $('joinBtn').disabled = true;
    return;
  }
  renderAddresses();
  const meIdx = setup.slots.findIndex(s => s.ctrl === 'me');
  $('hostGrid').hidden = meIdx < 0;
  if (meIdx >= 0) {
    renderCharGrid($('hostGrid'), setup.slots[meIdx].char, takenByName(lobbyPlayers(), meIdx), id => {
      setup.slots[meIdx].char = id;
      onSetupChange();
    });
  }
  renderPlayerList($('lanPlayers'), lobbyPlayers(), meIdx, kickPeer);
  const spect = lobbySpectators();
  $('lanSpectWrap').hidden = !spect.length;
  renderSpectatorList($('lanSpectators'), spect, kickPeer);
}

// Adresy do wysłania znajomym: przez internet (tunel) i w tej samej sieci
const LOCAL_HOST = /^(localhost|127\.|\[::1\]$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function publicAddress() {
  if (net.publicUrl) return net.publicUrl;
  // gospodarz sam otworzył grę przez tunel
  return LOCAL_HOST.test(location.hostname) ? '' : location.origin;
}

function renderAddresses() {
  const box = $('lanAddr');
  box.replaceChildren();
  const pub = publicAddress();
  const group = (title, urls) => {
    const h = document.createElement('div');
    h.className = 'addr-title';
    h.textContent = title;
    box.appendChild(h);
    for (const url of urls) box.appendChild(addressRow(url));
  };
  if (pub) group('Przez internet', [pub]);
  // serwer podaje adresy LAN tylko połączeniom z tej sieci; gospodarz, który sam wszedł
  // przez tunel, widzi więc tylko adres internetowy
  if (net.ips.length) group('W tej samej sieci', net.ips.map(ip => `http://${ip}:${net.port}`));
  else if (!pub) group('W tej samej sieci', [`http://<IP tego komputera>:${net.port}`]);
  if (!pub) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.innerHTML = 'Gra przez internet: uruchom serwer poleceniem <kbd>node server.mjs --tunnel</kbd>.';
    box.appendChild(hint);
  }
}

function addressRow(url) {
  const row = document.createElement('div');
  row.className = 'addr';
  const text = document.createElement('span');
  text.textContent = url;
  const btn = document.createElement('button');
  btn.className = 'copy';
  btn.textContent = 'Kopiuj';
  btn.addEventListener('click', async () => {
    const ok = await copyText(url);
    btn.textContent = ok ? 'Skopiowano!' : 'Zaznacz i skopiuj';
    setTimeout(() => { btn.textContent = 'Kopiuj'; }, 1500);
  });
  row.append(text, btn);
  return row;
}

// Schowek działa tylko w bezpiecznym kontekście (localhost, https); poza nim stara metoda
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* brak schowka */ }
    ta.remove();
    return ok;
  }
}

// --- lobby: gracze, gotowość, taniec, wybór postaci ---

// licznik tańców: każde naciśnięcie T zwiększa go o 1 i odpala jeden taniec
let hostDanceId = 0;

// Lista graczy w pokoju liczona przez hosta i rozsyłana do gości
function lobbyPlayers() {
  const out = [];
  setup.slots.forEach((s, i) => {
    if (s.ctrl === 'off') return;
    const peer = s.ctrl.startsWith('net') ? peers.get(Number(s.ctrl.slice(3))) : null;
    out.push({
      slot: i,
      name: s.ctrl === 'me' ? myNick() : peer ? peer.name : 'BOT',
      host: s.ctrl === 'me',
      bot: s.ctrl === 'bot',
      charId: s.char,
      color: css(SLOT_COLORS[i]),
      ready: s.ctrl === 'me' || !!peer?.ready,
      dance: s.ctrl === 'me' ? hostDanceId : peer?.danceId || 0,
      peerId: peer ? Number(s.ctrl.slice(3)) : undefined,
    });
  });
  return out;
}

// Widzowie: w pokoju, ale bez miejsca w grze (liczy host)
function lobbySpectators() {
  return [...peers].filter(([, p]) => p.spectator).map(([id, p]) => ({ name: p.name, peerId: id }));
}

function takenByName(players, exceptSlot) {
  return new Map(players.filter(p => p.slot !== exceptSlot).map(p => [p.charId, p.name]));
}

function kickButton(p, onKick) {
  const kick = document.createElement('button');
  kick.className = 'kick';
  kick.textContent = 'Wyrzuć';
  kick.title = `Wyrzuć gracza ${p.name} z pokoju`;
  kick.addEventListener('click', () => onKick(p.peerId));
  return kick;
}

function renderSpectatorList(el, spectators, onKick) {
  el.replaceChildren(...spectators.map(p => {
    const row = document.createElement('div');
    row.className = 'player spect';
    row.style.setProperty('--c', '#8a7a6a');
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name + (p.me ? ' (ty)' : '');
    const badge = document.createElement('span');
    badge.className = 'badge spect';
    badge.textContent = 'widz';
    row.append(name, badge);
    if (onKick && p.peerId !== undefined) row.append(kickButton(p, onKick));
    return row;
  }));
}

// onKick: tylko u gospodarza; dodaje przycisk „Wyrzuć” przy gościach
function renderPlayerList(el, players, mine, onKick) {
  el.replaceChildren(...players.map(p => {
    const row = document.createElement('div');
    row.className = 'player';
    row.style.setProperty('--c', p.color);
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name + (p.host ? ' (host)' : '') + (p.slot === mine ? ' (ty)' : '');
    const ch = document.createElement('span');
    ch.className = 'pchar';
    ch.textContent = Object.hasOwn(CHAR_BY_ID, p.charId) ? CHAR_BY_ID[p.charId].name : '';
    row.append(name, ch);
    const badge = document.createElement('span');
    badge.className = 'badge ' + (p.bot ? 'bot' : p.ready ? 'ready' : 'wait');
    badge.textContent = p.bot ? 'bot' : p.ready ? 'Gotowe' : 'Czeka';
    row.append(badge);
    if (onKick && p.peerId !== undefined) row.append(kickButton(p, onKick));
    return row;
  }));
}

// Gospodarz wyrzuca gościa: gość dostaje wiadomość, a do końca tego pokoju nie może wrócić
const kickedPeers = new Set();

function kickPeer(id) {
  if (!peers.has(id)) return;
  kickedPeers.add(id);
  netSend({ to: id, t: 'kicked' });
  hostOnLeave({ from: id, kicked: true });
}

// Portrety postaci renderowane raz, w osobnym małym rendererze
let portraitCache = null;
function portraits() {
  if (portraitCache) return portraitCache;
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.setSize(96, 96);
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0x9a8a78, 1.4));
  const light = new THREE.DirectionalLight(0xffffff, 1.6);
  light.position.set(2, 4, 5);
  sc.add(light);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  portraitCache = {};
  for (const c of CHARACTERS) {
    const g = c.build();
    sc.add(g);
    cam.position.set(0, c.height * 0.55, c.height * 2.2 + 0.3);
    cam.lookAt(0, c.height * 0.48, 0);
    r.render(sc, cam);
    portraitCache[c.id] = r.domElement.toDataURL();
    sc.remove(g);
  }
  r.dispose();
  r.forceContextLoss();
  return portraitCache;
}

// Wybór postaci jak w LoL: siatka portretów, zajęte wyszarzone z nickiem
function renderCharGrid(el, selected, taken, onPick) {
  const pics = portraits();
  el.replaceChildren(...CHARACTERS.map(c => {
    const b = document.createElement('button');
    b.className = 'tile';
    const by = taken.get(c.id);
    if (c.id === selected) b.classList.add('on');
    if (by) {
      b.classList.add('taken');
      b.disabled = true;
    }
    if (c.locked) b.classList.add('locked');
    const img = document.createElement('img');
    img.src = pics[c.id];
    img.alt = '';
    const nm = document.createElement('span');
    nm.className = 'tname';
    nm.textContent = c.name;
    b.append(img, nm);
    if (by) {
      const t = document.createElement('span');
      t.className = 'tby';
      t.textContent = by;
      b.append(t);
    }
    if (c.locked) {
      const t = document.createElement('span');
      t.className = 'tlock';
      t.innerHTML = LOCK_SVG + 'DLC';
      b.append(t);
    }
    b.title = by ? `Wybrane przez: ${by}` : c.locked ? 'Dostępne w DLC' : c.name;
    b.addEventListener('click', () => onPick(c.id));
    return b;
  }));
}

// Taniec w podglądzie: nowy numer tańca gracza = jeden, niezapętlony taniec
function syncDancing(players) {
  const now = clock.elapsedTime;
  for (const f of fighters) {
    const id = players.find(p => p.slot === f.slot)?.dance || 0;
    // świeżo zbudowana postać nie powtarza tańca sprzed przebudowy podglądu
    if (f.danceId === undefined) {
      f.danceId = id;
      continue;
    }
    if (id !== f.danceId) {
      f.danceId = id;
      f.dancing = true;
      f.danceStart = now;
    }
  }
}

function afterSetupChange() {
  saveSetup();
  if (state === 'menu') {
    renderMenu();
    showPreview();
  } else if (state === 'matchEnd' && !endEl.hidden) {
    updateAgain(); // ktoś dołączył lub wyszedł po meczu
  }
}

// --- host ---

const INPUT_QUEUE_MAX = 30;
const INPUT_STALE = 0.5; // s bez sterowania od gościa = stoi w miejscu

const sameButtons = (a, b) => a.attack === b.attack && a.dash === b.dash && a.dance === b.dance;

// Kolejka sterowania gościa: wpisy bez zmiany przycisków się scalają (zostaje najnowszy
// ruch i celowanie), więc każde naciśnięcie i puszczenie zostaje odczytane, po jednym na klatkę
function queueInput(ni, inp) {
  const q = ni.queue;
  if (q.length && sameButtons(q[q.length - 1], inp)) q[q.length - 1] = inp;
  else q.push(inp);
  // po scaleniu każdy wpis (poza może najstarszym) zmienia przyciski; przy zalewie
  // wiadomości (~pół sekundy zaległości) odpadają najstarsze
  if (q.length > INPUT_QUEUE_MAX) q.splice(0, q.length - INPUT_QUEUE_MAX);
}

function netInput(f) {
  const ni = netInputs.get(f.ctrl.id);
  if (!ni) return NO_INPUT;
  // zamrożona albo schowana karta gościa: nie powtarzamy w kółko ostatniego sterowania
  if (clock.elapsedTime - ni.lastT > INPUT_STALE) {
    ni.queue.length = 0;
    ni.last = NO_INPUT;
    return NO_INPUT;
  }
  const q = ni.queue;
  // wpis bez zmiany przycisków względem bieżącego stanu można pominąć, jeśli czeka nowszy
  while (q.length > 1 && sameButtons(q[0], ni.last)) q.shift();
  if (q.length) ni.last = q.shift();
  return ni.last;
}

function rosterMsg() {
  return { t: 'roster', target: setup.target, boom: setup.boom, f: fighters.map(f => ({ s: f.slot, c: f.char.id, tag: f.tag })) };
}

function roundMsg() {
  return { t: 'round', l: LAYOUTS.indexOf(layout), n: roundNo, p: fighters.map(f => [f.slot, r2(f.x), r2(f.z), f.alive ? 1 : 0]) };
}

function makeSnapshot() {
  return {
    t: 'snap', st: state, p: paused,
    f: fighters.map(f => [
      f.slot, r2(f.x), r2(f.z), r2(f.vx), r2(f.vz), r2(f.facing), r2(f.aimAngle),
      f.alive ? 1 : 0, f.hasBoom ? 1 : 0,
      f.charging ? r2(clamp((f.pressT - TAP_TIME) / MAX_CHARGE, 0, 1)) : -1,
      f.dashT > 0 ? 1 : 0, r2(Math.max(0, f.meleeT)), f.power?.type || 0, f.score, f.stunT > 0 ? 1 : 0, f.emote ? 1 : 0,
      f.power ? (Number.isFinite(f.power.t) ? r2(f.power.t) : -1) : 0,
    ]),
    b: boomerangs.map(b => [b.id, b.owner.slot, r2(b.x), r2(b.z), b.state === 'drop' ? 1 : 0, b.big ? 1 : 0]),
    u: powerups.map(p => [p.id, p.type, r2(p.x), r2(p.z)]),
  };
}

function hostOnJoin(msg) {
  // powtórzona prośba od gracza, który już jest w pokoju
  if (peers.has(msg.from)) return;
  if (kickedPeers.has(msg.from)) {
    netSend({ to: msg.from, t: 'err', msg: 'Zostałeś wyrzucony z tego pokoju.' });
    return;
  }
  // nick w pokoju musi być unikalny; powtórka dostaje numerek
  let name = sanitizeName(msg.name);
  const used = new Set([myNick(), 'BOT', ...[...peers.values()].map(p => p.name)]);
  for (let n = 2; used.has(name); n++) name = `${sanitizeName(msg.name).slice(0, 7)}${n}`;
  if (msg.spectate) {
    // widz: w pokoju bez miejsca w grze, ogląda mecze
    if (lobbySpectators().length >= MAX_SPECTATORS) {
      netSend({ to: msg.from, t: 'err', msg: 'Brak miejsc dla widzów.' });
      return;
    }
    peers.set(msg.from, { name, ready: false, danceId: 0, spectator: true });
    netSend({ to: msg.from, t: 'joined', slot: -1, name, spectator: true });
    if (state === 'menu') setLanMsg(`${name} ogląda.`);
    else sendMatchTo(msg.from);
    afterSetupChange();
    return;
  }
  const seat = seatPeer(msg.from, msg.char);
  if (seat.err) {
    netSend({ to: msg.from, t: 'err', msg: seat.err });
    return;
  }
  peers.set(msg.from, { name, ready: false, danceId: 0 });
  netSend({ to: msg.from, t: 'joined', slot: seat.idx, name });
  netSend({ to: msg.from, t: 'charSet', char: seat.char });
  if (state === 'menu') setLanMsg(`${name} dołącza do gry.`);
  else sendMatchTo(msg.from); // mecz trwa: nowy gracz ogląda, zagra od następnego meczu
  afterSetupChange();
}

// Wolne miejsce i wolna postać dla gościa; zajmuje je od razu
function seatPeer(id, wantedChar) {
  const idx = setup.slots.findIndex(s => s.ctrl === 'off');
  if (idx < 0) return { err: 'Brak wolnych miejsc w grze. Możesz dołączyć jako widz.' };
  const char = freeChar(idx, wantedChar);
  if (!char) return { err: 'Brak wolnych postaci w grze.' };
  setup.slots[idx] = { ctrl: 'net' + id, char };
  return { idx, char };
}

// Dołączającemu w trakcie meczu wysyłamy skład i bieżącą rundę
function sendMatchTo(id) {
  netSend({ to: id, ...rosterMsg() });
  netSend({ to: id, ...roundMsg() });
}

// Gość zmienia rolę: widz chce grać albo gracz woli oglądać. Tylko w pokoju, między meczami
function hostOnRole(msg) {
  const p = peers.get(msg.from);
  if (!p) return;
  const want = !!msg.spectate;
  if (want === !!p.spectator) return;
  if (state !== 'menu') {
    netSend({ to: msg.from, t: 'err', msg: 'Rolę można zmienić w pokoju, między meczami.' });
    return;
  }
  if (want) {
    if (lobbySpectators().length >= MAX_SPECTATORS) {
      netSend({ to: msg.from, t: 'err', msg: 'Brak miejsc dla widzów.' });
      return;
    }
    for (const s of setup.slots) if (s.ctrl === 'net' + msg.from) s.ctrl = 'off';
    p.spectator = true;
    p.ready = false;
    netSend({ to: msg.from, t: 'joined', slot: -1, name: p.name, spectator: true });
    setLanMsg(`${p.name} będzie oglądać.`);
  } else {
    const seat = seatPeer(msg.from, msg.char);
    if (seat.err) {
      netSend({ to: msg.from, t: 'err', msg: seat.err });
      return;
    }
    p.spectator = false;
    p.ready = false;
    netSend({ to: msg.from, t: 'joined', slot: seat.idx, name: p.name, spectator: false });
    netSend({ to: msg.from, t: 'charSet', char: seat.char });
    setLanMsg(`${p.name} dołącza do gry.`);
  }
  afterSetupChange();
}

function hostOnLeave(msg) {
  const p = peers.get(msg.from);
  peers.delete(msg.from);
  netInputs.delete(msg.from);
  for (const s of setup.slots) if (s.ctrl === 'net' + msg.from) s.ctrl = 'off';
  // w trwającym meczu postać rozłączonego gracza odpada i nie wraca w kolejnych rundach
  for (const f of fighters) {
    if (f.ctrl.kind !== 'net' || f.ctrl.id !== msg.from) continue;
    f.gone = true;
    if (f.alive && state !== 'menu') killFighter(f, null, 0, 1);
  }
  if (p && state === 'menu') {
    setLanMsg(msg.kicked ? `${p.name} został wyrzucony z pokoju.` : p.spectator ? `${p.name} przestaje oglądać.` : `${p.name} wychodzi z gry.`);
  }
  afterSetupChange();
}

// Wiadomości od gości (przez serwer); inne typy niż poniższe są ignorowane
function hostMessage(msg) {
  if (msg.t === 'join') hostOnJoin(msg);
  else if (msg.t === 'leave') hostOnLeave(msg);
  else if (msg.t === 'role') hostOnRole(msg);
  else if (msg.t === 'char') {
    // zajętej lub zablokowanej postaci nie przyjmujemy; gracz dostaje swoją aktualną
    const idx = setup.slots.findIndex(s => s.ctrl === 'net' + msg.from);
    if (idx < 0) return;
    if (playable(msg.char) && !takenChars(idx).has(msg.char)) {
      setup.slots[idx].char = msg.char;
      afterSetupChange();
    }
    netSend({ to: msg.from, t: 'charSet', char: setup.slots[idx].char });
  } else if (msg.t === 'ready' || msg.t === 'dance') {
    const p = peers.get(msg.from);
    if (!p) return;
    if (msg.t === 'ready') p.ready = !!msg.v;
    else p.danceId = (p.danceId || 0) + 1;
    if (state === 'menu') renderMenu();
  } else if (msg.t === 'i') {
    // sterowanie tylko od graczy, którzy mają postać w trwającym meczu (nie od widzów)
    if (state === 'menu' || !fighters.some(f => f.ctrl.kind === 'net' && f.ctrl.id === msg.from && !f.gone)) return;
    let ni = netInputs.get(msg.from);
    if (!ni) netInputs.set(msg.from, ni = { queue: [], last: NO_INPUT, lastT: 0 });
    ni.lastT = clock.elapsedTime;
    const inp = { mx: clamp(+msg.mx || 0, -1, 1), mz: clamp(+msg.mz || 0, -1, 1), attack: !!msg.a, dash: !!msg.d, digital: !!msg.dg, dance: !!msg.dn };
    if (Number.isFinite(msg.ax) && Number.isFinite(msg.az)) {
      inp.aimX = msg.ax;
      inp.aimZ = msg.az;
    }
    queueInput(ni, inp);
  }
}

// Pokój bez botów: przy zakładaniu boty się wyłączają, po zamknięciu wracają
let slotsBeforeHosting = null;

function enterHosting() {
  // na tym urządzeniu gra jedna osoba: zostaje pierwszy wiersz „Ty”
  let me = false;
  for (const s of setup.slots) {
    if (s.ctrl !== 'me') continue;
    if (me) s.ctrl = 'off';
    me = true;
  }
  slotsBeforeHosting = setup.slots.map(s => ({ ctrl: s.ctrl, char: s.char }));
  for (const s of setup.slots) if (s.ctrl === 'bot') s.ctrl = 'off';
  if (!me) setup.slots[0].ctrl = 'me';
}

function leaveHosting() {
  for (const s of setup.slots) if (s.ctrl.startsWith('net')) s.ctrl = 'off';
  // boty wracają z dawną postacią, chyba że w pokoju zajął ją host: wtedy z wolną
  setup.slots.forEach((s, i) => {
    const before = slotsBeforeHosting?.[i];
    if (before?.ctrl !== 'bot' || s.ctrl !== 'off') return;
    const c = freeChar(i, before.char);
    if (!c) return;
    s.ctrl = 'bot';
    s.char = c;
  });
  slotsBeforeHosting = null;
}

function stopHosting() {
  netSend({ t: 'unhost' });
  net.role = null;
  peers.clear();
  netInputs.clear();
  kickedPeers.clear();
  leaveHosting();
  setLanMsg('');
  mode = 'online';
  showMenuPanel();
  renderLan();
  afterSetupChange();
}

// --- gracz sieciowy (klient) ---

function bySlot(s) {
  return fighters.find(f => f.slot === s);
}

function clientClearWorld() {
  clearRound();
  for (const o of [...cBooms.values(), ...cPus.values()]) {
    world.remove(o.mesh);
    disposeTree(o.mesh);
  }
  cBooms.clear();
  cPus.clear();
}

function showLobby() {
  clientClearWorld();
  state = 'menu';
  matchWinner = null;
  myFighterInRoster = false;
  menuEl.hidden = startEl.hidden = onlineEl.hidden = hudEl.hidden = endEl.hidden = pauseEl.hidden = boardEl.hidden = helpEl.hidden = clientEscEl.hidden = true;
  lobbyEl.hidden = false;
  hideCenter();
  buildArena({ ...LAYOUTS[0], blocks: [] });
  lineupKey = '';
  renderLobby();
}

let lobbyInfo = { host: '', players: [], spectators: [] };
let lineupKey = '';
// klient: czy w bieżącym meczu mam swoją postać (dołączający w trakcie i widzowie tylko oglądają)
let myFighterInRoster = false;

function renderLobby() {
  const players = lobbyInfo.players;
  const me = players.find(p => p.slot === mySlot);
  const full = players.length >= MAX_PLAYERS;
  $('lobRoom').textContent = `Pokój gracza ${lobbyInfo.host || '…'} · ${mySpectator ? 'oglądasz' : 'grasz'} jako ${myName}`;
  // widz nie wybiera postaci ani nie zgłasza gotowości
  $('lobPick').hidden = mySpectator;
  $('readyBtn').hidden = mySpectator;
  const watch = $('lobWatch');
  watch.hidden = !mySpectator;
  watch.textContent = full
    ? `Oglądasz. Wszystkie miejsca w grze (${MAX_PLAYERS}) są zajęte.`
    : 'Oglądasz. Możesz dołączyć do gry, dopóki jest wolne miejsce.';
  const roleBtn = $('roleBtn');
  roleBtn.textContent = mySpectator ? 'Chcę grać' : 'Tylko oglądam';
  roleBtn.disabled = mySpectator && full;
  if (!mySpectator) {
    // zajęte postacie wyszarzone; zablokowaną można obejrzeć, grasz ostatnią grywalną
    renderCharGrid($('lobGrid'), myChar, takenByName(players, mySlot), id => {
      myChar = id;
      if (playable(id)) {
        myPlayChar = id;
        netSend({ t: 'char', char: id });
      }
      renderLobby();
    });
    const note = $('lobLocked');
    note.hidden = myChar === myPlayChar;
    note.textContent = playable(myChar)
      ? `Postać ${CHAR_BY_ID[myChar].name} jest już zajęta. Zagrasz postacią: ${CHAR_BY_ID[myPlayChar].name}.`
      : `${CHAR_BY_ID[myChar].name} jest dostępny w DLC. Zagrasz postacią: ${CHAR_BY_ID[myPlayChar].name}.`;
  }
  renderPlayerList($('lobPlayers'), players, mySlot);
  const spect = lobbyInfo.spectators.map(s => ({ ...s, me: mySpectator && s.name === myName }));
  $('lobSpectWrap').hidden = !spect.length;
  renderSpectatorList($('lobSpectators'), spect);

  const ready = !!me?.ready;
  $('readyBtn').textContent = ready ? 'Cofnij gotowość' : 'Gotowe!';
  $('readyBtn').classList.toggle('on', ready);

  // podgląd: wszyscy gracze z pokoju w rzędzie (twoja postać tak, jak ją oglądasz); widzów nie widać
  const shown = players.map(p => ({ ...p, charId: p.slot === mySlot ? myChar : p.charId }));
  if (!mySpectator && !shown.some(p => p.slot === mySlot)) shown.push({ slot: mySlot, name: myName, charId: myChar });
  const key = shown.map(p => `${p.slot}:${p.charId}:${p.name}`).join('|');
  if (key !== lineupKey) {
    lineupKey = key;
    fighters.forEach(f => f.dispose());
    fighters = shown.map(p => new Fighter(p.slot, charOr(p.charId), { kind: 'remote', tag: p.name }));
    layoutLineup();
  }
  syncDancing(players);
}

// Postacie w podglądzie stoją w rzędzie przodem do kamery
function layoutLineup() {
  const n = fighters.length;
  fighters.forEach((f, i) => {
    f.reset(2.8 + (i - (n - 1) / 2) * 1.3, 1.5);
    f.facing = 0;
    f.wrap.rotation.y = 0;
    if (f.char.locked) addLockBadge(f);
  });
}

// --- dane od gospodarza ---
// Gospodarz to zwykła przeglądarka, więc jego wiadomości sprawdzamy jak każde inne z sieci:
// zły typ, nieznany identyfikator albo za duża lista nie mogą wywrócić gry u gościa
const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const num = v => numOr(v, 0);
const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');
const list = (v, max = 64) => (Array.isArray(v) ? v.slice(0, max) : []);
const slotOk = s => Number.isInteger(s) && s >= 0 && s < SLOT_COLORS.length;
const idOk = v => typeof v === 'number' || typeof v === 'string';
const SNAP_STATES = new Set(['countdown', 'play', 'roundOver', 'roundResult', 'matchEnd']);
const MAX_FIGHTERS = MAX_PLAYERS;

function cleanRows(rows) {
  return list(rows, MAX_FIGHTERS)
    .filter(r => r && typeof r === 'object')
    .map(r => ({ tag: str(r.tag, 16), name: str(r.name, 40), c: str(r.c, 40), sc: num(r.sc), rk: num(r.rk), w: !!r.w }));
}

function cleanPlayers(players) {
  return list(players, MAX_FIGHTERS)
    .filter(p => p && typeof p === 'object' && slotOk(p.slot))
    .map(p => ({
      slot: p.slot, name: str(p.name, 16), charId: str(p.charId, 40), color: str(p.color, 40),
      host: !!p.host, bot: !!p.bot, ready: !!p.ready, dance: num(p.dance),
    }));
}

function cleanEmit(a) {
  const o = a[5] && typeof a[5] === 'object' ? a[5] : {};
  const opts = { speed: numOr(o.speed, 4), size: numOr(o.size, 0.08), life: numOr(o.life, 1), up: numOr(o.up, 3), gravity: numOr(o.gravity, 14), dir: null };
  if (o.dir && typeof o.dir === 'object') opts.dir = { x: num(o.dir.x), z: num(o.dir.z) };
  const colors = list(a[4], 16).map(num);
  return [num(a[0]), num(a[1]), num(a[2]), Math.min(200, Math.max(0, num(a[3]))), colors.length ? colors : [0xffffff], opts];
}

function clientOnRoster(msg) {
  netMatch = {
    target: TARGETS.includes(msg.target) ? msg.target : 10,
    boom: Object.hasOwn(BOOM_LEVELS, msg.boom) ? msg.boom : 'normal',
  };
  fighters.forEach(f => f.dispose());
  const roster = list(msg.f, MAX_FIGHTERS).filter(d => d && typeof d === 'object' && slotOk(d.s));
  fighters = roster.map(d => new Fighter(d.s, charOr(d.c), { kind: 'remote', tag: str(d.tag, 16) }));
  // to moja postać tylko wtedy, gdy zgadza się miejsce i nick (dołączający w trakcie ogląda)
  myFighterInRoster = !mySpectator && roster.some(d => d.s === mySlot && d.tag === myName);
  $('watching').hidden = myFighterInRoster;
  menuEl.hidden = startEl.hidden = onlineEl.hidden = lobbyEl.hidden = endEl.hidden = pauseEl.hidden = clientEscEl.hidden = true;
  hudEl.hidden = false;
  matchWinner = null;
  state = 'countdown';
}

function clientOnRound(msg) {
  clientClearWorld();
  hideBoard();
  buildArena(Number.isInteger(msg.l) && LAYOUTS[msg.l] ? LAYOUTS[msg.l] : LAYOUTS[0]);
  roundNo = num(msg.n);
  for (const row of list(msg.p, MAX_FIGHTERS)) {
    if (!Array.isArray(row)) continue;
    const [s, , , alive] = row;
    const x = num(row[1]);
    const z = num(row[2]);
    const f = bySlot(s);
    if (!f) continue;
    f.reset(x, z);
    f.tx = x;
    f.tz = z;
    f.tf = f.facing;
    if (!alive) {
      f.alive = false;
      f.root.visible = false;
    }
  }
  updateScoreboard();
}

function applySnapshot(s) {
  if (!SNAP_STATES.has(s.st)) return; // zepsuta migawka
  state = s.st;
  // pauza hosta: u gościa ten sam ekran z napisem i przyciskiem „Rozłącz”
  pauseEl.hidden = !s.p;
  if (s.p) clientEscEl.hidden = true;
  let scoresChanged = false;
  for (const d of list(s.f, MAX_FIGHTERS)) {
    if (!Array.isArray(d)) continue;
    const f = bySlot(d[0]);
    if (!f) continue;
    f.tx = num(d[1]);
    f.tz = num(d[2]);
    f.vx = num(d[3]);
    f.vz = num(d[4]);
    f.tf = num(d[5]);
    f.aimAngle = num(d[6]);
    f.hasBoom = !!d[8];
    const charge = numOr(d[9], -1);
    f.charging = charge >= 0;
    f.pressT = TAP_TIME + Math.max(0, charge) * MAX_CHARGE;
    f.dashT = d[10] ? 0.1 : 0;
    const melee = num(d[11]);
    if (melee > 0 && f.meleeT <= 0) f.meleeT = melee;
    // -1 = bez limitu (tarcza)
    f.power = typeof d[12] === 'string' && Object.hasOwn(POWER_TYPES, d[12]) ? { type: d[12], t: numOr(d[16], -1) } : null;
    f.stunT = d[14] ? 0.1 : 0;
    // taniec startuje tylko, gdy u hosta się zaczyna; kończy się lokalnie po jednym przebiegu
    if (d[15] && !f.netEmote) {
      f.emote = true;
      f.emoteT = 0;
    }
    if (!d[15]) f.emote = false;
    f.netEmote = !!d[15];
    const score = num(d[13]);
    if (f.score !== score) {
      f.score = score;
      scoresChanged = true;
    }
    if (!d[7] && f.alive) {
      killVisuals(f, 1, 0);
      scoresChanged = true;
    }
  }

  const seenB = new Set();
  for (const row of list(s.b, 64)) {
    if (!Array.isArray(row) || !idOk(row[0])) continue;
    const [id, slot, , , drop, big] = row;
    const x = num(row[2]);
    const z = num(row[3]);
    seenB.add(id);
    let cb = cBooms.get(id);
    if (!cb) {
      const o = bySlot(slot);
      if (!o) continue;
      const mesh = makeBoomerangMesh(o.char, o.color);
      mesh.scale.setScalar((big ? 1.8 : 1) * boomLevel().size);
      mesh.position.set(x, 0.55, z);
      world.add(mesh);
      cb = { mesh, color: o.color };
      cBooms.set(id, cb);
    }
    Object.assign(cb, { tx: x, tz: z, drop: !!drop });
  }
  for (const [id, cb] of cBooms) {
    if (!seenB.has(id)) {
      world.remove(cb.mesh);
      disposeTree(cb.mesh);
      cBooms.delete(id);
    }
  }

  const seenU = new Set();
  for (const row of list(s.u, 32)) {
    if (!Array.isArray(row) || !idOk(row[0]) || typeof row[1] !== 'string' || !Object.hasOwn(POWER_TYPES, row[1])) continue;
    const [id, type] = row;
    seenU.add(id);
    if (cPus.has(id)) continue;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), powerMaterial(type));
    mesh.castShadow = true;
    mesh.position.set(num(row[2]), 0.7, num(row[3]));
    world.add(mesh);
    cPus.set(id, { mesh, t: 0 });
  }
  for (const [id, p] of cPus) {
    if (!seenU.has(id)) {
      world.remove(p.mesh);
      p.mesh.geometry.dispose();
      cPus.delete(id);
    }
  }

  if (scoresChanged) updateScoreboard();
}

function clientUpdate(rdt, time) {
  const k = 1 - Math.exp(-18 * rdt);
  for (const f of fighters) {
    if (state !== 'menu' && f.alive && f.tx !== undefined) {
      if (Math.hypot(f.tx - f.x, f.tz - f.z) > 3) {
        f.x = f.tx;
        f.z = f.tz;
      } else {
        f.x += (f.tx - f.x) * k;
        f.z += (f.tz - f.z) * k;
      }
      f.facing = lerpAngle(f.facing, f.tf, k);
      f.meleeT -= rdt;
    }
    animateFighter(f, rdt, time);
  }
  for (const cb of cBooms.values()) {
    const m = cb.mesh;
    m.position.x += (cb.tx - m.position.x) * k;
    m.position.z += (cb.tz - m.position.z) * k;
    m.position.y = cb.drop ? 0.08 : 0.55;
    if (!cb.drop) {
      m.rotation.y += rdt * 24;
      if (Math.random() < 0.4) emitLocal(m.position.x, 0.55, m.position.z, 1, [cb.color], { speed: 0.2, size: 0.05, life: 0.25, up: 0, gravity: 0 });
    }
  }
  for (const p of cPus.values()) {
    p.t += rdt;
    p.mesh.position.y = 0.7 + Math.sin(p.t * 3) * 0.12;
    p.mesh.rotation.set(0.4, p.mesh.rotation.y + rdt * 1.5, 0);
    p.mesh.scale.setScalar(Math.min(1, p.t * 3));
  }
  fx = fx.filter(e => {
    if (e.update(rdt)) return true;
    e.remove();
    return false;
  });
  if (state === 'matchEnd' && matchWinner?.char.id === 'pope' && Math.random() < 0.4) {
    emitLocal(matchWinner.x + rand(-0.3, 0.3), 2.4, matchWinner.z + rand(-0.3, 0.3), 1, [0xffffff, 0xf2f2f2], { speed: 0.4, size: 0.22, life: 2.5, up: 1.5, gravity: -0.6 });
  }
}

function sendClientInput(now) {
  // w pokoju i jako widz (dołączony w trakcie meczu) nie ma czym sterować
  if (state === 'menu' || !myFighterInRoster) return;
  const i = readLocal(bySlot(mySlot));
  const msg = { t: 'i', mx: r2(i.mx), mz: r2(i.mz), a: i.attack ? 1 : 0, d: i.dash ? 1 : 0, dg: i.digital ? 1 : 0, dn: i.dance ? 1 : 0 };
  if (i.aimX !== undefined) {
    const l = Math.hypot(i.aimX, i.aimZ) || 1;
    msg.ax = r2(i.aimX / l);
    msg.az = r2(i.aimZ / l);
  }
  const key = `${msg.mx},${msg.mz},${msg.a},${msg.d},${msg.dn},${msg.ax},${msg.az}`;
  const btn = `${msg.a},${msg.d},${msg.dn}`;
  if (key === lastSent && now - lastSentT < 0.1) return;
  // sam ruch kursora wysyłamy najwyżej 60 razy na sekundę; naciśnięcia zawsze od razu,
  // żeby nie przekroczyć limitu serwera i nie zgubić żadnego kliknięcia
  if (btn === lastBtn && now - lastSentT < 1 / 60) return;
  netSend(msg);
  lastSent = key;
  lastBtn = btn;
  lastSentT = now;
}

// Schowana karta lub okno bez fokusu: od razu puszczamy wszystko u hosta
function sendClientIdle() {
  if (net.role !== 'client' || state === 'menu' || !myFighterInRoster) return;
  netSend({ t: 'i', mx: 0, mz: 0, a: 0, d: 0, dn: 0 });
  lastSent = ''; // po powrocie bieżące sterowanie pójdzie od razu
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) sendClientIdle();
});
window.addEventListener('blur', sendClientIdle);

function clientMessage(msg) {
  switch (msg.t) {
    case 'roster': clientOnRoster(msg); break;
    case 'round': clientOnRound(msg); break;
    case 'snap': applySnapshot(msg); break;
    case 'kill': {
      const v = bySlot(msg.s);
      if (v?.alive) {
        killVisuals(v, num(msg.dx), num(msg.dz));
        updateScoreboard();
      }
      break;
    }
    case 'swoosh': {
      const f = bySlot(msg.s);
      if (f) {
        f.meleeT = MELEE_TIME;
        swooshFx(f, num(msg.r), num(msg.a));
      }
      break;
    }
    case 'sfx':
      // tylko własne dźwięki z audio.js (nie np. toString); argumenty to liczby albo flagi
      if (Object.hasOwn(localSfx, msg.n)) localSfx[msg.n](...list(msg.a, 4).map(v => (typeof v === 'boolean' ? v : num(v))));
      break;
    case 'emit': emitLocal(...cleanEmit(list(msg.a, 6))); break;
    case 'center': showCenter(str(msg.m), str(msg.s), !!msg.f); break;
    case 'hideCenter': hideCenter(); break;
    case 'end': {
      const w = bySlot(msg.s);
      if (w) {
        matchWinner = w;
        state = 'matchEnd';
        w.emote = true;
        showEnd(w, cleanRows(msg.d));
      }
      break;
    }
    case 'board':
      if (msg.d && typeof msg.d === 'object') showBoard({ title: str(msg.d.title), sub: str(msg.d.sub), rows: cleanRows(msg.d.rows) });
      break;
    case 'lobby': showLobby(); break;
    case 'lobbyState':
      lobbyInfo = {
        host: str(msg.host, 16),
        players: cleanPlayers(msg.players),
        spectators: list(msg.spectators, MAX_SPECTATORS).filter(s => s && typeof s === 'object').map(s => ({ name: str(s.name, 16) })),
      };
      if (state === 'menu' && !lobbyEl.hidden) renderLobby();
      break;
    case 'charSet':
      // nieznanej lub zablokowanej postaci nie przyjmujemy
      if (!playable(msg.char)) break;
      myPlayChar = msg.char;
      // podgląd zablokowanej postaci zostaje; poza tym pokazujemy to, czym faktycznie zagrasz
      if (playable(myChar)) myChar = msg.char;
      if (state === 'menu' && !lobbyEl.hidden) renderLobby();
      break;
  }
}

// --- wspólne ---

// Prośba o założenie pokoju lub dołączenie w toku: przyciski nieaktywne (najwyżej ~5 s)
function setNetBusy(on) {
  clearTimeout(netBusyTimer);
  netBusy = on;
  netBusyTimer = on ? setTimeout(() => setNetBusy(false), 5000) : 0;
  renderLan();
}

netOn(msg => {
  // pole "from" mają tylko wiadomości od gości przekazane przez serwer: trafiają wyłącznie do hosta
  if (msg.from !== undefined) {
    if (net.role === 'host') hostMessage(msg);
    return;
  }
  switch (msg.t) {
    case 'hello':
    case 'room':
      serverOk = true;
      net.room = msg.room;
      if (msg.t === 'hello') net.publicUrl = typeof msg.publicUrl === 'string' ? msg.publicUrl : '';
      renderLan();
      return;
    case 'publicUrl':
      net.publicUrl = typeof msg.url === 'string' ? msg.url : '';
      if (net.role === 'host') renderLan();
      return;
    case 'hosting':
      setNetBusy(false);
      // odpowiedź przyszła za późno: gracz już zmienił ekran
      if (state !== 'menu' || mode !== 'online') {
        netSend({ t: 'unhost' });
        return;
      }
      net.role = 'host';
      enterHosting();
      setLanMsg('');
      if (state === 'menu') {
        showMenuPanel();
        afterSetupChange(); // odświeża też podgląd: widać tylko twoją postać
      }
      return;
    case 'joined':
      setNetBusy(false);
      net.role = 'client';
      // przychodzi też przy zmianie roli (widz <-> gracz) w pokoju
      mySpectator = !!msg.spectator;
      mySlot = !mySpectator && slotOk(msg.slot) ? msg.slot : -1;
      myName = str(msg.name, 16) || myName;
      lobbyInfo = { host: net.room?.name || lobbyInfo.host || '', players: [], spectators: [] };
      document.body.classList.add('net-client');
      setLanMsg('');
      showLobby();
      return;
    case 'err':
      setNetBusy(false);
      setLanMsg(str(msg.msg, 200));
      return;
    case 'hostLeft':
      if (net.role === 'client') {
        net.role = null;
        goToMenu();
        setLanMsg('Host zakończył grę.');
      }
      return;
    case 'kicked':
      if (net.role === 'client') {
        net.role = null;
        goToMenu();
        setLanMsg('Gospodarz wyrzucił Cię z pokoju.');
      }
      return;
    case 'disconnected':
      // utracone połączenie odnawia sam net.js; po własnym rozłączeniu łączymy się od nowa
      // (bez roli), żeby panel sieciowy znów pokazywał pokój
      serverOk = false;
      net.room = null;
      setNetBusy(false);
      if (leaving) setTimeout(tryConnect, 300);
      if (msg.was === 'host') {
        peers.clear();
        netInputs.clear();
        leaveHosting();
        // także z widoku pokoju: wracamy do ekranu sieciowego (z „Zmień tryb”)
        mode = 'online';
        goToMenu();
        setLanMsg('Utracono połączenie z serwerem.');
      } else if (msg.was === 'client') {
        goToMenu();
        setLanMsg(leaving ? '' : 'Utracono połączenie z hostem.');
      }
      leaving = false;
      return;
  }
  // reszta to wiadomości od hosta do gości
  if (net.role === 'client') clientMessage(msg);
});

async function ensureConnected() {
  try {
    await netConnect();
    return true;
  } catch {
    setLanMsg('Brak serwera sieciowego. Uruchom grę poleceniem: node server.mjs');
    return false;
  }
}

function tryConnect() {
  netConnect().catch(() => {
    serverOk = false;
    renderLan();
  });
}

$('modeLocal').addEventListener('click', () => {
  mode = 'local';
  showMenuPanel();
});
$('modeOnline').addEventListener('click', () => {
  mode = 'online';
  showMenuPanel();
  renderLan();
  if (!nickEntered()) $('nick').focus();
});
for (const b of document.querySelectorAll('[data-back]')) {
  b.addEventListener('click', () => {
    mode = null;
    setLanMsg('');
    showMenuPanel();
  });
}

$('nick').addEventListener('input', () => {
  try { localStorage.setItem(NICK_KEY, $('nick').value.trim()); } catch { /* bez zapisu */ }
  renderLan();
});
$('nick').addEventListener('change', () => {
  if (state === 'menu') afterSetupChange();
});

$('hostBtn').addEventListener('click', async () => {
  if (!nickEntered() || netBusy) return;
  unlockAudio();
  setNetBusy(true);
  if (await ensureConnected()) netSend({ t: 'host', name: myNick() });
  else setNetBusy(false);
});
$('unhostBtn').addEventListener('click', stopHosting);

// Taniec (T): jeden, niezapętlony taniec; gość prosi o niego hosta
function toggleDance() {
  if (net.role === 'client') {
    if (!lobbyEl.hidden) netSend({ t: 'dance' });
    return;
  }
  hostDanceId++;
  renderMenu();
}
// Dołączenie do pokoju: jako gracz albo jako widz (bez miejsca w grze)
async function joinRoom(spectate) {
  if (!nickEntered() || netBusy) return;
  unlockAudio();
  myName = sanitizeName($('nick').value);
  const meSlot = setup.slots.find(s => s.ctrl === 'me') || setup.slots[0];
  myChar = meSlot.char;
  myPlayChar = playable(myChar) ? myChar : 'apple';
  setNetBusy(true);
  if (!(await ensureConnected())) {
    setNetBusy(false);
    return;
  }
  setLanMsg('Łączenie...');
  netSend({ t: 'join', name: myName, char: myPlayChar, spectate });
}
$('joinBtn').addEventListener('click', () => joinRoom(false));
$('spectateBtn').addEventListener('click', () => joinRoom(true));
$('readyBtn').addEventListener('click', () => {
  if (mySpectator) return;
  const me = lobbyInfo.players.find(p => p.slot === mySlot);
  netSend({ t: 'ready', v: !me?.ready });
});
// widz prosi o miejsce w grze, gracz oddaje swoje; host odpowiada nowym „joined” albo błędem
$('roleBtn').addEventListener('click', () => {
  setLanMsg('');
  netSend({ t: 'role', spectate: !mySpectator, char: myPlayChar });
});
$('leaveBtn').addEventListener('click', () => {
  leaving = true;
  netClose();
});
for (const id of ['clientLeave', 'pauseLeave', 'escLeave']) {
  $(id).addEventListener('click', () => {
    leaving = true;
    netClose();
  });
}
$('escBack').addEventListener('click', () => { clientEscEl.hidden = true; });

// ---------- Pętla gry ----------

const clock = new THREE.Clock();
let hudAcc = 0;

function update(dt, rdt, time) {
  stateT += rdt;

  // najpierw tytuł rundy, potem 3, 2, 1 i start
  if (state === 'countdown' && stateT > 0.9) {
    const n = 3 - Math.floor((stateT - 0.9) / 0.7);
    if (n !== lastCount) {
      lastCount = n;
      if (n > 0) {
        showCenter(String(n), layout.name);
        sfx.beep(false);
      } else {
        showCenter('Bumerang!', '', true);
        sfx.beep(true);
        state = 'play';
        stateT = 0;
      }
    }
  }
  checkRoundOver();

  if (state === 'play' || state === 'roundOver') {
    for (const f of fighters) {
      if (!f.alive) continue;
      const k = f.ctrl.kind;
      updateFighter(f, k === 'bot' ? botInput(f, dt) : k === 'net' ? netInput(f) : readLocal(f), dt);
    }
    separateFighters();
    updateBoomerangs(dt);
    updatePowerups(dt);
  }

  for (const f of fighters) animateFighter(f, dt, time);
  fx = fx.filter(e => {
    if (e.update(dt)) return true;
    e.remove();
    return false;
  });

  if (state === 'roundOver' && stateT > 1.6) finishRound();
  if (state === 'roundResult' && stateT > 3.6) {
    // wygrywa samodzielny lider, który osiągnął próg; remis na prowadzeniu = kolejna runda
    // gracze, którzy wyszli z meczu, się nie liczą
    const active = fighters.filter(f => !f.gone);
    const top = Math.max(...active.map(f => f.score));
    const leaders = active.filter(f => f.score === top);
    if (top >= setup.target && leaders.length === 1) endMatch(leaders[0]);
    else newRound();
  }
  if (state === 'matchEnd' && matchWinner?.char.id === 'pope' && Math.random() < 0.4) {
    emit(matchWinner.x + rand(-0.3, 0.3), 2.4, matchWinner.z + rand(-0.3, 0.3), 1, [0xffffff, 0xf2f2f2], { speed: 0.4, size: 0.22, life: 2.5, up: 1.5, gravity: -0.6 });
  }
}

function updateCamera(rdt) {
  const aspect = window.innerWidth / window.innerHeight;
  if (state === 'menu') {
    tmpV.copy(MENU_CAM);
    tmpL.copy(MENU_LOOK);
  } else {
    const k = Math.max(1, 1.5 / aspect);
    tmpV.set(0, 19.5 * k, 11.6 * k);
    tmpL.set(0, 0, 0.8);
  }
  const k = 1 - Math.exp(-4 * rdt);
  camPos.lerp(tmpV, k);
  camLook.lerp(tmpL, k);
  camera.position.copy(camPos);
  if (shake > 0.002) {
    camera.position.x += rand(-1, 1) * shake;
    camera.position.y += rand(-1, 1) * shake;
    camera.position.z += rand(-1, 1) * shake;
  }
  shake *= Math.exp(-10 * rdt);
  camera.lookAt(camLook);
}

function frame() {
  requestAnimationFrame(frame);
  const rdt = Math.min(0.05, clock.getDelta());
  const time = clock.elapsedTime;
  if (net.role === 'client') {
    // gracz sieciowy tylko wyświetla stan od hosta i wysyła swoje sterowanie
    clientUpdate(rdt, time);
    updateParticles(rdt);
    sendClientInput(time);
  } else {
    if (!paused) {
      let scale = 1;
      if (slowT > 0) {
        slowT -= rdt;
        scale = 0.3;
      }
      update(rdt * scale, rdt, time);
      updateParticles(rdt * scale);
    }
    if (net.role === 'host' && state !== 'menu') {
      snapAcc += rdt;
      if (snapAcc >= 1 / 30) {
        snapAcc = 0;
        netSend(makeSnapshot());
      }
    }
  }
  // licznik mocy na kartach graczy odświeżany kilka razy na sekundę
  hudAcc += rdt;
  if (hudAcc > 0.2 && state !== 'menu') {
    hudAcc = 0;
    updatePowerHud();
  }
  updateCamera(rdt);
  renderer.render(scene, camera);
}

// ---------- Start ----------

$('play').addEventListener('click', startMatch);
$('resume').addEventListener('click', togglePause);
$('quit').addEventListener('click', goToMenu);
$('again').addEventListener('click', startMatch);
$('toMenu').addEventListener('click', goToMenu);

goToMenu();
frame();
tryConnect();
