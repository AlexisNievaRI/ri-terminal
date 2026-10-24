use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{fs, io::Seek, io::SeekFrom, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use std::{collections::HashMap, io::{Read, Write}, sync::{Mutex, OnceLock}};
use tauri::{AppHandle, Emitter, State};
use base64::{engine::general_purpose::STANDARD, Engine as _};

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

#[derive(Serialize, Clone)]
struct SessionInfo { id: String, file: String, cwd: Option<String>, title: String, updated: u64 }

static SESS_CACHE: OnceLock<Mutex<HashMap<String, (u64, Option<SessionInfo>)>>> = OnceLock::new();

// El nombre del archivo es rollout-<fecha>-<uuid>.jsonl: el uuid son los últimos 36 caracteres.
fn id_from_name(name: &str) -> Option<String> {
    let s = name.strip_suffix(".jsonl")?;
    if s.len() < 36 || !s.is_char_boundary(s.len() - 36) { return None; }
    let id = &s[s.len() - 36..];
    if id.matches('-').count() == 4 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') { Some(id.to_string()) } else { None }
}

fn clean_title(t: &str) -> String {
    let line = t.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let one = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > 90 { let mut s: String = one.chars().take(90).collect(); s.push('…'); s } else { one }
}

// Lee solo el comienzo del rollout: carpeta de trabajo y primer mensaje del usuario (se usa como título).
fn parse_session(path: &Path, updated: u64) -> Option<SessionInfo> {
    let name = path.file_name()?.to_str()?;
    let mut id = id_from_name(name);
    let mut cwd: Option<String> = None;
    let mut title: Option<String> = None;
    let mut fallback: Option<String> = None;
    for line in read_part(path, false, 262_144).lines() {
        if cwd.is_none() && line.contains("\"session_meta\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                cwd = v.pointer("/payload/cwd").and_then(|x| x.as_str()).map(String::from);
                if id.is_none() { id = v.pointer("/payload/id").and_then(|x| x.as_str()).map(String::from); }
            }
        } else if title.is_none() && line.contains("\"user_message\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if v.pointer("/payload/type").and_then(|x| x.as_str()) == Some("user_message") {
                    if let Some(m) = v.pointer("/payload/message").and_then(|x| x.as_str()) {
                        let t = clean_title(m);
                        if !t.is_empty() { title = Some(t); }
                    }
                }
            }
        } else if fallback.is_none() && line.contains("\"role\":\"user\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(arr) = v.pointer("/payload/content").and_then(|x| x.as_array()) {
                    for c in arr {
                        if let Some(t) = c.get("text").and_then(|x| x.as_str()) {
                            let t = t.trim_start();
                            if !t.starts_with('<') && !t.starts_with('#') {
                                let t = clean_title(t);
                                if !t.is_empty() { fallback = Some(t); break; }
                            }
                        }
                    }
                }
            }
        }
        if cwd.is_some() && title.is_some() { break; }
    }
    // Sin ningún mensaje del usuario no hay nada que retomar.
    let title = title.or(fallback)?;
    Some(SessionInfo { id: id?, file: path.to_string_lossy().into_owned(), cwd, title, updated })
}

#[tauri::command]
fn codex_sessions(limit: usize) -> Vec<SessionInfo> {
    let Some(home) = codex_home() else { return vec![] };
    let root = home.join("sessions");
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    for y in sorted_dirs(&root) { for m in sorted_dirs(&y) { for d in sorted_dirs(&m) {
        if let Ok(rd) = fs::read_dir(&d) { for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name.starts_with("rollout-") || !name.ends_with(".jsonl") { continue; }
            let up = e.metadata().and_then(|m| m.modified()).map(ms).unwrap_or(0);
            files.push((up, p));
        } }
    } } }
    // Una conversación retomada sigue escribiendo en su archivo original, por eso se ordena por última modificación.
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let limit = limit.clamp(1, 300);
    let cache = SESS_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut out: Vec<SessionInfo> = Vec::new();
    for (up, p) in files {
        if out.len() >= limit { break; }
        let key = p.to_string_lossy().into_owned();
        let cached = cache.lock().ok().and_then(|c| c.get(&key).and_then(|(u, s)| if *u == up { Some(s.clone()) } else { None }));
        let info = match cached {
            Some(i) => i,
            None => {
                let i = parse_session(&p, up);
                if let Ok(mut c) = cache.lock() { c.insert(key, (up, i.clone())); }
                i
            }
        };
        if let Some(i) = info { out.push(i); }
    }
    out
}

