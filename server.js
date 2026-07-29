/**
 * server.js
 * Local-network authoritative WebSocket server for "Hide & Seek".
 * Run with: node server.js
 * Clients connect to ws://<HOST_LOCAL_IP>:8080
 */

const WebSocket = require('ws');
const os = require('os');
const dgram = require('dgram');

const PORT = process.env.PORT || 8080;
const DISCOVERY_PORT = 41234;
const HIDE_PHASE_SECONDS = 60;   // 1 minute hiding phase
const SEEK_PHASE_SECONDS = 300;  // 5 minute seeking phase
const SHOOT_RANGE = 6;           // world units
const MAX_PLAYERS = 10;

const wss = new WebSocket.Server({ port: PORT });

/** @type {Map<string, Player>} */
const players = new Map();

let gameState = 'LOBBY'; // LOBBY | HIDING | SEEKING | ROUND_OVER
let phaseTimer = null;
let phaseEndsAt = null;

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function broadcast(msg, exceptId = null) {
  const payload = JSON.stringify(msg);
  for (const [id, p] of players) {
    if (id === exceptId) continue;
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(payload);
  }
}

function publicPlayerList() {
  return [...players.values()].map(p => ({
    id: p.id,
    name: p.name,
    character: p.character,
    role: p.role,
    alive: p.alive,
    x: p.x, y: p.y, z: p.z,
    ry: p.ry
  }));
}

function resetRound() {
  gameState = 'LOBBY';
  clearTimeout(phaseTimer);
  phaseEndsAt = null;
  for (const p of players.values()) {
    p.role = null;
    p.alive = true;
    p.x = 0; p.y = 0; p.z = 0; p.ry = 0;
  }
}

function startRound() {
  const ids = [...players.keys()];
  if (ids.length < 2) return; // need at least 1 seeker + 1 hider

  const seekerIndex = Math.floor(Math.random() * ids.length);
  ids.forEach((id, i) => {
    const p = players.get(id);
    p.role = i === seekerIndex ? 'SEEKER' : 'HIDER';
    p.alive = true;
  });

  gameState = 'HIDING';
  phaseEndsAt = Date.now() + HIDE_PHASE_SECONDS * 1000;

  broadcast({
    type: 'ROUND_START',
    state: gameState,
    phaseEndsAt,
    players: publicPlayerList()
  });

  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(beginSeekingPhase, HIDE_PHASE_SECONDS * 1000);
}

function beginSeekingPhase() {
  gameState = 'SEEKING';
  phaseEndsAt = Date.now() + SEEK_PHASE_SECONDS * 1000;

  broadcast({
    type: 'SEEK_PHASE_START',
    state: gameState,
    phaseEndsAt
  });

  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(() => endRound('HIDERS_WIN_TIMEOUT'), SEEK_PHASE_SECONDS * 1000);
}

function checkForSeekerWin() {
  const hiders = [...players.values()].filter(p => p.role === 'HIDER');
  if (hiders.length > 0 && hiders.every(p => !p.alive)) {
    endRound('SEEKER_WINS');
  }
}

function endRound(reason) {
  gameState = 'ROUND_OVER';
  clearTimeout(phaseTimer);
  broadcast({ type: 'ROUND_OVER', reason, players: publicPlayerList() });
}

function distance3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: 'LOBBY_FULL' }));
    ws.close();
    return;
  }

  const id = makeId();
  const player = {
    id, ws, name: `Player-${id.slice(0, 4)}`,
    character: null, role: null, alive: true,
    x: 0, y: 0, z: 0, ry: 0
  };
  players.set(id, player);

  ws.send(JSON.stringify({
    type: 'WELCOME',
    id,
    state: gameState,
    phaseEndsAt,
    players: publicPlayerList()
  }));

  broadcast({ type: 'LOBBY_UPDATE', players: publicPlayerList() }, id);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const p = players.get(id);
    if (!p) return;

    switch (msg.type) {
      case 'SET_PROFILE': {
        p.name = String(msg.name || p.name).slice(0, 24);
        const requested = String(msg.character || '').slice(0, 40);
        if (requested && isCharacterTaken(requested, id)) {
          ws.send(JSON.stringify({ type: 'CHARACTER_TAKEN', character: requested }));
        } else if (requested) {
          p.character = requested;
        }
        broadcast({ type: 'LOBBY_UPDATE', players: publicPlayerList() });
        break;
      }

      case 'SELECT_CHARACTER': {
        const requested = String(msg.character || '').slice(0, 40);
        if (isCharacterTaken(requested, id)) {
          ws.send(JSON.stringify({ type: 'CHARACTER_TAKEN', character: requested }));
        } else {
          p.character = requested;
          broadcast({ type: 'LOBBY_UPDATE', players: publicPlayerList() });
        }
        break;
      }

      case 'START_GAME':
        if (gameState === 'LOBBY' || gameState === 'ROUND_OVER') {
          resetRound();
          startRound();
        }
        break;

      case 'MOVE':
        if (gameState === 'HIDING' || gameState === 'SEEKING') {
          // Seekers are blind/locked during HIDING phase — server enforces this.
          if (gameState === 'HIDING' && p.role === 'SEEKER') break;
          p.x = msg.x; p.y = msg.y; p.z = msg.z; p.ry = msg.ry;
          broadcast({ type: 'PLAYER_MOVED', id, x: p.x, y: p.y, z: p.z, ry: p.ry }, id);
        }
        break;

      case 'SHOOT':
        if (gameState === 'SEEKING' && p.role === 'SEEKER' && p.alive) {
          for (const target of players.values()) {
            if (target.role !== 'HIDER' || !target.alive) continue;
            if (distance3(p, target) <= SHOOT_RANGE) {
              target.alive = false;
              broadcast({ type: 'PLAYER_ELIMINATED', id: target.id, by: p.id });
              checkForSeekerWin();
              break; // one hit per shot
            }
          }
        }
        break;

      case 'PLAY_AGAIN':
        resetRound();
        broadcast({ type: 'LOBBY_RESET', players: publicPlayerList() });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'PLAYER_LEFT', id });
    broadcast({ type: 'LOBBY_UPDATE', players: publicPlayerList() });
    if (gameState === 'SEEKING') checkForSeekerWin();
  });
});

function isCharacterTaken(characterId, exceptPlayerId) {
  for (const p of players.values()) {
    if (p.id !== exceptPlayerId && p.character === characterId) return true;
  }
  return false;
}

function localIPs() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

// ---- LAN discovery: broadcast this lobby so the Android/macOS
// apps' "Browse Lobbies" can find it without typing an IP. ----
const discoverySocket = dgram.createSocket('udp4');
discoverySocket.bind(() => {
  discoverySocket.setBroadcast(true);
  setInterval(() => {
    const payload = Buffer.from(JSON.stringify({
      app: 'bagong-ilog-hideseek',
      name: 'Laptop-Hosted Lobby',
      players: players.size,
      maxPlayers: MAX_PLAYERS,
      port: PORT
    }));
    discoverySocket.send(payload, DISCOVERY_PORT, '255.255.255.255');
  }, 2000);
});

console.log(`Hide & Seek server listening on port ${PORT}`);
console.log('Have players connect their app to one of these Local IPs:');
localIPs().forEach(ip => console.log(`  ws://${ip}:${PORT}`));
