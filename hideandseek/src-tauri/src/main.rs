#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host_server;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use host_server::Hub;
use tauri::State;

#[derive(Default)]
struct HostState(Mutex<Option<Arc<Hub>>>);

#[tauri::command]
fn start_host(port: u16, state: State<HostState>) -> Result<String, String> {
  let mut guard = state.0.lock().map_err(|e| e.to_string())?;
  if guard.is_some() {
    return Err("Host server is already running".into());
  }
  let (hub, ip) = host_server::start(port)?;
  *guard = Some(hub);
  Ok(ip)
}

#[tauri::command]
fn stop_host(state: State<HostState>) -> Result<(), String> {
  let mut guard = state.0.lock().map_err(|e| e.to_string())?;
  if let Some(hub) = guard.take() {
    hub.running.store(false, Ordering::Relaxed);
  }
  Ok(())
}

#[tauri::command]
fn discover_lobbies(timeout_ms: u64) -> Result<Vec<host_server::LobbyInfo>, String> {
  host_server::discover(timeout_ms)
}

fn main() {
  tauri::Builder::default()
    .manage(HostState::default())
    .invoke_handler(tauri::generate_handler![start_host, stop_host, discover_lobbies])
    .run(tauri::generate_context!())
    .expect("error while running Bagong Ilog Hide and Seek");
}
