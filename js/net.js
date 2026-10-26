// Połączenie WebSocket z serwerem LAN (server.mjs).
// Po utracie nawiązanego połączenia sam próbuje połączyć się ponownie
// (1 s, 2 s, 4 s ... do 10 s), chyba że rozłączyliśmy się sami (netClose).

const RETRY_MIN = 1000;
const RETRY_MAX = 10000;
const CONNECT_TIMEOUT = 8000;

let ws = null;
let connecting = null; // obietnica trwającej próby połączenia
let retryTimer = null;
let retryDelay = RETRY_MIN;
let autoRetry = false; // włączane po utracie nawiązanego połączenia
const listeners = new Set();

export const net = { role: null, id: null, ips: [], port: 0 };

function emit(msg) {
  listeners.forEach(fn => {
    try {
      fn(msg);
    } catch (e) {
      console.error(e);
    }
  });
}

function clearRetry() {
  clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry() {
  clearRetry();
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (autoRetry) netConnect().catch(() => { /* kolejna próba zaplanowana w onclose */ });
  }, delay);
}

export function netConnect() {
  if (connecting) return connecting;
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve(net);
  clearRetry();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let sock;
  try {
    sock = new WebSocket(`${proto}://${location.host}/ws`);
  } catch (e) {
    if (autoRetry) scheduleRetry();
    return Promise.reject(e);
  }
  connecting = new Promise((resolve, reject) => {
    let ready = false;
    // połączenie, które nie doszło do skutku w rozsądnym czasie, przerywamy
    const timeout = setTimeout(() => {
      if (!ready) sock.close();
    }, CONNECT_TIMEOUT);
    sock.onmessage = e => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello' && !ready) {
        Object.assign(net, { id: msg.id, ips: Array.isArray(msg.ips) ? msg.ips.filter(ip => typeof ip === 'string') : [], port: msg.port });
        ready = true;
        clearTimeout(timeout);
        connecting = null;
        retryDelay = RETRY_MIN;
        resolve(net);
      }
      emit(msg);
    };
    sock.onerror = () => {
      if (!ready) reject(new Error('Brak serwera'));
    };
    sock.onclose = () => {
      clearTimeout(timeout);
      if (ws === sock) ws = null;
      if (!ready) {
        connecting = null;
        reject(new Error('Brak serwera'));
        if (autoRetry && !sock.byUser) scheduleRetry();
        return;
      }
      const was = net.role;
      net.role = null;
      // utracone połączenie: próbujemy dalej, chyba że to my się rozłączyliśmy
      autoRetry = !sock.byUser;
      if (autoRetry) {
        retryDelay = RETRY_MIN;
        scheduleRetry();
      }
      emit({ t: 'disconnected', was });
    };
    ws = sock;
  });
  return connecting;
}

export function netSend(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

export function netOn(fn) {
  listeners.add(fn);
}

export function netClose() {
  autoRetry = false;
  clearRetry();
  if (ws) {
    ws.byUser = true;
    ws.close();
  }
}
