use std::collections::HashMap;
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tungstenite::{Message, WebSocket};

const HIDE_PHASE_SECS: u64 = 60;
const SEEK_PHASE_SECS: u64 = 300;
const SHOOT_RANGE: f64 = 6.0;
const MAX_PLAYERS: usize = 10;
const DISCOVERY_PORT: u16 = 41234;

#[derive(Clone)]
struct PlayerInfo {
    name: String,
    character: String,
    role: Option<String>, // "SEEKER" | "HIDER"
    alive: bool,
    x: f64,
    y: f64,
    z: f64,
    ry: f64,
}

impl Default for PlayerInfo {
    fn default() -> Self {
        PlayerInfo {
            name: "Player".into(),
            character: String::new(),
            role: None,
            alive: true,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            ry: 0.0,
        }
    }
}

struct GameState {
    status: String, // LOBBY | HIDING | SEEKING | ROUND_OVER
    phase_ends_at: Option<Instant>,
    players: HashMap<String, PlayerInfo>,
}

type Conn = Arc<Mutex<WebSocket<TcpStream>>>;

pub struct Hub {
    state: Mutex<GameState>,
    conns: Mutex<HashMap<String, Conn>>,
    pub running: AtomicBool,
}

impl Hub {
    fn new() -> Self {
        Hub {
            state: Mutex::new(GameState {
                status: "LOBBY".into(),
                phase_ends_at: None,
                players: HashMap::new(),
            }),
            conns: Mutex::new(HashMap::new()),
            running: AtomicBool::new(true),
        }
    }

    fn send_to(&self, id: &str, msg: &Value) {
        if let Some(conn) = self.conns.lock().unwrap().get(id) {
            let text = msg.to_string();
            let _ = conn.lock().unwrap().send(Message::Text(text));
        }
    }

    fn broadcast(&self, msg: &Value, except_id: Option<&str>) {
        let text = msg.to_string();
        let conns = self.conns.lock().unwrap();
        for (id, conn) in conns.iter() {
            if Some(id.as_str()) == except_id {
                continue;
            }
            let _ = conn.lock().unwrap().send(Message::Text(text.clone()));
        }
    }

    fn public_player_list(&self) -> Value {
        let state = self.state.lock().unwrap();
        let list: Vec<Value> = state
            .players
            .iter()
            .map(|(id, p)| {
                json!({
                    "id": id, "name": p.name, "character": p.character,
                    "role": p.role, "alive": p.alive,
                    "x": p.x, "y": p.y, "z": p.z, "ry": p.ry
                })
            })
            .collect();
        json!(list)
    }

    fn is_character_taken(&self, character: &str, except_id: &str) -> bool {
        let state = self.state.lock().unwrap();
        state.players.iter().any(|(id, p)| {
            id != except_id && p.character == character && !character.is_empty()
        })
    }

    fn on_connect(&self, id: &str) {
        {
            let mut state = self.state.lock().unwrap();
            state.players.insert(id.to_string(), PlayerInfo::default());
        }
        let (status, phase_ends_at) = {
            let state = self.state.lock().unwrap();
            (state.status.clone(), millis_remaining(&state.phase_ends_at))
        };
        self.send_to(
            id,
            &json!({
                "type": "WELCOME", "id": id, "state": status,
                "phaseEndsAt": phase_ends_at, "players": self.public_player_list()
            }),
        );
        self.broadcast(
            &json!({ "type": "LOBBY_UPDATE", "players": self.public_player_list() }),
            Some(id),
        );
    }

    fn on_disconnect(&self, id: &str) {
        self.conns.lock().unwrap().remove(id);
        {
            let mut state = self.state.lock().unwrap();
            state.players.remove(id);
        }
        self.broadcast(&json!({ "type": "PLAYER_LEFT", "id": id }), None);
        self.broadcast(
            &json!({ "type": "LOBBY_UPDATE", "players": self.public_player_list() }),
            None,
        );
        self.check_seeker_win();
    }

