import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_KEY = 'ri-term:cfgpath';
const DEF_PATH = 'C:\\OracleMcp\\Release\\appsettings.json';
const st = { vars: [], cfg: null, tab: 'vars', mode: 'profiles', all: false, q: '', ev: null, pe: null, shown: new Set(), armed: null, dirty: false, path: null, ver: '', u: { busy: false, up: null, text: '', kind: '' } };
let gearBtn;
let root;

const getPath = () => st.path || localStorage.getItem(PATH_KEY) || DEF_PATH;
const profiles = () => st.cfg?.OracleMcp?.Profiles ?? {};
const hasVar = (n) => st.vars.some((v) => v.n.toLowerCase() === String(n).toLowerCase());
function msg(t, kind = '') { const m = $('#setMsg'); m.textContent = t; m.className = kind; }
function markDirty() { st.dirty = true; const h = $('#pCfg .foot .hint'); if (h) h.textContent = 'Hay cambios sin guardar.'; }
async function refreshVars() {
  try { st.vars = await invoke('env_list'); } catch (e) { msg('No se pudieron leer las variables: ' + e, 'err'); }
}
function arm(key, run, redraw) {
  if (st.armed !== key) {
    st.armed = key; redraw();
    setTimeout(() => { if (st.armed === key) { st.armed = null; redraw(); } }, 3000);
    return;
  }
  st.armed = null; run().catch((x) => msg(String(x), 'err'));
}

