(function(){
'use strict';

/* ---------- Configuration (clé publique: faite pour être dans l'app) ---------- */
const VERSION = '2.1';
const SUPA_URL = 'https://dcforgceifhnrplsydfk.supabase.co';
const SUPA_KEY = 'sb_publishable_1Iojb5iodd5Rwn4Cgmhj3Q_2BI4wdMW';
const TOKEN_KEY = 'ads-terrain-token';
const LOGIN_KEY = 'ads-terrain-login';
const SNAP_KEY = 'ads-terrain-snap';
const STALE_H = 12;           // un punch ouvert plus longtemps que ça déclenche le rappel
const EDIT_DAYS = 7;          // les heures peuvent être corrigées pendant 7 jours

/* ---------- Outils ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2,'0');
const iso = d => d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const hm = d => pad(d.getHours())+':'+pad(d.getMinutes());
const fmtDur = h => { const m = Math.round(h*60); return Math.floor(m/60)+' h '+pad(m%60); };
const cap = s => s.charAt(0).toUpperCase()+s.slice(1);
const longDate = d => cap(d.toLocaleDateString('fr-CA',{weekday:'long',day:'numeric',month:'long'}));
const uid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,8);
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function ssGet(k){ try{ return sessionStorage.getItem(k); }catch(e){ return null; } }
function ssSet(k,v){ try{ if(v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k,v); }catch(e){} }
function lsSet(k,v){ try{ if(v == null) localStorage.removeItem(k); else localStorage.setItem(k,v); }catch(e){} }
function calcH(debut,fin,pause){
  const a = debut.split(':'), b = fin.split(':');
  let m = (+b[0]*60 + +b[1]) - (+a[0]*60 + +a[1]); if(m < 0) m += 1440;
  return Math.round(Math.max(0, m - Math.max(0,pause||0)) / 60 * 100) / 100;
}
const dayLabel = ds => {
  const t = iso(new Date()), y = iso(new Date(Date.now()-86400000));
  if(ds === t) return 'Aujourd\'hui'; if(ds === y) return 'Hier';
  return cap(new Date(ds+'T12:00:00').toLocaleDateString('fr-CA',{weekday:'long',day:'numeric',month:'short'}));
};

/* ---------- Accès à la base (fonctions terrain_* de Supabase) ---------- */
class ApiErr extends Error{ constructor(code,msg){ super(msg); this.code = code; } }
async function rpc(fn,args){
  const big = args && (args.p_src || args.p_mini);
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const to = ctl ? setTimeout(()=>ctl.abort(), big ? 90000 : 25000) : null;
  let r;
  try{
    r = await fetch(SUPA_URL+'/rest/v1/rpc/'+fn,{
      method:'POST',
      headers:{'apikey':SUPA_KEY,'Content-Type':'application/json'},
      body:JSON.stringify(args || {}),
      signal: ctl ? ctl.signal : undefined
    });
  }catch(e){ if(to) clearTimeout(to); throw new ApiErr('reseau','Pas de réseau. Réessaie dans un instant.'); }
  let txt;
  try{ txt = await r.text(); }catch(e){ if(to) clearTimeout(to); throw new ApiErr('reseau','Pas de réseau. Réessaie dans un instant.'); }
  if(to) clearTimeout(to);
  let data = null;
  try{ data = txt ? JSON.parse(txt) : null; }catch(e){}
  if(!r.ok){
    const msg = (data && data.message) || '';
    if(msg.indexOf('session_invalide') >= 0) throw new ApiErr('session','Session expirée.');
    if(msg.indexOf('aucun_punch') >= 0) throw new ApiErr('aucun_punch','Ce punch est déjà terminé.');
    if(msg.indexOf('date_invalide') >= 0) throw new ApiErr('serveur','Date refusée: seulement les '+EDIT_DAYS+' derniers jours.');
    if(msg.indexOf('heure_invalide') >= 0) throw new ApiErr('serveur','Heure invalide.');
    if(msg.indexOf('acces_refuse') >= 0) throw new ApiErr('serveur','Cette entrée ne t\'appartient pas.');
    if(r.status >= 500 && !msg) throw new ApiErr('reseau','Service indisponible. Réessaie dans un instant.');
    throw new ApiErr('serveur', msg || ('Erreur '+r.status));
  }
  return data;
}

/* ---------- File d'attente hors ligne (IndexedDB, avec repli en mémoire) ---------- */
const DB = (function(){
  let db = null, mem = [], seq = 0;
  const ready = new Promise(res => {
    try{
      const r = indexedDB.open('ads-terrain',1);
      r.onupgradeneeded = () => r.result.createObjectStore('outbox',{keyPath:'seq',autoIncrement:true});
      r.onsuccess = () => { db = r.result; res(); };
      r.onerror = r.onblocked = () => res();
    }catch(e){ res(); }
  });
  function tx(mode,fn){
    return new Promise(res => {
      if(!db) return res(null);
      try{
        const t = db.transaction('outbox',mode); const rq = fn(t.objectStore('outbox'));
        t.oncomplete = () => res(rq ? rq.result : true); t.onerror = t.onabort = () => res(null);
      }catch(e){ res(null); }
    });
  }
  return {
    async all(){ await ready; if(!db) return mem.slice(); return (await tx('readonly',s=>s.getAll())) || []; },
    async add(op){ await ready; const k = await tx('readwrite',s=>s.add(op)); if(k == null){ op.seq = ++seq + 1e9; mem.push(op); } else op.seq = k; return op; },
    async del(op){ await ready; mem = mem.filter(o=>o.seq!==op.seq); if(db) await tx('readwrite',s=>s.delete(op.seq)); }
  };
})();
let OUT = [];
const mine = () => S.user ? OUT.filter(o=>o.owner===S.user.id) : [];
const pending = () => mine().length;
const hasOp = (fn,key,val) => mine().some(o=>o.fn===fn && o.args[key]===val);

/* ---------- État ---------- */
const S = {token:lsGet(TOKEN_KEY) || ssGet(TOKEN_KEY),user:null,tab:'punch',projets:[],heures:[],open:null,skew:0,pid:null,sub:'check',
  pick:null,jDraft:'',jPhoto:null,ckDraft:'',sheet:false,pause:30,note:'',endT:'',lb:null,photos:{},photoFor:'gallery',wk:0,hs:null,
  loading:true,bootErr:null,syncing:false,dirty:false,reg:null};
const proj = id => S.projets.find(p=>p.id===id);
const projName = id => { const p = proj(id); return p ? p.nomDossier : 'Sans projet'; };
const nowMs = () => Date.now() + S.skew;
const pauseTot = (o,at) => (o.pauseMs||0) + (o.pauseStart ? Math.max(0,at-o.pauseStart) : 0);
const workMs = (o,at) => Math.max(0, at - o.start - pauseTot(o,at));
function segment(o,f,pause,notes){
  const d0 = new Date(o.start), d1 = new Date(f);
  return {id:'h'+uid(),date:iso(d0),projetId:o.projetId,debut:hm(d0),fin:hm(d1),pause,
    heures:calcH(hm(d0),hm(d1),pause) + (f-o.start>=86400000 ? Math.floor((f-o.start)/86400000)*24 : 0),notes:notes||null,modifie:false,manuel:false};
}
const fmtClock = ms => { const s = Math.max(0,Math.floor(ms/1000)); return pad(Math.floor(s/3600))+':'+pad(Math.floor(s%3600/60))+':'+pad(s%60); };

function persist(){
  if(!S.user) return;
  lsSet(SNAP_KEY, JSON.stringify({user:S.user,projets:S.projets,heures:S.heures,open:S.open,skew:S.skew}));
}
function readSnap(){
  const raw = lsGet(SNAP_KEY); if(!raw) return null;
  try{ const s = JSON.parse(raw); return s && s.user && s.user.id ? s : null; }catch(e){ return null; }
}
async function loadAll(){
  const d = await rpc('terrain_charger',{p_token:S.token});
  S.user = d.employe; S.projets = d.projets || []; S.heures = d.heures || []; S.open = d.punch || null;
  S.skew = d.now ? d.now - Date.now() : 0;
  if(S.pid && !proj(S.pid)) S.pid = null;
  persist();
}
async function loadAllSafe(){
  try{ await loadAll(); return true; }
  catch(e){ if(e.code === 'session'){ sessionLost(); toast('Session expirée. Reconnecte-toi.'); } return false; }
}
async function loadPhotos(pid){
  try{ S.photos[pid] = await rpc('terrain_photos',{p_token:S.token,p_projet:pid}) || []; softRender(); }catch(e){}
}
/* Photos affichées = celles du serveur + celles en attente d'envoi - celles supprimées en attente */
function photosOf(pid){
  const base = (S.photos[pid] || []).slice(); const ids = new Set(base.map(f=>f.id));
  const gone = new Set(mine().filter(o=>o.fn==='terrain_photo_delete').map(o=>o.args.p_id));
  mine().forEach(o=>{
    if(o.fn==='terrain_photo_add' && o.args.p_projet===pid && !ids.has(o.args.p_id)){ base.push({id:o.args.p_id,mini:o.args.p_mini,src:o.args.p_src,par:S.user.nom,journalId:null,mine:true,wait:true}); ids.add(o.args.p_id); }
    if(o.fn==='terrain_journal_add' && o.args.p_projet===pid && o.args.p_photo_id && !ids.has(o.args.p_photo_id)){ base.push({id:o.args.p_photo_id,mini:o.args.p_mini,src:o.args.p_src,par:S.user.nom,journalId:o.args.p_id,mine:true,wait:true}); ids.add(o.args.p_photo_id); }
  });
  return base.filter(f=>!gone.has(f.id));
}
function nbPhotos(p){
  let n = p.nbPhotos || 0; const known = new Map((S.photos[p.id] || []).map(f=>[f.id,f]));
  mine().forEach(o=>{
    if(o.fn==='terrain_photo_add' && o.args.p_projet===p.id) n++;
    if(o.fn==='terrain_photo_delete'){ const f = known.get(o.args.p_id); if(f && !f.journalId) n--; }
  });
  return Math.max(0,n);
}

function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(()=>{ t.hidden = true; }, 4000);
}
function sessionLost(){
  lsSet(TOKEN_KEY,null); ssSet(TOKEN_KEY,null); lsSet(SNAP_KEY,null);
  S.token = null; S.user = null; S.open = null; S.pid = null; S.sheet = false; S.lb = null; S.tab = 'punch'; S.photos = {};
  render();
}

/* ---------- Envoi des actions: tout passe par la file, même en ligne ---------- */
async function queue(fn,args){
  const op = {owner:S.user.id, fn, args, at:Date.now()};
  await DB.add(op); OUT.push(op);
  persist(); updSync();
  flush();
}
async function flush(){
  if(S.syncing || !S.token || !S.user) return false;
  if(!pending()) return false;
  S.syncing = true; updSync();
  let did = false, stop = false;
  try{
    for(;;){
      const op = mine()[0]; if(!op) break;
      try{ await rpc(op.fn, Object.assign({p_token:S.token}, op.args)); }
      catch(e){
        if(e.code === 'reseau'){ stop = true; break; }
        if(e.code === 'session'){ stop = true; sessionLost(); toast('Session expirée. Reconnecte-toi, tes données seront envoyées.'); break; }
        if(e.code !== 'aucun_punch') toast(e.message || 'Une action a été refusée.');
      }
      await DB.del(op); OUT = OUT.filter(o=>o.seq!==op.seq); did = true;
    }
  } finally { S.syncing = false; }
  if(did && !stop && !pending() && S.user){
    S.photos = {}; await loadAllSafe();
    if(S.pid && S.user) loadPhotos(S.pid);
  }
  updSync(); softRender();
  return did;
}
async function refresh(){
  if(!S.token || !S.user) return;
  const did = await flush();
  if(!did && !pending()){ await loadAllSafe(); if(S.pid && S.user) loadPhotos(S.pid); }
  softRender();
}

/* ---------- Vues ---------- */
const pinSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
const mapLink = a => a ? `<a class="addr-link" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}" target="_blank" rel="noopener">${pinSvg}<span>${esc(a)}</span></a>` : '';
function stale(o){ return (nowMs()-o.start) > STALE_H*3600000 || iso(new Date(o.start)) !== iso(new Date(nowMs())); }
function todayWorked(){
  const t = iso(new Date());
  let h = S.heures.filter(x=>x.date===t).reduce((a,x)=>a+Number(x.heures),0);
  if(S.open) h += workMs(S.open,nowMs())/3600000;
  return h;
}
function tags(h){
  let t = '';
  if(hasOp('terrain_heure_save','p_id',h.id) || hasOp('terrain_punch_out','p_id',h.id)) t += '<span class="tag wait">À envoyer</span>';
  if(h.manuel) t += '<span class="tag">Ajouté</span>'; else if(h.modifie) t += '<span class="tag">Modifié</span>';
  return t;
}
function heureRow(h,edit){
  const body = `<div class="l"><b>${esc(projName(h.projetId))} ${tags(h)}</b><small class="num">${esc(h.debut)} à ${esc(h.fin)}, pause ${h.pause} min${h.notes ? ' · '+esc(h.notes) : ''}</small></div><div class="r num">${fmtDur(Number(h.heures))}</div>`;
  return edit ? `<button class="row" data-act="hsedit" data-id="${esc(h.id)}">${body}</button>` : `<div class="row">${body}</div>`;
}
function viewPunch(){
  const first = new Date();
  const todays = S.heures.filter(h=>h.date===iso(first));
  const list = todays.length ? '<div class="card">'+todays.map(h=>heureRow(h,false)).join('')+'</div>' : '<div class="empty">Aucun punch terminé aujourd\'hui.</div>';
  if(S.open){
    const o = S.open, p = proj(o.projetId), paused = !!o.pauseStart;
    const warn = stale(o) ? `<div class="alert"><b>Punch ouvert depuis ${fmtDur((nowMs()-o.start)/3600000)}</b>As-tu oublié de punch out? Appuie sur Punch OUT et mets l'heure à laquelle tu as vraiment fini.</div>` : '';
    return `<p class="eyebrow">${longDate(first)}</p>${warn}
    <div class="live${paused?' paused':''}">
      <span class="pulse">${paused ? 'En pause' : 'Au travail'}</span>
      <div class="clock" id="clock">00:00:00</div>
      <div class="since num" id="sub"></div>
      <div class="proj">${esc(p ? p.nomDossier : '')}</div>
      <div class="since num">Punch depuis ${hm(new Date(o.start))}${iso(new Date(o.start))!==iso(first) ? ' ('+esc(dayLabel(iso(new Date(o.start))).toLowerCase())+')' : ''}</div>
      ${p ? mapLink(p.adresse) : ''}
      ${p ? `<button class="linkbtn" data-act="open" data-id="${esc(p.id)}">Voir le projet et ajouter une photo</button>` : ''}
    </div>
    <div class="sec"><span class="lbl">Aujourd'hui</span>${list}</div>
    <div class="dock">
      ${paused
        ? `<button class="punch pause" data-act="pauseend">Terminer la pause</button><button class="btn ghost wide" data-act="out">Punch OUT</button>`
        : `<div class="two"><button class="btn ghost big2" data-act="pausego">Pause</button><button class="btn ghost big2" data-act="xfer"${S.projets.length>1?'':' disabled'}>Changer de projet</button></div><button class="punch stop" data-act="out">Punch OUT</button>`}
    </div>`;
  }
  return `<p class="eyebrow">${longDate(first)}</p>
    <h1 class="big">Bonjour, ${esc((S.user.nom || '').split(' ')[0])}</h1>
    <div class="sec"><span class="lbl">Aujourd'hui <span class="num" style="float:right;text-transform:none;letter-spacing:0">${fmtDur(todayWorked())}</span></span>${list}</div>
    ${S.projets.length ? '' : '<div class="empty">Aucun projet actif pour l\'instant. Demande à Francis d\'en ajouter.</div>'}
    <div class="dock"><button class="punch go" data-act="in"${S.projets.length?'':' disabled'}>Punch IN</button></div>`;
}
function viewProjets(){
  if(!S.projets.length) return '<h1 class="big" style="margin-bottom:14px">Mes projets</h1><div class="empty">Aucun projet actif pour l\'instant.</div>';
  return `<h1 class="big" style="margin-bottom:14px">Mes projets</h1>`+S.projets.map(p=>{
    const d = p.checklist.filter(i=>i.done).length;
    const n = nbPhotos(p);
    return `<button class="pcard" data-act="open" data-id="${esc(p.id)}"><h3>${esc(p.nomDossier)}</h3><div class="addr">${esc(p.adresse || '')}</div>
    <div class="meta"><span class="chip${p.status==='En cours'?'':' warn'}">${esc(p.status)}</span><span>Liste ${d}/${p.checklist.length}</span><span>${n} photo${n>1?'s':''}</span></div></button>`;
  }).join('');
}
const camSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
function viewProjet(){
  const p = proj(S.pid); if(!p) return '';
  const tabs = [['check','Liste'],['photos','Photos'],['journal','Journal']];
  const phs = photosOf(p.id), loaded = !!S.photos[p.id];
  let body = '';
  if(S.sub==='check'){
    const d = p.checklist.filter(i=>i.done).length;
    body = (p.checklist.length ? `<div class="eyebrow" style="margin-bottom:4px">${d} sur ${p.checklist.length} complété${d>1?'s':''}</div><div class="card">`+p.checklist.map(i=>`<label class="ck${i.done?' done':''}"><input type="checkbox" data-act="ck" data-id="${esc(i.id)}"${i.done?' checked':''}><span><b>${esc(i.text)}</b>${i.done && i.completedBy ? `<small>${esc(i.completedBy)}${i.completedAt ? ', '+hm(new Date(i.completedAt)) : ''}</small>` : ''}</span></label>`).join('')+'</div>' : '<div class="empty">Aucun item pour ce chantier.</div>')
      +`<div class="addrow"><input id="ckIn" placeholder="Ajouter un item" value="${esc(S.ckDraft)}"><button class="btn" data-act="ckadd" aria-label="Ajouter">+</button></div>`;
  } else if(S.sub==='photos'){
    const gal = phs.filter(f=>!f.journalId);
    body = `<button class="cam" data-act="shoot">${camSvg}Prendre une photo</button>`
      +(gal.length ? `<div class="grid">${gal.map(f=>`<button data-act="zoom" data-id="${esc(f.id)}"><img src="${f.mini}" alt="Photo du chantier">${f.wait?'<span class="tag wait pin">À envoyer</span>':''}</button>`).join('')}</div>` : '<div class="empty">Aucune photo pour l\'instant. Prends la première au début du chantier.</div>');
  } else {
    body = `<textarea id="jIn" placeholder="Avancement, problème, question...">${esc(S.jDraft)}</textarea>`
      +(S.jPhoto ? `<div class="pending-img"><img src="${S.jPhoto.mini}" alt="Photo jointe"></div>` : '')
      +`<div class="jtools"><button class="btn ghost" data-act="jshoot" aria-label="Ajouter une photo">${camSvg}</button><button class="btn" data-act="jadd">Ajouter au journal</button></div>`
      +'<div style="margin-top:14px">'+(p.journal.length ? [...p.journal].reverse().map(j=>{
        const ph = j.photoId ? phs.find(f=>f.id===j.photoId) : null;
        const wait = hasOp('terrain_journal_add','p_id',j.id);
        return `<div class="j"><small>${esc(j.author || '')}, ${esc(cap(new Date(j.createdAt).toLocaleDateString('fr-CA',{weekday:'short',day:'numeric',month:'short'})))} ${hm(new Date(j.createdAt))}</small>${wait?' <span class="tag wait">À envoyer</span>':''}${j.text ? `<p>${esc(j.text)}</p>` : ''}${ph ? `<img src="${ph.mini}" alt="Photo du journal" data-act="zoomj" data-id="${esc(ph.id)}">` : (j.photoId && !loaded ? '<p><small>Photo en chargement...</small></p>' : '')}</div>`;
      }).join('') : '<div class="empty">Le journal est vide.</div>')+'</div>';
  }
  return `<button class="back" data-act="back">‹ Projets</button>
    <h1 class="big" style="font-size:32px">${esc(p.nomDossier)}</h1>
    <div class="meta" style="margin-top:6px"><span class="chip${p.status==='En cours'?'':' warn'}">${esc(p.status)}</span></div>
    ${mapLink(p.adresse)}
    <div class="seg">${tabs.map(t=>`<button class="${S.sub===t[0]?'on':''}" data-act="sub" data-sub="${t[0]}">${t[1]}</button>`).join('')}</div>${body}`;
}
function viewMoi(){
  const d0 = new Date(); const dow = (d0.getDay()+6)%7;
  const mon = new Date(d0); mon.setDate(d0.getDate()-dow+S.wk*7);
  const days = [];
  for(let i=0;i<7;i++){ const d = new Date(mon); d.setDate(mon.getDate()+i); days.push(iso(d)); }
  const wk = S.heures.filter(h=>days.includes(h.date));
  const tot = wk.reduce((a,h)=>a+Number(h.heures),0) + (S.open && S.wk===0 ? workMs(S.open,nowMs())/3600000 : 0);
  const limit = iso(new Date(Date.now()-EDIT_DAYS*86400000));
  const blocks = days.slice().reverse().map(ds=>{
    const hs = wk.filter(h=>h.date===ds); if(!hs.length) return '';
    const dt = hs.reduce((a,h)=>a+Number(h.heures),0);
    return `<div class="dayh"><span>${esc(dayLabel(ds))}</span><span class="num">${fmtDur(dt)}</span></div><div class="card">`
      +hs.map(h=>heureRow(h, ds>=limit)).join('')+'</div>';
  }).join('');
  const nav = `<div class="wknav"><button data-act="wk" data-d="-1" aria-label="Semaine précédente"${S.wk<=-2?' disabled':''}>‹</button><span class="eyebrow">${S.wk===0?'Cette semaine':'Semaine du '+mon.toLocaleDateString('fr-CA',{day:'numeric',month:'long'})}</span><button data-act="wk" data-d="1" aria-label="Semaine suivante"${S.wk>=0?' disabled':''}>›</button></div>`;
  return `${nav}
    <div class="total"><b class="num">${fmtDur(tot)}</b><span class="lbl">Total</span></div>
    <button class="btn ghost" style="width:100%;margin-top:14px;height:48px" data-act="hsnew">+ Ajouter une entrée oubliée</button>
    ${blocks || '<div class="empty">Aucune heure cette semaine.</div>'}
    <p class="note">Touche une entrée des ${EDIT_DAYS} derniers jours pour la corriger.</p>
    <button class="btn ghost" style="width:100%;margin-top:18px" data-act="refresh">Actualiser</button>
    <button class="btn ghost" style="width:100%;margin-top:10px" data-act="logout">Se déconnecter</button>
    <div class="foot">ADS Terrain v${VERSION}</div>`;
}

/* ---------- Rendu ---------- */
function render(){
  $('#loading').hidden = !S.loading;
  $('#bootErr').hidden = S.loading || !S.bootErr;
  $('#login').hidden = S.loading || !!S.bootErr || !!S.user;
  $('#main').hidden = S.loading || !!S.bootErr || !S.user;
  if(S.bootErr) $('#bootMsg').textContent = S.bootErr;
  S.dirty = false;
  if(!S.user){ renderOverlay(true); return; }
  $('#hello').textContent = S.user.nom;
  $('#roleLbl').textContent = S.user.role === 'admin' ? 'Administrateur' : 'Employé';
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on', b.dataset.tab===S.tab));
  const v = $('#view'); const st = v.scrollTop;
  v.innerHTML = S.pid ? viewProjet() : S.tab==='punch' ? viewPunch() : S.tab==='projets' ? viewProjets() : viewMoi();
  v.scrollTop = st;
  renderOverlay(false); tick(); updSync();
}
/* Rendu "doux": ne casse pas un champ en cours de saisie quand une synchro se termine en arrière-plan */
function softRender(){
  const a = document.activeElement;
  if(a && a.closest && a.closest('#view') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)){ S.dirty = true; updSync(); return; }
  render();
}
document.addEventListener('focusout', () => { if(S.dirty) setTimeout(()=>{ const a = document.activeElement; if(!(a && a.closest && a.closest('#view') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) render(); },120); });

function sheetPick(mode){
  const list = mode==='xfer' ? S.projets.filter(p=>!S.open || p.id!==S.open.projetId) : S.projets;
  return `<div class="veil" data-act="sheetclose"><div class="sheet" role="dialog" aria-label="Choisir le projet">
    <h2>${mode==='xfer' ? 'Changer de projet' : 'Sur quel projet?'}</h2>
    ${mode==='xfer' ? '<p class="note" style="margin:0">Ton temps sur le projet actuel est enregistré, et un nouveau punch commence maintenant sur celui que tu choisis.</p>' : ''}
    <div class="plist">${list.map(p=>`<button class="pick" data-act="${mode==='xfer'?'xferp':'startp'}" data-id="${esc(p.id)}"><span><b>${esc(p.nomDossier)}</b><small>${esc(p.adresse || '')}</small></span></button>`).join('') || '<div class="empty">Aucun autre projet actif.</div>'}</div>
    <button class="btn ghost" data-act="sheetclose">Annuler</button></div></div>`;
}
function sheetOut(){
  const mins = outMins();
  return `<div class="veil" data-act="sheetclose"><div class="sheet" role="dialog" aria-label="Terminer le punch">
    <h2>Terminer le punch</h2>
    <div class="field"><label for="endIn">Heure de fin</label><input id="endIn" class="ctl" type="time" value="${esc(S.endT)}"></div>
    <div class="field"><label for="pauseIn">Pause prise (minutes)</label><input id="pauseIn" class="ctl" type="number" inputmode="numeric" min="0" step="5" value="${S.pause}"></div>
    <div class="field"><label for="noteIn">Note (facultatif)</label><input id="noteIn" class="ctl" value="${esc(S.note)}" placeholder="Ex.: pluie en après-midi"></div>
    <div class="sum"><span>Temps travaillé</span><span class="num" id="outSum">${mins == null ? '--' : fmtDur(mins/60)}</span></div>
    <button class="punch stop" style="height:64px;font-size:28px" data-act="outok">Confirmer</button>
    <button class="btn ghost" data-act="sheetclose">Annuler</button></div></div>`;
}
function sheetHs(){
  const h = S.hs, today = new Date();
  const projs = S.projets.slice(); if(h.projet && !proj(h.projet)) projs.push({id:h.projet,nomDossier:projName(h.projet)+' (terminé)'});
  const dayOpts = []; for(let i=0;i<=EDIT_DAYS;i++){ dayOpts.push(iso(new Date(today.getTime()-i*86400000))); }
  if(h.jour && !dayOpts.includes(h.jour)) dayOpts.push(h.jour);
  return `<div class="veil" data-act="sheetclose"><div class="sheet" role="dialog" aria-label="Heures">
    <h2>${h.id ? 'Corriger les heures' : 'Ajouter des heures'}</h2>
    <div class="field"><label for="hsP">Projet</label><select id="hsP" class="ctl">${projs.map(p=>`<option value="${esc(p.id)}"${p.id===h.projet?' selected':''}>${esc(p.nomDossier)}</option>`).join('')}</select></div>
    <div class="field"><label for="hsD">Jour</label><select id="hsD" class="ctl">${dayOpts.map(d=>`<option value="${d}"${d===h.jour?' selected':''}>${esc(dayLabel(d))}</option>`).join('')}</select></div>
    <div class="two"><div class="field"><label for="hsA">Début</label><input id="hsA" class="ctl" type="time" value="${esc(h.debut)}"></div><div class="field"><label for="hsB">Fin</label><input id="hsB" class="ctl" type="time" value="${esc(h.fin)}"></div></div>
    <div><span class="lbl">Pause prise</span><div class="chips" style="margin-top:8px">${[0,15,30,45,60].map(m=>`<button class="${h.pause===m?'on':''}" data-act="hspause" data-m="${m}">${m} min</button>`).join('')}</div></div>
    <div class="field"><label for="hsN">Note (facultatif)</label><input id="hsN" class="ctl" value="${esc(h.notes)}"></div>
    <div class="sum"><span>Temps travaillé</span><span class="num" id="hsSum">${h.debut && h.fin ? fmtDur(calcH(h.debut,h.fin,h.pause)) : '--'}</span></div>
    <button class="btn" data-act="hssave">Enregistrer</button>
    ${h.id ? '<button class="btn danger" data-act="hsdel">Supprimer cette entrée</button>' : ''}
    <button class="btn ghost" data-act="sheetclose">Annuler</button></div></div>`;
}
function renderOverlay(force){
  const o = $('#overlay');
  if(S.lb){
    const f = S.lb, can = f.mine || (S.user && S.user.role === 'admin');
    o.innerHTML = `<div class="lb" data-act="lbclose"><img src="${f.src || f.mini}" alt="Photo agrandie"><div class="lbtools">${can ? (f.confirm ? '<button class="btn danger" data-act="phdel">Confirmer la suppression</button>' : '<button class="btn ghost" data-act="phdelask">Supprimer cette photo</button>') : ''}<button class="btn ghost" data-act="lbclose">Fermer</button></div></div>`;
    return;
  }
  if((S.sheet === 'start' || S.sheet === 'xfer') && (S.sheet==='start' ? !S.open : S.open)){ if(force || !o.firstChild) o.innerHTML = sheetPick(S.sheet); return; }
  if(S.sheet === 'out' && S.open){ if(force || !o.firstChild) o.innerHTML = sheetOut(); return; }
  if(S.sheet === 'hs' && S.hs){ if(force || !o.firstChild) o.innerHTML = sheetHs(); return; }
  o.innerHTML = '';
}
function tick(){
  const c = $('#clock'); if(!c || !S.open) return;
  const o = S.open, n = nowMs();
  if(o.pauseStart){ c.textContent = fmtClock(n-o.pauseStart); const el = $('#sub'); if(el) el.textContent = 'Temps travaillé : '+fmtClock(workMs(o,n)); }
  else { c.textContent = fmtClock(workMs(o,n)); const el = $('#sub'); if(el) el.textContent = pauseTot(o,n) > 0 ? 'Pauses : '+fmtDur(pauseTot(o,n)/3600000) : 'Temps travaillé'; }
}
setInterval(tick,1000);
function updSync(){
  const s = $('#sync'); if(!s) return;
  const on = navigator.onLine !== false, n = S.user ? pending() : 0;
  let txt = on ? 'En ligne' : 'Hors ligne';
  if(S.syncing && n) txt = 'Envoi...'; else if(n) txt = on ? n+' à envoyer' : 'Hors ligne · '+n;
  s.classList.toggle('off', !on || n>0);
  s.querySelector('span').textContent = txt;
}

/* Heure de fin du punch (HH:MM saisie -> instant), jamais dans le futur */
function endMs(t){
  if(!t) return null; const p = t.split(':'); const d = new Date(); d.setHours(+p[0],+p[1],0,0);
  let ms = d.getTime(); const lim = nowMs()+300000; while(ms > lim) ms -= 86400000; return ms;
}
function outMins(){
  if(!S.open) return null; const f = endMs(S.endT); if(f == null) return null;
  return Math.max(0, Math.round((f - S.open.start)/60000) - S.pause);
}

/* ---------- Photos ---------- */
function shrink(file,sizes){
  return new Promise((res,rej)=>{
    const r = new FileReader(); r.onerror = rej;
    r.onload = () => { const img = new Image(); img.onerror = rej;
      img.onload = () => {
        res(sizes.map(([max,q]) => {
          const k = Math.min(1,max/Math.max(img.width,img.height)); const c = document.createElement('canvas');
          c.width = Math.round(img.width*k); c.height = Math.round(img.height*k);
          c.getContext('2d').drawImage(img,0,0,c.width,c.height);
          return c.toDataURL('image/jpeg',q);
        }));
      };
      img.src = r.result; };
    r.readAsDataURL(file);
  });
}
$('#photoIn').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = ''; if(!f) return;
  let pair;
  try{ pair = await shrink(f,[[1280,.8],[320,.7]]); }catch(err){ toast('La photo n\'a pas pu être lue. Réessaie.'); return; }
  const [src,mini] = pair; const p = proj(S.pid); if(!p) return;
  if(S.photoFor === 'journal'){ S.jPhoto = {src,mini}; render(); return; }
  await queue('terrain_photo_add',{p_projet:p.id,p_id:'p'+uid(),p_mini:mini,p_src:src});
  toast(navigator.onLine === false ? 'Photo gardée. Elle partira avec le réseau.' : 'Photo enregistrée.');
  render();
});

