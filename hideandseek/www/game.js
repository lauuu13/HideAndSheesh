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

const remotePlayers = new Map(); // id -> { mesh, data }
let localAvatar = null;
const world = { colliders: [] }; // simple AABB colliders for hiding geometry

const input = {
  move: { x: 0, y: 0, active: false },
  look: { x: 0, y: 0, active: false }
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
        showToast('You were caught! 👮 You can spectate.');
      } else {
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
      myRole = p.role;
      myAlive = p.alive;
      applyRoleUI();
      return;
    }
    let rp = remotePlayers.get(p.id);
    if (!rp) {
      const mesh = buildAvatar(p.role === 'SEEKER' ? 'seeker' : (p.character || CHARACTERS[0].id));
      scene.add(mesh);
      rp = { mesh, data: p };
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
}

// ============================================================
// THREE.JS SETUP
// ============================================================
function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fc6e8);
  scene.fog = new THREE.Fog(0x8fc6e8, 60, 220);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);

  renderer = new THREE.WebGLRenderer({ canvas: el('gameCanvas'), antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x4a4a4a, 1.0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(60, 90, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -120;
  sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120;
  sun.shadow.camera.bottom = -120;
  scene.add(sun);

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
  return m;
}

// ---- Map: simplified Bagong Ilog, Pasig ----
function buildMap() {
  // Ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    new THREE.MeshStandardMaterial({ color: 0x6b8f57 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // --- Zone 1: C-5 highway boundary (north edge) ---
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 24),
    new THREE.MeshStandardMaterial({ color: 0x2b2b2b })
  );
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0.01, -120);
  road.receiveShadow = true;
  scene.add(road);

  for (let i = -140; i <= 140; i += 12) {
    box(1.4, 1.1, 2.4, 0xd9d9d9, i, 0.55, -100, false); // jersey barrier
  }
  const carColors = [0xe63946, 0x2a9d8f, 0xf4a261, 0x264653];
  for (let i = -130; i <= 130; i += 22) {
    const c = box(4.2, 1.4, 2, carColors[Math.floor(Math.random() * carColors.length)], i, 0.7, -128);
    addCollider(c);
  }

  // --- Zone 2: Pasig River boundary (south edge) ---
  const river = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 30),
    new THREE.MeshStandardMaterial({ color: 0x2274a5 })
  );
  river.rotation.x = -Math.PI / 2;
  river.position.set(0, -0.05, 130);
  scene.add(river);
  for (let i = -140; i <= 140; i += 16) {
    box(2, 1, 2, 0x9c6b30, i, 0.5, 112); // riverbank bollards
  }

  // --- Zone 3: Industrial zone (east side) ---
  const whColors = [0xadb5bd, 0x868e96, 0xced4da];
  for (let ix = 0; ix < 4; ix++) {
    for (let iz = 0; iz < 3; iz++) {
      const x = 90 + ix * 18;
      const z = -40 + iz * 26;
      const h = 8 + Math.random() * 6;
      const wh = box(14, h, 20, whColors[(ix + iz) % whColors.length], x, h / 2, z);
      addCollider(wh);
    }
  }

  // --- Zone 4: Dense residential zone with eskinitas (west/center) ---
  const houseColors = [0xf6bd60, 0xf28482, 0x84a59d, 0xf5cac3, 0xa2d2ff];
  const alleySpacing = 9;
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 8; col++) {
      const x = -140 + col * alleySpacing;
      const z = -30 + row * alleySpacing;
      if (Math.random() < 0.15) continue; // leave gaps for eskinita paths
      const h = 4 + Math.random() * 2;
      const house = box(
        6 + Math.random() * 1.5, h, 6 + Math.random() * 1.5,
        houseColors[Math.floor(Math.random() * houseColors.length)],
        x + (Math.random() - 0.5) * 1.5, h / 2, z + (Math.random() - 0.5) * 1.5
      );
      addCollider(house);
      // little roof
      const roof = box(6.6, 0.6, 6.6, 0x5c3d2e, house.position.x, h + 0.3, house.position.z, false);
    }
  }

  // Sari-sari stores dotted through the residential zone
  for (let i = 0; i < 6; i++) {
    const x = -140 + Math.random() * 70;
    const z = -20 + Math.random() * 60;
    const store = box(3, 2.2, 2.4, 0xffb703, x, 1.1, z);
    addCollider(store);
  }

  // Tricycles as hiding props scattered in alleys
  for (let i = 0; i < 10; i++) {
    const x = -140 + Math.random() * 75;
    const z = -25 + Math.random() * 65;
    const body = box(2.6, 1.5, 1.4, 0x1971c2, x, 0.75, z);
    const sidecar = box(1.2, 1.3, 1.6, 0xffd43b, x + 1.6, 0.7, z, false);
    addCollider(body);
    addCollider(sidecar);
  }

  // Perimeter walls so players can't wander off-map
  const wallMat = 0x3a3a3a;
  box(300, 6, 1, wallMat, 0, 3, -150);
  box(300, 6, 1, wallMat, 0, 3, 150);
  box(1, 6, 300, wallMat, -150, 3, 0);
  box(1, 6, 300, wallMat, 150, 3, 0);
}

