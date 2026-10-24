import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const st = { src: null, info: null, name: '', armed: false, rm: null };
let timer, rmTimer;

function paint(box) {
  box.innerHTML = `
    <h3 class="skh">Skills de Codex</h3>
    <p class="hint">Carga una skill (una carpeta con un <code>SKILL.md</code>, o el archivo <code>.md</code> suelto), ponle el nombre con el que la vas a invocar y guárdala. Se instala en <code>.codex\\skills</code>.</p>
    <div class="bar2">
      <button class="pri" data-sk="load">Cargar skill</button>
    </div>
    <div id="skmenu" class="skmenu" hidden>
      <button data-sk="dir">Carpeta de la skill…</button>
      <button data-sk="file">Archivo .md suelto…</button>
    </div>
    <div id="skload" hidden></div>
    <div id="skmsg" class="ust"></div>
    <h4 class="skh2">Instaladas</h4>
    <div id="sklist" class="sklist"></div>`;
}

function say(t, kind = '') { const m = $('#skmsg'); if (m) { m.textContent = t; m.className = 'ust ' + kind; } }
const clean = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const fmtSize = (n) => (n < 1024 ? n + ' B' : Math.ceil(n / 1024) + ' KB');

function paintLoaded() {
  const box = $('#skload'); if (!box) return;
  const i = st.info;
  if (!i) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `
    <div class="skcard">
      <div class="skcn"><b>${esc(i.name)}</b><span class="skst">${i.kind === 'dir' ? 'carpeta' : 'archivo'} · ${fmtSize(i.size)}</span></div>
      <div class="skdesc">${esc(i.description || 'Sin descripción en el encabezado.')}</div>
      <div class="skfiles">${i.files.map((f) => `<div>${esc(f)}</div>`).join('')}</div>
    </div>
    <label class="krow">Nombre de la skill (se invoca como $nombre)
      <div class="skname"><span>$</span><input id="sknm" type="text" value="${esc(st.name)}" spellcheck="false" maxlength="64"></div>
    </label>
    <div class="bar2">
      <button class="pri" id="sksave" data-sk="save">Guardar</button>
      <button data-sk="cancel">Cancelar</button>
    </div>`;
}

async function pick(kind) {
  $('#skmenu').hidden = true;
  try {
    const sel = kind === 'dir'
      ? await open({ directory: true, multiple: false, title: 'Elige la carpeta de la skill' })
      : await open({ directory: false, multiple: false, title: 'Elige el archivo .md de la skill', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!sel || typeof sel !== 'string') return;
    const info = await invoke('skill_inspect', { path: sel });
    st.src = sel; st.info = info; st.name = clean(info.name) || 'mi-skill'; st.armed = false;
    paintLoaded(); say('');
  } catch (x) { say(String(x), 'err'); }
}

async function save() {
  const name = clean(st.name);
  if (!st.src || !name) return say('Escribe un nombre para la skill.', 'err');
  const btn = $('#sksave');
  try {
    const dir = await invoke('skill_save', { src: st.src, name, overwrite: st.armed });
    st.armed = false; st.info = null; st.src = null; paintLoaded();
    say(`Skill guardada en ${dir}. Reinicia las pestañas de Codex abiertas para que la cargue; luego escribe $${name} en el mensaje.`, 'ok');
    await refreshList();
  } catch (x) {
    if (String(x) === 'EXISTE') {
      st.armed = true; if (btn) btn.textContent = `¿Reemplazar la skill $${name}?`;
      clearTimeout(timer); timer = setTimeout(() => { st.armed = false; const b = $('#sksave'); if (b) b.textContent = 'Guardar'; }, 4000);
      return say('Ya existe una skill con ese nombre. Pulsa de nuevo para reemplazarla.');
    }
    say(String(x), 'err');
  }
}

async function refreshList() {
  const box = $('#sklist'); if (!box) return;
  try {
    const l = await invoke('skill_list');
    box.innerHTML = l.length ? l.map((s) => `
      <div class="skrow">
        <div class="skrt"><b>$${esc(s.name)}</b><span title="${esc(s.description)}">${esc(s.description)}</span></div>
        <button data-rm="${esc(s.name)}">${st.rm === s.name ? '¿Quitar?' : 'Quitar'}</button>
      </div>`).join('') : '<p class="hint">Todavía no hay skills instaladas.</p>';
  } catch (x) { box.innerHTML = `<p class="hint">${esc(String(x))}</p>`; }
}

async function remove(name) {
  if (st.rm !== name) {
    st.rm = name; clearTimeout(rmTimer); rmTimer = setTimeout(() => { st.rm = null; refreshList(); }, 3500);
    return refreshList();
  }
  st.rm = null;
  try { await invoke('skill_remove', { name }); say(`Skill $${name} quitada.`, 'ok'); } catch (x) { say(String(x), 'err'); }
  await refreshList();
}

async function onClick(e) {
  const r = e.target.closest('[data-rm]'); if (r) return remove(r.dataset.rm);
  const b = e.target.closest('[data-sk]'); if (!b) return;
  switch (b.dataset.sk) {
    case 'load': { const m = $('#skmenu'); m.hidden = !m.hidden; break; }
    case 'dir': await pick('dir'); break;
    case 'file': await pick('file'); break;
    case 'save': await save(); break;
    case 'cancel': st.info = null; st.src = null; st.armed = false; paintLoaded(); say(''); break;
  }
}

export function mountSkill(container) {
  const box = document.createElement('div'); box.id = 'skBox'; box.className = 'kform skform';
  container.append(box); st.src = null; st.info = null; st.armed = false; st.rm = null; paint(box);
  box.addEventListener('click', onClick);
  box.addEventListener('input', (e) => { if (e.target.id === 'sknm') { const v = clean(e.target.value); if (v !== e.target.value) e.target.value = v; st.name = v; st.armed = false; const b = $('#sksave'); if (b) b.textContent = 'Guardar'; } });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'sknm') save(); });
  refreshList();
}