/* ---------- Actions ---------- */
document.addEventListener('input', e => {
  const id = e.target.id;
  if(id==='jIn') S.jDraft = e.target.value;
  if(id==='ckIn') S.ckDraft = e.target.value;
  if(id==='noteIn') S.note = e.target.value;
  if(id==='pauseIn'){ S.pause = Math.max(0,parseInt(e.target.value,10)||0); const m = outMins(); const el = $('#outSum'); if(el) el.textContent = m == null ? '--' : fmtDur(m/60); }
  if(id==='endIn'){ S.endT = e.target.value; const m = outMins(); const el = $('#outSum'); if(el) el.textContent = m == null ? '--' : fmtDur(m/60); }
  if(S.hs && /^hs[PDABN]$/.test(id)){
    const k = {hsP:'projet',hsD:'jour',hsA:'debut',hsB:'fin',hsN:'notes'}[id]; S.hs[k] = e.target.value;
    const el = $('#hsSum'); if(el) el.textContent = S.hs.debut && S.hs.fin ? fmtDur(calcH(S.hs.debut,S.hs.fin,S.hs.pause)) : '--';
  }
});
const savedLogin = lsGet(LOGIN_KEY); if(savedLogin) $('#lid').value = savedLogin;
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#lbtn'); btn.disabled = true; $('#lerr').textContent = '';
  try{
    const login = $('#lid').value.trim();
    const r = await rpc('terrain_login',{p_login:login,p_pin:$('#lpin').value});
    if(!r || !r.ok){
      $('#lerr').textContent = r && r.erreur === 'compte_bloque' ? 'Trop d\'essais. Réessaie dans 15 minutes.' : 'Identifiant ou NIP incorrect.';
    } else {
      S.token = r.token; lsSet(TOKEN_KEY,null); ssSet(TOKEN_KEY,null);
      if($('#lremember').checked) lsSet(TOKEN_KEY,r.token); else ssSet(TOKEN_KEY,r.token);
      lsSet(LOGIN_KEY,login.toLowerCase());
      $('#lpin').value = '';
      await loadAll(); S.tab = 'punch'; S.wk = 0; render(); flush();
    }
  }catch(err){ $('#lerr').textContent = err.message || 'Erreur, réessaie.'; }
  btn.disabled = false;
});
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]'); if(!t) return;
  const a = t.dataset.act;
  if(a==='sheetclose'){ if(t.classList.contains('veil') && e.target!==t) return; S.sheet=false; S.hs=null; renderOverlay(true); return; }
  if(a==='lbclose'){ if(t.classList.contains('lb') && e.target!==t) return; S.lb=null; renderOverlay(true); return; }
  if(a==='retry'){ S.bootErr = null; S.loading = true; render(); boot(); return; }
  if(a==='reload'){ location.reload(); return; }
  if(a==='refresh'){ toast('Actualisation...'); await refresh(); toast(pending() ? 'Il reste des éléments à envoyer.' : 'À jour.'); return; }
  if(a==='logout'){
    const n = pending();
    if(n && !confirm(n+' élément'+(n>1?'s':'')+' pas encore envoyé'+(n>1?'s':'')+'. Ils partiront à ta prochaine connexion. Se déconnecter quand même?')) return;
    const tk = S.token; sessionLost(); if(tk) rpc('terrain_logout',{p_token:tk}).catch(()=>{}); return;
  }
  if(a==='tab'){ S.tab=t.dataset.tab; S.pid=null; render(); $('#view').scrollTop=0; return; }
  if(a==='wk'){ S.wk = Math.max(-2,Math.min(0,S.wk+Number(t.dataset.d))); render(); return; }
  if(a==='pick'){ S.pick=t.dataset.id; render(); return; }
  if(a==='in'){ if(S.open || !S.projets.length) return; S.sheet='start'; renderOverlay(true); return; }
  if(a==='startp'){
    if(S.open) return; const id = t.dataset.id;
    S.pick = id; S.open = {projetId:id,start:nowMs(),pauseMs:0,pauseStart:null}; S.sheet = false; renderOverlay(true); render();
    await queue('terrain_punch_in',{p_projet:id,p_at:S.open.start}); return;
  }
  if(a==='pausego'){
    if(!S.open || S.open.pauseStart) return; S.open.pauseStart = nowMs(); persist(); render();
    await queue('terrain_punch_pause',{p_at:S.open.pauseStart}); return;
  }
  if(a==='pauseend'){
    if(!S.open || !S.open.pauseStart) return; const n = nowMs();
    S.open.pauseMs = (S.open.pauseMs||0) + Math.max(0,n-S.open.pauseStart); S.open.pauseStart = null; persist(); render();
    await queue('terrain_punch_resume',{p_at:n}); return;
  }
  if(a==='xfer'){ if(!S.open || S.open.pauseStart) return; S.sheet='xfer'; renderOverlay(true); return; }
  if(a==='xferp'){
    if(!S.open) return; const o = S.open, n = nowMs(), id = t.dataset.id;
    if(id === o.projetId) return;
    const h = segment(o,n,Math.round(pauseTot(o,n)/60000),null);
    S.heures.push(h); S.pick = id; S.open = {projetId:id,start:n,pauseMs:0,pauseStart:null}; S.sheet=false; renderOverlay(true); render();
    toast('Projet changé. '+fmtDur(Number(h.heures))+' enregistrées sur le précédent.');
    await queue('terrain_punch_out',{p_id:h.id,p_pause:h.pause,p_notes:'',p_at:n});
    await queue('terrain_punch_in',{p_projet:id,p_at:n});
    return;
  }
  if(a==='out'){
    const n = nowMs(); S.sheet='out'; S.pause = S.open ? Math.round(pauseTot(S.open,n)/60000) : 0; S.note=''; S.endT = S.open && stale(S.open) ? '' : hm(new Date(n)); renderOverlay(true); return;
  }
  if(a==='outok'){
    if(!S.open) return;
    let f = endMs(S.endT);
    if(f == null){ toast('Entre l\'heure de fin.'); return; }
    if(f < S.open.start - 59999){ toast('L\'heure de fin doit être après le début.'); return; }
    f = Math.max(f, S.open.start);
    const h = segment(S.open,f,S.pause,S.note.trim()||null);
    S.heures.push(h); S.open = null; S.sheet = false; renderOverlay(true); render();
    toast('Punch terminé : '+fmtDur(Number(h.heures)));
    await queue('terrain_punch_out',{p_id:h.id,p_pause:S.pause,p_notes:S.note,p_at:f});
    return;
  }
  if(a==='hsnew'){
    S.hs = {id:null,projet:S.pick || (S.projets[0] && S.projets[0].id) || '',jour:iso(new Date()),debut:'07:00',fin:'16:00',pause:30,notes:''};
    S.sheet='hs'; renderOverlay(true); return;
  }
  if(a==='hsedit'){
    const h = S.heures.find(x=>x.id===t.dataset.id); if(!h) return;
    S.hs = {id:h.id,projet:h.projetId,jour:h.date,debut:h.debut,fin:h.fin,pause:Number(h.pause)||0,notes:h.notes||''};
    S.sheet='hs'; renderOverlay(true); return;
  }
  if(a==='hspause'){ if(S.hs){ S.hs.pause = Number(t.dataset.m); renderOverlay(true); } return; }
  if(a==='hssave'){
    const h = S.hs; if(!h) return;
    if(!h.projet){ toast('Choisis un projet.'); return; }
    if(!h.debut || !h.fin){ toast('Entre l\'heure de début et de fin.'); return; }
    if(h.debut === h.fin){ toast('Début et fin sont identiques.'); return; }
    const hrs = calcH(h.debut,h.fin,h.pause);
    const ex = h.id ? S.heures.find(x=>x.id===h.id) : null;
    const id = h.id || 'h'+uid();
    const row = {id,date:h.jour,projetId:h.projet,debut:h.debut,fin:h.fin,pause:h.pause,heures:hrs,notes:h.notes.trim()||null,modifie:ex ? true : false,manuel:ex ? !!ex.manuel : true};
    if(ex) Object.assign(ex,row); else S.heures.push(row);
    S.sheet=false; S.hs=null; renderOverlay(true); render();
    toast(ex ? 'Heures corrigées.' : 'Entrée ajoutée.');
    await queue('terrain_heure_save',{p_id:id,p_projet:row.projetId,p_jour:row.date,p_debut:row.debut,p_fin:row.fin,p_pause:row.pause,p_notes:row.notes || ''});
    return;
  }
  if(a==='hsdel'){
    const h = S.hs; if(!h || !h.id) return;
    if(!confirm('Supprimer cette entrée d\'heures?')) return;
    S.heures = S.heures.filter(x=>x.id!==h.id);
    S.sheet=false; S.hs=null; renderOverlay(true); render(); toast('Entrée supprimée.');
    await queue('terrain_heure_delete',{p_id:h.id});
    return;
  }
  if(a==='open'){ S.pid=t.dataset.id; S.sub='check'; S.tab='projets'; render(); $('#view').scrollTop=0; loadPhotos(S.pid); return; }
  if(a==='back'){ S.pid=null; render(); return; }
  if(a==='sub'){ S.sub=t.dataset.sub; render(); return; }
  const p = proj(S.pid);
  if(a==='ck' && p){
    const i = p.checklist.find(x=>x.id===t.dataset.id); if(!i) return;
    const val = t.checked;
    i.done = val; i.completedBy = val ? S.user.nom : null; i.completedAt = val ? Date.now() : null; render();
    await queue('terrain_checklist_set',{p_item:i.id,p_fait:val});
    return;
  }
  if(a==='ckadd' && p){
    const v = S.ckDraft.trim(); if(!v) return;
    const id = 'c'+uid();
    p.checklist.push({id,text:v,done:false,completedBy:null,completedAt:null}); S.ckDraft = ''; render();
    await queue('terrain_checklist_add',{p_projet:p.id,p_id:id,p_texte:v});
    return;
  }
  if(a==='shoot'){ S.photoFor='gallery'; $('#photoIn').click(); return; }
  if(a==='jshoot'){ S.photoFor='journal'; $('#photoIn').click(); return; }
  if(a==='jadd' && p){
    const v = S.jDraft.trim(); if(!v && !S.jPhoto) return;
    const id = 'j'+uid(), phId = S.jPhoto ? 'p'+uid() : null, ph = S.jPhoto;
    p.journal.push({id,author:S.user.nom,text:v,photoId:phId,createdAt:Date.now()});
    S.jDraft = ''; S.jPhoto = null; render();
    await queue('terrain_journal_add',{p_projet:p.id,p_id:id,p_texte:v,p_photo_id:phId,p_mini:ph ? ph.mini : null,p_src:ph ? ph.src : null});
    return;
  }
  if(a==='zoom' || a==='zoomj'){
    const f = photosOf(S.pid).find(x=>x.id===t.dataset.id); if(!f) return;
    S.lb = {id:f.id,mini:f.mini,src:f.src || null,mine:!!f.mine,confirm:false}; renderOverlay(true);
    if(!f.src){
      try{ const full = await rpc('terrain_photo',{p_token:S.token,p_id:f.id}); if(full && S.lb && S.lb.id === f.id){ S.lb.src = full; renderOverlay(true); } }catch(err){}
    }
    return;
  }
  if(a==='phdelask'){ if(S.lb){ S.lb.confirm = true; renderOverlay(true); } return; }
  if(a==='phdel'){
    if(!S.lb) return; const id = S.lb.id; S.lb = null; renderOverlay(true); render(); toast('Photo supprimée.');
    await queue('terrain_photo_delete',{p_id:id});
    return;
  }
});

