/* global THREE */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';

// ============================================================
// FICTIONAL HIDER ROSTER — 13 characters, Filipino formalwear
// (barong for men, filipiniana for women)
// ============================================================
const CHARACTERS = [
  { id: 'chika',     name: 'Sen. Chika Ramos',      gender: 'F', color: 0xd6336c, accent: 0xffd43b },
  { id: 'marites',   name: 'Sen. Marites dela Cruz', gender: 'F', color: 0x862e9c, accent: 0xffe066 },
  { id: 'kalbo',     name: 'Sen. Bossing Kalbo',     gender: 'M', color: 0x2f6f4f, accent: 0xd4af37 },
  { id: 'tito',      name: 'Sen. Tito Moustachio',   gender: 'M', color: 0x1971c2, accent: 0xd4af37 },
  { id: 'smiley',    name: 'Sen. Smiley Santos',     gender: 'M', color: 0xf08c00, accent: 0xd4af37 },
  { id: 'spread',    name: 'Sen. Kuya Spreadsheet',  gender: 'M', color: 0x495057, accent: 0xd4af37 },
  { id: 'tsismosa',  name: 'Sen. Madam Tsismosa',    gender: 'F', color: 0xe64980, accent: 0xffd43b },
  { id: 'glamour',   name: 'Sen. Glamour Garcia',    gender: 'F', color: 0xae3ec9, accent: 0xffe066 },
  { id: 'bigote',    name: 'Sen. Mang Bigote',       gender: 'M', color: 0x5f3dc4, accent: 0xd4af37 },
  { id: 'memo',      name: 'Sen. Sir Memo',          gender: 'M', color: 0x087f5b, accent: 0xd4af37 },
  { id: 'attend',    name: 'Sen. Ate Attendance',    gender: 'F', color: 0xf76707, accent: 0xffd43b },
  { id: 'copypaste', name: 'Sen. Cong. Copy-Paste',  gender: 'M', color: 0x1864ab, accent: 0xd4af37 },
  { id: 'berto',     name: 'Sen. Budget Berto',      gender: 'M', color: 0x2b8a3e, accent: 0xd4af37 }
];
const MAX_PLAYERS = 10;

// House floor plan constants — shared between buildMap() (geometry)
// and the player movement code (floor-height resolution on stairs).
const FLOOR_HEIGHT = 5.6;
const STAIR_X_MIN = -3, STAIR_X_MAX = 3, STAIR_Z_MIN = 3, STAIR_Z_MAX = 9;
const HOUSE_X_MIN = -15.6, HOUSE_X_MAX = 15.6, HOUSE_Z_MIN = -12.6, HOUSE_Z_MAX = 12.6;

// Resolves how high the "ground" is beneath (x,z), and which floor the
// player is considered to be standing on. Two floors can share the same
// (x,z) footprint, so floor state persists once off the stairs rather
// than being derivable purely from position.
function resolveFloorHeight(x, z, currentFloor) {
  const onStairs = x >= STAIR_X_MIN && x <= STAIR_X_MAX && z >= STAIR_Z_MIN && z <= STAIR_Z_MAX;
  if (onStairs) {
    const t = THREE.MathUtils.clamp((z - STAIR_Z_MIN) / (STAIR_Z_MAX - STAIR_Z_MIN), 0, 1);
    return { height: t * FLOOR_HEIGHT, floor: t > 0.5 ? 1 : 0 };
  }
  return { height: currentFloor * FLOOR_HEIGHT, floor: currentFloor };
}

// ============================================================
// STATE
// ============================================================
let scene, camera, renderer, clock;
let ws = null;
let myId = null;
let myRole = null;
let myAlive = true;
let selectedCharacter = CHARACTERS[0].id;
let gameState = 'LOBBY';
let phaseEndsAt = null;

const remotePlayers = new Map(); // id -> { mesh, parts, kind, walkPhase, lastX, lastZ, data }
let localAvatarEntry = null; // { mesh, parts, kind, walkPhase }
const world = { colliders: [], raycastMeshes: [] }; // AABBs for movement collision + meshes for bullet raycasts
const tracers = [];      // active bullet-trail visuals
const impactMarks = [];  // active bullet-hit marks
let spectateTargetId = null; // which remote player an eliminated player is watching

const input = {
  move: { x: 0, y: 0, active: false }
};

// ============================================================
// DOM
// ============================================================
const el = (id) => document.getElementById(id);
const lobbyScreen = el('lobbyScreen');
const roundOverScreen = el('roundOverScreen');
const hud = el('hud');
const blindOverlay = el('blindOverlay');
const rolePill = el('rolePill');
const timerPill = el('timerPill');
const shootBtn = el('shootBtn');
const crosshair = el('crosshair');
const jumpBtn = el('jumpBtn');
const duckBtn = el('duckBtn');
const minimapCanvas = el('minimap');
const minimapCtx = minimapCanvas.getContext('2d');
const spectateBar = el('spectateBar');
const toast = el('toast');
const lobbyList = el('lobbyList');
const startBtn = el('startBtn');

function showToast(msg, ms = 2200) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), ms);
}

// ---- Character picker (live: reflects what's taken once connected) ----
let takenCharacters = {}; // characterId -> playerName (excludes this client's own pick)

function buildCharGrid() {
  const grid = el('charGrid');
  grid.innerHTML = '';
  CHARACTERS.forEach((c) => {
    const takenBy = takenCharacters[c.id];
    const isMine = c.id === selectedCharacter;
    const card = document.createElement('div');
    card.className = 'char-card' + (isMine ? ' selected' : '') + (takenBy && !isMine ? ' taken' : '');
    card.innerHTML = `<div class="char-avatar" style="background:#${c.color.toString(16).padStart(6,'0')}"></div>
                       <div class="char-name">${c.name}</div>
                       ${takenBy && !isMine ? `<div class="char-taken-label">${takenBy}</div>` : ''}`;
    if (!takenBy || isMine) {
      card.onclick = () => {
        selectedCharacter = c.id;
        if (ws && ws.readyState === WebSocket.OPEN) {
          send({ type: 'SELECT_CHARACTER', character: c.id });
        }
        buildCharGrid();
      };
    }
    grid.appendChild(card);
  });
}
buildCharGrid();

// ============================================================
// NETWORKING
// ============================================================
function connect(ip, name) {
  ws = new WebSocket(`ws://${ip}:8080`);

  ws.onopen = () => showToast('Connected to host!');
  ws.onclose = () => showToast('Disconnected from host.');
  ws.onerror = () => showToast('Could not reach host at ' + ip);

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleServerMessage(msg);
  };

  ws.addEventListener('open', () => {
    send({ type: 'SET_PROFILE', name, character: selectedCharacter });
    startBtn.classList.remove('hidden');
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'WELCOME':
      myId = msg.id;
      gameState = msg.state;
      phaseEndsAt = msg.phaseEndsAt;
      syncPlayerList(msg.players);
      renderLobbyList(msg.players);
      updateTakenCharacters(msg.players);
      updateStartButtonState(msg.players.length);
      break;

    case 'LOBBY_UPDATE':
      renderLobbyList(msg.players);
      updateTakenCharacters(msg.players);
      updateStartButtonState(msg.players.length);
      break;

    case 'CHARACTER_TAKEN':
      showToast(`That character was just taken by someone else — pick another!`);
      break;

    case 'LOBBY_FULL':
      showToast('This lobby is full (10/10 players). Try another one.');
      break;

    case 'PLAYER_JOINED':
    case 'PLAYER_UPDATED':
      // superseded by LOBBY_UPDATE, which carries the full roster
      break;

    case 'PLAYER_LEFT':
      removeRemotePlayer(msg.id);
      if (!myAlive && msg.id === spectateTargetId) cycleSpectateTarget(1);
      break;

    case 'ROUND_START':
      gameState = msg.state;
      phaseEndsAt = msg.phaseEndsAt;
      syncPlayerList(msg.players);
      enterGameView();
      break;

    case 'SEEK_PHASE_START':
      gameState = msg.state;
      phaseEndsAt = msg.phaseEndsAt;
      blindOverlay.classList.add('hidden');
      showToast('The Seeker has been released! 🚨');
      break;

    case 'PLAYER_MOVED': {
      const rp = remotePlayers.get(msg.id);
      if (rp) {
        rp.mesh.position.set(msg.x, msg.y, msg.z);
        rp.mesh.rotation.y = msg.ry;
      }
      break;
    }

    case 'PLAYER_ELIMINATED': {
      const rp = remotePlayers.get(msg.id);
      if (rp) rp.mesh.visible = false;
      if (msg.id === myId) {
        myAlive = false;
        if (localAvatarEntry) localAvatarEntry.mesh.visible = false;
        updateAliveUI();
        showToast('You were caught! 👮 You can spectate.');
      } else {
        if (!myAlive && msg.id === spectateTargetId) cycleSpectateTarget(1);
        showToast('A hider was caught!');
      }
      break;
    }

    case 'ROUND_OVER':
      gameState = 'ROUND_OVER';
      showRoundOver(msg.reason);
      break;

    case 'LOBBY_RESET':
      resetToLobby(msg.players);
      break;
  }
}