// ---- Avatar builder: barong (men), filipiniana (women), NBI uniform (seeker) ----
function buildAvatar(kind) {
  const group = new THREE.Group();

  if (kind === 'seeker') {
    // NBI-style police uniform: navy shirt, cap with brim, gold badge
    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 1.1, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x0d1b2a })
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
      new THREE.SphereGeometry(0.32, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0xf1c27d })
    );
    head.position.y = 1.75;
    head.castShadow = true;
    group.add(head);

    // Cap with brim
    const capTop = new THREE.Mesh(
      new THREE.CylinderGeometry(0.36, 0.38, 0.2, 12),
      new THREE.MeshStandardMaterial({ color: 0x0d1b2a })
    );
    capTop.position.y = 2.02;
    group.add(capTop);
    const brim = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.04, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    brim.position.set(0, 1.93, 0.2);
    group.add(brim);

    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.9, 0.32), new THREE.MeshStandardMaterial({ color: 0x1b263b }));
    legL.position.set(-0.22, 0.35, 0);
    const legR = legL.clone(); legR.position.x = 0.22;
    group.add(legL, legR);

    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.6), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    gun.position.set(0.5, 1.0, 0.2);
    group.add(gun);

    return group;
  }

  const c = CHARACTERS.find((ch) => ch.id === kind) || CHARACTERS[0];
  const isFemale = c.gender === 'F';

  // Torso: cream barong (men) or jewel-tone filipiniana bodice (women)
  const torsoColor = isFemale ? c.color : 0xf3ecd8;
  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 1.1, 0.5),
    new THREE.MeshStandardMaterial({ color: torsoColor })
  );
  torso.position.y = 1.0;
  torso.castShadow = true;
  group.add(torso);

  // Embroidery/placket stripe down the front
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 1.05, 0.02),
    new THREE.MeshStandardMaterial({ color: c.accent })
  );
  stripe.position.set(0, 1.0, 0.26);
  group.add(stripe);

  if (isFemale) {
    // Butterfly sleeves — signature filipiniana silhouette
    const sleeveGeo = new THREE.BoxGeometry(0.55, 0.32, 0.4);
    const sleeveMat = new THREE.MeshStandardMaterial({ color: c.color });
    const sleeveL = new THREE.Mesh(sleeveGeo, sleeveMat);
    sleeveL.position.set(-0.62, 1.35, 0);
    sleeveL.rotation.z = 0.25;
    const sleeveR = new THREE.Mesh(sleeveGeo, sleeveMat);
    sleeveR.position.set(0.62, 1.35, 0);
    sleeveR.rotation.z = -0.25;
    group.add(sleeveL, sleeveR);

    // Long skirt (tapis-style) instead of visible legs
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.4, 0.95, 10),
      new THREE.MeshStandardMaterial({ color: c.color })
    );
    skirt.position.y = 0.42;
    group.add(skirt);
  } else {
    // Barong sleeves (plain, tucked)
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.9, 0.32), new THREE.MeshStandardMaterial({ color: 0x2b2b2b }));
    legL.position.set(-0.22, 0.35, 0);
    const legR = legL.clone(); legR.position.x = 0.22;
    group.add(legL, legR);
  }

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 16, 16),
    new THREE.MeshStandardMaterial({ color: 0xf1c27d })
  );
  head.position.y = 1.75;
  head.castShadow = true;
  group.add(head);

  // Small accent accessory (hairpin/pin) instead of a hat, to keep formalwear intact
  const pin = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 8, 8),
    new THREE.MeshStandardMaterial({ color: c.accent, metalness: 0.5 })
  );
  pin.position.set(0.28, 1.9, 0.15);
  group.add(pin);

  return group;
}

// ============================================================
// LOCAL PLAYER / CAMERA-CONTROLLED AVATAR
// ============================================================
const playerState = { x: 0, y: 0, z: 0, ry: 0, pitch: 0 };
const MOVE_SPEED = 6.5;

function spawnLocalPlayer() {
  playerState.x = (Math.random() - 0.5) * 20;
  playerState.z = 40 + Math.random() * 20;
  playerState.ry = Math.PI;
  camera.position.set(playerState.x, 1.6, playerState.z);
}