/* ---------- Réseau, rafraîchissement, démarrage ---------- */
window.addEventListener('online',()=>{ updSync(); refresh(); });
window.addEventListener('offline',updSync);
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState !== 'visible') return;
  if(S.reg) S.reg.update().catch(()=>{});
  if(S.token && S.user && !S.sheet) refresh();
});
setInterval(() => { if(S.token && S.user && pending() && navigator.onLine !== false) flush(); }, 30000);

async function boot(){
  OUT = await DB.all();
  if(!S.token){ S.loading = false; render(); return; }
  const snap = readSnap();
  if(snap){
    S.user = snap.user; S.projets = snap.projets || []; S.heures = snap.heures || []; S.open = snap.open || null; S.skew = snap.skew || 0;
    S.loading = false; render(); refresh(); return;
  }
  try{ await loadAll(); S.loading = false; render(); flush(); }
  catch(e){
    S.loading = false;
    if(e.code === 'session'){ lsSet(TOKEN_KEY,null); ssSet(TOKEN_KEY,null); S.token = null; }
    else S.bootErr = e.code === 'reseau' ? 'Pas de réseau pour le moment. Vérifie ta connexion et réessaie.' : (e.message || 'Erreur de chargement.');
    render();
  }
}
if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(r => { S.reg = r; r.update().catch(()=>{}); }).catch(()=>{});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if(had) $('#updBar').hidden = false; });
}
boot();
})();