function syncPlayerList(list) {
  list.forEach((p) => {
    if (p.id === myId) {
      const roleChanged = myRole !== p.role;
      myRole = p.role;
      myAlive = p.alive;
      applyRoleUI();
      if (roleChanged) rebuildLocalAvatar();
      if (localAvatarEntry) localAvatarEntry.mesh.visible = myAlive;
      return;
    }
    const desiredKind = p.role === 'SEEKER' ? 'seeker' : (p.character || CHARACTERS[0].id);
    let rp = remotePlayers.get(p.id);
    if (!rp || rp.kind !== desiredKind) {
      if (rp) scene.remove(rp.mesh);
      const built = buildAvatar(desiredKind);
      scene.add(built.group);
      rp = {
        mesh: built.group, parts: built.parts, kind: desiredKind,
        walkPhase: 0, lastX: p.x || 0, lastZ: p.z || 0, data: p
      };
      remotePlayers.set(p.id, rp);
    }
    rp.mesh.visible = p.alive !== false;
    rp.mesh.position.set(p.x || 0, p.y || 0, p.z || 0);
    rp.data = p;
  });
}

function removeRemotePlayer(id) {
  const rp = remotePlayers.get(id);
  if (rp) {
    scene.remove(rp.mesh);
    remotePlayers.delete(id);
  }
}

// Animates every remote player's walk cycle by estimating speed from
// how far their mesh moved since the last frame (their movement comes
// in via network updates, not local input, so we infer speed instead).
function updateRemoteWalkAnimations(dt) {
  remotePlayers.forEach((rp) => {
    if (!rp.mesh.visible) return;
    const dx = rp.mesh.position.x - rp.lastX;
    const dz = rp.mesh.position.z - rp.lastZ;
    const dist = Math.hypot(dx, dz);
    const speedFraction = dt > 0 ? Math.min(1, (dist / dt) / MOVE_SPEED) : 0;
    updateWalkAnimation(rp, dt, speedFraction);
    rp.lastX = rp.mesh.position.x;
    rp.lastZ = rp.mesh.position.z;
  });
}

function updateTakenCharacters(list) {
  takenCharacters = {};
  list.forEach((p) => {
    if (p.character && p.id !== myId) takenCharacters[p.character] = p.name || 'Taken';
  });
  buildCharGrid();
}

function updateStartButtonState(count) {
  startBtn.textContent = `Start Round (Host) — ${count}/${MAX_PLAYERS} players`;
  startBtn.disabled = count < 2;
}

function renderLobbyList(list) {
  const charName = (id) => (CHARACTERS.find((c) => c.id === id) || {}).name;
  lobbyList.innerHTML = `<b>Players (${list.length}/${MAX_PLAYERS}):</b><br/>` +
    list.map((p) => `• ${p.name}${p.character ? ' — ' + charName(p.character) : ' (choosing character…)'}`).join('<br/>');
}

function resetToLobby(list) {
  gameState = 'LOBBY';
  myRole = null;
  myAlive = true;
  hud.classList.add('hidden');
  roundOverScreen.classList.add('hidden');
  lobbyScreen.classList.remove('hidden');
  renderLobbyList(list || []);
  updateTakenCharacters(list || []);
  updateStartButtonState((list || []).length);
  clearBulletVfx();
}

function clearBulletVfx() {
  tracers.forEach((t) => scene.remove(t.mesh));
  tracers.length = 0;
  impactMarks.forEach((m) => scene.remove(m.mesh));
  impactMarks.length = 0;
}

// ============================================================
// THREE.JS SETUP
// ============================================================
// ============================================================
// PROCEDURAL TEXTURES — generated on-device via <canvas>, so the
// map has real surface detail without depending on any external
// image CDN (keeps the app reliable on flaky Wi-Fi).
// ============================================================
function makeCanvasTexture(draw, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeGrassTexture() {
  return makeCanvasTexture((ctx, s) => {
    ctx.fillStyle = '#5f8a4f';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 700; i++) {
      const shade = Math.random() * 35;
      ctx.fillStyle = `rgba(${60 + shade},${110 + shade},${55 + shade * 0.5},0.5)`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
  }, 128);
}

function makeAsphaltTexture() {
  return makeCanvasTexture((ctx, s) => {
    ctx.fillStyle = '#2c2c2e';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 400; i++) {
      const v = 30 + Math.random() * 25;
      ctx.fillStyle = `rgba(${v},${v},${v},0.4)`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1.5, 1.5);
    }
    ctx.fillStyle = '#e9c46a';
    const dashW = s * 0.08, gap = s * 0.07;
    for (let x = 0; x < s; x += dashW + gap) ctx.fillRect(x, s / 2 - 3, dashW, 6);
  }, 256);
}

function makeSidewalkTexture() {
  return makeCanvasTexture((ctx, s) => {
    ctx.fillStyle = '#a3a39a';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 2;
    const tiles = 5;
    for (let i = 0; i <= tiles; i++) {
      const p = i * (s / tiles);
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(s, p); ctx.stroke();
    }
  }, 128);
}

// Shared window-grid texture; tinted per-building via material.color.
function makeWindowTexture() {
  return makeCanvasTexture((ctx, s) => {
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(0, 0, s, s);
    const cols = 4, rows = 4;
    const pad = s * 0.08;
    const cw = (s - pad * (cols + 1)) / cols;
    const ch = (s - pad * (rows + 1)) / rows;
    ctx.fillStyle = 'rgba(140,190,215,0.9)';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillRect(pad + c * (cw + pad), pad + r * (ch + pad), cw, ch);
      }
    }
  }, 256);
}

function makeSignTexture(lines, bg = '#0d5c2c', fg = '#ffffff') {
  return makeCanvasTexture((ctx, s) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#ffd60a';
    ctx.lineWidth = s * 0.03;
    ctx.strokeRect(s * 0.03, s * 0.03, s * 0.94, s * 0.94);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lineHeight = s / (lines.length + 1);
    lines.forEach((line, i) => {
      ctx.font = `bold ${Math.floor(s * 0.11)}px sans-serif`;
      ctx.fillText(line, s / 2, lineHeight * (i + 1));
    });
  }, 256);
}