#[derive(Serialize)]
struct TicketFile { client: String, name: String, path: String, size: u64, modified: u64 }

// Busca en <base>\<cliente>\<sub> los archivos cuyo nombre empieza con el número de tarea (con o sin prefijo tipo RI-T-).
#[tauri::command]
fn ticket_find(base: String, sub: String, ticket: String) -> Result<Vec<TicketFile>, String> {
    let t = ticket.trim().to_lowercase();
    if t.is_empty() { return Err("Escribe un número de tarea.".into()); }
    let digits: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
    let mut cands = vec![t.clone()];
    if digits.len() >= 4 && digits != t { cands.push(digits); }
    let root = PathBuf::from(base.trim());
    let rd = fs::read_dir(&root).map_err(|e| format!("No se pudo abrir {}: {}", root.display(), e))?;
    let sub = sub.trim().trim_matches(|c: char| c == '\\' || c == '/').to_string();
    let mut out: Vec<TicketFile> = Vec::new();
    for c in rd.flatten() {
        let cp = c.path();
        if !cp.is_dir() { continue; }
        let dir = if sub.is_empty() { cp.clone() } else { cp.join(&sub) };
        let Ok(files) = fs::read_dir(&dir) else { continue };
        let client = cp.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        for f in files.flatten() {
            let p = f.path();
            if !p.is_file() { continue; }
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            let low = name.to_lowercase();
            if !cands.iter().any(|c| low.starts_with(c.as_str())) { continue; }
            let md = f.metadata().ok();
            let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
            let modified = md.and_then(|m| m.modified().ok()).map(ms).unwrap_or(0);
            out.push(TicketFile { client: client.clone(), name, path: p.to_string_lossy().into_owned(), size, modified });
        }
    }
    out.sort_by(|a, b| a.client.cmp(&b.client).then(a.name.cmp(&b.name)));
    Ok(out)
}

// ---------- Skills de Codex: cargar una carpeta o un .md, nombrarla y guardarla en <CODEX_HOME>\skills ----------
fn skill_dir(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Nombre inválido: usa solo letras, números, guiones y guion bajo.".into());
    }
    let home = codex_home().ok_or("No se encontró la carpeta de Codex.")?;
    Ok(home.join("skills").join(name))
}

// Lee un campo simple del encabezado (--- ... ---) de un SKILL.md.
fn fm_field(md: &str, key: &str) -> Option<String> {
    let mut it = md.trim_start_matches('\u{feff}').lines();
    if it.next()?.trim() != "---" { return None; }
    for l in it {
        if l.trim() == "---" { break; }
        if let Some(v) = l.trim_start().strip_prefix(key) {
            if let Some(v) = v.trim_start().strip_prefix(':') {
                let v = v.trim().trim_matches(|c: char| c == '\'' || c == '"');
                return Some(v.to_string());
            }
        }
    }
    None
}

// Deja el nombre elegido en el encabezado del SKILL.md (así se invoca como $nombre).
fn patch_skill_name(md: &str, name: &str) -> String {
    let text = md.trim_start_matches('\u{feff}');
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    if lines.first().map(|l| l.trim()) == Some("---") {
        let end = lines.iter().skip(1).position(|l| l.trim() == "---").map(|i| i + 1);
        if let Some(end) = end {
            for i in 1..end {
                if lines[i].trim_start().starts_with("name:") {
                    lines[i] = format!("name: {}", name);
                    return lines.join(nl) + nl;
                }
            }
            lines.insert(1, format!("name: {}", name));
            return lines.join(nl) + nl;
        }
    }
    format!("---{nl}name: {name}{nl}description: Skill cargada desde RI Terminal.{nl}---{nl}{nl}{text}")
}

fn walk_files(root: &Path, dir: &Path, out: &mut Vec<String>, size: &mut u64) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= 300 { return; }
        let p = e.path();
        if e.file_name().to_string_lossy().starts_with('.') { continue; }
        if p.is_dir() {
            walk_files(root, &p, out, size);
        } else if let Ok(md) = e.metadata() {
            *size += md.len();
            if let Ok(r) = p.strip_prefix(root) { out.push(r.to_string_lossy().replace('\\', "/")); }
        }
    }
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') { continue; }
        let from = e.path();
        let to = dst.join(&name);
        if from.is_dir() { copy_dir(&from, &to)?; } else { fs::copy(&from, &to)?; }
    }
    Ok(())
}

#[derive(Serialize)]
struct SkillInspect { kind: String, name: String, description: String, files: Vec<String>, size: u64 }