    fn on_message(&self, id: &str, raw: &str) {
        let msg: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => return,
        };
        let msg_type = msg.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match msg_type {
            "SET_PROFILE" => {
                let requested = msg.get("character").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let taken = !requested.is_empty() && self.is_character_taken(&requested, id);
                {
                    let mut state = self.state.lock().unwrap();
                    if let Some(p) = state.players.get_mut(id) {
                        if let Some(n) = msg.get("name").and_then(|v| v.as_str()) {
                            p.name = n.chars().take(24).collect();
                        }
                        if !requested.is_empty() && !taken {
                            p.character = requested.clone();
                        }
                    }
                }
                if taken {
                    self.send_to(id, &json!({ "type": "CHARACTER_TAKEN", "character": requested }));
                }
                self.broadcast(
                    &json!({ "type": "LOBBY_UPDATE", "players": self.public_player_list() }),
                    None,
                );
            }
            "SELECT_CHARACTER" => {
                let requested = msg.get("character").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if self.is_character_taken(&requested, id) {
                    self.send_to(id, &json!({ "type": "CHARACTER_TAKEN", "character": requested }));
                } else {
                    {
                        let mut state = self.state.lock().unwrap();
                        if let Some(p) = state.players.get_mut(id) {
                            p.character = requested;
                        }
                    }
                    self.broadcast(
                        &json!({ "type": "LOBBY_UPDATE", "players": self.public_player_list() }),
                        None,
                    );
                }
            }
            "START_GAME" => self.start_round(),
            "MOVE" => {
                let (status, role) = {
                    let state = self.state.lock().unwrap();
                    (
                        state.status.clone(),
                        state.players.get(id).and_then(|p| p.role.clone()),
                    )
                };
                let blocked = status == "HIDING" && role.as_deref() == Some("SEEKER");
                if (status == "HIDING" || status == "SEEKING") && !blocked {
                    let x = msg.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let y = msg.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let z = msg.get("z").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let ry = msg.get("ry").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    {
                        let mut state = self.state.lock().unwrap();
                        if let Some(p) = state.players.get_mut(id) {
                            p.x = x;
                            p.y = y;
                            p.z = z;
                            p.ry = ry;
                        }
                    }
                    self.broadcast(
                        &json!({ "type": "PLAYER_MOVED", "id": id, "x": x, "y": y, "z": z, "ry": ry }),
                        Some(id),
                    );
                }
            }
            "SHOOT" => self.handle_shoot(id),
            "PLAY_AGAIN" => self.reset_round(),
            _ => {}
        }
    }

    fn handle_shoot(&self, shooter_id: &str) {
        let (status, shooter_role, shooter_alive, shooter_pos) = {
            let state = self.state.lock().unwrap();
            let p = state.players.get(shooter_id);
            (
                state.status.clone(),
                p.and_then(|p| p.role.clone()),
                p.map(|p| p.alive).unwrap_or(false),
                p.map(|p| (p.x, p.y, p.z)),
            )
        };
        if status != "SEEKING" || shooter_role.as_deref() != Some("SEEKER") || !shooter_alive {
            return;
        }
        let (sx, sy, sz) = match shooter_pos {
            Some(p) => p,
            None => return,
        };

        let hit_id = {
            let state = self.state.lock().unwrap();
            state
                .players
                .iter()
                .find(|(_, p)| {
                    p.role.as_deref() == Some("HIDER")
                        && p.alive
                        && dist3((sx, sy, sz), (p.x, p.y, p.z)) <= SHOOT_RANGE
                })
                .map(|(id, _)| id.clone())
        };

        if let Some(target_id) = hit_id {
            {
                let mut state = self.state.lock().unwrap();
                if let Some(p) = state.players.get_mut(&target_id) {
                    p.alive = false;
                }
            }
            self.broadcast(
                &json!({ "type": "PLAYER_ELIMINATED", "id": target_id, "by": shooter_id }),
                None,
            );
            self.check_seeker_win();
        }
    }

    fn check_seeker_win(&self) {
        let should_end = {
            let state = self.state.lock().unwrap();
            let hiders: Vec<&PlayerInfo> = state
                .players
                .values()
                .filter(|p| p.role.as_deref() == Some("HIDER"))
                .collect();
            !hiders.is_empty() && hiders.iter().all(|p| !p.alive)
        };
        if should_end {
            self.end_round("SEEKER_WINS");
        }
    }

    fn start_round(&self) {
        let ids: Vec<String> = {
            let state = self.state.lock().unwrap();
            state.players.keys().cloned().collect()
        };
        if ids.len() < 2 {
            return;
        }
        let seeker_idx = (rand::random::<u32>() as usize) % ids.len();
        {
            let mut state = self.state.lock().unwrap();
            for (i, id) in ids.iter().enumerate() {
                if let Some(p) = state.players.get_mut(id) {
                    p.role = Some(if i == seeker_idx { "SEEKER".into() } else { "HIDER".into() });
                    p.alive = true;
                }
            }
            state.status = "HIDING".into();
            state.phase_ends_at = Some(Instant::now() + Duration::from_secs(HIDE_PHASE_SECS));
        }
        let phase_ends_at = {
            let state = self.state.lock().unwrap();
            millis_remaining(&state.phase_ends_at)
        };
        self.broadcast(
            &json!({
                "type": "ROUND_START", "state": "HIDING",
                "phaseEndsAt": phase_ends_at, "players": self.public_player_list()
            }),
            None,
        );
    }

    fn begin_seeking(&self) {
        {
            let mut state = self.state.lock().unwrap();
            state.status = "SEEKING".into();
            state.phase_ends_at = Some(Instant::now() + Duration::from_secs(SEEK_PHASE_SECS));
        }
        let phase_ends_at = {
            let state = self.state.lock().unwrap();
            millis_remaining(&state.phase_ends_at)
        };
        self.broadcast(
            &json!({ "type": "SEEK_PHASE_START", "state": "SEEKING", "phaseEndsAt": phase_ends_at }),
            None,
        );
    }

    fn end_round(&self, reason: &str) {
        {
            let mut state = self.state.lock().unwrap();
            state.status = "ROUND_OVER".into();
            state.phase_ends_at = None;
        }
        self.broadcast(
            &json!({ "type": "ROUND_OVER", "reason": reason, "players": self.public_player_list() }),
            None,
        );
    }

    fn reset_round(&self) {
        {
            let mut state = self.state.lock().unwrap();
            state.status = "LOBBY".into();
            state.phase_ends_at = None;
            for p in state.players.values_mut() {
                p.role = None;
                p.alive = true;
                p.x = 0.0;
                p.y = 0.0;
                p.z = 0.0;
                p.ry = 0.0;
            }
        }
        self.broadcast(
            &json!({ "type": "LOBBY_RESET", "players": self.public_player_list() }),
            None,
        );
    }

    // Called periodically to fire phase transitions when a timer elapses.
    fn tick(&self) {
        let (status, expired) = {
            let state = self.state.lock().unwrap();
            let expired = state
                .phase_ends_at
                .map(|t| Instant::now() >= t)
                .unwrap_or(false);
            (state.status.clone(), expired)
        };
        if !expired {
            return;
        }
        match status.as_str() {
            "HIDING" => self.begin_seeking(),
            "SEEKING" => self.end_round("HIDERS_WIN_TIMEOUT"),
            _ => {}
        }
    }
}

