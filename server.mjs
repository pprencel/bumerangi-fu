// Serwer gry w sieci lokalnej: serwuje pliki gry i przekazuje wiadomości
// WebSocket między hostem a graczami. Bez zależności, wystarczy Node 18+.
//
//   node server.mjs            (port 8080)
//   PORT=9000 node server.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const TUNNEL = process.argv.includes('--tunnel');

// ---------- Adres publiczny (do wysłania znajomym) ----------
// Ustawiany z PUBLIC_URL, z tunelu uruchomionego przez --tunnel albo wykrywany
// z nagłówka Host, gdy ktoś wejdzie przez tunel cloudflared/ngrok.

// Na Fly.io (zmienna FLY_APP_NAME) adres publiczny to https://<aplikacja>.fly.dev.
// HOSTED oznacza serwer w chmurze: nikt nie gra z nim w jednej sieci lokalnej,
// więc nie wysyłamy adresów LAN (byłyby to adresy wnętrza kontenera)
const HOSTED = Boolean(process.env.FLY_APP_NAME || process.env.HOSTED);
let publicUrl = process.env.PUBLIC_URL || (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : '');
const TUNNEL_HOST = /^[a-z0-9-]+\.(trycloudflare\.com|ngrok-free\.app|ngrok\.app|ngrok\.io)$/i;

function setPublicUrl(url) {
  if (publicUrl === url) return;
  publicUrl = url;
  if (url) console.log(`  W internecie:       ${url}`);
  const frame = encode(JSON.stringify({ t: 'publicUrl', url }));
  for (const c of clients.values()) sendRaw(c, frame);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Najwyżej tyle połączeń naraz: 6 graczy, obserwatorzy listy pokoi i ponowne łączenia.
// Więcej to raczej ktoś, kto chce zapchać serwer
const MAX_CONN = 32;

// adresy z sieci lokalnej (i pętli zwrotnej)
function isPrivate(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  return LOOPBACK.has(a) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|f[cd][0-9a-f]{2}:)/i.test(a);
}

// Adresy LAN dostaje tylko gracz z tej sieci; gość z internetu (przez tunel albo adres publiczny)
// nie ma po co znać układu Twojej sieci domowej
function lanAddressesFor(req) {
  if (HOSTED || TUNNEL_HOST.test(String(req.headers.host || '')) || !isPrivate(req.socket.remoteAddress)) return [];
  return lanAddresses();
}

// Nick gospodarza czyścimy tak samo jak gra: litery, cyfry, spacja, _ i -, najwyżej 8 znaków
function cleanName(s) {
  return (typeof s === 'string' ? s : '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 8) || 'Gość';
}

// Nagłówki bezpieczeństwa: skrypty i połączenia tylko z tego adresu, strony nie da się osadzić w ramce
function securityHeaders(req) {
  const host = String(req.headers.host || '').replace(/[^\w.:[\]-]/g, '');
  const ws = host ? ` ws://${host} wss://${host}` : '';
  return {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      `img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${ws}; ` +
      "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

// adres, przez który ostatnio faktycznie ktoś wszedł, wygrywa: stare tunele po restarcie przestają działać.
// Nagłówkowi Host ufamy tylko z tego komputera: stąd przychodzi ruch z cloudflared/ngrok,
// a ktoś z sieci mógłby nim podsunąć graczom cudzy adres
function notePublicHost(req) {
  if (HOSTED || !LOOPBACK.has(req.socket.remoteAddress)) return;
  const host = String(req.headers.host || '');
  if (TUNNEL_HOST.test(host)) setPublicUrl(`https://${host}`);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // nie-przeglądarka (np. skrypt testowy)
  try {
    return new URL(origin).host === String(req.headers.host || '');
  } catch {
    return false;
  }
}

// Limity dla gości: rozmiar wiadomości i liczba wiadomości na sekundę
const MAX_CLIENT_MSG = 4096;
const MAX_CLIENT_RATE = 150;

function overRate(c) {
  const now = Date.now();
  if (now - c.rateStart >= 1000) {
    c.rateStart = now;
    c.rateCount = 0;
  }
  return ++c.rateCount > MAX_CLIENT_RATE;
}

// --tunnel: uruchamia szybki tunel Cloudflare i wyłapuje jego adres
function startTunnel() {
  const proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.on('error', () => console.log('  Nie znaleziono programu cloudflared. Zainstaluj: brew install cloudflared'));
  let tunnelUrl = '';
  const onData = d => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) setPublicUrl(tunnelUrl = m[0]);
  };
  // tunel padł: jego adres już nie działa, więc go nie pokazujemy
  proc.on('exit', () => {
    console.log('  Tunel Cloudflare został zamknięty.');
    if (tunnelUrl && publicUrl === tunnelUrl) setPublicUrl('');
  });
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const stop = () => proc.kill();
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(0); });
  console.log('  Uruchamiam tunel Cloudflare…');
}
const SELF = fileURLToPath(import.meta.url);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 1 << 20; // największa wiadomość (także złożona z fragmentów)
const MAX_OUT = 4 << 20; // tyle może czekać w buforze wysyłki, potem rozłączamy
const PING_EVERY = 5000;
const TIMEOUT = 15000; // cisza dłuższa niż to = martwe połączenie
// Typy wiadomości, które gracz może przesłać hostowi
const FROM_CLIENT = new Set(['join', 'char', 'ready', 'dance', 'role', 'i']);
// Serwujemy wyłącznie pliki gry: stronę, skrypty, czcionki i obrazki.
// Reszta (dokumentacja, kod serwera, kopie zapasowe) daje 404
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(a => a && (a.family === 'IPv4' || a.family === 4) && !a.internal)
    .map(a => a.address);
}

