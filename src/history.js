import { invoke } from '@tauri-apps/api/core';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const KEY = 'ri-term:hist';
const st = { list: [], q: '', open: localStorage.getItem(KEY) !== '0', err: '', loaded: false, sig: '' };
let api;

const base = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysAgo = (ms) => Math.round((dayStart(new Date()) - dayStart(new Date(ms))) / 86400000);
function group(ms) { const n = daysAgo(ms); return n <= 0 ? 'Hoy' : n === 1 ? 'Ayer' : n < 7 ? 'Esta semana' : 'Anteriores'; }
function stamp(ms) {
  const d = new Date(ms), n = daysAgo(ms);
  if (n <= 1) return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
}

function render(force) {
  const box = $('#histList'); if (!box) return;
  const q = st.q.trim().toLowerCase();
  const items = st.list.filter((s) => !q || s.title.toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q));
  const opens = items.map((s) => (api.isOpen(s) ? s.id : '')).join('');
  const sig = JSON.stringify([items, opens, st.err, st.loaded]);
  if (!force && sig === st.sig) return;
  st.sig = sig;
  const top = box.scrollTop;
  if (!items.length) {
    box.innerHTML = `<p class="hEmpty">${esc(st.err || (!st.loaded ? 'Cargando…' : q ? 'Sin resultados.' : 'Todavía no hay conversaciones guardadas.'))}</p>`;
    return;
  }
  let last = '', html = '';
  for (const s of items) {
    const g = group(s.updated);
    if (g !== last) { html += `<div class="hGrp">${g}</div>`; last = g; }
    const open = api.isOpen(s);
    html += `<button class="hIt${open ? ' open' : ''}" data-id="${esc(s.id)}" title="${esc(s.title)}${s.cwd ? '\n' + esc(s.cwd) : ''}">
      <span class="hTi">${esc(s.title)}</span>
      <span class="hMe">${esc(stamp(s.updated))}${s.cwd ? ' · ' + esc(base(s.cwd)) : ''}${open ? ' · <b>abierta</b>' : ''}</span></button>`;
  }
  box.innerHTML = html;
  box.scrollTop = top;
}

export async function refreshHistory(force) {
  if (!st.open) return;
  try { st.list = await invoke('codex_sessions', { limit: 80 }); st.err = ''; }
  catch (e) { st.err = 'No se pudieron leer las conversaciones: ' + e; }
  st.loaded = true; render(force);
}

function applyOpen() {
  $('#hist').hidden = !st.open;
  $('#histBtn').classList.toggle('on', st.open);
  localStorage.setItem(KEY, st.open ? '1' : '0');
  if (st.open) refreshHistory(true);
}

// cb: { isOpen(sesion) -> bool, onResume(sesion) }
export function initHistory(cb) {
  api = cb;
  $('#histBtn').onclick = () => { st.open = !st.open; applyOpen(); };
  $('#histRef').onclick = () => refreshHistory(true);
  $('#histQ').addEventListener('input', (e) => { st.q = e.target.value; render(true); });
  $('#histList').addEventListener('click', (e) => {
    const b = e.target.closest('.hIt'); if (!b) return;
    const s = st.list.find((x) => x.id === b.dataset.id); if (s) api.onResume(s);
  });
  applyOpen();
  setInterval(() => refreshHistory(false), 5000);
}