fn millis_remaining(t: &Option<Instant>) -> Option<u128> {
    t.map(|deadline| {
        let now = Instant::now();
        if deadline > now {
            (deadline - now).as_millis()
        } else {
            0
        }
    })
}

fn dist3(a: (f64, f64, f64), b: (f64, f64, f64)) -> f64 {
    let dx = a.0 - b.0;
    let dy = a.1 - b.1;
    let dz = a.2 - b.2;
    (dx * dx + dy * dy + dz * dz).sqrt()
}

fn gen_id() -> String {
    format!("{:08x}", rand::random::<u32>())
}

fn handle_client(hub: Arc<Hub>, stream: TcpStream) {
    let mut ws = match tungstenite::accept(stream) {
        Ok(ws) => ws,
        Err(_) => return,
    };

    let full = {
        let state = hub.state.lock().unwrap();
        state.players.len() >= MAX_PLAYERS
    };
    if full {
        let _ = ws.send(Message::Text(json!({ "type": "LOBBY_FULL" }).to_string()));
        let _ = ws.close(None);
        return;
    }

    let id = gen_id();
    let conn: Conn = Arc::new(Mutex::new(ws));
    hub.conns.lock().unwrap().insert(id.clone(), conn.clone());
    hub.on_connect(&id);

    loop {
        if !hub.running.load(Ordering::Relaxed) {
            break;
        }
        let msg = {
            let mut sock = conn.lock().unwrap();
            sock.read()
        };
        match msg {
            Ok(Message::Text(txt)) => hub.on_message(&id, &txt),
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }
    hub.on_disconnect(&id);
}

#[derive(Serialize, Clone)]
pub struct LobbyInfo {
    pub name: String,
    pub ip: String,
    pub players: usize,
    #[serde(rename = "maxPlayers")]
    pub max_players: usize,
}

/// Starts the embedded host server. Returns the LAN IP players should type in.
pub fn start(port: u16) -> Result<(Arc<Hub>, String), String> {
    let listener = TcpListener::bind(("0.0.0.0", port)).map_err(|e| e.to_string())?;
    let hub = Arc::new(Hub::new());

    let accept_hub = hub.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            if !accept_hub.running.load(Ordering::Relaxed) {
                break;
            }
            if let Ok(stream) = stream {
                let hub = accept_hub.clone();
                thread::spawn(move || handle_client(hub, stream));
            }
        }
    });

    let timer_hub = hub.clone();
    thread::spawn(move || {
        while timer_hub.running.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(500));
            timer_hub.tick();
        }
    });

    // Periodically announce this lobby over UDP broadcast so the
    // "Browse Lobbies" screen (on any device) can find it.
    let announce_hub = hub.clone();
    thread::spawn(move || {
        let socket = match UdpSocket::bind(("0.0.0.0", 0)) {
            Ok(s) => s,
            Err(_) => return,
        };
        let _ = socket.set_broadcast(true);
        while announce_hub.running.load(Ordering::Relaxed) {
            let player_count = announce_hub.state.lock().unwrap().players.len();
            let payload = json!({
                "app": "bagong-ilog-hideseek",
                "name": "Mac-Hosted Lobby",
                "players": player_count,
                "maxPlayers": MAX_PLAYERS,
                "port": port
            })
            .to_string();
            let _ = socket.send_to(payload.as_bytes(), ("255.255.255.255", DISCOVERY_PORT));
            thread::sleep(Duration::from_secs(2));
        }
    });

    let ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    Ok((hub, ip))
}

