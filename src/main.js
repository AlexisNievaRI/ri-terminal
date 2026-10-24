import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { initSettings, codexLaunch, codexStartsByDefault, agentDir } from './settings.js';
import { initHistory } from './history.js';
import { initFiles, setRoot, openPath } from './files.js';

const PROFILES = [
  { key: 'codex', name: 'Codex', agent: true, shell: 'powershell.exe' },
  { name: 'PowerShell', shell: 'powershell.exe', args: ['-NoLogo', '-ExecutionPolicy', 'RemoteSigned'], init: true },
  { name: 'PowerShell 7', shell: 'pwsh.exe', args: ['-NoLogo', '-ExecutionPolicy', 'RemoteSigned'], init: true },
  { name: 'OpenCode', shell: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'RemoteSigned', '-Command', 'opencode'], tui: true },
  { name: 'CMD', shell: 'cmd.exe', args: [] },
];
const THEME = {
  background: '#14121f', foreground: '#e8e4f0', cursor: '#9d8cff', selectionBackground: '#3a3560',
  black: '#1d1a2e', red: '#ff7a93', green: '#8ee0a0', yellow: '#f2d38a', blue: '#7aa2ff',
  magenta: '#c8a2ff', cyan: '#6fdcd0', white: '#e8e4f0', brightBlack: '#5b5578',
  brightRed: '#ff9bb0', brightGreen: '#a9f0b8', brightYellow: '#ffe3a3', brightBlue: '#9bb8ff',
  brightMagenta: '#dcbcff', brightCyan: '#92ece2', brightWhite: '#ffffff',
};
const $ = (s) => document.querySelector(s);
const tabs = new Map();
let nextId = 1, active = null;