function updateLocalPlayer(dt) {
  if (gameState !== 'HIDING' && gameState !== 'SEEKING') return;
  if (myRole === 'SEEKER' && gameState === 'HIDING') return; // blinded/locked
  if (!myAlive) return;

  // Look (right stick) -> yaw/pitch
  if (input.look.active) {
    playerState.ry -= input.look.x * dt * 2.4;
    playerState.pitch = THREE.MathUtils.clamp(playerState.pitch - input.look.y * dt * 2.0, -1.1, 1.1);
  }

  // Move (left stick) relative to facing
  if (input.move.active) {
    const forward = new THREE.Vector3(Math.sin(playerState.ry), 0, Math.cos(playerState.ry));
    const right = new THREE.Vector3(Math.cos(playerState.ry), 0, -Math.sin(playerState.ry));
    const dx = (forward.x * -input.move.y + right.x * input.move.x) * MOVE_SPEED * dt;
    const dz = (forward.z * -input.move.y + right.z * input.move.x) * MOVE_SPEED * dt;

    const nextX = playerState.x + dx;
    const nextZ = playerState.z + dz;
    if (!collidesAt(nextX, playerState.z)) playerState.x = nextX;
    if (!collidesAt(playerState.x, nextZ)) playerState.z = nextZ;
    playerState.x = THREE.MathUtils.clamp(playerState.x, -148, 148);
    playerState.z = THREE.MathUtils.clamp(playerState.z, -148, 148);
  }

  camera.position.set(playerState.x, 1.6, playerState.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = playerState.ry;
  camera.rotation.x = playerState.pitch;

  send({ type: 'MOVE', x: playerState.x, y: 0, z: playerState.z, ry: playerState.ry });
}

function collidesAt(x, z) {
  const r = 0.4;
  for (const b of world.colliders) {
    if (x + r > b.min.x && x - r < b.max.x && z + r > b.min.z && z - r < b.max.z) return true;
  }
  return false;
}

// ============================================================
// TOUCH JOYSTICKS
// ============================================================
function setupJoystick(zoneEl, targetState) {
  const knob = zoneEl.querySelector('.joystick-knob');
  const radius = zoneEl.clientWidth / 2;
  let touchId = null, originX = 0, originY = 0;

  function start(e) {
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
shootBtn.addEventListener('touchstart', fireShot, { passive: false });
shootBtn.addEventListener('click', fireShot);
function fireShot(e) {
  if (e) e.preventDefault();
  if (gameState !== 'SEEKING' || myRole !== 'SEEKER' || !myAlive) return;
  send({ type: 'SHOOT' });
  shootBtn.style.transform = 'scale(0.9)';
  setTimeout(() => (shootBtn.style.transform = ''), 120);
}

// ============================================================
// UI FLOW
// ============================================================
function applyRoleUI() {
  rolePill.className = myRole === 'SEEKER' ? 'seeker' : 'hider';
  rolePill.textContent = myRole === 'SEEKER' ? '👮 SEEKER' : '🙈 HIDER';
  shootBtn.classList.toggle('hidden', myRole !== 'SEEKER');
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
// device (Tauri on macOS, or the native Capacitor plugin on
// Android) and then connects to it exactly like any other client.
// ============================================================
const hostBtn = el('hostBtn');
const hostStatus = el('hostStatus');

function isTauri() {
  return typeof window.__TAURI__ !== 'undefined';
}
function isNativeAndroid() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

hostBtn.onclick = async () => {
  const name = el('nameInput').value.trim() || 'Player';
  hostBtn.disabled = true;
  hostStatus.classList.remove('hidden');

  try {
    let ip;
    if (isTauri()) {
      hostStatus.textContent = 'Starting host server…';
      ip = await window.__TAURI__.invoke('start_host', { port: 8080 });
    } else if (isNativeAndroid()) {
      hostStatus.textContent = 'Starting host server…';
      const result = await window.Capacitor.Plugins.HostServer.start({ port: 8080 });
      ip = result.ip;
    } else {
      showToast('Host mode needs the installed app (Android/macOS), not a browser tab.');
      hostBtn.disabled = false;
      hostStatus.classList.add('hidden');
      return;
    }

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
// any host (macOS app, Android app, or a laptop running server.js)
// ============================================================
const browseBtn = el('browseBtn');
const browseResults = el('browseResults');

browseBtn.onclick = async () => {
  browseResults.classList.remove('hidden');
  browseResults.innerHTML = '<p class="sub">Searching your Wi-Fi for lobbies…</p>';

  let lobbies = [];
  try {
    if (isTauri()) {
      lobbies = await window.__TAURI__.invoke('discover_lobbies', { timeoutMs: 3000 });
    } else if (isNativeAndroid()) {
      const result = await window.Capacitor.Plugins.HostServer.discoverLobbies({ timeoutMs: 3000 });
      lobbies = result.lobbies || [];
    } else {
      browseResults.innerHTML = '<p class="sub">Browsing needs the installed app (Android/macOS) — enter the host IP manually below instead.</p>';
      return;
    }
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
function updateTimerPill() {
  if (!phaseEndsAt || (gameState !== 'HIDING' && gameState !== 'SEEKING')) {
    timerPill.textContent = '--:--';
    return;
  }
  const remaining = Math.max(0, Math.round((phaseEndsAt - Date.now()) / 1000));
  const m = String(Math.floor(remaining / 60)).padStart(2, '0');
  const s = String(remaining % 60).padStart(2, '0');
  timerPill.textContent = (gameState === 'HIDING' ? '🙈 ' : '👮 ') + `${m}:${s}`;
}

// ============================================================
// MAIN LOOP
// ============================================================
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  updateLocalPlayer(dt);
  updateTimerPill();
  renderer.render(scene, camera);
}

// ============================================================
// BOOT
// ============================================================
initScene();
setupJoystick(el('moveZone'), input.move);
setupJoystick(el('lookZone'), input.look);
animate();
