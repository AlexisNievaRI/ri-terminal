use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{fs, io::Seek, io::SeekFrom, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use std::{collections::HashMap, io::{Read, Write}, sync::Mutex};
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct AppState { sessions: Mutex<HashMap<u32, Session>> }

#[derive(Clone, Serialize)]
struct Output { id: u32, data: Vec<u8> }

fn size(cols: u16, rows: u16) -> PtySize { PtySize { rows, cols, pixel_width: 0, pixel_height: 0 } }

#[tauri::command]
async fn pty_spawn(app: AppHandle, state: State<'_, AppState>, id: u32, cols: u16, rows: u16, shell: String, args: Vec<String>, cwd: Option<String>) -> Result<(), String> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(&shell);
    for a in &args { cmd.arg(a); }
    let start = cwd.filter(|d| Path::new(d).is_dir()).map(std::ffi::OsString::from).or_else(|| std::env::var_os("USERPROFILE"));
    if let Some(d) = start { cmd.cwd(d); }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => { let _ = app.emit("pty-output", Output { id, data: buf[..n].to_vec() }); }
            }
        }
        let _ = app.emit("pty-exit", id);
    });
    state.sessions.lock().unwrap().insert(id, Session { master: pair.master, writer, child });
    Ok(())
}

#[tauri::command]
fn pty_write(state: State<AppState>, id: u32, data: String) -> Result<(), String> {
    if let Some(s) = state.sessions.lock().unwrap().get_mut(&id) {
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        let _ = s.writer.flush();
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(state: State<AppState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(s) = state.sessions.lock().unwrap().get(&id) {
        s.master.resize(size(cols, rows)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_close(state: State<AppState>, id: u32) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) { let _ = s.child.kill(); }
}

#[derive(Serialize, Default)]
struct CodexInfo {
    file: Option<String>, model: Option<String>, effort: Option<String>,
    five_h: Option<f64>, week: Option<f64>, five_reset: Option<i64>, week_reset: Option<i64>,
}

fn ms(t: SystemTime) -> u64 { t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }

fn codex_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("CODEX_HOME") { return Some(PathBuf::from(h)); }
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(|h| PathBuf::from(h).join(".codex"))
}

fn sorted_dirs(p: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(p).map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
    v.sort(); v.reverse(); v
}

// Primer rollout sin dueño creado después de abrir la pestaña (se reparten en orden de creación).
fn find_new_rollout(root: &Path, since_ms: u64, claimed: &[String]) -> Option<PathBuf> {
    let mut best: Option<(u64, PathBuf)> = None;
    let mut days = 0;
    'outer: for y in sorted_dirs(root) { for m in sorted_dirs(&y) { for d in sorted_dirs(&m) {
        days += 1; if days > 3 { break 'outer; }
        if let Ok(rd) = fs::read_dir(&d) { for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name.starts_with("rollout-") || !name.ends_with(".jsonl") { continue; }
            if claimed.iter().any(|c| Path::new(c) == p) { continue; }
            let Ok(md) = e.metadata() else { continue };
            let created = md.created().or_else(|_| md.modified()).map(ms).unwrap_or(0);
            if created >= since_ms && best.as_ref().map_or(true, |(b, _)| created < *b) { best = Some((created, p)); }
        } }
    } } }
    best.map(|(_, p)| p)
}

fn read_part(p: &Path, tail: bool, n: u64) -> String {
    let Ok(mut f) = fs::File::open(p) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if tail && len > n { let _ = f.seek(SeekFrom::Start(len - n)); }
    let mut buf = Vec::new();
    let _ = std::io::Read::read_to_end(&mut std::io::Read::take(&mut f, n), &mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

fn scan(info: &mut CodexInfo, text: &str) {
    let mut got_rl = false;
    for line in text.lines().rev() {
        if !got_rl && line.contains("\"token_count\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(rl) = v.pointer("/payload/rate_limits").filter(|x| x.is_object()) {
                    for key in ["primary", "secondary"] {
                        if let Some(w) = rl.get(key) {
                            let used = w.get("used_percent").and_then(|x| x.as_f64());
                            let mins = w.get("window_minutes").and_then(|x| x.as_f64()).unwrap_or(if key == "primary" { 300.0 } else { 10080.0 });
                            let reset = w.get("resets_at").and_then(|x| x.as_i64());
                            if mins <= 360.0 { info.five_h = used; info.five_reset = reset; } else { info.week = used; info.week_reset = reset; }
                        }
                    }
                    got_rl = true;
                }
            }
        }
        if info.model.is_none() && line.contains("\"turn_context\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                info.model = v.pointer("/payload/model").and_then(|x| x.as_str()).map(String::from);
                info.effort = v.pointer("/payload/effort").and_then(|x| x.as_str()).map(String::from);
            }
        }
        if got_rl && info.model.is_some() { break; }
    }
}

#[tauri::command]
fn codex_info(since_ms: u64, file: Option<String>, claimed: Vec<String>) -> CodexInfo {
    let mut info = CodexInfo::default();
    let Some(home) = codex_home() else { return info };
    let path = match file {
        Some(f) => PathBuf::from(f),
        None => match find_new_rollout(&home.join("sessions"), since_ms, &claimed) { Some(p) => p, None => return info },
    };
    if !path.exists() { return info; }
    info.file = Some(path.to_string_lossy().into_owned());
    scan(&mut info, &read_part(&path, true, 700_000));
    if info.model.is_none() { scan(&mut info, &read_part(&path, false, 400_000)); }
    info
}

