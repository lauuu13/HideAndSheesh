package com.bagongilog.hostserver;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.text.format.Formatter;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.HashMap;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "HostServer")
public class HostServerPlugin extends Plugin {

    private GameServer server;
    private ScheduledExecutorService timerExecutor;
    private ScheduledExecutorService announceExecutor;

    private static final long HIDE_PHASE_MS = 60_000;
    private static final long SEEK_PHASE_MS = 300_000;
    private static final double SHOOT_RANGE = 6.0;
    private static final int MAX_PLAYERS = 10;
    private static final int DISCOVERY_PORT = 41234;

    @PluginMethod
    public void start(PluginCall call) {
        if (server != null) {
            call.reject("Host server is already running");
            return;
        }
        int port = call.getInt("port", 8080);
        try {
            server = new GameServer(port);
            server.setReuseAddr(true);
            server.start();

            timerExecutor = Executors.newSingleThreadScheduledExecutor();
            timerExecutor.scheduleAtFixedRate(() -> server.tick(), 500, 500, TimeUnit.MILLISECONDS);

            announceExecutor = Executors.newSingleThreadScheduledExecutor();
            announceExecutor.scheduleAtFixedRate(() -> broadcastAnnouncement(port), 0, 2, TimeUnit.SECONDS);

            JSObject ret = new JSObject();
            ret.put("ip", getLocalIpAddress());
            call.resolve(ret);
        } catch (Exception e) {
            server = null;
            call.reject("Failed to start host server: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (timerExecutor != null) {
            timerExecutor.shutdownNow();
            timerExecutor = null;
        }
        if (announceExecutor != null) {
            announceExecutor.shutdownNow();
            announceExecutor = null;
        }
        if (server != null) {
            try {
                server.stop();
            } catch (Exception ignored) {
            }
            server = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void discoverLobbies(PluginCall call) {
        int timeoutMs = call.getInt("timeoutMs", 3000);
        new Thread(() -> {
            Map<String, JSObject> found = new HashMap<>();
            try (DatagramSocket socket = new DatagramSocket(DISCOVERY_PORT)) {
                socket.setBroadcast(true);
                socket.setSoTimeout(300);
                long deadline = System.currentTimeMillis() + timeoutMs;
                byte[] buf = new byte[1024];
                while (System.currentTimeMillis() < deadline) {
                    DatagramPacket packet = new DatagramPacket(buf, buf.length);
                    try {
                        socket.receive(packet);
                        String text = new String(packet.getData(), 0, packet.getLength());
                        JSONObject obj = new JSONObject(text);
                        if ("bagong-ilog-hideseek".equals(obj.optString("app"))) {
                            String ip = packet.getAddress().getHostAddress();
                            JSObject lobby = new JSObject();
                            lobby.put("name", obj.optString("name", "Lobby"));
                            lobby.put("ip", ip);
                            lobby.put("players", obj.optInt("players", 0));
                            lobby.put("maxPlayers", obj.optInt("maxPlayers", MAX_PLAYERS));
                            found.put(ip, lobby);
                        }
                    } catch (java.net.SocketTimeoutException ignored) {
                        // expected — keep looping until deadline
                    }
                }
            } catch (Exception ignored) {
            }

            JSObject ret = new JSObject();
            JSArray lobbies = new JSArray();
            for (JSObject lobby : found.values()) lobbies.put(lobby);
            ret.put("lobbies", lobbies);
            call.resolve(ret);
        }).start();
    }

    private void broadcastAnnouncement(int port) {
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            JSONObject payload = new JSONObject();
            payload.put("app", "bagong-ilog-hideseek");
            payload.put("name", "Phone-Hosted Lobby");
            payload.put("players", server != null ? server.playerCount() : 0);
            payload.put("maxPlayers", MAX_PLAYERS);
            payload.put("port", port);
            byte[] data = payload.toString().getBytes();
            DatagramPacket packet = new DatagramPacket(
                data, data.length, InetAddress.getByName("255.255.255.255"), DISCOVERY_PORT
            );
            socket.send(packet);
        } catch (Exception ignored) {
        }
    }

    @PluginMethod
    public void getLocalIp(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ip", getLocalIpAddress());
        call.resolve(ret);
    }

    private String getLocalIpAddress() {
        try {
            WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            int ip = wm.getConnectionInfo().getIpAddress();
            return Formatter.formatIpAddress(ip);
        } catch (Exception e) {
            return "127.0.0.1";
        }
    }

    // ============================================================
    // Embedded game server — mirrors server.js's protocol exactly
    // so any client (laptop, other phones, this phone's own UI)
    // connects the normal way.
    // ============================================================
    private class GameServer extends WebSocketServer {
        private final Map<WebSocket, String> ids = new ConcurrentHashMap<>();
        private final Map<String, PlayerInfo> players = new ConcurrentHashMap<>();
        private final Map<String, WebSocket> sockets = new ConcurrentHashMap<>();
        private final Random random = new Random();

        private String status = "LOBBY";
        private Long phaseEndsAt = null; // epoch millis

        GameServer(int port) {
            super(new InetSocketAddress("0.0.0.0", port));
        }

        @Override
        public void onOpen(WebSocket conn, ClientHandshake handshake) {
            if (players.size() >= MAX_PLAYERS) {
                JSONObject full = new JSONObject();
                try {
                    full.put("type", "LOBBY_FULL");
                } catch (JSONException ignored) {
                }
                conn.send(full.toString());
                conn.close();
                return;
            }

            String id = Long.toHexString(random.nextLong() & 0xffffffffL);
            ids.put(conn, id);
            sockets.put(id, conn);
            players.put(id, new PlayerInfo());

            sendTo(id, welcomeMessage(id));
            JSONObject update = new JSONObject();
            try {
                update.put("type", "LOBBY_UPDATE");
                update.put("players", playerListJson());
            } catch (JSONException ignored) {
            }
            broadcast(update, id);
        }

        @Override
        public void onClose(WebSocket conn, int code, String reason, boolean remote) {
            String id = ids.remove(conn);
            if (id == null) return;
            sockets.remove(id);
            players.remove(id);
            JSONObject left = new JSONObject();
            try {
                left.put("type", "PLAYER_LEFT");
                left.put("id", id);
            } catch (JSONException ignored) {
            }
            broadcast(left, null);
            JSONObject update = new JSONObject();
            try {
                update.put("type", "LOBBY_UPDATE");
                update.put("players", playerListJson());
            } catch (JSONException ignored) {
            }
            broadcast(update, null);
            checkSeekerWin();
        }

        @Override
        public void onMessage(WebSocket conn, String raw) {
            String id = ids.get(conn);
            if (id == null) return;
            try {
                JSONObject msg = new JSONObject(raw);
                String type = msg.optString("type", "");
                switch (type) {
                    case "SET_PROFILE":
                        onSetProfile(id, msg);
                        break;
                    case "SELECT_CHARACTER":
                        onSelectCharacter(id, msg);
                        break;
                    case "START_GAME":
                        startRound();
                        break;
                    case "MOVE":
                        onMove(id, msg);
                        break;
                    case "SHOOT":
                        onShoot(id);
                        break;
                    case "PLAY_AGAIN":
                        resetRound();
                        break;
                }
            } catch (JSONException ignored) {
            }
        }

        @Override
        public void onError(WebSocket conn, Exception ex) {
        }

        @Override
        public void onStart() {
        }

        // ---- message handlers ----

        private void onSetProfile(String id, JSONObject msg) {
            PlayerInfo p = players.get(id);
            if (p == null) return;
            String name = msg.optString("name", p.name);
            p.name = name.length() > 24 ? name.substring(0, 24) : name;

            String character = msg.optString("character", "");
            if (!character.isEmpty()) {
                if (isCharacterTaken(character, id)) {
                    sendCharacterTaken(id, character);
                } else {
                    p.character = character;
                }
            }
            broadcastLobbyUpdate();
        }

        private void onSelectCharacter(String id, JSONObject msg) {
            PlayerInfo p = players.get(id);
            if (p == null) return;
            String character = msg.optString("character", "");
            if (isCharacterTaken(character, id)) {
                sendCharacterTaken(id, character);
            } else {
                p.character = character;
                broadcastLobbyUpdate();
            }
        }

        private boolean isCharacterTaken(String character, String exceptId) {
            if (character.isEmpty()) return false;
            for (Map.Entry<String, PlayerInfo> e : players.entrySet()) {
                if (!e.getKey().equals(exceptId) && character.equals(e.getValue().character)) return true;
            }
            return false;
        }

        private void sendCharacterTaken(String id, String character) {
            JSONObject msg = new JSONObject();
            try {
                msg.put("type", "CHARACTER_TAKEN");
                msg.put("character", character);
            } catch (JSONException ignored) {
            }
            sendTo(id, msg);
        }

        private void broadcastLobbyUpdate() {
            JSONObject msg = new JSONObject();
            try {
                msg.put("type", "LOBBY_UPDATE");
                msg.put("players", playerListJson());
            } catch (JSONException ignored) {
            }
            broadcast(msg, null);
        }

        int playerCount() {
            return players.size();
        }

        private void onMove(String id, JSONObject msg) {
            PlayerInfo p = players.get(id);
            if (p == null) return;
            boolean blocked = "HIDING".equals(status) && "SEEKER".equals(p.role);
            if (!("HIDING".equals(status) || "SEEKING".equals(status)) || blocked) return;

            p.x = msg.optDouble("x", p.x);
            p.y = msg.optDouble("y", p.y);
            p.z = msg.optDouble("z", p.z);
            p.ry = msg.optDouble("ry", p.ry);

            JSONObject moved = new JSONObject();
            try {
                moved.put("type", "PLAYER_MOVED");
                moved.put("id", id);
                moved.put("x", p.x);
                moved.put("y", p.y);
                moved.put("z", p.z);
                moved.put("ry", p.ry);
            } catch (JSONException ignored) {
            }
            broadcast(moved, id);
        }

        private void onShoot(String shooterId) {
            PlayerInfo shooter = players.get(shooterId);
            if (shooter == null || !"SEEKING".equals(status) || !"SEEKER".equals(shooter.role) || !shooter.alive) {
                return;
            }
            for (Map.Entry<String, PlayerInfo> entry : players.entrySet()) {
                PlayerInfo target = entry.getValue();
                if (!"HIDER".equals(target.role) || !target.alive) continue;
                double dx = shooter.x - target.x, dy = shooter.y - target.y, dz = shooter.z - target.z;
                double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (dist <= SHOOT_RANGE) {
                    target.alive = false;
                    JSONObject elim = new JSONObject();
                    try {
                        elim.put("type", "PLAYER_ELIMINATED");
                        elim.put("id", entry.getKey());
                        elim.put("by", shooterId);
                    } catch (JSONException ignored) {
                    }
                    broadcast(elim, null);
                    checkSeekerWin();
                    break;
                }
            }
        }

        private void checkSeekerWin() {
            boolean anyHiders = false;
            boolean allDead = true;
            for (PlayerInfo p : players.values()) {
                if ("HIDER".equals(p.role)) {
                    anyHiders = true;
                    if (p.alive) allDead = false;
                }
            }
            if (anyHiders && allDead) endRound("SEEKER_WINS");
        }

        private void startRound() {
            if (players.size() < 2) return;
            String[] idArr = players.keySet().toArray(new String[0]);
            int seekerIdx = random.nextInt(idArr.length);
            for (int i = 0; i < idArr.length; i++) {
                PlayerInfo p = players.get(idArr[i]);
                p.role = (i == seekerIdx) ? "SEEKER" : "HIDER";
                p.alive = true;
            }
            status = "HIDING";
            phaseEndsAt = System.currentTimeMillis() + HIDE_PHASE_MS;

            JSONObject msg = new JSONObject();
            try {
                msg.put("type", "ROUND_START");
                msg.put("state", "HIDING");
                msg.put("phaseEndsAt", remainingMillis());
                msg.put("players", playerListJson());
            } catch (JSONException ignored) {
            }
            broadcast(msg, null);
        }

        private void beginSeeking() {
            status = "SEEKING";
            phaseEndsAt = System.currentTimeMillis() + SEEK_PHASE_MS;
            JSONObject msg = new JSONObject();
            try {
                msg.put("type", "SEEK_PHASE_START");
                msg.put("state", "SEEKING");
                msg.put("phaseEndsAt", remainingMillis());
            } catch (JSONException ignored) {
            }
            broadcast(msg, null);
        }

        private void endRound(String reason) {
            status = "ROUND_OVER";
            phaseEndsAt = null;
            JSONObject msg = new JSONObject();
            try {
                msg.put("type", "ROUND_OVER");
                msg.put("reason", reason);
                msg.put("players", playerListJson());
            } catch (JSONException ignored) {
            }
            broadcast(msg, null);
        }

        private void resetRound() {
            status = "LOBBY";
            phaseEndsAt = null;
            for (PlayerInfo p : players.values()) {
                p.role = null;
                p.alive = true;
                p.x = 0;
                p.y = 0;
                p.z = 0;
                p.ry = 0;
            }
            JSONObject msg = new JSONObject();
            try {
                msg.put("type", "LOBBY_RESET");
                msg.put("players", playerListJson());
            } catch (JSONException ignored) {
            }
            broadcast(msg, null);
        }

        void tick() {
            if (phaseEndsAt == null) return;
            if (System.currentTimeMillis() < phaseEndsAt) return;
            if ("HIDING".equals(status)) beginSeeking();
            else if ("SEEKING".equals(status)) endRound("HIDERS_WIN_TIMEOUT");
        }

        // ---- helpers ----

        private Object remainingMillis() {
            if (phaseEndsAt == null) return JSONObject.NULL;
            long rem = phaseEndsAt - System.currentTimeMillis();
            return Math.max(0, rem);
        }

        private JSONArray playerListJson() {
            JSONArray arr = new JSONArray();
            for (Map.Entry<String, PlayerInfo> e : players.entrySet()) {
                PlayerInfo p = e.getValue();
                JSONObject o = new JSONObject();
                try {
                    o.put("id", e.getKey());
                    o.put("name", p.name);
                    o.put("character", p.character);
                    o.put("role", p.role == null ? JSONObject.NULL : p.role);
                    o.put("alive", p.alive);
                    o.put("x", p.x);
                    o.put("y", p.y);
                    o.put("z", p.z);
                    o.put("ry", p.ry);
                } catch (JSONException ignored) {
                }
                arr.put(o);
            }
            return arr;
        }

        private JSONObject welcomeMessage(String id) {
            JSONObject msg = new JSONObject();
            try {
                msg.put("type", "WELCOME");
                msg.put("id", id);
                msg.put("state", status);
                msg.put("phaseEndsAt", remainingMillis());
                msg.put("players", playerListJson());
            } catch (JSONException ignored) {
            }
            return msg;
        }

        private void sendTo(String id, JSONObject msg) {
            WebSocket ws = sockets.get(id);
            if (ws != null && ws.isOpen()) ws.send(msg.toString());
        }

        private void broadcast(JSONObject msg, String exceptId) {
            String text = msg.toString();
            for (Map.Entry<String, WebSocket> e : sockets.entrySet()) {
                if (e.getKey().equals(exceptId)) continue;
                if (e.getValue().isOpen()) e.getValue().send(text);
            }
        }
    }

    private static class PlayerInfo {
        String name = "Player";
        String character = "";
        String role = null;
        boolean alive = true;
        double x = 0, y = 0, z = 0, ry = 0;
    }
}
