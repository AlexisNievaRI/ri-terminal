import { invoke } from '@tauri-apps/api/core';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import python from 'highlight.js/lib/languages/python';
import powershell from 'highlight.js/lib/languages/powershell';
import rust from 'highlight.js/lib/languages/rust';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import bash from 'highlight.js/lib/languages/bash';
import csharp from 'highlight.js/lib/languages/csharp';
import { showTab } from './history.js';

for (const [n, l] of Object.entries({ javascript, typescript, json, xml, css, sql, python, powershell, rust, markdown, yaml, ini, bash, csharp })) hljs.registerLanguage(n, l);
const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', xaml: 'xml', svg: 'xml', css: 'css', sql: 'sql', prc: 'sql', pks: 'sql', pkb: 'sql', fnc: 'sql', trg: 'sql',
  py: 'python', ps1: 'powershell', psm1: 'powershell', rs: 'rust', md: 'markdown', yml: 'yaml', yaml: 'yaml',
  ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini', sh: 'bash', bash: 'bash', cs: 'csharp',
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const base = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p);
const parent = (p) => {
  const s = String(p).replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (i < 0) return p; const r = s.slice(0, i); return /^[A-Za-z]:$/.test(r) ? r + '\\' : r || p;
};
const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? Math.ceil(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

const st = { root: '', cur: '', open: new Set(), cache: new Map(), sel: '', sig: '', pv: '' };
let api;

function rows(path, depth, out) {
  for (const e of st.cache.get(path) || []) {
    const isOpen = e.is_dir && st.open.has(e.path);
    out.push(`<div class="fxr${e.is_dir ? ' dir' : ''}${isOpen ? ' open' : ''}${st.sel === e.path ? ' sel' : ''}" data-p="${esc(e.path)}" data-d="${e.is_dir ? 1 : 0}" style="padding-left:${8 + depth * 14}px" title="${esc(e.path)}"><span class="fxc">${e.is_dir ? (isOpen ? '&#9662;' : '&#9656;') : ''}</span><span class="fxn">${esc(e.name)}</span></div>`);
    if (isOpen) rows(e.path, depth + 1, out);
  }
}
function render(force) {
  const box = $('#fxTree'); if (!box) return;
  const out = []; rows(st.root, 0, out);
  const sig = out.join('') + '|' + (st.cache.get(st.root) ? '' : 'x');
  if (!force && sig === st.sig) return; st.sig = sig;
  const top = box.scrollTop;
  box.innerHTML = out.length ? out.join('') : `<p class="hEmpty">${st.cache.has(st.root) ? 'Carpeta vacía.' : 'Escribe una ruta arriba para empezar.'}</p>`;
  box.scrollTop = top;
}
async function load(path) {
  try { st.cache.set(path, await invoke('fs_list', { path })); $('#fxMsg').textContent = ''; }
  catch (e) { st.cache.set(path, []); $('#fxMsg').textContent = String(e); }
}
export async function refresh(force) {
  if (!st.root) return;
  for (const p of [st.root, ...st.open]) await load(p);
  render(force);
}
// Cambia la carpeta raíz del explorador. El campo de ruta siempre muestra la carpeta "actual" (la última que tocaste).
export async function setRoot(path) {
  if (!path) return;
  st.cur = path; $('#fxPath').value = path;
  if (path === st.root) { st.sel = ''; render(true); return; }
  st.root = path; st.open.clear(); st.cache.clear(); st.sig = ''; st.sel = '';
  await load(path); render(true);
}

async function preview(path) {
  st.pv = path; st.sel = path; render(true);
  $('#pv').hidden = false; $('#pvName').textContent = base(path); $('#pvPath').textContent = path;
  const body = $('#pvBody'); body.innerHTML = '<p class="hEmpty">Cargando…</p>';
  try {
    const f = await invoke('fs_read', { path });
    if (st.pv !== path) return;
    if (f.kind === 'image') {
      body.innerHTML = `<div class="pvImg"><img src="data:${f.mime};base64,${f.b64}" alt=""><div class="pvNote">${fmtSize(f.size)}</div></div>`;
    } else if (f.kind === 'text') {
      const text = f.text.replace(/\r/g, '');
      const n = text.replace(/\n$/, '').split('\n').length;
      const gut = Array.from({ length: n }, (_, i) => i + 1).join('\n');
      const ext = (path.split('.').pop() || '').toLowerCase(); const lang = LANG[ext];
      let html = esc(text);
      if (lang && text.length <= 200000) { try { html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch {} }
      body.innerHTML = `<div class="pvCode"><pre class="pvGut">${gut}</pre><pre class="pvTxt"><code>${html}</code></pre></div>${f.truncated ? '<div class="pvNote">Se muestra solo el comienzo del archivo.</div>' : ''}`;
    } else {
      body.innerHTML = `<p class="hEmpty">${f.kind === 'toobig' ? 'La imagen es demasiado grande para previsualizarla' : 'Archivo binario: no se puede previsualizar'} (${fmtSize(f.size)}).</p>`;
    }
  } catch (e) { body.innerHTML = `<p class="hEmpty">${esc(String(e))}</p>`; }
}

// Abre una ruta: si es carpeta la muestra en el explorador; si es archivo, lo previsualiza.
export async function openPath(p) {
  p = String(p).trim().replace(/^"|"$/g, '');
  try { await invoke('fs_list', { path: p }); showTab('files', true); await setRoot(p); return; } catch {}
  showTab('files', true); await setRoot(parent(p)); preview(p);
}

export function initFiles(cb) {
  api = cb;
  $('#fxTree').addEventListener('click', async (e) => {
    const r = e.target.closest('.fxr'); if (!r) return;
    const p = r.dataset.p;
    if (r.dataset.d === '1') {
      st.cur = p; st.sel = p; $('#fxPath').value = p;
      if (st.open.has(p)) st.open.delete(p); else { st.open.add(p); if (!st.cache.has(p)) await load(p); }
      render(true);
    } else { st.cur = parent(p); $('#fxPath').value = st.cur; preview(p); }
  });
  $('#fxTree').addEventListener('dblclick', (e) => { const r = e.target.closest('.fxr.dir'); if (r) setRoot(r.dataset.p); });
  $('#fxUp').onclick = () => setRoot(parent(st.root));
  $('#fxRef').onclick = () => refresh(true);
  $('#fxPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') setRoot(e.target.value.trim().replace(/^"|"$/g, '')); });
  // Mueve la terminal a la carpeta que muestra el campo (la pegada o la última que tocaste en el árbol).
  $('#fxCd').onclick = async () => {
    const p = $('#fxPath').value.trim().replace(/^"|"$/g, ''); if (!p) return;
    const err = api.cd(p);
    if (err) { $('#fxMsg').textContent = err; return; }
    await setRoot(p);
  };
  // Pega la ruta seleccionada (o la del campo) en la terminal activa: sirve también dentro de OpenCode / Codex.
  $('#fxPaste').onclick = () => {
    const p = st.sel || $('#fxPath').value.trim().replace(/^"|"$/g, ''); if (!p) return;
    $('#fxMsg').textContent = api.paste(p);
  };
  $('#fxPath').addEventListener('input', () => { st.sel = ''; });
  $('#pvClose').onclick = () => { $('#pv').hidden = true; st.pv = ''; st.sel = ''; render(true); };
  $('#pvCopy').onclick = () => navigator.clipboard.writeText(st.pv || '');
  setInterval(() => { if (!$('#hist').hidden && !$('#fxPane').hidden) refresh(false); }, 5000);
  setTimeout(async () => { if (!st.root) setRoot(await invoke('home_dir').catch(() => 'C:\\')); }, 1500);
}