// ---------- Pliki statyczne ----------

const server = http.createServer((req, res) => {
  notePublicHost(req);
  for (const [k, v] of Object.entries(securityHeaders(req))) res.setHeader(k, v);
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (rel.includes('\0')) {
    res.writeHead(400).end();
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, path.normalize(rel));
  // tylko pliki wewnątrz katalogu gry, bez ukrytych katalogów/plików i bez samego serwera
  if (!file.startsWith(ROOT + path.sep) || file === SELF ||
      path.relative(ROOT, file).split(path.sep).some(s => s.startsWith('.'))) {
    res.writeHead(403).end();
    return;
  }
  const notFound = () => res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nie znaleziono');
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) {
    notFound();
    return;
  }
  try {
    fs.readFile(file, (err, data) => {
      if (err) {
        notFound();
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch {
    notFound();
  }
});

// ---------- WebSocket ----------

const clients = new Map();
let nextId = 1;
let hostId = null;
let hostName = '';

// Informacja o pokoju dla wszystkich, którzy jeszcze do niego nie dołączyli
function roomInfo() {
  if (!clients.has(hostId)) return null;
  let players = 1;
  let spectators = 0;
  for (const c of clients.values()) {
    if (c.role !== 'client') continue;
    if (c.spectator) spectators++;
    else players++;
  }
  return { name: hostName, players, spectators };
}

function broadcastRoom() {
  const frame = encode(JSON.stringify({ t: 'room', room: roomInfo() }));
  for (const c of clients.values()) if (c.role === null) sendRaw(c, frame);
}

function encode(text) {
  const payload = Buffer.from(text);
  const n = payload.length;
  let header;
  if (n < 126) {
    header = Buffer.from([0x81, n]);
  } else if (n < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendRaw(c, frame) {
  const s = c.socket;
  if (s.destroyed) return;
  // odbiorca nie nadąża (albo nie odbiera): nie buforujemy w nieskończoność
  if (s.writableLength > MAX_OUT) {
    s.destroy();
    return;
  }
  s.write(frame);
}

function send(c, obj) {
  sendRaw(c, encode(JSON.stringify(obj)));
}

function broadcastClients(obj) {
  const frame = encode(JSON.stringify(obj));
  for (const c of clients.values()) if (c.role === 'client') sendRaw(c, frame);
}

server.on('upgrade', (req, socket) => {
  notePublicHost(req);
  const key = req.headers['sec-websocket-key'];
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !key) {
    socket.destroy();
    return;
  }
  // Obca strona WWW otwarta w przeglądarce gracza mogłaby połączyć się z serwerem:
  // przeglądarka zawsze dodaje Origin, więc musi on wskazywać ten sam adres, co Host
  if (!sameOrigin(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  if (clients.size >= MAX_CONN) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'));
  socket.setNoDelay(true);
  socket.setKeepAlive(true, PING_EVERY);

  const c = {
    id: nextId++, socket, role: null, buf: Buffer.alloc(0),
    frags: [], fragLen: 0, fragOp: null, lastSeen: Date.now(), rateStart: 0, rateCount: 0,
  };
  clients.set(c.id, c);
  socket.on('data', chunk => {
    try {
      onData(c, chunk);
    } catch (e) {
      console.error('Błąd obsługi połączenia:', e);
      socket.destroy();
    }
  });
  // serwer HTTP dopuszcza półotwarte gniazda: gdy druga strona zamknie (FIN), kończymy od razu
  socket.on('end', () => socket.destroy());
  socket.on('close', () => onClose(c));
  socket.on('error', () => socket.destroy());
  send(c, { t: 'hello', id: c.id, ips: lanAddressesFor(req), port: PORT, room: roomInfo(), publicUrl });
});

function onData(c, chunk) {
  c.lastSeen = Date.now();
  c.buf = Buffer.concat([c.buf, chunk]);
  while (c.buf.length >= 2 && !c.socket.destroyed) {
    const fin = (c.buf[0] & 0x80) !== 0;
    const op = c.buf[0] & 0x0f;
    const masked = (c.buf[1] & 0x80) !== 0;
    let len = c.buf[1] & 0x7f;
    let off = 2;
    // ramki od klienta muszą być maskowane (RFC 6455)
    if (!masked) {
      c.socket.destroy();
      return;
    }
    if (len === 126) {
      if (c.buf.length < 4) return;
      len = c.buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (c.buf.length < 10) return;
      len = Number(c.buf.readBigUInt64BE(2));
      off = 10;
    }
    // ramki sterujące: zawsze kompletne i najwyżej 125 bajtów
    if (len > MAX_MSG || (op >= 0x8 && (!fin || len > 125))) {
      c.socket.destroy();
      return;
    }
    const maskOff = off;
    off += 4;
    if (c.buf.length < off + len) return;
    const data = Buffer.from(c.buf.subarray(off, off + len));
    for (let i = 0; i < len; i++) data[i] ^= c.buf[maskOff + (i & 3)];
    c.buf = c.buf.subarray(off + len);

    if (op === 0x8) {
      c.socket.end(Buffer.from([0x88, 0]));
      return;
    }
    if (op === 0x9) {
      sendRaw(c, Buffer.concat([Buffer.from([0x8a, data.length]), data]));
      continue;
    }
    if (op === 0xa) continue; // pong: wystarczy, że odświeżył lastSeen
    if (op === 0x1 || op === 0x2) {
      // nowa wiadomość w trakcie poprzedniej pofragmentowanej to błąd protokołu
      if (c.fragOp !== null) {
        c.socket.destroy();
        return;
      }
      c.fragOp = op;
      c.frags = [];
      c.fragLen = 0;
    } else if (op !== 0x0 || c.fragOp === null) {
      c.socket.destroy(); // nieznany kod albo kontynuacja bez początku
      return;
    }
    c.fragLen += data.length;
    if (c.fragLen > MAX_MSG) {
      c.socket.destroy();
      return;
    }
    // binarnych wiadomości nie obsługujemy: pomijamy je razem z kontynuacjami
    if (c.fragOp === 0x1) c.frags.push(data);
    if (fin) {
      const isText = c.fragOp === 0x1;
      const text = isText ? Buffer.concat(c.frags).toString('utf8') : '';
      c.frags = [];
      c.fragLen = 0;
      c.fragOp = null;
      if (isText) onMessage(c, text);
    }
  }
}

function onMessage(c, text) {
  // gość przekraczający limity jest rozłączany, zanim cokolwiek trafi do hosta
  if (c.id !== hostId && (text.length > MAX_CLIENT_MSG || overRate(c))) {
    c.socket.destroy();
    return;
  }
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  // tylko zwykłe obiekty; null, liczby, napisy i tablice odrzucamy
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

  if (msg.t === 'host') {
    if (hostId !== null && hostId !== c.id && clients.has(hostId)) {
      send(c, { t: 'err', msg: 'Ktoś już hostuje grę na tym serwerze.' });
      return;
    }
    if (c.role === 'client' || c.role === 'pending') return;
    hostId = c.id;
    hostName = cleanName(msg.name);
    c.role = 'host';
    send(c, { t: 'hosting' });
    broadcastRoom();
    console.log(`${hostName} zakłada pokój`);
    return;
  }

  if (msg.t === 'unhost') {
    if (hostId === c.id) dropHost(c);
    return;
  }

  // Host: wiadomość do jednego gracza (pole "to") albo do wszystkich
  if (c.id === hostId) {
    if (msg.to) {
      const target = clients.get(msg.to);
      if (!target || target === c) return;
      sendRaw(target, encode(text));
      // odpowiedź hosta na prośbę o dołączenie rozstrzyga rolę gracza;
      // „joined” przychodzi też przy zmianie roli (gracz <-> widz) kogoś, kto już jest w pokoju
      if (msg.t === 'joined') {
        target.role = 'client';
        target.spectator = !!msg.spectator;
        broadcastRoom();
      } else if (target.role === 'pending' && msg.t === 'err') {
        target.role = null;
        send(target, { t: 'room', room: roomInfo() });
      }
      // wyrzucony gracz wraca do roli obserwatora listy pokoi
      if (msg.t === 'kicked' && target.role !== null) {
        target.role = null;
        send(target, { t: 'room', room: roomInfo() });
        broadcastRoom();
      }
    } else {
      const frame = encode(text);
      for (const o of clients.values()) if (o.role === 'client') sendRaw(o, frame);
    }
    return;
  }

  // Gracz: do hosta trafiają tylko dozwolone typy wiadomości
  if (!FROM_CLIENT.has(msg.t)) return;
  const host = clients.get(hostId);
  if (msg.t === 'join') {
    if (c.role === 'client' || c.role === 'pending') return;
    if (!host) {
      send(c, { t: 'err', msg: 'Nikt jeszcze nie hostuje gry.' });
      return;
    }
    // rola tymczasowa, dopóki host nie przyjmie (joined) albo nie odrzuci (err)
    c.role = 'pending';
  } else if (c.role !== 'client') {
    return;
  }
  if (!host) return;
  msg.from = c.id;
  send(host, msg);
}

function dropHost(c) {
  hostId = null;
  c.role = null;
  broadcastClients({ t: 'hostLeft' });
  for (const o of clients.values()) {
    if (o.role === 'pending') send(o, { t: 'err', msg: 'Host zakończył grę.' });
    if (o.role === 'client' || o.role === 'pending') o.role = null;
  }
  broadcastRoom();
  console.log('Pokój zamknięty');
}

function onClose(c) {
  if (!clients.has(c.id)) return;
  clients.delete(c.id);
  if (c.id === hostId) {
    dropHost(c);
  } else if (c.role === 'client' || c.role === 'pending') {
    // także przy "pending": host mógł już przydzielić miejsce
    const host = clients.get(hostId);
    if (host) send(host, { t: 'leave', from: c.id });
    if (c.role === 'client') broadcastRoom();
  }
}

// Ping co kilka sekund; kto długo milczy (uśpiony laptop, zerwane Wi-Fi), zostaje rozłączony
const PING = Buffer.from([0x89, 0]);
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) {
    if (now - c.lastSeen > TIMEOUT) c.socket.destroy();
    else sendRaw(c, PING);
  }
}, PING_EVERY);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Bumerangi Fu działa.');
  if (!HOSTED) {
    console.log(`  Na tym komputerze:  http://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  W sieci lokalnej:   http://${ip}:${PORT}`);
  }
  if (publicUrl) console.log(`  W internecie:       ${publicUrl}`);
  if (TUNNEL && !HOSTED) startTunnel();
});

// Chmura (Fly.io) zatrzymuje maszynę sygnałem SIGTERM: zamykamy gniazda od razu,
// żeby gracze dostali rozłączenie zamiast czekać na timeout
process.on('SIGTERM', () => {
  for (const c of clients.values()) c.socket.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