#[derive(Serialize)]
struct EnvVar { n: String, v: String }

fn valid_name(n: &str) -> bool {
    n.chars().next().map_or(false, |c| c.is_ascii_alphabetic() || c == '_')
        && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// Ejecuta PowerShell sin ventana; los datos sensibles viajan por variables de entorno del proceso hijo, nunca por la línea de comandos.
fn ps(script: &str, envs: &[(&str, &str)]) -> Result<String, String> {
    use std::process::Command;
    let full = format!("[Console]::OutputEncoding=[Text.Encoding]::UTF8; {}", script);
    let mut c = Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", full.as_str()]);
    for (k, v) in envs { c.env(k, v); }
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(0x08000000); }
    let o = c.output().map_err(|e| format!("No se pudo ejecutar PowerShell: {e}"))?;
    let out = String::from_utf8_lossy(&o.stdout).trim_start_matches('\u{feff}').to_string();
    let err = String::from_utf8_lossy(&o.stderr).to_string();
    if o.status.success() { Ok(out) } else { Err(format!("{}{}", out, err)) }
}

#[tauri::command]
async fn env_list() -> Result<Vec<EnvVar>, String> {
    let out = ps(r#"$l=@([Environment]::GetEnvironmentVariables('User').GetEnumerator()|%{[pscustomobject]@{n=[string]$_.Key;v=[string]$_.Value}}); ConvertTo-Json -InputObject $l -Compress"#, &[])?;
    if out.trim().is_empty() { return Ok(vec![]); }
    let v: serde_json::Value = serde_json::from_str(out.trim()).map_err(|e| e.to_string())?;
    let arr = match v { serde_json::Value::Array(a) => a, o @ serde_json::Value::Object(_) => vec![o], _ => vec![] };
    let mut r: Vec<EnvVar> = arr.iter().filter_map(|x| Some(EnvVar { n: x.get("n")?.as_str()?.to_string(), v: x.get("v")?.as_str()?.to_string() })).collect();
    r.sort_by(|a, b| a.n.to_lowercase().cmp(&b.n.to_lowercase()));
    Ok(r)
}

#[tauri::command]
async fn env_set(name: String, value: String) -> Result<(), String> {
    if !valid_name(&name) { return Err("Nombre inválido: usa letras, números y _ (sin espacios).".into()); }
    if value.is_empty() { return Err("El valor no puede estar vacío.".into()); }
    ps("[Environment]::SetEnvironmentVariable($env:RI_N,$env:RI_V,'User')", &[("RI_N", name.as_str()), ("RI_V", value.as_str())])?;
    std::env::set_var(&name, &value); // las pestañas nuevas de la app la heredan
    Ok(())
}

#[tauri::command]
async fn env_delete(name: String) -> Result<(), String> {
    if !valid_name(&name) { return Err("Nombre inválido.".into()); }
    ps("[Environment]::SetEnvironmentVariable($env:RI_N,$null,'User')", &[("RI_N", name.as_str())])?;
    std::env::remove_var(&name);
    Ok(())
}

#[tauri::command]
fn cfg_read(path: String) -> Result<String, String> {
    let s = fs::read_to_string(&path).map_err(|e| format!("No se pudo leer {path}: {e}"))?;
    Ok(s.trim_start_matches('\u{feff}').to_string())
}

// Valida el JSON, deja un respaldo del archivo anterior y escribe el nuevo contenido.
#[tauri::command]
fn cfg_write(path: String, content: String) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(&content).map_err(|e| format!("JSON inválido: {e}"))?;
    let p = PathBuf::from(&path);
    let mut bak = String::new();
    if p.exists() {
        let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        bak = format!("{path}.bak-{t}");
        fs::copy(&p, &bak).map_err(|e| format!("No se pudo crear el respaldo: {e}"))?;
    }
    fs::write(&p, content).map_err(|e| format!("No se pudo guardar: {e}"))?;
    Ok(bak)
}

// Equivale a: codex mcp remove oracle_local + codex mcp add oracle_local --env VAR=valor ... -- cmd.exe /d /s /c "cd /d <dir> && OracleMcp.exe"
#[tauri::command]
async fn mcp_apply(dir: String, vars: Vec<String>) -> Result<String, String> {
    if vars.iter().any(|v| !valid_name(v)) { return Err("Hay un nombre de variable inválido en el JSON.".into()); }
    let script = r#"$ErrorActionPreference='Continue'; (& codex mcp remove oracle_local 2>&1 | Out-String); $a=@('mcp','add','oracle_local'); $miss=@(); foreach($n in ($env:RI_VARS -split ',')){ if($n){ $v=[Environment]::GetEnvironmentVariable($n,'User'); if($v){ $a+=@('--env',($n+'='+$v)) } else { $miss+=$n } } }; $a+=@('--','cmd.exe','/d','/s','/c',('cd /d '+$env:RI_DIR+' && OracleMcp.exe')); if($miss.Count){ 'Sin valor (omitidas): '+($miss -join ', ') }; (& codex @a 2>&1 | Out-String); '--- codex mcp get oracle_local ---'; (& codex mcp get oracle_local 2>&1 | Out-String)"#;
    let joined = vars.join(",");
    ps(script, &[("RI_VARS", joined.as_str()), ("RI_DIR", dir.as_str())])
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_close, codex_info, env_list, env_set, env_delete, cfg_read, cfg_write, mcp_apply])
        .run(tauri::generate_context!())
        .expect("error al iniciar RI Terminal");
}