export function initSettings(btn) {
  root = document.createElement('div'); root.id = 'set'; root.hidden = true;
  root.innerHTML = `<div id="setBox">
    <div id="setHead"><b>Ajustes</b><button id="setX" title="Cerrar">&#10005;</button></div>
    <div id="setTabs"><button data-t="vars" class="on">Variables de entorno</button><button data-t="cfg">Conexiones Oracle (JSON)</button><button data-t="codex">Codex</button><button data-t="upd">Actualizaciones</button></div>
    <section id="pVars"></section><section id="pCfg" hidden></section><section id="pCodex" hidden></section><section id="pUpd" hidden></section>
    <div id="setMsg"></div></div>`;
  document.body.append(root);
  btn.onclick = openSet; gearBtn = btn;
  getVersion().then((v) => { st.ver = v; }).catch(() => {});
  if (autoCheck()) setTimeout(() => doCheck(true), 6000);
  root.addEventListener('mousedown', (e) => { if (e.target === root) closeSet(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) closeSet(); });
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
}
async function openSet() {
  document.activeElement?.blur(); root.hidden = false; msg('Cargando…');
  await refreshVars(); showTab(st.tab); msg('');
}
function closeSet() { root.hidden = true; st.ev = null; st.pe = null; }
function showTab(t) {
  st.tab = t; msg('');
  root.querySelectorAll('#setTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  $('#pVars').hidden = t !== 'vars'; $('#pCfg').hidden = t !== 'cfg'; $('#pCodex').hidden = t !== 'codex'; $('#pUpd').hidden = t !== 'upd';
  if (t === 'vars') renderVars(); else if (t === 'codex') renderCodex(); else if (t === 'upd') renderUpd(); else if (st.cfg) renderCfg(); else loadCfg();
}

/* ---------- Variables de entorno ---------- */
function renderVars() {
  const e = st.ev;
  $('#pVars').innerHTML = `
    <div class="bar2"><input id="vq" type="text" placeholder="Buscar variable…" value="${esc(st.q)}">
      <label class="chk"><input type="checkbox" id="vall" ${st.all ? 'checked' : ''}> Mostrar todas</label>
      <button class="pri" data-a="vnew">+ Nueva variable</button></div>
    ${e ? `<div class="form"><input id="vn" type="text" placeholder="NOMBRE (ej. ORACLE_BUSTOS_PASSWORD)" value="${esc(e.n)}" ${e.isNew ? '' : 'readonly'}>
      <input id="vv" type="password" placeholder="Valor" value="${esc(e.v)}">
      <button class="pri" data-a="vsave">Guardar</button><button data-a="vcancel">Cancelar</button></div>` : ''}
    <div id="vlist" class="tbl"></div>
    <p class="hint">Se guardan a nivel de usuario (igual que setx). Las pestañas nuevas de RI Terminal ya las ven; las ventanas de PowerShell abiertas fuera de la app, no. Por defecto solo se listan las que empiezan con ORACLE_.</p>`;
  renderVarsList();
  if (e) $(e.isNew ? '#vn' : '#vv').focus();
}
function renderVarsList() {
  const q = st.q.toLowerCase();
  const l = st.vars.filter((v) => (st.all || /^ORACLE_/i.test(v.n)) && v.n.toLowerCase().includes(q));
  $('#vlist').innerHTML = l.map((v) => `<div class="r"><code>${esc(v.n)}</code>
    <span class="val">${st.shown.has(v.n) ? esc(v.v) : '••••••••'}</span>
    <button data-a="veye" data-n="${esc(v.n)}">${st.shown.has(v.n) ? 'Ocultar' : 'Ver'}</button>
    <button data-a="vedit" data-n="${esc(v.n)}">Editar</button>
    <button class="dng" data-a="vdel" data-n="${esc(v.n)}">${st.armed === v.n ? '¿Seguro?' : 'Eliminar'}</button></div>`).join('')
    || '<p class="empty">No hay variables para mostrar.</p>';
}

/* ---------- Conexiones (appsettings.json) ---------- */
function fixCfg() {
  const c = st.cfg;
  if (!c || typeof c !== 'object') throw new Error('estructura inesperada');
  c.OracleMcp ??= {}; c.OracleMcp.Profiles ??= {};
}
async function loadCfg() {
  const path = getPath();
  try {
    const txt = await invoke('cfg_read', { path });
    st.cfg = JSON.parse(txt); fixCfg(); st.dirty = false; st.pe = null;
    localStorage.setItem(PATH_KEY, path); msg('Archivo cargado.', 'ok');
  } catch (x) { st.cfg = null; msg(String(x?.message ?? x), 'err'); }
  renderCfg();
}
const profRow = (n, p) => `<div class="r pr"><label class="chk"><input type="checkbox" data-a="ptog" data-n="${esc(n)}" ${p.Enabled ? 'checked' : ''}></label>
  <b>${esc(n)}</b><span class="dim">${esc(p.Host)}:${esc(p.Port)} / ${esc(p.Sid)}</span><span class="dim">${esc(p.User)} · ${esc(p.Schema)}</span>
  <span class="badge ${hasVar(p.PasswordEnvVar) ? 'okb' : 'errb'}" title="${esc(p.PasswordEnvVar)}">${hasVar(p.PasswordEnvVar) ? 'clave ✓' : 'falta clave'}</span>
  <button data-a="pedit" data-n="${esc(n)}">Editar</button>
  <button class="dng" data-a="pdel" data-n="${esc(n)}">${st.armed === 'p:' + n ? '¿Seguro?' : 'Eliminar'}</button></div>`;
const profForm = (p) => `<div class="form pf">
  <input id="pn" type="text" placeholder="Nombre (ej. BUSTOS)" value="${esc(p.n)}" ${p.isNew ? '' : 'readonly'}>
  <input id="ph" type="text" placeholder="Host / IP" value="${esc(p.Host)}">
  <input id="pp" type="number" placeholder="Puerto" value="${esc(p.Port)}">
  <input id="ps" type="text" placeholder="SID" value="${esc(p.Sid)}">
  <input id="pu" type="text" placeholder="Usuario Oracle" value="${esc(p.User)}">
  <input id="pc" type="text" placeholder="Schema" value="${esc(p.Schema)}">
  <input id="pv" type="text" placeholder="Variable de contraseña" value="${esc(p.PasswordEnvVar)}">
  <input id="pw" type="password" placeholder="${!p.isNew && hasVar(p.PasswordEnvVar) ? 'Contraseña (vacío = no cambiar)' : 'Contraseña'}">
  <label class="chk"><input type="checkbox" id="pen" ${p.Enabled ? 'checked' : ''}> Habilitada</label>
  <button class="pri" data-a="psave">Aceptar</button><button data-a="pcancel">Cancelar</button></div>`;
function renderCfg() {
  const p = profiles(), names = Object.keys(p), o = st.cfg?.OracleMcp;
  $('#pCfg').innerHTML = `
    <div class="bar2"><input id="cpath" type="text" value="${esc(getPath())}" style="flex:1;min-width:220px"><button data-a="cload">Cargar</button></div>
    ${!st.cfg ? '<p class="empty">Carga el archivo para empezar (debe ser JSON válido, sin comentarios).</p>' : `
    <div class="bar2"><div class="seg"><button data-a="mode" data-m="profiles" class="${st.mode === 'profiles' ? 'on' : ''}">Conexiones</button><button data-a="mode" data-m="raw" class="${st.mode === 'raw' ? 'on' : ''}">JSON</button></div>
      ${st.mode === 'profiles' ? `<label class="chk">Por defecto <select id="cdef">${names.map((n) => `<option ${o.DefaultProfile === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label><button class="pri" data-a="pnew">+ Nueva conexión</button>` : ''}</div>
    ${st.mode === 'raw' ? `<textarea id="craw" spellcheck="false">${esc(JSON.stringify(st.cfg, null, 2))}</textarea>`
      : `${st.pe ? profForm(st.pe) : ''}<div class="tbl">${names.map((n) => profRow(n, p[n])).join('') || '<p class="empty">Sin conexiones.</p>'}</div>`}
    <div class="bar2 foot"><button class="pri" data-a="csave">Guardar archivo</button><button data-a="capply" title="codex mcp remove + add oracle_local">Registrar en Codex</button><span class="hint">${st.dirty ? 'Hay cambios sin guardar.' : ''}</span></div>
    <pre id="clog" hidden></pre>`}`;
}
async function save() {
  if ($('#cpath') && $('#cpath').value.trim() !== getPath()) { msg('Cambiaste la ruta: pulsa "Cargar" primero.', 'err'); return false; }
  let content;
  if (st.mode === 'raw') {
    try { st.cfg = JSON.parse($('#craw').value); fixCfg(); content = $('#craw').value; }
    catch (x) { msg('JSON inválido: ' + x.message, 'err'); return false; }
  } else content = JSON.stringify(st.cfg, null, 2);
  try {
    const bak = await invoke('cfg_write', { path: getPath(), content });
    st.dirty = false; msg('Archivo guardado.' + (bak ? ' Respaldo: ' + bak : ''), 'ok'); return true;
  } catch (x) { msg(String(x), 'err'); return false; }
}

/* ---------- Eventos ---------- */
async function onClick(e) {
  const t = e.target.closest('#setTabs button'); if (t) return showTab(t.dataset.t);
  if (e.target.closest('#setX')) return closeSet();
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a, n = b.dataset.n;
  switch (a) {
    case 'vnew': st.ev = { n: 'ORACLE_', v: '', isNew: true }; renderVars(); break;
    case 'vedit': st.ev = { n, v: st.vars.find((x) => x.n === n)?.v ?? '', isNew: false }; renderVars(); break;
    case 'vcancel': st.ev = null; renderVars(); break;
    case 'veye': st.shown.has(n) ? st.shown.delete(n) : st.shown.add(n); renderVarsList(); break;
    case 'vsave': {
      const name = $('#vn').value.trim(), value = $('#vv').value;
      if (!NAME.test(name)) return msg('Nombre inválido: solo letras, números y _ (sin espacios ni número al inicio).', 'err');
      if (!value) return msg('El valor no puede estar vacío.', 'err');
      try { await invoke('env_set', { name, value }); } catch (x) { return msg(String(x), 'err'); }
      await refreshVars(); st.ev = null; renderVars(); msg(`Variable ${name} guardada.`, 'ok'); break;
    }
    case 'vdel': arm(n, async () => { await invoke('env_delete', { name: n }); await refreshVars(); renderVars(); msg(`Variable ${n} eliminada.`, 'ok'); }, renderVarsList); break;
    case 'cload': st.path = $('#cpath').value.trim() || DEF_PATH; await loadCfg(); break;
    case 'mode': {
      if (b.dataset.m === st.mode) break;
      if (st.mode === 'raw') {
        try { st.cfg = JSON.parse($('#craw').value); fixCfg(); } catch (x) { return msg('JSON inválido: ' + x.message, 'err'); }
      }
      st.mode = b.dataset.m; renderCfg(); break;
    }
    case 'pnew': st.pe = { isNew: true, n: '', Host: '', Port: 1521, Sid: '', User: '', Schema: '', PasswordEnvVar: '', Enabled: true, auto: true }; renderCfg(); $('#pn').focus(); break;
    case 'pedit': st.pe = { isNew: false, n, ...profiles()[n] }; renderCfg(); break;
    case 'pcancel': st.pe = null; renderCfg(); break;
    case 'ptog': profiles()[n].Enabled = b.checked; markDirty(); break;
    case 'pdel': arm('p:' + n, async () => { delete profiles()[n]; const o = st.cfg.OracleMcp; if (o.DefaultProfile === n) o.DefaultProfile = Object.keys(o.Profiles)[0] ?? ''; st.dirty = true; renderCfg(); msg(`Conexión ${n} quitada (falta guardar el archivo).`); }, renderCfg); break;
    case 'psave': {
      const name = $('#pn').value.trim(), v = $('#pv').value.trim(), pw = $('#pw').value, port = Number($('#pp').value);
      const o = { Enabled: $('#pen').checked, Host: $('#ph').value.trim(), Port: port, Sid: $('#ps').value.trim(), User: $('#pu').value.trim(), Schema: $('#pc').value.trim(), PasswordEnvVar: v };
      if (!name) return msg('Falta el nombre de la conexión.', 'err');
      if (st.pe.isNew && profiles()[name]) return msg('Ya existe una conexión con ese nombre.', 'err');
      if (!o.Host || !o.Sid || !o.User || !o.Schema) return msg('Completa host, SID, usuario y schema.', 'err');
      if (!Number.isInteger(port) || port < 1 || port > 65535) return msg('Puerto inválido.', 'err');
      if (!NAME.test(v)) return msg('La variable de contraseña tiene un nombre inválido.', 'err');
      if (pw) {
        try { await invoke('env_set', { name: v, value: pw }); await refreshVars(); } catch (x) { return msg(String(x), 'err'); }
      }
      const P = st.cfg.OracleMcp.Profiles;
      P[name] = { ...(P[name] ?? {}), ...o };
      if (!st.cfg.OracleMcp.DefaultProfile) st.cfg.OracleMcp.DefaultProfile = name;
      st.pe = null; st.dirty = true; renderCfg();
      msg(hasVar(v) ? `Conexión ${name} lista (falta guardar el archivo).` : `Conexión ${name} lista, pero la variable ${v} aún no existe: créala o escribe la contraseña.`, hasVar(v) ? 'ok' : 'err');
      break;
    }
    case 'ucheck': await doCheck(false); break;
    case 'uinstall': arm('upd', doInstall, paintUpd); break;
    case 'ksave':
      localStorage.setItem(CK, JSON.stringify({ v: 2, dir: $('#kdir').value.trim(), sandbox: $('#ksb').value, approval: $('#kap').value, start: $('#kst').checked }));
      msg('Guardado. Se aplica a las pestañas Codex que abras desde ahora.', 'ok'); break;
    case 'csave': await save(); renderCfgHint(); break;
    case 'capply': {
      if ((st.dirty || st.mode === 'raw') && !(await save())) break;
      const vs = [...new Set(Object.values(profiles()).map((p) => p.PasswordEnvVar).filter(Boolean))];
      const dir = getPath().replace(/[\\/][^\\/]*$/, '');
      msg('Registrando en Codex…');
      try {
        const out = await invoke('mcp_apply', { dir, vars: vs });
        const l = $('#clog'); l.hidden = false; l.textContent = out;
        msg('Listo. Cierra y vuelve a abrir Codex y revisa con /mcp.', 'ok');
      } catch (x) { msg(String(x), 'err'); }
      break;
    }
  }
}
function renderCfgHint() { const h = $('#pCfg .foot .hint'); if (h) h.textContent = st.dirty ? 'Hay cambios sin guardar.' : ''; }
function onInput(e) {
  const t = e.target;
  if (t.id === 'vq') { st.q = t.value; renderVarsList(); }
  else if (t.id === 'vall') { st.all = t.checked; renderVarsList(); }
  else if (t.id === 'pn' && st.pe?.auto) $('#pv').value = t.value.trim() ? `ORACLE_${t.value.trim()}_PASSWORD` : '';
  else if (t.id === 'pv' && st.pe) st.pe.auto = false;
  else if (t.id === 'uauto') localStorage.setItem(AUTO_KEY, t.checked ? '1' : '0');
  else if (t.id === 'ksb' || t.id === 'kap') kprev();
  else if (t.id === 'cdef') { st.cfg.OracleMcp.DefaultProfile = t.value; markDirty(); }
}

/* ---------- Codex: carpeta de inicio y permisos ---------- */
const CK = 'ri-term:codex';
const SANDBOX = { '': 'Predeterminado de Codex', 'read-only': 'Solo lectura', 'workspace-write': 'Escritura en el espacio de trabajo', 'danger-full-access': 'Acceso total (sin sandbox)' };
const APPROVAL = { '': 'Predeterminado de Codex', 'on-request': 'Solo cuando Codex lo pida (on-request)', never: 'Nunca preguntar (never)' };
const DEFAULTS = { v: 2, dir: 'K:\\', sandbox: 'danger-full-access', approval: '', start: true };
const codexOpts = () => { try { const o = JSON.parse(localStorage.getItem(CK)); return o?.v === 2 ? { ...DEFAULTS, ...o } : { ...DEFAULTS }; } catch { return { ...DEFAULTS }; } };
export const codexStartsByDefault = () => codexOpts().start;
export function codexLaunch(key, resumeId) {
  const o = codexOpts(), sb = o.sandbox;
  let cmd = 'codex'; if (sb) cmd += ` -s ${sb}`; if (o.approval in APPROVAL && o.approval) cmd += ` -a ${o.approval}`;
  if (resumeId && /^[0-9a-f-]{36}$/i.test(resumeId)) cmd += ` resume ${resumeId}`;
  return { args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'RemoteSigned', '-Command', cmd], cwd: o.dir.trim() || null };
}
function kprev() { const sb = $('#ksb').value, ap = $('#kap').value; $('#kprev').textContent = 'codex' + (sb ? ' -s ' + sb : '') + (ap ? ' -a ' + ap : ''); }
function renderCodex() {
  const o = codexOpts(), opt = (m, v) => Object.entries(m).map(([k, t]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${esc(t)}</option>`).join('');
  $('#pCodex').innerHTML = `
    <div class="kform">
      <label class="krow">Carpeta predeterminada de Codex (la que se usa cada vez que abres una pestaña Codex)<input id="kdir" type="text" placeholder="Ej. K:\\proyectos  (vacío = tu carpeta de usuario)" value="${esc(o.dir)}"></label>
      <label class="krow">Permisos (sandbox)<select id="ksb">${opt(SANDBOX, o.sandbox)}</select></label>
      <label class="krow">Aprobaciones<select id="kap">${opt(APPROVAL, o.approval)}</select></label>
      <label class="chk"><input type="checkbox" id="kst" ${o.start ? 'checked' : ''}> Abrir una pestaña de Codex al iniciar la app (y con Ctrl+T)</label>
      <p class="hint">Las pestañas Codex se abrirán con: <code id="kprev"></code></p>
      <div class="bar2"><button class="pri" data-a="ksave">Guardar</button></div>
    </div>
    <p class="hint"><b>Unidades de red (K:, \\\\servidor\\carpeta):</b> el sandbox de Codex en Windows las bloquea, y de ahí el error de permisos. Para leerlas, Codex tiene que correr con <b>Acceso total</b>, que es el valor por defecto aquí. Eso le permite leer, escribir y ejecutar todo lo que tu usuario pueda tocar, así que revisa con cuidado lo que le pides. Si prefieres el sandbox, cambia "Permisos" a "Predeterminado de Codex".</p>`;
  kprev();
}

/* ---------- Actualizaciones ---------- */
const AUTO_KEY = 'ri-term:autoupd';
const autoCheck = () => localStorage.getItem(AUTO_KEY) !== '0';
function friendly(x) {
  const m = String(x?.message ?? x);
  if (/pubkey|public key|signature|base64/i.test(m)) return 'Las actualizaciones aún no están configuradas en esta versión (falta la clave pública).';
  if (/valid release json|404|not found/i.test(m)) return 'Todavía no hay versiones publicadas para buscar.';
  if (/network|dns|connect|timed out|sending request/i.test(m)) return 'No se pudo conectar. Revisa tu conexión a internet.';
  return 'No se pudo buscar actualizaciones: ' + m;
}
function markUpd(on) {
  gearBtn?.classList.toggle('upd', on);
  root?.querySelector('#setTabs [data-t="upd"]')?.classList.toggle('dot', on);
}
function renderUpd() {
  $('#pUpd').innerHTML = `<div class="uform">
    <div class="ucard"><div class="ulbl">Versión instalada</div><div class="uver">${esc(st.ver || '—')}</div></div>
    <div class="bar2"><button class="pri" id="ubtn" data-a="ucheck">Buscar actualizaciones</button><button class="pri" id="uins" data-a="uinstall" hidden>Instalar y reiniciar</button></div>
    <div id="ust" class="ust"></div>
    <div id="ubarw" class="ubarw" hidden><div id="ubar"></div></div>
    <pre id="unotes" hidden></pre>
    <label class="chk"><input type="checkbox" id="uauto" ${autoCheck() ? 'checked' : ''}> Buscar actualizaciones al iniciar la app</label>
    <p class="hint">Al instalar una actualización, RI Terminal se cierra y se vuelve a abrir: se cerrarán las pestañas abiertas (incluidas las de Codex), así que termina lo que estés haciendo antes. Tus ajustes, perfil y variables de entorno se conservan.</p></div>`;
  paintUpd();
}
function paintUpd() {
  const u = st.u; if (!$('#ust')) return;
  $('#ust').textContent = u.text; $('#ust').className = 'ust ' + (u.kind || '');
  $('#ubtn').disabled = u.busy;
  const ins = $('#uins'); ins.hidden = !u.up || (u.busy && !u.dl); ins.disabled = u.busy;
  ins.textContent = st.armed === 'upd' ? '¿Seguro? Se cerrarán las pestañas' : `Instalar ${u.up ? u.up.version : ''} y reiniciar`;
  const n = $('#unotes'); const body = u.up?.body?.trim();
  n.hidden = !body; n.textContent = body || '';
  $('#ubarw').hidden = !u.dl;
}
function setBar(frac) {
  const b = $('#ubar'); if (!b) return;
  b.style.width = frac == null ? '100%' : Math.round(frac * 100) + '%';
}
async function doCheck(silent) {
  if (st.u.busy) return;
  st.u = { busy: true, up: null, text: 'Buscando actualizaciones…', kind: '' }; paintUpd();
  try {
    const up = await check();
    if (!up) { st.u = { busy: false, up: null, text: 'RI Terminal está al día.', kind: 'ok' }; markUpd(false); }
    else { st.u = { busy: false, up, text: `Hay una versión nueva: ${up.version}.`, kind: 'ok' }; markUpd(true); }
  } catch (x) {
    st.u = { busy: false, up: null, text: silent ? '' : friendly(x), kind: silent ? '' : 'err' };
  }
  paintUpd();
}
async function doInstall() {
  const up = st.u.up; if (!up || st.u.busy) return;
  st.u = { ...st.u, busy: true, dl: true, text: 'Descargando…', kind: '' }; paintUpd(); setBar(0);
  let total = 0, got = 0;
  try {
    await up.downloadAndInstall((ev) => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
      else if (ev.event === 'Progress') {
        got += ev.data.chunkLength; setBar(total ? got / total : null);
        $('#ust').textContent = total ? `Descargando… ${Math.round((got / total) * 100)}%` : 'Descargando…';
      } else if (ev.event === 'Finished') $('#ust').textContent = 'Instalando…';
    });
    st.u.text = 'Actualización instalada. Reiniciando…'; paintUpd();
    await relaunch();
  } catch (x) {
    st.u = { ...st.u, busy: false, dl: false, text: friendly(x), kind: 'err' }; paintUpd();
  }
}