#[tauri::command]
fn skill_inspect(path: String) -> Result<SkillInspect, String> {
    let p = PathBuf::from(&path);
    let kind = if p.is_dir() { "dir" } else { "file" };
    let md_path = if kind == "dir" { p.join("SKILL.md") } else { p.clone() };
    let md = fs::read_to_string(&md_path).map_err(|_| {
        if kind == "dir" { "La carpeta no tiene un archivo SKILL.md.".to_string() } else { "No se pudo leer el archivo.".to_string() }
    })?;
    let stem_os = if kind == "dir" { p.file_name() } else { p.file_stem() };
    let stem = stem_os.and_then(|n| n.to_str()).unwrap_or("skill").to_string();
    let name = fm_field(&md, "name").filter(|s| !s.is_empty()).unwrap_or(stem);
    let mut files: Vec<String> = Vec::new();
    let mut size: u64 = 0;
    if kind == "dir" {
        walk_files(&p, &p, &mut files, &mut size);
        files.sort();
    } else {
        size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        files.push(p.file_name().and_then(|n| n.to_str()).unwrap_or("SKILL.md").to_string());
    }
    Ok(SkillInspect { kind: kind.to_string(), name, description: fm_field(&md, "description").unwrap_or_default(), files, size })
}

// Copia la skill a <CODEX_HOME>\skills\<name>. Si ya existe y no se pidió reemplazar, devuelve "EXISTE".
#[tauri::command]
fn skill_save(src: String, name: String, overwrite: bool) -> Result<String, String> {
    let dst = skill_dir(&name)?;
    let sp = PathBuf::from(&src);
    if dst.exists() {
        if !overwrite { return Err("EXISTE".into()); }
        if let (Ok(a), Ok(b)) = (sp.canonicalize(), dst.canonicalize()) {
            if a == b { return Err("Esa carpeta ya es la skill instalada con ese nombre.".into()); }
        }
        fs::remove_dir_all(&dst).map_err(|e| format!("No se pudo reemplazar la skill anterior: {}", e))?;
    }
    let md_path = dst.join("SKILL.md");
    if sp.is_dir() {
        copy_dir(&sp, &dst).map_err(|e| format!("No se pudo copiar la skill: {}", e))?;
    } else {
        fs::create_dir_all(&dst).map_err(|e| format!("No se pudo crear la carpeta: {}", e))?;
        fs::copy(&sp, &md_path).map_err(|e| format!("No se pudo copiar el archivo: {}", e))?;
    }
    let md = fs::read_to_string(&md_path).map_err(|e| format!("No se pudo leer SKILL.md: {}", e))?;
    fs::write(&md_path, patch_skill_name(&md, &name)).map_err(|e| format!("No se pudo escribir SKILL.md: {}", e))?;
    Ok(dst.to_string_lossy().into_owned())
}

#[derive(Serialize)]
struct SkillItem { name: String, dir: String, description: String }

#[tauri::command]
fn skill_list() -> Vec<SkillItem> {
    let Some(home) = codex_home() else { return vec![] };
    let Ok(rd) = fs::read_dir(home.join("skills")) else { return vec![] };
    let mut v: Vec<SkillItem> = rd.flatten().filter_map(|e| {
        let p = e.path();
        let n = e.file_name().to_string_lossy().into_owned();
        if !p.is_dir() || n.starts_with('.') { return None; }
        let md = fs::read_to_string(p.join("SKILL.md")).ok()?;
        Some(SkillItem { description: fm_field(&md, "description").unwrap_or_default(), name: n, dir: p.to_string_lossy().into_owned() })
    }).collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    v
}

#[tauri::command]
fn skill_remove(name: String) -> Result<(), String> {
    let d = skill_dir(&name)?;
    if !d.join("SKILL.md").exists() { return Err("Esa skill no está instalada.".into()); }
    fs::remove_dir_all(&d).map_err(|e| format!("No se pudo quitar la skill: {}", e))
}

// ---------- Explorador de archivos y vista previa ----------
#[derive(Serialize)]
struct FsEntry { name: String, path: String, is_dir: bool, size: u64 }

#[tauri::command]
fn fs_list(path: String) -> Result<Vec<FsEntry>, String> {
    let rd = fs::read_dir(&path).map_err(|e| format!("No se pudo abrir {}: {}", path, e))?;
    let mut v: Vec<FsEntry> = Vec::new();
    for e in rd.flatten() {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = if is_dir { 0 } else { e.metadata().map(|m| m.len()).unwrap_or(0) };
        v.push(FsEntry { name: e.file_name().to_string_lossy().into_owned(), path: e.path().to_string_lossy().into_owned(), is_dir, size });
        if v.len() >= 3000 { break; }
    }
    v.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(v)
}