function makeFlagTexture() {
  // Simplified Philippine flag: white hoist triangle with a sun,
  // blue over red field.
  return makeCanvasTexture((ctx, s) => {
    ctx.fillStyle = '#0038a8';
    ctx.fillRect(0, 0, s, s / 2);
    ctx.fillStyle = '#ce1126';
    ctx.fillRect(0, s / 2, s, s / 2);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(s * 0.42, s / 2); ctx.lineTo(0, s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fcd116';
    ctx.beginPath();
    ctx.arc(s * 0.16, s / 2, s * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }, 128);
}

function makeFaceTexture() {
  // Transparent-background decal: eyes, brows, and a smile, mounted on
  // the front of each character's head sphere.
  return makeCanvasTexture((ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = '#241a12';
    ctx.beginPath(); ctx.arc(s * 0.34, s * 0.44, s * 0.085, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(s * 0.66, s * 0.44, s * 0.085, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(s * 0.365, s * 0.42, s * 0.02, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(s * 0.685, s * 0.42, s * 0.02, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#2a1a10';
    ctx.lineWidth = s * 0.03;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(s * 0.24, s * 0.29); ctx.lineTo(s * 0.44, s * 0.26); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s * 0.56, s * 0.26); ctx.lineTo(s * 0.76, s * 0.29); ctx.stroke();
    ctx.strokeStyle = '#7a2e20';
    ctx.lineWidth = s * 0.035;
    ctx.beginPath(); ctx.arc(s * 0.5, s * 0.52, s * 0.19, 0.12 * Math.PI, 0.88 * Math.PI); ctx.stroke();
  }, 160);
}

function makeWoodFloorTexture() {
  return makeCanvasTexture((ctx, s) => {
    ctx.fillStyle = '#a9784f';
    ctx.fillRect(0, 0, s, s);
    const planks = 6;
    for (let i = 0; i < planks; i++) {
      const y = (i * s) / planks;
      ctx.fillStyle = i % 2 === 0 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(0, y, s, s / planks);
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
    }
    for (let i = 0; i < 200; i++) {
      ctx.fillStyle = `rgba(70,45,25,${0.05 + Math.random() * 0.1})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 12, 1);
    }
  }, 128);
}

function makeWallTexture() {
  return makeCanvasTexture((ctx, s) => {
    ctx.fillStyle = '#e9e2d0';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 300; i++) {
      const v = Math.random() * 12;
      ctx.fillStyle = `rgba(${180 - v},${170 - v},${150 - v},0.15)`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 3, 3);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1;
    ctx.strokeRect(4, 4, s - 8, s - 8); // subtle wainscot/panel line
  }, 128);
}

let TEX = null; // populated once in initScene()

function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1c1712);
  scene.fog = new THREE.Fog(0x1c1712, 40, 90);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);

  renderer = new THREE.WebGLRenderer({ canvas: el('gameCanvas'), antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;

  const hemi = new THREE.HemisphereLight(0xfff2d9, 0x6b5a4a, 1.3);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d5, 1.1);
  sun.position.set(20, 30, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -20;
  sun.shadow.camera.right = 20;
  sun.shadow.camera.top = 20;
  sun.shadow.camera.bottom = -20;
  scene.add(sun);

  TEX = {
    floorWood: makeWoodFloorTexture(),
    wall: makeWallTexture(),
    tile: makeSidewalkTexture(),
    window: makeWindowTexture(),
    face: makeFaceTexture(),
    signLiving: makeSignTexture(['LIVING ROOM'], '#5c3d2e', '#ffffff'),
    signKitchen: makeSignTexture(['KITCHEN'], '#5c3d2e', '#ffffff'),
    signBed1: makeSignTexture(['BEDROOM 1'], '#5c3d2e', '#ffffff'),
    signBed2: makeSignTexture(['BEDROOM 2'], '#5c3d2e', '#ffffff')
  };

  buildMap();

  clock = new THREE.Clock();
  window.addEventListener('resize', onResize);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function addCollider(mesh) {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  world.colliders.push(box);
}

function box(w, h, d, color, x, y, z, castShadow = true) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color })
  );
  m.position.set(x, y, z);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  scene.add(m);
  world.raycastMeshes.push(m);
  return m;
}

// Box with a shared canvas texture applied (window grid, signage, etc.),
// optionally tinted via `tint` (multiplies the texture's colors).
function texturedBox(w, h, d, x, y, z, { map, tint = 0xffffff, castShadow = true, repeatU = 2, repeatV = 2 } = {}) {
  let material;
  if (map) {
    const tex = map.clone();
    tex.needsUpdate = true;
    tex.repeat.set(repeatU, repeatV);
    material = new THREE.MeshStandardMaterial({ map: tex, color: tint });
  } else {
    material = new THREE.MeshStandardMaterial({ color: tint });
  }
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  scene.add(m);
  world.raycastMeshes.push(m);
  return m;
}

// A single flat, non-repeating plane for signage/plaques (front-facing).
function signPlane(w, h, x, y, z, map, rotationY = 0) {
  const tex = map.clone();
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.position.set(x, y, z);
  m.rotation.y = rotationY;
  scene.add(m);
  return m;
}

// A ground/road-style plane with a repeating canvas texture applied.
function texturedPlane(w, h, x, y, z, map, repeatU, repeatV, rotationX = -Math.PI / 2) {
  const tex = map.clone();
  tex.needsUpdate = true;
  tex.repeat.set(repeatU, repeatV);
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.rotation.x = rotationX;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  scene.add(m);
  world.raycastMeshes.push(m);
  return m;
}

// Box that also registers as a movement collider (walls, big furniture).
function wallBox(w, h, d, color, x, y, z) {
  const m = box(w, h, d, color, x, y, z);
  addCollider(m);
  return m;
}

function addLampFixture(x, y, z) {
  const fixture = box(0.7, 0.25, 0.7, 0xfff3b0, x, y, z, false);
  fixture.material.emissive = new THREE.Color(0xfff3b0);
  fixture.material.emissiveIntensity = 0.8;
}

// ---- Map: interior of a two-story house — the whole game now takes
// place indoors, with a walkable staircase connecting the floors. ----
function buildMap() {
  buildFloor(0, 'GROUND');
  buildStaircase();
  buildFloor2Slab();
  buildFloor(FLOOR_HEIGHT, 'UPPER');

  // Roof cap (purely visual — players can't jump high enough to reach it)
  box(HOUSE_X_MAX * 2 + 0.6, 0.3, HOUSE_Z_MAX * 2 + 0.6, 0x5c3d2e, 0, FLOOR_HEIGHT * 2 + 0.15, 0, false);
}

function buildFloor(baseY, level) {
  const wallH = FLOOR_HEIGHT;
  const y = baseY + wallH / 2;

  // Floor surface — ground floor is a solid plane; the upper floor's
  // surface is built separately (buildFloor2Slab), with a gap left
  // open over the stairwell, so it's deliberately NOT drawn here.
  if (level === 'GROUND') {
    texturedPlane(HOUSE_X_MAX * 2, HOUSE_Z_MAX * 2, 0, baseY + 0.01, 0, TEX.floorWood, 10, 8);
  }

  // Exterior walls
  wallBox(HOUSE_X_MAX * 2 + 0.6, wallH, 0.3, 0xe9e2d0, 0, y, HOUSE_Z_MIN);
  wallBox(HOUSE_X_MAX * 2 + 0.6, wallH, 0.3, 0xe9e2d0, 0, y, HOUSE_Z_MAX);
  wallBox(0.3, wallH, HOUSE_Z_MAX * 2 + 0.6, 0xe9e2d0, HOUSE_X_MIN, y, 0);
  wallBox(0.3, wallH, HOUSE_Z_MAX * 2 + 0.6, 0xe9e2d0, HOUSE_X_MAX, y, 0);

  // Central divider wall (front rooms), with a doorway gap
  wallBox(0.25, wallH, 6.5, 0xe9e2d0, 0, y, -9.75);
  wallBox(0.25, wallH, 6.5, 0xe9e2d0, 0, y, -0.25);

  // Foyer/hallway pinch near the front entrance — narrows the entry
  // into a proper hall before opening into the wider rooms beyond
  wallBox(0.25, wallH, 3.6, 0xe9e2d0, -3, y, -10.8);
  wallBox(0.25, wallH, 3.6, 0xe9e2d0, 3, y, -10.8);

  // A few ceiling lamps for atmosphere
  addLampFixture(-8, baseY + wallH - 0.3, -6);
  addLampFixture(8, baseY + wallH - 0.3, -6);
  addLampFixture(0, baseY + wallH - 0.3, 11);

  if (level === 'GROUND') {
    // --- Living room (front-left) ---
    signPlane(2.2, 0.6, -8, 3.6, HOUSE_Z_MIN + 0.05, TEX.signLiving, 0);
    wallBox(3.2, 1, 1.1, 0x6d597a, -11, 0.5, -11); // sofa
    wallBox(2, 0.6, 0.5, 0x2b2b2b, -14.5, 0.3, -6); // TV stand
    wallBox(1.4, 0.5, 0.8, 0x8a6c4a, -9, 0.25, -8); // coffee table
    wallBox(0.4, 2, 2, 0x5c3d2e, -15.5, 1, -2); // bookshelf
    wallBox(1, 1, 1, 0x557153, -13, 0.5, -9); // armchair
    wallBox(0.5, 1.6, 0.5, 0x2f6f4f, -9, 0.8, -5.2); // floor plant
    wallBox(0.4, 2, 1.4, 0x5c3d2e, -2.6, 1, -11); // side cabinet by the divider

    // --- Kitchen / dining (front-right) ---
    signPlane(2.2, 0.6, 8, 3.6, HOUSE_Z_MIN + 0.05, TEX.signKitchen, 0);
    wallBox(7, 1, 0.8, 0xced4da, 9.3, 0.5, -12.3); // counter
    wallBox(1, 2, 1, 0xf1f3f5, 14.5, 1, -10.5); // fridge
    wallBox(2.4, 0.8, 1.4, 0x8a6c4a, 6, 0.4, -3); // dining table
    for (const cx of [4.9, 7.1]) for (const cz of [-3.9, -2.1]) {
      wallBox(0.5, 0.8, 0.5, 0x6d597a, cx, 0.4, cz); // chairs
    }
    wallBox(1, 2.2, 0.6, 0xced4da, 15, 1.1, -6); // pantry cabinet
    wallBox(2, 0.9, 1, 0xced4da, 10, 0.45, -7); // kitchen island
    wallBox(0.4, 0.6, 0.4, 0x495057, 13.5, 0.3, -12.5); // trash bin

    // --- Back rooms: enclosed bathroom (left) + laundry (right of it) + storage (far right) ---
    wallBox(0.25, wallH, 4, 0xe9e2d0, 0, y, 11); // divider: laundry vs storage
    wallBox(0.25, wallH, 4, 0xe9e2d0, -8, y, 11); // divider: bathroom vs laundry
    wallBox(4.6, wallH, 0.25, 0xe9e2d0, -13, y, 9);   // bathroom front wall, west segment
    wallBox(0.8, wallH, 0.25, 0xe9e2d0, -8.4, y, 9);  // bathroom front wall, east segment (door gap between)
    wallBox(0.6, 0.8, 0.6, 0xffffff, -11, 0.4, 11); // toilet
    wallBox(0.8, 0.9, 0.5, 0xffffff, -13, 0.45, 11.7); // sink
    wallBox(1.8, 0.7, 3, 0xffffff, -10, 0.35, 10.5); // tub
    wallBox(1.2, 1.8, 0.5, 0x8a6c4a, -15, 0.9, 12); // shelving unit

    wallBox(1, 1.2, 1, 0xadb5bd, 10, 0.6, 11.5); // washing machine
    wallBox(1.4, 1.4, 1.4, 0x8a6c4a, 6.5, 0.7, 11); // stacked crates
    wallBox(1.4, 1, 1.4, 0x8a6c4a, 13, 0.5, 10.5); // more crates
    wallBox(1, 1, 1, 0x8a6c4a, 8, 0.5, 12.5); // extra crates
    wallBox(0.6, 1, 0.6, 0xadb5bd, 12, 0.5, 9.5); // utility bin
  } else {
    // --- Hallway pinch mirrors the foyer below, leading to the bedroom wing ---
    wallBox(0.25, wallH, 0.25, 0xe9e2d0, -3, y, -9); // hall post (visual anchor)
    wallBox(0.25, wallH, 0.25, 0xe9e2d0, 3, y, -9);

    // --- Home office, split off from Bedroom 2 ---
    wallBox(0.25, wallH, 3.6, 0xe9e2d0, 11, y, -1.2);
    wallBox(1.4, 1, 0.6, 0x8a6c4a, 13.5, baseY + 0.5, 0.5); // office desk
    wallBox(0.6, 1, 0.6, 0x557153, 13.5, baseY + 0.5, 2); // office chair
    wallBox(0.4, 2, 1.4, 0x5c3d2e, 15.3, baseY + 1, 1); // filing cabinet
    // --- Bedroom 1 (front-left) ---
    signPlane(2.2, 0.6, -8, baseY + 3.6, HOUSE_Z_MIN + 0.05, TEX.signBed1, 0);
    wallBox(2, 0.6, 3, 0x94a89a, -11, baseY + 0.3, -9); // bed
    wallBox(0.6, 2.2, 2, 0x5c3d2e, -15.5, baseY + 1.1, -2); // closet
    wallBox(1.4, 1, 0.6, 0x8a6c4a, -9, baseY + 0.5, -5); // dresser
    wallBox(1, 0.9, 0.8, 0x8a6c4a, -13.5, baseY + 0.45, -6); // nightstand
    wallBox(0.5, 1.6, 0.5, 0x2f6f4f, -6, baseY + 0.8, -11); // floor plant

    // --- Bedroom 2 (front-right) ---
    signPlane(2.2, 0.6, 8, baseY + 3.6, HOUSE_Z_MIN + 0.05, TEX.signBed2, 0);
    wallBox(2, 0.6, 3, 0xf4a261, 9, baseY + 0.3, -9); // bed
    wallBox(1.6, 0.8, 0.7, 0x8a6c4a, 14, baseY + 0.4, -3); // desk
    wallBox(0.4, 2, 2, 0x5c3d2e, 15.5, baseY + 1, -6); // bookshelf
    wallBox(1, 0.5, 1.4, 0x557153, 12, baseY + 0.25, -10.5); // bench at foot of bed
    wallBox(0.6, 1.2, 0.6, 0x8a6c4a, 6, baseY + 0.6, -3); // side cabinet

    // --- Back: small bathroom (left) + linen/storage (right) ---
    wallBox(0.25, wallH, 4, 0xe9e2d0, 0, y, 11);
    wallBox(0.6, 0.8, 0.6, 0xffffff, -11, baseY + 0.4, 11);
    wallBox(0.8, 0.9, 0.5, 0xffffff, -7, baseY + 0.45, 11.7);
    wallBox(1, 1.8, 0.5, 0x8a6c4a, -15, baseY + 0.9, 12); // linen shelf

    wallBox(2, 2, 0.6, 0x8a6c4a, 8, baseY + 1, 12); // linen closet
    wallBox(1.2, 1.2, 1.2, 0x8a6c4a, 13, baseY + 0.6, 11); // storage boxes
    wallBox(0.8, 0.8, 0.8, 0x8a6c4a, 12, baseY + 0.4, 9.5); // extra boxes
  }
}

// Visual staircase steps — the walkable ramp itself is handled by
// resolveFloorHeight() elsewhere, this is just what it looks like.
function buildStaircase() {
  const steps = 12;
  const stepDepth = (STAIR_Z_MAX - STAIR_Z_MIN) / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    const stepZ = STAIR_Z_MIN + t * (STAIR_Z_MAX - STAIR_Z_MIN);
    const stepY = t * FLOOR_HEIGHT;
    box(5.6, 0.25, stepDepth + 0.05, 0x8a6c4a, 0, stepY, stepZ, true);
  }
}

// Upper floor surface, built as pieces around the stairwell opening
// so players can walk up through it (not a movement collider — the
// floor-height logic handles standing height, not physical blocking).
function buildFloor2Slab() {
  texturedBox(HOUSE_X_MAX * 2, 0.3, 16, 0, FLOOR_HEIGHT, -5, { map: TEX.floorWood, repeatU: 8, repeatV: 4 });   // front, before the stairwell
  texturedBox(HOUSE_X_MAX * 2, 0.3, 4, 0, FLOOR_HEIGHT, 11, { map: TEX.floorWood, repeatU: 8, repeatV: 1 });    // back, past the stairwell
  texturedBox(13, 0.3, 6, -9.5, FLOOR_HEIGHT, 6, { map: TEX.floorWood, repeatU: 5, repeatV: 2 });               // left of the stairwell
  texturedBox(13, 0.3, 6, 9.5, FLOOR_HEIGHT, 6, { map: TEX.floorWood, repeatU: 5, repeatV: 2 });                // right of the stairwell
}

// ---- Avatar builder: barong (men), filipiniana (women), NBI uniform (seeker) ----
// ---- Limb pivot helper: rotating the returned group swings the limb
// naturally around its joint (hip or shoulder), for walk/run animation.
function makeLimbPivot(jointX, jointY, jointZ, radius, length, color) {
  const pivot = new THREE.Group();
  pivot.position.set(jointX, jointY, jointZ);
  const totalHeight = length + radius * 2;
  const limb = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, length, 4, 8),
    new THREE.MeshStandardMaterial({ color })
  );
  limb.position.y = -totalHeight / 2;
  limb.castShadow = true;
  pivot.add(limb);
  return pivot;
}

function addFace(group, headY) {
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(0.4, 0.4),
    new THREE.MeshBasicMaterial({ map: TEX.face, transparent: true, depthWrite: false, side: THREE.DoubleSide })
  );
  face.position.set(0, headY + 0.03, 0.33);
  group.add(face);
}

// ---- Avatar builder: barong (men), filipiniana (women), NBI uniform
// (seeker) — jointed at hips/shoulders so limbs can swing for walking.
function buildAvatar(kind) {
  const group = new THREE.Group();
  const parts = { legL: null, legR: null, armL: null, armR: null };

  if (kind === 'seeker') {
    const uniform = 0x0d1b2a;

    const torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.32, 0.5, 4, 8),
      new THREE.MeshStandardMaterial({ color: uniform })
    );
    torso.position.y = 1.0;
    torso.castShadow = true;
    group.add(torso);

    const badge = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.14, 0.05),
      new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.6 })
    );
    badge.position.set(-0.25, 1.25, 0.28);
    group.add(badge);

    const belt = new THREE.Mesh(
      new THREE.BoxGeometry(0.94, 0.14, 0.54),
      new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    belt.position.y = 0.55;
    group.add(belt);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 20, 20),
      new THREE.MeshStandardMaterial({ color: 0xf1c27d })
    );
    head.position.y = 1.75;
    head.castShadow = true;
    group.add(head);
    addFace(group, 1.75);

    const capTop = new THREE.Mesh(
      new THREE.CylinderGeometry(0.36, 0.38, 0.2, 16),
      new THREE.MeshStandardMaterial({ color: uniform })
    );
    capTop.position.y = 2.02;
    group.add(capTop);
    const brim = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.04, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    brim.position.set(0, 1.93, 0.2);
    group.add(brim);

    parts.legL = makeLimbPivot(-0.22, 0.8, 0, 0.16, 0.55, 0x1b263b);
    parts.legR = makeLimbPivot(0.22, 0.8, 0, 0.16, 0.55, 0x1b263b);
    group.add(parts.legL, parts.legR);

    parts.armL = makeLimbPivot(-0.55, 1.45, 0, 0.1, 0.5, uniform);
    parts.armR = makeLimbPivot(0.55, 1.45, 0, 0.1, 0.5, uniform);
    group.add(parts.armL, parts.armR);

    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.55), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    gun.position.set(0, -0.55, 0.32);
    parts.armR.add(gun);

    return { group, parts };
  }

  const c = CHARACTERS.find((ch) => ch.id === kind) || CHARACTERS[0];
  const isFemale = c.gender === 'F';
  const skin = 0xf1c27d;

  const torsoColor = isFemale ? c.color : 0xf3ecd8;
  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 0.5, 4, 8),
    new THREE.MeshStandardMaterial({ color: torsoColor })
  );
  torso.position.y = 1.0;
  torso.castShadow = true;
  group.add(torso);

  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 1.05, 0.02),
    new THREE.MeshStandardMaterial({ color: c.accent })
  );
  stripe.position.set(0, 1.0, 0.26);
  group.add(stripe);

  parts.armL = makeLimbPivot(-0.55, 1.45, 0, 0.1, 0.5, isFemale ? c.color : torsoColor);
  parts.armR = makeLimbPivot(0.55, 1.45, 0, 0.1, 0.5, isFemale ? c.color : torsoColor);
  group.add(parts.armL, parts.armR);

  if (isFemale) {
    // Butterfly sleeves — signature filipiniana silhouette (worn over the arm pivots)
    const sleeveGeo = new THREE.BoxGeometry(0.55, 0.32, 0.4);
    const sleeveMat = new THREE.MeshStandardMaterial({ color: c.color });
    const sleeveL = new THREE.Mesh(sleeveGeo, sleeveMat);
    sleeveL.position.set(-0.62, 1.35, 0);
    sleeveL.rotation.z = 0.25;
    const sleeveR = new THREE.Mesh(sleeveGeo, sleeveMat);
    sleeveR.position.set(0.62, 1.35, 0);
    sleeveR.rotation.z = -0.25;
    group.add(sleeveL, sleeveR);
  }

  parts.legL = makeLimbPivot(-0.22, 0.8, 0, 0.16, 0.55, isFemale ? 0x3a2f28 : 0x2b2b2b);
  parts.legR = makeLimbPivot(0.22, 0.8, 0, 0.16, 0.55, isFemale ? 0x3a2f28 : 0x2b2b2b);
  group.add(parts.legL, parts.legR);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 20, 20),
    new THREE.MeshStandardMaterial({ color: skin })
  );
  head.position.y = 1.75;
  head.castShadow = true;
  group.add(head);
  addFace(group, 1.75);

  const pin = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 8, 8),
    new THREE.MeshStandardMaterial({ color: c.accent, metalness: 0.5 })
  );
  pin.position.set(0.28, 1.9, 0.15);
  group.add(pin);

  return { group, parts };
}

// ---- Walk/run animation: swings jointed limbs based on movement speed ----
function updateWalkAnimation(avatarEntry, dt, speedFraction) {
  if (!avatarEntry) return;
  const parts = avatarEntry.parts;
  if (!parts) return;
  const moving = speedFraction > 0.04;

  if (moving) {
    const cycleSpeed = 5 + speedFraction * 7; // faster stride when running
    avatarEntry.walkPhase = (avatarEntry.walkPhase || 0) + dt * cycleSpeed;
    const amp = 0.45 + speedFraction * 0.35;
    const swing = Math.sin(avatarEntry.walkPhase) * amp;
    if (parts.legL) parts.legL.rotation.x = swing;
    if (parts.legR) parts.legR.rotation.x = -swing;
    if (parts.armL) parts.armL.rotation.x = -swing * 0.8;
    if (parts.armR) parts.armR.rotation.x = swing * 0.8;
  } else {
    // ease back to a neutral standing pose
    ['legL', 'legR', 'armL', 'armR'].forEach((k) => {
      if (parts[k]) parts[k].rotation.x *= 0.8;
    });
  }
}

// ============================================================
// LOCAL PLAYER / CAMERA-CONTROLLED AVATAR
// ============================================================
const playerState = { x: 0, y: 0, z: 0, ry: 0, pitch: 0, vy: 0, ducking: false, floor: 0 };
const MOVE_SPEED = 6.5;
const CAM_DISTANCE = 5.5;
const CAM_HEIGHT = 2.2;
const JUMP_SPEED = 6.2;
const GRAVITY = -16;
let jumpRequested = false;

function rebuildLocalAvatar() {
  if (localAvatarEntry) {
    scene.remove(localAvatarEntry.mesh);
    localAvatarEntry = null;
  }
  const kind = myRole === 'SEEKER' ? 'seeker' : selectedCharacter;
  const built = buildAvatar(kind);
  built.group.position.set(playerState.x, playerState.y, playerState.z);
  built.group.rotation.y = playerState.ry;
  scene.add(built.group);
  localAvatarEntry = { mesh: built.group, parts: built.parts, kind, walkPhase: 0 };
}

function spawnLocalPlayer() {
  // Foyer (entry hall) — a proper room now, clear of all colliders
  playerState.x = (Math.random() - 0.5) * 3;
  playerState.z = -11 + (Math.random() - 0.5) * 1.5;
  playerState.ry = 0;
  playerState.pitch = 0;
  playerState.y = 0;
  playerState.vy = 0;
  playerState.ducking = false;
  playerState.floor = 0;
  rebuildLocalAvatar();
  updateThirdPersonCamera();
}

// Positions the camera behind and above the avatar, looking at it —
// a simple over-the-shoulder chase cam driven by yaw (left/right stick)
// and pitch (up/down stick), following jump height and ducking too.
const camRaycaster = new THREE.Raycaster();
function updateThirdPersonCamera() {
  const yaw = playerState.ry;
  const pitch = playerState.pitch;
  const duckOffset = playerState.ducking ? -0.55 : 0;
  let dist = CAM_DISTANCE * (1 - pitch * 0.25);

  // Pull the camera in if it would otherwise clip through a wall behind
  // the player — essential indoors, unlike the old open outdoor map.
  const pivot = new THREE.Vector3(playerState.x, playerState.y + 1.5 + duckOffset, playerState.z);
  const behind = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  camRaycaster.set(pivot, behind);
  camRaycaster.far = dist;
  const hits = camRaycaster.intersectObjects(world.raycastMeshes, false);
  if (hits.length > 0) dist = Math.max(1.2, hits[0].distance - 0.3);

  const camX = playerState.x - Math.sin(yaw) * dist;
  const camZ = playerState.z - Math.cos(yaw) * dist;
  const floorBaseY = playerState.floor * FLOOR_HEIGHT;
  let camY = playerState.y + 1.6 + CAM_HEIGHT + duckOffset - pitch * 3.5;
  camY = Math.min(camY, floorBaseY + FLOOR_HEIGHT - 0.4); // don't poke through the ceiling

  camera.position.set(camX, Math.max(playerState.y + 0.6, camY), camZ);
  const lookAt = new THREE.Vector3(
    playerState.x + Math.sin(yaw) * 2,
    playerState.y + 1.5 + duckOffset - pitch * 1.5,
    playerState.z + Math.cos(yaw) * 2
  );
  camera.lookAt(lookAt);
}

function updateLocalPlayer(dt) {
  if (gameState !== 'HIDING' && gameState !== 'SEEKING') return;
  if (myRole === 'SEEKER' && gameState === 'HIDING') return; // blinded/locked
  if (!myAlive) return;

  // Resolve the floor height beneath the player (handles the staircase ramp)
  const resolved = resolveFloorHeight(playerState.x, playerState.z, playerState.floor);
  playerState.floor = resolved.floor;
  const floorY = resolved.height;

  // Jump / gravity, relative to whichever floor the player is on
  if (jumpRequested && playerState.y <= floorY + 0.001) {
    playerState.vy = JUMP_SPEED;
  }
  jumpRequested = false;
  playerState.vy += GRAVITY * dt;
  playerState.y = Math.max(floorY, playerState.y + playerState.vy * dt);
  if (playerState.y <= floorY) { playerState.y = floorY; playerState.vy = 0; }

  // Move (left stick) relative to facing — slower while ducking
  let speedFraction = 0;
  if (input.move.active && Number.isFinite(input.move.x) && Number.isFinite(input.move.y)) {
    speedFraction = Math.min(1, Math.hypot(input.move.x, input.move.y));
    const speed = MOVE_SPEED * (playerState.ducking ? 0.55 : 1);
    const forward = new THREE.Vector3(Math.sin(playerState.ry), 0, Math.cos(playerState.ry));
    const right = new THREE.Vector3(Math.cos(playerState.ry), 0, -Math.sin(playerState.ry));
    const dx = (forward.x * -input.move.y - right.x * input.move.x) * speed * dt;
    const dz = (forward.z * -input.move.y - right.z * input.move.x) * speed * dt;

    const nextX = playerState.x + dx;
    const nextZ = playerState.z + dz;
    if (!collidesAt(nextX, playerState.z, playerState.y)) playerState.x = nextX;
    if (!collidesAt(playerState.x, nextZ, playerState.y)) playerState.z = nextZ;
    playerState.x = THREE.MathUtils.clamp(playerState.x, HOUSE_X_MIN, HOUSE_X_MAX);
    playerState.z = THREE.MathUtils.clamp(playerState.z, HOUSE_Z_MIN, HOUSE_Z_MAX);
  }

  if (localAvatarEntry) {
    localAvatarEntry.mesh.position.set(playerState.x, playerState.y, playerState.z);
    localAvatarEntry.mesh.rotation.y = playerState.ry;
    localAvatarEntry.mesh.scale.y = playerState.ducking ? 0.6 : 1;
    updateWalkAnimation(localAvatarEntry, dt, speedFraction);
  }

  updateThirdPersonCamera();

  send({ type: 'MOVE', x: playerState.x, y: playerState.y, z: playerState.z, ry: playerState.ry });
}

// Colliders carry their real Y range, so a player is only blocked by
// obstacles that vertically overlap them — this is what keeps ground
// floor and upper floor collision separate despite sharing X/Z space.
function collidesAt(x, z, y) {
  const r = 0.4;
  const feetY = y, headY = y + 1.8;
  for (const b of world.colliders) {
    if (headY < b.min.y || feetY > b.max.y) continue;
    if (x + r > b.min.x && x - r < b.max.x && z + r > b.min.z && z - r < b.max.z) return true;
  }
  return false;
}

// ============================================================
// JUMP / DUCK CONTROLS
// ============================================================
jumpBtn.addEventListener('touchstart', (e) => { e.preventDefault(); jumpRequested = true; }, { passive: false });
jumpBtn.addEventListener('click', () => { jumpRequested = true; });

duckBtn.addEventListener('touchstart', (e) => { e.preventDefault(); playerState.ducking = true; }, { passive: false });
duckBtn.addEventListener('touchend', (e) => { e.preventDefault(); playerState.ducking = false; }, { passive: false });
duckBtn.addEventListener('mousedown', () => { playerState.ducking = true; });
duckBtn.addEventListener('mouseup', () => { playerState.ducking = false; });

// ============================================================
// SPECTATOR MODE — eliminated players watch an alive player's
// third-person view and swipe left/right to switch who they watch.
// ============================================================
function getAliveSpectateCandidates() {
  return [...remotePlayers.entries()].filter(([, rp]) => rp.mesh.visible).map(([id]) => id);
}

function updateSpectateBarLabel() {
  if (myAlive) return;
  if (!spectateTargetId) {
    spectateBar.textContent = '👻 Spectating — no one else alive yet';
    return;
  }
  const rp = remotePlayers.get(spectateTargetId);
  const name = rp && rp.data ? rp.data.name : 'a player';
  spectateBar.textContent = `👻 Spectating ${name} — swipe to switch`;
}

function pickInitialSpectateTarget() {
  const candidates = getAliveSpectateCandidates();
  spectateTargetId = candidates.length ? candidates[0] : null;
  updateSpectateBarLabel();
}

function cycleSpectateTarget(direction) {
  const candidates = getAliveSpectateCandidates();
  if (!candidates.length) {
    spectateTargetId = null;
  } else {
    let idx = candidates.indexOf(spectateTargetId);
    idx = (idx + direction + candidates.length) % candidates.length;
    spectateTargetId = candidates[idx];
  }
  updateSpectateBarLabel();
}

function updateSpectateCamera() {
  if (myAlive) return;
  let rp = spectateTargetId ? remotePlayers.get(spectateTargetId) : null;
  if (!rp || !rp.mesh.visible) {
    pickInitialSpectateTarget();
    rp = spectateTargetId ? remotePlayers.get(spectateTargetId) : null;
  }
  if (!rp) return; // no one alive to watch yet

  const pos = rp.mesh.position;
  const yaw = rp.mesh.rotation.y;
  const camX = pos.x - Math.sin(yaw) * CAM_DISTANCE;
  const camZ = pos.z - Math.cos(yaw) * CAM_DISTANCE;
  const camY = pos.y + 1.6 + CAM_HEIGHT;
  camera.position.set(camX, camY, camZ);
  camera.lookAt(pos.x, pos.y + 1.5, pos.z);
}

// ============================================================
// MINIMAP — deliberately shows only your own position (or your
// spectate target's), never other players. A minimap that reveals
// everyone's live location would defeat the point of hide & seek.
// ============================================================
function drawMinimap() {
  if (gameState !== 'HIDING' && gameState !== 'SEEKING') return;
  const w = minimapCanvas.width, h = minimapCanvas.height;
  minimapCtx.clearRect(0, 0, w, h);

  // Simple floor-plan sketch — matches buildFloor()'s room layout
  minimapCtx.fillStyle = '#3a3226';
  minimapCtx.fillRect(0, 0, w, h);
  minimapCtx.strokeStyle = 'rgba(255,255,255,0.35)';
  minimapCtx.lineWidth = 1.5;
  minimapCtx.strokeRect(2, 2, w - 4, h - 4); // exterior walls
  minimapCtx.beginPath(); // central divider (with the doorway gap left open)
  minimapCtx.moveTo(w / 2, 2); minimapCtx.lineTo(w / 2, h * 0.42);
  minimapCtx.moveTo(w / 2, h * 0.58); minimapCtx.lineTo(w / 2, h * 0.72);
  minimapCtx.stroke();
  minimapCtx.beginPath(); // back-room divider
  minimapCtx.moveTo(w / 2, h * 0.84); minimapCtx.lineTo(w / 2, h - 2);
  minimapCtx.stroke();
  minimapCtx.strokeStyle = 'rgba(255,214,10,0.5)'; // stairwell outline
  minimapCtx.strokeRect(w * 0.41, h * 0.6, w * 0.18, h * 0.24);

  let px, pz, ry, isSelf, floor;
  if (myAlive) {
    px = playerState.x; pz = playerState.z; ry = playerState.ry; isSelf = true; floor = playerState.floor;
  } else if (spectateTargetId && remotePlayers.get(spectateTargetId)) {
    const rp = remotePlayers.get(spectateTargetId);
    px = rp.mesh.position.x; pz = rp.mesh.position.z; ry = rp.mesh.rotation.y; isSelf = false;
    floor = rp.mesh.position.y >= FLOOR_HEIGHT / 2 ? 1 : 0;
  } else {
    return;
  }

  minimapCtx.fillStyle = '#fff3b0';
  minimapCtx.font = 'bold 12px sans-serif';
  minimapCtx.fillText(floor === 1 ? '2F' : '1F', 6, 14);

  const nx = THREE.MathUtils.clamp((px - HOUSE_X_MIN) / (HOUSE_X_MAX - HOUSE_X_MIN), 0, 1);
  const nz = THREE.MathUtils.clamp((pz - HOUSE_Z_MIN) / (HOUSE_Z_MAX - HOUSE_Z_MIN), 0, 1);
  const mx = nx * w, my = nz * h;

  // Direction arrow — computed directly in canvas-space (world +X maps
  // to canvas +X, world +Z maps to canvas +Y) rather than via ctx.rotate,
  // to avoid sign-convention mistakes between the two coordinate systems.
  const dirX = Math.sin(ry), dirY = Math.cos(ry);
  const perpX = -dirY, perpY = dirX;
  const tipX = mx + dirX * 9, tipY = my + dirY * 9;
  const backX = mx - dirX * 5, backY = my - dirY * 5;

  minimapCtx.fillStyle = isSelf ? '#ffb703' : '#4caf50';
  minimapCtx.beginPath();
  minimapCtx.moveTo(tipX, tipY);
  minimapCtx.lineTo(backX + perpX * 5, backY + perpY * 5);
  minimapCtx.lineTo(backX - perpX * 5, backY - perpY * 5);
  minimapCtx.closePath();
  minimapCtx.fill();
}

// Swipe anywhere on screen to switch spectate target (only listens
// while actually spectating — joysticks handle their own touches
// while alive and are hidden while dead, so there's no conflict).
let spectateSwipeStartX = null;
document.addEventListener('touchstart', (e) => {
  if (myAlive) return;
  spectateSwipeStartX = e.changedTouches[0].clientX;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (myAlive || spectateSwipeStartX === null) return;
  const dx = e.changedTouches[0].clientX - spectateSwipeStartX;
  spectateSwipeStartX = null;
  if (Math.abs(dx) < 50) return;
  cycleSpectateTarget(dx < 0 ? 1 : -1);
}, { passive: true });

// ============================================================
// CODM-STYLE DRAG-TO-LOOK — touch-drag anywhere on screen (except
// the move joystick and action buttons) turns the camera, instead
// of a fixed joystick with a spring-loaded knob. Multiple sequential
// drags accumulate rotation, same as a mobile shooter's free-look.
// ============================================================
const LOOK_SENSITIVITY = 0.0045;
let lookDragId = null;
let lookDragLastX = 0, lookDragLastY = 0;

function isLookExemptTarget(target) {
  return !!(target && target.closest &&
    target.closest('#moveZone, #jumpBtn, #duckBtn, #shootBtn, .screen'));
}

document.addEventListener('touchstart', (e) => {
  if (!myAlive || lookDragId !== null) return;
  for (const t of e.changedTouches) {
    if (isLookExemptTarget(t.target)) continue;
    lookDragId = t.identifier;
    lookDragLastX = t.clientX;
    lookDragLastY = t.clientY;
    break;
  }
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!myAlive || lookDragId === null) return;
  for (const t of e.changedTouches) {
    if (t.identifier !== lookDragId) continue;
    const dx = t.clientX - lookDragLastX;
    const dy = t.clientY - lookDragLastY;
    lookDragLastX = t.clientX;
    lookDragLastY = t.clientY;
    playerState.ry += dx * LOOK_SENSITIVITY;
    playerState.pitch = THREE.MathUtils.clamp(playerState.pitch - dy * LOOK_SENSITIVITY, -1.1, 1.1);
    break;
  }
}, { passive: true });

function releaseLookDrag(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === lookDragId) lookDragId = null;
  }
}
document.addEventListener('touchend', releaseLookDrag, { passive: true });
document.addEventListener('touchcancel', releaseLookDrag, { passive: true });

// Mouse fallback for desktop testing
let lookMouseDown = false;
document.addEventListener('mousedown', (e) => {
  if (!myAlive || isLookExemptTarget(e.target)) return;
  lookMouseDown = true;
  lookDragLastX = e.clientX;
  lookDragLastY = e.clientY;
});
document.addEventListener('mousemove', (e) => {
  if (!lookMouseDown || !myAlive) return;
  const dx = e.clientX - lookDragLastX;
  const dy = e.clientY - lookDragLastY;
  lookDragLastX = e.clientX;
  lookDragLastY = e.clientY;
  playerState.ry += dx * LOOK_SENSITIVITY;
  playerState.pitch = THREE.MathUtils.clamp(playerState.pitch - dy * LOOK_SENSITIVITY, -1.1, 1.1);
});
document.addEventListener('mouseup', () => { lookMouseDown = false; });

// Shows/hides the controls relevant to being alive vs. spectating.
function updateAliveUI() {
  el('moveZone').classList.toggle('hidden', !myAlive);
  jumpBtn.classList.toggle('hidden', !myAlive);
  duckBtn.classList.toggle('hidden', !myAlive);
  shootBtn.classList.toggle('hidden', !myAlive || myRole !== 'SEEKER');
  crosshair.classList.toggle('hidden', !myAlive || myRole !== 'SEEKER');
  spectateBar.classList.toggle('hidden', myAlive);
  if (!myAlive) {
    pickInitialSpectateTarget();
  }
}

// ============================================================
// TOUCH JOYSTICKS
// ============================================================
function setupJoystick(zoneEl, targetState) {
  const knob = zoneEl.querySelector('.joystick-knob');
  let radius = 65; // fallback matches the CSS-defined 130px zone width
  let touchId = null, originX = 0, originY = 0;

  function start(e) {
    // Recompute here, not at setup time — the HUD (and this zone) is
    // still display:none at boot, so clientWidth would read as 0 and
    // lock `radius` at 0 forever, producing 0/0 = NaN on every move.
    const measured = zoneEl.clientWidth / 2;
    radius = measured > 0 ? measured : 65;

    const t = e.changedTouches ? e.changedTouches[0] : e;
    touchId = e.changedTouches ? t.identifier : 'mouse';
    const rect = zoneEl.getBoundingClientRect();
    originX = rect.left + rect.width / 2;
    originY = rect.top + rect.height / 2;
    targetState.active = true;
    e.preventDefault();
  }
  function move(e) {
    if (touchId === null) return;
    let t;
    if (e.changedTouches) {
      t = [...e.changedTouches].find((tt) => tt.identifier === touchId);
      if (!t) return;
    } else t = e;
    let dx = t.clientX - originX;
    let dy = t.clientY - originY;
    const dist = Math.min(Math.hypot(dx, dy), radius);
    const ang = Math.atan2(dy, dx);
    dx = Math.cos(ang) * dist; dy = Math.sin(ang) * dist;
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    targetState.x = dx / radius;
    targetState.y = dy / radius;
    e.preventDefault();
  }
  function end(e) {
    touchId = null;
    targetState.active = false;
    targetState.x = 0; targetState.y = 0;
    knob.style.transform = `translate(-50%, -50%)`;
    e.preventDefault();
  }

  zoneEl.addEventListener('touchstart', start, { passive: false });
  zoneEl.addEventListener('touchmove', move, { passive: false });
  zoneEl.addEventListener('touchend', end, { passive: false });
  zoneEl.addEventListener('touchcancel', end, { passive: false });
  // mouse fallback for desktop testing
  zoneEl.addEventListener('mousedown', start);
  window.addEventListener('mousemove', (e) => { if (touchId === 'mouse') move(e); });
  window.addEventListener('mouseup', (e) => { if (touchId === 'mouse') end(e); });
}

// ============================================================
// SHOOTING
// ============================================================
// ============================================================
// SHOOTING — crosshair aim, bullet trail, and impact marks.
// These are purely visual; the server remains authoritative for
// whether a shot actually eliminates a hider.
// ============================================================
const shootRaycaster = new THREE.Raycaster();
const MAX_TRACE_DISTANCE = 80;
const MAX_IMPACT_MARKS = 24;

function spawnTracer(from, to) {
  const dist = from.distanceTo(to);
  if (dist < 0.01) return;
  const geo = new THREE.CylinderGeometry(0.025, 0.025, dist, 6, 1, true);
  geo.translate(0, dist / 2, 0);
  geo.rotateX(Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xfff3b0, transparent: true, opacity: 0.95 });
  const line = new THREE.Mesh(geo, mat);
  line.position.copy(from);
  line.lookAt(to);
  scene.add(line);
  tracers.push({ mesh: line, mat, age: 0, lifespan: 0.12 });
}

function spawnImpactMark(point, normal) {
  const geo = new THREE.CircleGeometry(0.14, 10);
  const mat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const mark = new THREE.Mesh(geo, mat);
  mark.position.copy(point).addScaledVector(normal, 0.02);
  mark.lookAt(point.clone().add(normal));
  scene.add(mark);
  impactMarks.push({ mesh: mark, mat, age: 0, lifespan: 4 });

  while (impactMarks.length > MAX_IMPACT_MARKS) {
    const old = impactMarks.shift();
    scene.remove(old.mesh);
  }
}

function updateBulletVfx(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.age += dt;
    t.mat.opacity = Math.max(0, 0.95 * (1 - t.age / t.lifespan));
    if (t.age >= t.lifespan) {
      scene.remove(t.mesh);
      tracers.splice(i, 1);
    }
  }
  for (let i = impactMarks.length - 1; i >= 0; i--) {
    const m = impactMarks[i];
    m.age += dt;
    if (m.age > m.lifespan - 1) {
      m.mat.opacity = Math.max(0, 0.85 * (1 - (m.age - (m.lifespan - 1))));
    }
    if (m.age >= m.lifespan) {
      scene.remove(m.mesh);
      impactMarks.splice(i, 1);
    }
  }
}

shootBtn.addEventListener('touchstart', fireShot, { passive: false });
shootBtn.addEventListener('click', fireShot);
function fireShot(e) {
  if (e) e.preventDefault();
  if (gameState !== 'SEEKING' || myRole !== 'SEEKER' || !myAlive) return;
  send({ type: 'SHOOT' });
  shootBtn.style.transform = 'scale(0.9)';
  setTimeout(() => (shootBtn.style.transform = ''), 120);

  // Visual-only raycast along the crosshair (screen center = camera
  // forward) so the shot has a trail and a mark, regardless of what
  // the server decides actually got eliminated.
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  const muzzle = localAvatarEntry
    ? localAvatarEntry.mesh.position.clone().add(new THREE.Vector3(0, 1.3, 0)).addScaledVector(dir, 0.6)
    : camera.position.clone();

  const targets = [
    ...world.raycastMeshes,
    ...[...remotePlayers.values()].filter((rp) => rp.mesh.visible).map((rp) => rp.mesh)
  ];
  shootRaycaster.set(camera.position, dir);
  shootRaycaster.far = MAX_TRACE_DISTANCE;
  const hits = shootRaycaster.intersectObjects(targets, true);

  let endPoint;
  let normal = new THREE.Vector3(0, 1, 0);
  if (hits.length > 0) {
    endPoint = hits[0].point;
    if (hits[0].face && hits[0].face.normal) {
      normal = hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld);
    }
    spawnImpactMark(endPoint, normal);
  } else {
    endPoint = camera.position.clone().addScaledVector(dir, MAX_TRACE_DISTANCE);
  }
  spawnTracer(muzzle, endPoint);
}

// ============================================================
// UI FLOW
// ============================================================
function applyRoleUI() {
  rolePill.className = myRole === 'SEEKER' ? 'seeker' : 'hider';
  rolePill.textContent = myRole === 'SEEKER' ? '👮 SEEKER' : '🙈 HIDER';
  updateAliveUI();
  if (myRole === 'SEEKER' && gameState === 'HIDING') {
    blindOverlay.classList.remove('hidden');
  } else {
    blindOverlay.classList.add('hidden');
  }
}

function enterGameView() {
  lobbyScreen.classList.add('hidden');
  roundOverScreen.classList.add('hidden');
  hud.classList.remove('hidden');
  spawnLocalPlayer();
  applyRoleUI();
  // Force a resize sync — the canvas may have gone stale while the
  // lobby (a different layout/overflow context) was on screen.
  onResize();
}

function showRoundOver(reason) {
  hud.classList.add('hidden');
  roundOverScreen.classList.remove('hidden');
  const title = el('roundOverTitle');
  const sub = el('roundOverSub');
  if (reason === 'SEEKER_WINS') {
    title.textContent = '👮 Seeker Wins!';
    sub.textContent = 'All hiders were caught.';
  } else {
    title.textContent = '🙈 Hiders Win!';
    sub.textContent = 'At least one hider survived the timer.';
  }
}

el('playAgainBtn').onclick = () => send({ type: 'PLAY_AGAIN' });
startBtn.onclick = () => send({ type: 'START_GAME' });

el('connectBtn').onclick = () => {
  const ip = el('ipInput').value.trim();
  const name = el('nameInput').value.trim() || 'Player';
  if (!ip) { showToast('Enter the host IP address'); return; }
  connect(ip, name);
};

// ============================================================
// HOST MODE — starts an embedded WebSocket server on this
// Android device via the native Capacitor plugin, then connects
// to it exactly like any other client.
// ============================================================
const hostBtn = el('hostBtn');
const hostStatus = el('hostStatus');

function isNativeAndroid() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

hostBtn.onclick = async () => {
  const name = el('nameInput').value.trim() || 'Player';
  hostBtn.disabled = true;
  hostStatus.classList.remove('hidden');

  try {
    if (!isNativeAndroid()) {
      showToast('Host mode needs the installed Android app, not a browser tab.');
      hostBtn.disabled = false;
      hostStatus.classList.add('hidden');
      return;
    }

    hostStatus.textContent = 'Starting host server…';
    const result = await window.Capacitor.Plugins.HostServer.start({ port: 8080 });
    const ip = result.ip;

    hostStatus.textContent = `Hosting at ${ip} — tell other players to type this IP in, or have them tap "Browse Lobbies"!`;
    el('ipInput').value = ip;
    connect(ip, name);
  } catch (err) {
    showToast('Could not start host server: ' + (err.message || err));
    hostBtn.disabled = false;
    hostStatus.classList.add('hidden');
  }
};

// ============================================================
// BROWSE LOBBIES — listens for LAN broadcast announcements from
// any Android device hosting a lobby.
// ============================================================
const browseBtn = el('browseBtn');
const browseResults = el('browseResults');

browseBtn.onclick = async () => {
  browseResults.classList.remove('hidden');
  browseResults.innerHTML = '<p class="sub">Searching your Wi-Fi for lobbies…</p>';

  if (!isNativeAndroid()) {
    browseResults.innerHTML = '<p class="sub">Browsing needs the installed Android app — enter the host IP manually below instead.</p>';
    return;
  }

  let lobbies = [];
  try {
    const result = await window.Capacitor.Plugins.HostServer.discoverLobbies({ timeoutMs: 3000 });
    lobbies = result.lobbies || [];
  } catch (err) {
    browseResults.innerHTML = `<p class="sub">Search failed: ${err.message || err}</p>`;
    return;
  }

  if (!lobbies.length) {
    browseResults.innerHTML = '<p class="sub">No lobbies found on this Wi-Fi. Try again, or enter an IP manually below.</p>';
    return;
  }

  browseResults.innerHTML = '';
  lobbies.forEach((l) => {
    const row = document.createElement('div');
    row.className = 'lobby-row';
    row.innerHTML = `<div>
        <div class="lobby-name">${l.name || 'Bagong Ilog Lobby'}</div>
        <div class="lobby-meta">${l.ip} · ${l.players}/${l.maxPlayers ?? MAX_PLAYERS} players</div>
      </div><div>▶</div>`;
    row.onclick = () => {
      const name = el('nameInput').value.trim() || 'Player';
      el('ipInput').value = l.ip;
      connect(l.ip, name);
    };
    browseResults.appendChild(row);
  });
};

// ============================================================
// TIMER DISPLAY
// ============================================================
const blindTimer = el('blindTimer');
function updateTimerPill() {
  if (!phaseEndsAt || (gameState !== 'HIDING' && gameState !== 'SEEKING')) {
    timerPill.textContent = '--:--';
    return;
  }
  const remaining = Math.max(0, Math.round((phaseEndsAt - Date.now()) / 1000));
  const m = String(Math.floor(remaining / 60)).padStart(2, '0');
  const s = String(remaining % 60).padStart(2, '0');
  const text = `${m}:${s}`;
  timerPill.textContent = (gameState === 'HIDING' ? '🙈 ' : '👮 ') + text;
  if (blindTimer) blindTimer.textContent = text;
}

// ============================================================
// MAIN LOOP
// ============================================================
let renderErrorShown = false;
function showFatalError(label, err) {
  if (renderErrorShown) return; // don't spam — show the first failure only
  renderErrorShown = true;
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:999;background:#5c0011;color:#fff;font-family:monospace;font-size:11px;padding:10px;white-space:pre-wrap;max-height:40vh;overflow:auto;';
  banner.textContent = `[${label}] ${err && err.stack ? err.stack : err}`;
  document.body.appendChild(banner);
}

function animate() {
  requestAnimationFrame(animate);
  try {
    const dt = Math.min(clock.getDelta(), 0.05);
    updateLocalPlayer(dt);
    updateSpectateCamera();
    updateRemoteWalkAnimations(dt);
    updateBulletVfx(dt);
    updateTimerPill();
    drawMinimap();
    renderer.render(scene, camera);
  } catch (err) {
    showFatalError('render loop', err);
  }
}

// ============================================================
// BOOT
// ============================================================
try {
  initScene();
  setupJoystick(el('moveZone'), input.move);
  el('gameCanvas').addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    showFatalError('webgl context lost', 'The GPU context was lost — try restarting the app.');
  });
  animate();
} catch (err) {
  showFatalError('boot', err);
}