const defaultProfile = () => (codexStartsByDefault() ? PROFILES[0] : PROFILES[1]);
async function newTab(p = defaultProfile(), opts = {}) {
  const id = nextId++;
  const pane = document.createElement('div'); pane.className = 'pane'; $('#stage').append(pane);
  const tabEl = document.createElement('div'); tabEl.className = 'tab';
  tabEl.innerHTML = '<b></b><span class="x">&#10005;</span>';
  tabEl.querySelector('b').textContent = opts.title || p.name;
  if (opts.title) tabEl.title = opts.title;
  $('#tabs').append(tabEl);
  const term = new Terminal({
    fontFamily: '"Cascadia Code","MesloLGM Nerd Font",Consolas,monospace', fontSize: 14,
    cursorBlink: true, allowProposedApi: true, scrollback: 10000, theme: THEME,
  });
  const fit = new FitAddon(); term.loadAddon(fit); term.loadAddon(new WebLinksAddon());
  term.open(pane);
  tabs.set(id, { term, fit, pane, tabEl, p, dec: new TextDecoder(), lastOut: 0, lastKey: 0, lastEnter: 0, workStart: 0, doneUntil: 0, errUntil: 0, pin: false, sid: opts.resumeId || null, cx: opts.file ? { file: opts.file } : undefined });
  tabEl.onclick = () => activate(id);
  tabEl.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeTab(id); };
  term.onData((data) => {
    const t = tabs.get(id); const n = Date.now();
    if (t) { t.lastKey = n; t.pin = false; if (data.includes('\r')) t.lastEnter = n; }
    invoke('pty_write', { id, data });
  });
  term.onResize(({ cols, rows }) => invoke('pty_resize', { id, cols, rows }));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true;
    if (e.key === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
    if (e.key === 'v' || e.key === 'V') { pasteClip(id, term, e.shiftKey); return false; }
    return true;
  });
  // La terminal avisa su carpeta actual (OSC 9;9) para que el explorador la siga.
  term.parser.registerOscHandler(9, (d) => {
    if (!d.startsWith('9;')) return false;
    const t = tabs.get(id); if (!t) return true;
    t.cwd = d.slice(2).replace(/^"|"$/g, ''); if (id === active) { setRoot(t.cwd); updateHere(); }
    return true;
  });
  // Ctrl+clic en una ruta de Windows impresa en la terminal la abre en el explorador / vista previa.
  term.registerLinkProvider({
    provideLinks(y, cb) {
      const line = term.buffer.active.getLine(y - 1); if (!line) return cb(undefined);
      const text = line.translateToString(true), re = /[A-Za-z]:\\[^\s"'<>|*?]+/g, links = []; let m;
      while ((m = re.exec(text))) {
        const raw = m[0].replace(/[.,;:)\]]+$/, '').replace(/:\d+(:\d+)?$/, '');
        links.push({ range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } }, text: m[0], activate: (ev) => { if (ev.ctrlKey) openPath(raw); } });
      }
      cb(links.length ? links : undefined);
    },
  });
  activate(id);
  await new Promise((r) => requestAnimationFrame(r));
  fit.fit();
  try {
    tabs.get(id).since = Date.now() - 1500;
    const run = p.key ? codexLaunch(p.key, opts.resumeId) : { args: p.args, cwd: null };
    if (p.init) { try { const f = await invoke('shell_init'); run.args = [...p.args, '-NoExit', '-Command', `. '${f.replace(/'/g, "''")}'`]; } catch {} }
    const home = await invoke('home_dir').catch(() => null);
    const cwd0 = opts.cwd || run.cwd || (p.tui ? agentDir() : null) || home;
    tabs.get(id).cwd = cwd0; if (id === active) { updateHere(); if (cwd0) setRoot(cwd0); }
    await invoke('pty_spawn', { id, cols: term.cols, rows: term.rows, shell: p.shell, args: run.args, cwd: cwd0 });
  } catch (err) {
    term.write(`\r\n\x1b[31mNo se pudo iniciar ${p.shell}:\x1b[0m ${err}\r\n`);
  }
}
function activate(id) {
  active = id;
  for (const [k, t] of tabs) {
    t.pane.classList.toggle('on', k === id); t.tabEl.classList.toggle('on', k === id);
  }
  renderCx();
  const t = tabs.get(id);
  updateHere();
  if (t.cwd) setRoot(t.cwd);
  requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
}
const shortPath = (p) => { if (p.length <= 34) return p; const s = p.split(/[\\/]+/).filter(Boolean); return s.length > 3 ? `${s[0]}\\…\\${s.slice(-2).join('\\')}` : p; };
// Pie del panel derecho: dónde está parada la pestaña activa (Codex, OpenCode, PowerShell…).
function updateHere() {
  const t = tabs.get(active); if (!t) return;
  const agent = t.p.agent || t.p.tui;
  $('#hereWho').textContent = agent ? `${t.p.name} · carpeta de trabajo` : `${t.p.name} · carpeta actual`;
  $('#herePath').textContent = t.cwd ? shortPath(t.cwd) : '';
  $('#here').title = t.cwd || '';
  $('#fxCd').textContent = agent ? `Abrir ${t.p.name} en esta carpeta` : 'Mover la terminal aquí';
}
const blobB64 = (b) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(b); });
// Ctrl+V: texto normal; si el portapapeles solo tiene una imagen, le pasa Ctrl+V al programa (OpenCode, Codex...) para que la lea él.
// Ctrl+Shift+V con imagen: la guarda como PNG temporal y pega su ruta.
async function pasteClip(id, term, asPath) {
  let img = null, hasText = false;
  try {
    for (const it of await navigator.clipboard.read()) {
      if (it.types.includes('text/plain')) hasText = true;
      const ty = it.types.find((x) => x.startsWith('image/')); if (ty && !img) img = await it.getType(ty);
    }
  } catch {}
  if (img && !hasText) {
    if (!asPath) { invoke('pty_write', { id, data: '\x16' }); return; }
    try {
      const path = await invoke('save_temp_image', { b64: await blobB64(img), ext: (img.type.split('/')[1] || 'png') });
      term.paste(path.includes(' ') ? `"${path}"` : path);
    } catch (err) { term.write(`\r\n\x1b[31mNo se pudo pegar la imagen:\x1b[0m ${err}\r\n`); }
    return;
  }
  try { term.paste(await navigator.clipboard.readText()); } catch {}
}
function closeTab(id) {
  const t = tabs.get(id); if (!t) return;
  invoke('pty_close', { id }); t.term.dispose(); t.pane.remove(); t.tabEl.remove(); tabs.delete(id);
  if (!tabs.size) return getCurrentWindow().close();
  if (active === id) activate([...tabs.keys()].pop());
}
const ERR = /\b(error|exception|failed|fatal|panic)\b|is not recognized|No se pudo/i;
const ASK = /\(y\/n\)|\[y\/n\]|allow|approve|do you want to|¿permitir/i;
listen('pty-output', ({ payload }) => {
  const t = tabs.get(payload.id); if (!t) return;
  const bytes = new Uint8Array(payload.data); t.term.write(bytes);
  const txt = t.dec.decode(bytes, { stream: true }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), n = Date.now();
  if (n - t.lastOut > 1500) t.workStart = n;
  t.lastOut = n;
  if (n - t.lastKey > 300) {
    if (ERR.test(txt)) t.errUntil = n + 3000;
    if (t.p.agent && ASK.test(txt)) t.pin = true;
  }
});
listen('pty-exit', ({ payload }) => closeTab(payload));
new ResizeObserver(() => tabs.get(active)?.fit.fit()).observe($('#stage'));