#[derive(Serialize)]
struct FilePreview { kind: String, text: String, b64: String, mime: String, size: u64, truncated: bool }

#[tauri::command]
fn fs_read(path: String) -> Result<FilePreview, String> {
    let p = PathBuf::from(&path);
    let size = fs::metadata(&p).map_err(|e| format!("No se pudo leer el archivo: {}", e))?.len();
    let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp",
        "bmp" => "image/bmp", "svg" => "image/svg+xml", "ico" => "image/x-icon", _ => "",
    };
    let blank = |kind: &str, text: String| FilePreview { kind: kind.to_string(), text, b64: String::new(), mime: mime.to_string(), size, truncated: false };
    if !mime.is_empty() {
        if size > 8 * 1024 * 1024 { return Ok(blank("toobig", String::new())); }
        let bytes = fs::read(&p).map_err(|e| format!("No se pudo leer la imagen: {}", e))?;
        let mut r = blank("image", String::new());
        r.b64 = STANDARD.encode(bytes);
        return Ok(r);
    }
    let mut f = fs::File::open(&p).map_err(|e| format!("No se pudo abrir el archivo: {}", e))?;
    let mut buf: Vec<u8> = Vec::new();
    (&mut f).take(524_288).read_to_end(&mut buf).map_err(|e| format!("No se pudo leer el archivo: {}", e))?;
    if buf.contains(&0) { return Ok(blank("binary", String::new())); }
    let mut r = blank("text", String::from_utf8_lossy(&buf).into_owned());
    r.truncated = size > 524_288;
    Ok(r)
}

// Guarda una imagen pegada (base64) en una carpeta temporal y devuelve la ruta, para pegarla como ruta en la terminal.
#[tauri::command]
fn save_temp_image(b64: String, ext: String) -> Result<String, String> {
    let ext = match ext.as_str() { "jpg" | "jpeg" => "jpg", "gif" => "gif", "webp" => "webp", _ => "png" };
    let data = STANDARD.decode(b64.trim()).map_err(|e| format!("Imagen inválida: {}", e))?;
    let dir = std::env::temp_dir().join("ri-terminal").join("pegados");
    fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear la carpeta temporal: {}", e))?;
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let viejo = e.metadata().and_then(|m| m.modified()).ok().and_then(|m| m.elapsed().ok()).map(|d| d.as_secs() > 3 * 86400).unwrap_or(false);
            if viejo { let _ = fs::remove_file(e.path()); }
        }
    }
    let p = dir.join(format!("pegado-{}.{}", ms(SystemTime::now()), ext));
    fs::write(&p, data).map_err(|e| format!("No se pudo guardar la imagen: {}", e))?;
    Ok(p.to_string_lossy().into_owned())
}

// Script que se carga en las pestañas de PowerShell: avisa a RI Terminal la carpeta actual en cada prompt (secuencia OSC 9;9).
const PS_INIT: &str = r##"try {
  if (-not (Get-Variable -Name RiOrigPrompt -Scope Global -ErrorAction SilentlyContinue)) {
    $global:RiOrigPrompt = $function:prompt
    function global:prompt {
      $esc = [char]27
      $loc = $executionContext.SessionState.Path.CurrentLocation
      $pre = ''
      if ($loc.Provider.Name -eq 'FileSystem') { $pre = "$esc]9;9;`"$($loc.ProviderPath)`"$esc\" }
      $pre + (& $global:RiOrigPrompt)
    }
  }
} catch {}
"##;

#[tauri::command]
fn home_dir() -> Result<String, String> {
    std::env::var("USERPROFILE").map_err(|_| "No se encontró la carpeta del usuario.".to_string())
}

#[tauri::command]
fn shell_init() -> Result<String, String> {
    let dir = std::env::temp_dir().join("ri-terminal").join("init");
    fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear la carpeta: {}", e))?;
    let p = dir.join("ri-init.ps1");
    fs::write(&p, PS_INIT).map_err(|e| format!("No se pudo escribir el script: {}", e))?;
    Ok(p.to_string_lossy().into_owned())
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
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_close, codex_info, codex_sessions, ticket_find, skill_inspect, skill_save, skill_list, skill_remove, fs_list, fs_read, save_temp_image, shell_init, home_dir, env_list, env_set, env_delete, cfg_read, cfg_write, mcp_apply])
        .run(tauri::generate_context!())
        .expect("error al iniciar RI Terminal");
}
