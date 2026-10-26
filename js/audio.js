// Proste efekty dźwiękowe generowane przez WebAudio (bez plików audio).

let ctx = null;
let master = null;
let noiseBuf = null;

// Głośność (0–1) i wyciszenie, zapamiętywane w przeglądarce
const SOUND_KEY = 'bumerangi-fu-sound';
let volume = 0.8;
let muted = false;
// Ustawienia zapisane pod starą nazwą gry przenosimy pod nową (do usunięcia za jakiś czas)
try {
  const old = localStorage.getItem('smartlunch-fu-sound');
  if (old !== null) {
    if (localStorage.getItem(SOUND_KEY) === null) localStorage.setItem(SOUND_KEY, old);
    localStorage.removeItem('smartlunch-fu-sound');
  }
} catch { /* brak zapisu */ }
try {
  const s = JSON.parse(localStorage.getItem(SOUND_KEY));
  if (s && Number.isFinite(s.volume)) volume = Math.min(1, Math.max(0, s.volume));
  if (s) muted = !!s.muted;
} catch { /* brak zapisu */ }

function applyVolume() {
  if (master) master.gain.value = muted ? 0 : volume * 0.6;
  try { localStorage.setItem(SOUND_KEY, JSON.stringify({ volume, muted })); } catch { /* bez zapisu */ }
}

export function getSound() {
  return { volume, muted };
}

export function setVolume(v) {
  volume = Math.min(1, Math.max(0, v));
  if (volume > 0) muted = false;
  applyVolume();
}

export function setMuted(m) {
  muted = !!m;
  applyVolume();
}

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    applyVolume();
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function tone(freq, dur, { type = 'sine', vol = 0.2, slide = 0, delay = 0, attack = 0.005 } = {}) {
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

function noise(dur, { vol = 0.2, freq = 1200, q = 1, type = 'bandpass', slide = 0, delay = 0 } = {}) {
  if (!ctx) return;
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t0 = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  if (slide) f.frequency.exponentialRampToValueAtTime(freq * slide, t0 + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur);
}

let lastWall = 0;

export const sfx = {
  throw: (p = 0.5) => noise(0.25 + p * 0.15, { vol: 0.25, freq: 600, slide: 3, q: 2 }),
  catch: () => {
    tone(660, 0.08, { type: 'triangle', vol: 0.15 });
    tone(990, 0.1, { type: 'triangle', vol: 0.12, delay: 0.05 });
  },
  melee: () => noise(0.15, { vol: 0.25, freq: 2000, slide: 0.4, q: 1.5 }),
  dash: () => noise(0.18, { vol: 0.18, freq: 400, slide: 2.5 }),
  clash: () => {
    tone(1400, 0.15, { type: 'square', vol: 0.08, slide: 0.7 });
    tone(2100, 0.1, { type: 'square', vol: 0.05 });
  },
  wall: () => {
    if (!ctx || ctx.currentTime - lastWall < 0.05) return;
    lastWall = ctx.currentTime;
    tone(220, 0.06, { type: 'triangle', vol: 0.12 });
  },
  splat: () => {
    noise(0.3, { vol: 0.4, freq: 900, slide: 0.3, q: 0.8, type: 'lowpass' });
    tone(140, 0.2, { vol: 0.3, slide: 0.5 });
  },
  bump: () => {
    tone(180, 0.14, { type: 'triangle', vol: 0.25, slide: 0.6 });
    noise(0.1, { vol: 0.2, freq: 500, q: 1 });
  },
  sizzle: () => noise(0.9, { vol: 0.18, freq: 4000, q: 0.7, type: 'highpass' }),
  shield: () => tone(500, 0.3, { vol: 0.2, slide: 2 }),
  power: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.12, { type: 'triangle', vol: 0.12, delay: i * 0.06 })),
  beep: hi => tone(hi ? 880 : 440, hi ? 0.4 : 0.15, { type: 'square', vol: 0.08 }),
  choir: () => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    tone(f, 2.2, { vol: 0.08, attack: 0.4, delay: i * 0.05 });
    tone(f * 1.005, 2.2, { type: 'triangle', vol: 0.03, attack: 0.5 });
  }),
  win: () => [523, 659, 784, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, { type: 'triangle', vol: 0.14, delay: i * 0.12 })),
};