const menu = $('#menu');
PROFILES.forEach((p) => {
  const d = document.createElement('div'); d.textContent = p.name;
  d.onclick = () => { menu.hidden = true; newTab(p); }; menu.append(d);
});
$('#add').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
document.addEventListener('click', () => (menu.hidden = true));
window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !$('#modal').hidden || !$('#set')?.hidden) return;
  if (e.key === 't') { e.preventDefault(); newTab(); }
  if (e.key === 'w') { e.preventDefault(); closeTab(active); }
  if (e.key === 'Tab') {
    e.preventDefault(); const ids = [...tabs.keys()]; const i = ids.indexOf(active);
    activate(ids[(i + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
  }
});
const w = getCurrentWindow();
$('#min').onclick = () => w.minimize();
$('#max').onclick = () => { w.toggleMaximize(); setTimeout(() => tabs.get(active)?.fit.fit(), 250); };
$('#close').onclick = () => w.close();

const SAY = { idle: 'Listo', typing: 'Te escucho', working: 'Trabajando…', thinking: 'Pensando…', done: '¡Terminado!', error: 'Algo falló', approval: 'Necesita tu permiso', sleeping: 'Zzz' };
function stateOf(t, n) {
  const quiet = n - t.lastOut > 700;
  if (t.pin) return 'approval';
  if (n < t.errUntil) return 'error';
  if (!quiet) return 'working';
  if (t.workStart > t.doneSeen && t.lastOut - t.workStart > 2500) { t.doneSeen = t.workStart; t.doneUntil = n + 2500; }
  if (n < t.doneUntil) return 'done';
  if (n - t.lastKey < 800) return 'typing';
  if (t.p.agent && t.lastEnter > t.lastOut - 1500 && n - t.lastEnter < 120000) return 'thinking';
  if (n - Math.max(t.lastOut, t.lastKey, t.born) > 60000) return 'sleeping';
  return 'idle';
}
setInterval(() => {
  const n = Date.now();
  for (const [id, t] of tabs) {
    t.born ??= n; t.doneSeen ??= 0;
    const s = stateOf(t, n); t.s = s;
    t.tabEl.classList.toggle('busy', s === 'working' || s === 'thinking');
    t.tabEl.classList.toggle('alert', s === 'approval');
  }
  const a = tabs.get(active); if (!a) return;
  const s = a.s || 'idle';
  if ($('#bit').dataset.s !== s) { $('#bit').dataset.s = s; $('#buddy').dataset.s = s; $('#bubble').textContent = SAY[s]; }
}, 300);
const KEY = 'bit-term:profile';
const loadProfile = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
function renderProfile(p) {
  $('#meName').textContent = `${p.name} ${p.last}`; $('#meMail').textContent = p.mail;
  const a = $('#avatarIn');
  a.style.backgroundImage = p.photo ? `url(${p.photo})` : '';
  a.textContent = p.photo ? '' : (p.name[0] + p.last[0]).toUpperCase();
}
function toAvatar(file) {
  return new Promise((ok, no) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
      const k = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - k) / 2, (img.height - k) / 2, k, k, 0, 0, s, s);
      URL.revokeObjectURL(url); ok(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = no; img.src = url;
  });
}
function askProfile(cur) {
  return new Promise((done) => {
    let photo = cur?.photo || '';
    const prev = () => { const e = $('#pPrev'); e.style.backgroundImage = photo ? `url(${photo})` : ''; e.textContent = photo ? '' : '+'; };
    $('#pName').value = cur?.name || ''; $('#pLast').value = cur?.last || ''; $('#pMail').value = cur?.mail || '';
    $('#pErr').hidden = true; $('#pCancel').hidden = !cur; prev();
    $('#modal').hidden = false; setTimeout(() => $('#pName').focus(), 50);
    $('#pFile').onchange = async (e) => { const f = e.target.files[0]; if (f) { try { photo = await toAvatar(f); prev(); } catch {} } };
    $('#pCancel').onclick = () => { $('#modal').hidden = true; done(cur); };
    $('#pform').onsubmit = (e) => {
      e.preventDefault();
      const p = { name: $('#pName').value.trim(), last: $('#pLast').value.trim(), mail: $('#pMail').value.trim(), photo };
      const err = !p.name || !p.last ? 'Escribe tu nombre y apellido.' : !/^\S+@\S+\.\S+$/.test(p.mail) ? 'Escribe un correo válido.' : '';
      if (err) { $('#pErr').textContent = err; $('#pErr').hidden = false; return; }
      try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {}
      $('#modal').hidden = true; done(p);
    };
  });
}
(async () => {
  const p = loadProfile() || (await askProfile(null));
  renderProfile(p);
  $('#me').onclick = async () => renderProfile(await askProfile(loadProfile()));
  newTab();
})();