/// Listens for lobby broadcasts on the LAN for `timeout_ms` and returns what it finds.
pub fn discover(timeout_ms: u64) -> Result<Vec<LobbyInfo>, String> {
    let socket = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)).map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_millis(300)))
        .map_err(|e| e.to_string())?;

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut found: HashMap<String, LobbyInfo> = HashMap::new();
    let mut buf = [0u8; 1024];

    while Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((n, src)) => {
                if let Ok(text) = std::str::from_utf8(&buf[..n]) {
                    if let Ok(v) = serde_json::from_str::<Value>(text) {
                        if v.get("app").and_then(|a| a.as_str()) == Some("bagong-ilog-hideseek") {
                            let ip = src.ip().to_string();
                            found.insert(
                                ip.clone(),
                                LobbyInfo {
                                    name: v.get("name").and_then(|n| n.as_str()).unwrap_or("Lobby").to_string(),
                                    ip,
                                    players: v.get("players").and_then(|p| p.as_u64()).unwrap_or(0) as usize,
                                    max_players: v.get("maxPlayers").and_then(|p| p.as_u64()).unwrap_or(MAX_PLAYERS as u64) as usize,
                                },
                            );
                        }
                    }
                }
            }
            Err(_) => continue, // timeout on this read, loop until deadline
        }
    }

    Ok(found.into_values().collect())
}
