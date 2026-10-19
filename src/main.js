import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { initSettings, codexLaunch, codexStartsByDefault } from './settings.js';

const PROFILES = [
  { key: 'codex', name: 'Codex', agent: true, shell: 'powershell.exe' },
  { name: 'PowerShell', shell: 'powershell.exe', args: ['-NoLogo'] },
  { name: 'PowerShell 7', shell: 'pwsh.exe', args: ['-NoLogo'] },
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
async function newTab(p = defaultProfile()) {
  const id = nextId++;
  const pane = document.createElement('div'); pane.className = 'pane'; $('#stage').append(pane);
  const tabEl = document.createElement('div'); tabEl.className = 'tab';
  tabEl.innerHTML = `<b>${p.name}</b><span class="x">&#10005;</span>`;
  $('#tabs').append(tabEl);
  const term = new Terminal({
    fontFamily: '"Cascadia Code","MesloLGM Nerd Font",Consolas,monospace', fontSize: 14,
    cursorBlink: true, allowProposedApi: true, scrollback: 10000, theme: THEME,
  });
  const fit = new FitAddon(); term.loadAddon(fit); term.loadAddon(new WebLinksAddon());
  term.open(pane);
  tabs.set(id, { term, fit, pane, tabEl, p, dec: new TextDecoder(), lastOut: 0, lastKey: 0, lastEnter: 0, workStart: 0, doneUntil: 0, errUntil: 0, pin: false });
  tabEl.onclick = () => activate(id);
  tabEl.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeTab(id); };
  term.onData((data) => {
    const t = tabs.get(id); const n = Date.now();
    if (t) { t.lastKey = n; t.pin = false; if (data.includes('\r')) t.lastEnter = n; }
    invoke('pty_write', { id, data });
  });
  term.onResize(({ cols, rows }) => invoke('pty_resize', { id, cols, rows }));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
    if (e.key === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
    if (e.key === 'v') { navigator.clipboard.readText().then((t) => term.paste(t)); return false; }
    return true;
  });
  activate(id);
  await new Promise((r) => requestAnimationFrame(r));
  fit.fit();
  try {
    tabs.get(id).since = Date.now() - 1500;
    const run = p.key ? codexLaunch(p.key) : { args: p.args, cwd: null };
    await invoke('pty_spawn', { id, cols: term.cols, rows: term.rows, shell: p.shell, args: run.args, cwd: run.cwd });
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
  requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
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