function fmtReset(ts) {
  const s = ts ? ts - Date.now() / 1000 : 0; if (s <= 0) return '';
  const h = Math.floor(s / 3600), min = Math.floor((s % 3600) / 60);
  return h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : h ? `${h} h ${min} min` : `${min} min`;
}
function renderCx() {
  const t = tabs.get(active), bar = $('#cx');
  if (!t || !t.p.agent) { bar.hidden = true; return; }
  bar.hidden = false;
  const c = t.cx || {}, p = c.five_h;
  $('#cxModel').textContent = c.model ? c.model + (c.effort ? ' · ' + c.effort : '') : 'Codex';
  $('#cxPct').textContent = p == null ? '\u2014' : Math.round(p) + '%';
  $('#cxArc').style.strokeDashoffset = 94.25 * (1 - Math.min(p ?? 0, 100) / 100);
  $('#cxArc').style.stroke = p >= 90 ? '#ff7a93' : p >= 70 ? '#f2d38a' : '#8ee0a0';
  bar.classList.toggle('hot', p >= 90);
  const r = fmtReset(c.five_reset);
  $('#cxSub').textContent = p == null ? 'Sin datos hasta tu primer mensaje' : p >= 100 ? 'Límite alcanzado' + (r ? ' · reinicia en ' + r : '') : '5 h' + (r ? ' · reinicia en ' + r : '');
  $('#cxWeek').textContent = c.week == null ? '' : 'semana ' + Math.round(c.week) + '%';
}
async function pollCodex() {
  const claimed = () => [...tabs.values()].map((t) => t.cx?.file).filter(Boolean);
  for (const t of tabs.values()) {
    if (!t.p.agent || !t.since) continue;
    try {
      const mine = t.cx?.file ?? null;
      const info = await invoke('codex_info', { sinceMs: t.since, file: mine, claimed: claimed().filter((f) => f !== mine) });
      if (info.file) t.cx = info;
    } catch {}
  }
  renderCx();
}
setInterval(pollCodex, 3000);

initSettings($('#gear'));

/* Explorador de archivos y vista previa (panel derecho, pestaña Archivos) */
$('#here').onclick = () => { const t = tabs.get(active); if (t?.cwd) openPath(t.cwd); };
initFiles({
  // Devuelve '' si pudo, o el motivo si no. En un shell mueve la carpeta; un agente (Codex, OpenCode) no puede cambiar de carpeta
  // con la sesión abierta, así que se abre otra pestaña del mismo agente en la carpeta elegida.
  cd: (path) => {
    const t = tabs.get(active); if (!t) return 'No hay una pestaña activa.';
    const norm = (x) => String(x || '').toLowerCase().replace(/[\\/]+$/, '');
    if (t.p.agent || t.p.tui) {
      if (norm(t.cwd) === norm(path)) return `${t.p.name} ya está en esa carpeta.`;
      const folder = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
      newTab(t.p, { cwd: path, title: `${t.p.name} · ${folder}` });
      return '';
    }
    if (t.term.buffer.active.type === 'alternate') return 'Hay un programa a pantalla completa en esta pestaña. Sal de él y vuelve a intentarlo.';
    const cmd = /cmd/i.test(t.p.shell) ? `cd /d "${path}"\r` : `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'\r`;
    invoke('pty_write', { id: active, data: cmd }); t.cwd = path; updateHere(); t.term.focus(); return '';
  },
  paste: (path) => {
    const t = tabs.get(active); if (!t) return 'No hay una pestaña activa.';
    t.term.paste(path.includes(' ') ? `"${path}"` : path); t.term.focus(); return '';
  },
});

/* Conversaciones anteriores de Codex (panel derecho) */
const sameSession = (t, s) => t.sid === s.id || (t.cx?.file && t.cx.file === s.file);
initHistory({
  isOpen: (s) => [...tabs.values()].some((t) => sameSession(t, s)),
  onResume: (s) => {
    const hit = [...tabs.entries()].find(([, t]) => sameSession(t, s));
    if (hit) return activate(hit[0]);
    newTab(PROFILES[0], { resumeId: s.id, cwd: s.cwd, title: s.title, file: s.file });
  },
});
