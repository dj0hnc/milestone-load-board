'use strict';
/* Shell renderer: drives the connection bar + diagnostics + push modal, and bridges
   live NewMile data into the embedded board (board.html) via its hooks:
     window.__applyLiveData({today, dayMap:{3,4,5}, trucks})  and  window.__getPlan().

   Connection is MANUAL and in-app: Connect opens NewMile's sign-in inside the app
   (modal BrowserWindow handled by the main process), then Refresh pulls live data. */

const $ = s => document.querySelector(s);
const board = () => document.getElementById('board').contentWindow;
function toast(t){ const m=$('#msg'); m.textContent=t; m.classList.add('show'); clearTimeout(m._t); m._t=setTimeout(()=>m.classList.remove('show'),3000); }
/* Miley lives in the board's tab row (the animated 🤝 button) — see board.html addTopTabs.
   The shell just tells him to "think" while we sync NewMile, via board().__mileyThinking(). */
function mileyThink(on){ try{ board().__mileyThinking && board().__mileyThinking(!!on); }catch(e){} }

/* ---------- status ---------- */
function setStatus(st){
  const dot=$('#dot'); dot.className='dot ' + (st.connected?'on':'off');
  const who = st.connected && (st.user||st.org) ? `<span class="who">${[st.user,st.org].filter(Boolean).join(' · ')}</span>` : '';
  $('#stat').innerHTML = (st.connected ? 'Connected to NewMile'
                         : (st.error ? ('Disconnected — ' + shortErr(st.error)) : 'Disconnected')) + who;
  $('#btnConnect').style.display    = st.connected ? 'none' : (st.hasToken||st.hasClient ? 'none' : '');
  $('#btnReconnect').style.display  = st.connected ? 'none' : ((st.hasToken||st.hasClient) ? '' : 'none');
  $('#btnDisconnect').style.display = st.connected ? '' : 'none';
  $('#btnRefresh').disabled = !st.connected;
}
function shortErr(e){ e=String(e); if(e==='NOT_CONNECTED') return 'session expired, reconnect'; return e.length>48?e.slice(0,48)+'…':e; }

let lastConnected=false;
window.newmile.onStatus((st)=>{ setStatus(st); if(lastConnected && !st.connected) stopAuto(); lastConnected=st.connected; });
window.newmile.onLog((line)=>appendLog(line));

/* ---------- auto-updater banner ---------- */
window.newmile.onUpdate((u)=>{
  const b=$('#btnUpdate'); if(!b||!u) return;
  // hide the raw semver from users — show a clean "update available" instead
  b.textContent='⬇ Actualizar';
  b.title='Hay una versión más nueva. Click para bajar '+(u.assetName||'el nuevo archivo')+' a tu carpeta de Descargas.';
  b.style.display='';
  b.onclick=async ()=>{
    b.disabled=true; b.textContent='⬇ Bajando…';
    const r=await window.newmile.downloadUpdate();
    if(r&&r.ok){ b.textContent='✓ En Descargas'; toast('Actualización descargada — cierra la app y abre el archivo nuevo.'); }
    else { b.disabled=false; b.textContent='⬇ Actualizar'; toast('Bajada falló: '+((r&&r.error)||'desconocido')); }
  };
  toast('🆕 Hay una nueva versión disponible — click ⬇ Actualizar cuando quieras.');
});

/* ---------- diagnostics drawer ---------- */
function appendLog(line){
  const el=$('#log'); const div=document.createElement('div');
  if(/error|fail/i.test(line)) div.className='err'; else if(/connected|refreshed|pushed|confirmed/i.test(line)) div.className='ok';
  div.textContent=line; el.appendChild(div); el.scrollTop=el.scrollHeight;
  while(el.childNodes.length>400) el.removeChild(el.firstChild);
}
$('#btnDiag').onclick=async()=>{ $('#diag').classList.toggle('open'); if($('#diag').classList.contains('open')){ const logs=await window.newmile.logs(); $('#log').innerHTML=''; logs.forEach(appendLog); } };
$('#diagClose').onclick=()=>$('#diag').classList.remove('open');

/* ---------- ⚙ ADMIN settings (per-market Samsara keys, updater PAT) ----------
   Gated by an admin code (default 0605 — change it inside). Keys saved here live in
   the user's profile and OVERRIDE the bundled config, so every market runs its own
   Samsara org(s) without rebuilding the app. */
async function sha256(s){
  try{
    const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(s)));
    return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
  }catch(e){ return sha256js(String(s)); }   // pure-JS fallback — never fail silently
}
/* compact pure-JS SHA-256 (fallback when crypto.subtle is unavailable) */
function sha256js(ascii){
  function rr(v,a){return (v>>>a)|(v<<(32-a));}
  var mathPow=Math.pow,maxWord=mathPow(2,32),result='',words=[],asciiBitLength=ascii.length*8;
  var hash=sha256js.h=sha256js.h||[],k=sha256js.k=sha256js.k||[],primeCounter=k.length,isComposite={};
  for(var candidate=2;primeCounter<64;candidate++){
    if(!isComposite[candidate]){
      for(var i=0;i<313;i+=candidate)isComposite[i]=candidate;
      hash[primeCounter]=(mathPow(candidate,.5)*maxWord)|0;
      k[primeCounter++]=(mathPow(candidate,1/3)*maxWord)|0;
    }
  }
  ascii+='\x80'; while(ascii.length%64-56)ascii+='\x00';
  for(i=0;i<ascii.length;i++){var j=ascii.charCodeAt(i);if(j>>8)return '';words[i>>2]|=j<<((3-i)%4)*8;}
  words[words.length]=(asciiBitLength/maxWord)|0;words[words.length]=asciiBitLength;
  for(j=0;j<words.length;){
    var w=words.slice(j,j+=16),oldHash=hash.slice(0,8);
    for(i=0;i<64;i++){
      var w15=w[i-15],w2=w[i-2];
      var a=hash[0],e=hash[4];
      var temp1=hash[7]+(rr(e,6)^rr(e,11)^rr(e,25))+((e&hash[5])^(~e&hash[6]))+k[i]
        +(w[i]=(i<16)?w[i]:(w[i-16]+(rr(w15,7)^rr(w15,18)^(w15>>>3))+w[i-7]+(rr(w2,17)^rr(w2,19)^(w2>>>10)))|0);
      var temp2=(rr(a,2)^rr(a,13)^rr(a,22))+((a&hash[1])^(a&hash[2])^(hash[1]&hash[2]));
      hash=[(temp1+temp2)|0].concat(hash);hash[4]=(hash[4]+temp1)|0;
    }
    for(i=0;i<8;i++)hash[i]=(hash[i]+oldHash[i])|0;
  }
  for(i=0;i<8;i++)for(j=3;j+1;j--){var b=(hash[i]>>(j*8))&255;result+=((b>>4).toString(16))+((b&15).toString(16));}
  return result;
}
let adminUnlocked=false;
let globalUnlocked=false;   // the webmaster's code (global admin) — unlocks prices/FSC/orders + the keys panel
let wmReveal=false;
function dtab(which){
  $('#dtabLog').classList.toggle('on',which==='log');
  $('#dtabAdmin').classList.toggle('on',which==='admin');
  $('#log').style.display=which==='log'?'':'none';
  $('#adminPane').style.display=which==='admin'?'':'none';
  if(which==='admin') renderAdmin();
}
$('#dtabLog').onclick=()=>dtab('log');
$('#dtabAdmin').onclick=()=>dtab('admin');

// ⬇ Updates section — always visible at the top of Settings (no admin code needed to CHECK).
function updBlockHtml(){
  return '<h4>⬇ Updates</h4>'
    +'<div class="hint">Check GitHub for a newer version. If one is found you can download it, then run the new file.</div>'
    +'<button class="ghost" id="updCheck" style="width:100%">🔄 Check for updates</button>'
    +'<div id="updMsg" style="font-size:11.5px;margin-top:6px;color:var(--dim)"></div>'
    +'<div style="border-bottom:1px solid var(--line);margin:12px 0"></div>';
}
function wireUpdBtn(){
  const b=document.getElementById('updCheck'); if(!b||b._w) return; b._w=1;
  b.onclick=async()=>{
    const m=document.getElementById('updMsg'); m.style.color='var(--dim)'; m.textContent='Checking GitHub…'; b.disabled=true;
    try{
      const r=await window.newmile.checkUpdate();
      if(r&&r.update){
        m.style.color='var(--green)';
        m.innerHTML='🆕 v'+r.update.version+' available (you have '+(r.update.current||'')+'). <a href="#" id="updDl">⬇ Download now</a>';
        const dl=document.getElementById('updDl'); if(dl)dl.onclick=async(ev)=>{ ev.preventDefault(); m.style.color='var(--dim)'; m.textContent='Downloading…';
          const d=await window.newmile.downloadUpdate();
          m.style.color=(d&&d.ok)?'var(--green)':'var(--red)';
          m.textContent=(d&&d.ok)?'✓ Downloaded — folder opened. Close this app and run the new .exe.':('Download failed: '+((d&&d.error)||'unknown')); };
      } else if(r&&r.upToDate){ m.style.color='var(--green)'; m.textContent='✓ You have the latest version ('+(r.current||'')+').'; }
      else if(r&&r.error==='no-config'){ m.style.color='#e0a04b'; m.textContent='This build has no updater repo configured — download the newest .exe manually once.'; }
      else if(r&&r.error==='needs-token'){ m.style.color='#e0a04b'; m.textContent='Releases are private — paste a GitHub read-only token in Admin below, or ask the webmaster to make releases public.'; }
      else { m.style.color='var(--red)'; m.textContent='Could not check now'+(r&&r.error?(' ('+r.error+')'):'')+'.'; }
    }catch(e){ m.style.color='var(--red)'; m.textContent='Check failed: '+(e.message||e); }
    finally{ b.disabled=false; }
  };
}
async function renderAdmin(){
  const pane=$('#adminPane');
  if(!adminUnlocked){
    pane.innerHTML=updBlockHtml()+'<h4>🔒 Admin access</h4>'
      +'<div class="hint">Enter the admin code to manage this market\'s API keys and updater token.</div>'
      +'<input id="admCode" type="password" placeholder="Admin code" autocomplete="off">'
      +'<button class="warn" id="admUnlock" style="width:100%">Unlock</button>'
      +'<div id="admErr" style="color:var(--red);font-size:11px;margin-top:6px"></div>';
    const tryUnlock=async()=>{
      const code=$('#admCode').value.trim();
      // HIDDEN TRICK: the webmaster's global code unlocks EVERYTHING (prices/FSC/orders + keys panel).
      // Any other valid code (0605) only opens Settings. Same field — nobody knows the trick exists.
      try{ const g=await window.newmile.fuel('unlock',{code}); if(g&&g.ok){ adminUnlocked=true; globalUnlocked=true; try{ board().__fscTabVis&&board().__fscTabVis(); }catch(_e){} renderAdmin(); return; } }catch(_e){}
      try{
        const s=await window.newmile.getSettings();
        const want=s.adminHash||await sha256('0605');
        if(await sha256(code)===want){ adminUnlocked=true; renderAdmin(); }
        else $('#admErr').textContent='Wrong code.';
      }catch(e){ $('#admErr').textContent='Unlock error: '+(e.message||e); }
    };
    $('#admUnlock').onclick=tryUnlock;
    $('#admCode').addEventListener('keydown',e=>{ if(e.key==='Enter')tryUnlock(); });
    setTimeout(()=>$('#admCode').focus(),50);
    wireUpdBtn();
    return;
  }
  const s=await window.newmile.getSettings();
  const rows=(s.samsaraTokens&&s.samsaraTokens.length?s.samsaraTokens:[{name:'',token:''}]);
  pane.innerHTML=updBlockHtml()+'<h4>🏷 Market</h4>'
    +'<input id="admMarket" placeholder="e.g. Texas, Florida, Tampa HQ…" value="'+(s.market||'').replace(/"/g,'&quot;')+'">'
    +'<h4>🛰 Samsara API keys (this market\'s fleets)</h4>'
    +'<div class="hint">One row per Samsara org. Get keys at cloud.samsara.com → Settings → API Tokens (read-only + Media Retrieval). Keys saved here override the bundled ones — maps, dashcams, parking and driver messaging all run on YOUR fleet.'
    +(s.bundledTokens&&s.bundledTokens.length?('<br>Bundled defaults: '+s.bundledTokens.map(t=>t.name+(t.has?' ✓':' —')).join(' · ')):'')+'</div>'
    +'<div id="admToks">'+rows.map((t,i)=>admTokRow(t,i)).join('')+'</div>'
    +'<button class="ghost" id="admAddTok" style="width:100%;margin-bottom:4px">+ Add fleet key</button>'
    +'<h4>⬇ Auto-updater token (GitHub)</h4>'
    +'<div class="hint">Fine-grained PAT, Contents: Read-only, repo milestone-load-board. Lets the app announce new versions.</div>'
    +'<input id="admGh" type="password" placeholder="github_pat_…" value="'+(s.githubToken||'').replace(/"/g,'&quot;')+'">'
    +'<h4>🤖 AI Copilot key (Anthropic)</h4>'
    +'<div class="hint">Anthropic API key (console.anthropic.com). Turns on the 🤖 Copilot tab — read-only chat over your live board. Pay-per-use. Leave empty to keep it off.</div>'
    +'<input id="admAi" type="password" placeholder="sk-ant-…" value="'+(s.aiKey||'').replace(/"/g,'&quot;')+'">'
    +'<h4>🔑 Change admin code</h4>'
    +'<input id="admNewCode" type="password" placeholder="New code (leave empty to keep current)">'
    +'<button class="warn" id="admSave" style="width:100%;margin-top:8px">💾 Save settings</button>'
    +'<div id="admMsg" style="font-size:11px;margin-top:6px"></div>';
  $('#admAddTok').onclick=()=>{ $('#admToks').insertAdjacentHTML('beforeend',admTokRow({name:'',token:''},Date.now())); wireTokRows(); };
  wireTokRows(); wireUpdBtn();
  $('#admSave').onclick=async()=>{
    const toks=Array.from(document.querySelectorAll('#admToks .tokrow')).map(r=>({
      name:r.querySelector('.tname').value.trim(), token:r.querySelector('.ttok').value.trim()
    })).filter(t=>t.name||t.token);
    const out={ market:$('#admMarket').value.trim(), samsaraTokens:toks, githubToken:$('#admGh').value.trim(), aiKey:$('#admAi').value.trim(), adminHash:s.adminHash||'' };
    const nc=$('#admNewCode').value.trim();
    if(nc) out.adminHash=await sha256(nc);
    const res=await window.newmile.saveSettings(out);
    $('#admMsg').style.color=res&&res.ok?'var(--green)':'var(--red)';
    $('#admMsg').textContent=res&&res.ok?'✓ Saved — new keys are live (refresh to repull Samsara data).':('Save failed: '+((res&&res.error)||'unknown'));
    if(res&&res.ok) toast('⚙ Settings saved — '+toks.filter(t=>t.token).length+' Samsara key(s) active');
  };
  if(globalUnlocked){ pane.insertAdjacentHTML('beforeend','<div id="wmKeys" style="margin-top:14px;border-top:1px solid var(--line);padding-top:10px"></div>'); renderWmKeys(); }
}
// 🔐 Webmaster keys panel — only rendered when the GLOBAL code was used. Shows accesses + API keys
// (masked, with a reveal toggle) for the session. Lives INSIDE Settings (no separate visible entry).
async function renderWmKeys(){
  const box=document.getElementById('wmKeys'); if(!box) return;
  let w={}; try{ w=await window.newmile.fuel('status',{reveal:wmReveal})||{}; }catch(e){}
  const row=(k,v)=>'<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid var(--line);font-size:12.5px"><span style="color:var(--dim)">'+k+'</span><b style="word-break:break-all;text-align:right">'+String(v==null?'—':v).replace(/</g,'&lt;')+'</b></div>';
  box.innerHTML='<h4>🔐 Webmaster — accesses &amp; API keys</h4>'
    +'<div class="hint">'+(wmReveal?'⚠ Showing FULL keys — don\'t share the screen.':'Keys masked (last 4).')+' Global admin is ACTIVE for this session.</div>'
    +row('NewMile',(w.newmile&&w.newmile.connected)?('✓ '+(w.newmile.user||'')+(w.newmile.org?(' · '+w.newmile.org):'')):'no')
    +row('NewMile token',(w.newmile&&w.newmile.token)||'—')
    +((w.samsara||[]).map(s=>row('Samsara · '+s.fleet,s.key)).join(''))
    +row('EIA (diesel)',(w.eia&&w.eia.key)||'—')
    +row('GitHub updater',((w.github&&w.github.repo)||'—')+' · '+((w.github&&w.github.token)||'—'))
    +'<button class="ghost" id="wmReveal" style="width:100%;margin-top:8px">'+(wmReveal?'🙈 Hide keys':'👁 Show full keys')+'</button>'
    +'<button class="ghost" id="wmLock" style="width:100%;margin-top:4px">🔒 Lock global admin now</button>';
  document.getElementById('wmReveal').onclick=()=>{ if(!wmReveal){ if(!confirm('Show the FULL API keys?\n\nMake sure nobody else sees the screen.'))return; wmReveal=true; } else wmReveal=false; renderWmKeys(); };
  document.getElementById('wmLock').onclick=async()=>{ try{ await window.newmile.fuel('lock'); }catch(e){} globalUnlocked=false; wmReveal=false; try{ board().__fscTabVis&&board().__fscTabVis(); board().closeTab&&board().closeTab('fsc'); }catch(e){} renderAdmin(); toast('🔒 Global admin locked'); };
}
function admTokRow(t,i){
  return '<div class="tokrow">'
    +'<input class="tname" placeholder="Fleet name" value="'+String(t.name||'').replace(/"/g,'&quot;')+'">'
    +'<input class="ttok" type="password" placeholder="samsara_api_…" value="'+String(t.token||'').replace(/"/g,'&quot;')+'">'
    +'<button class="ghost admTest" title="Verify this key against Samsara right now">🧪</button>'
    +'<button class="ghost admDel">✕</button></div>'
    +'<div class="hint admTestOut" style="margin:-2px 0 6px"></div>';
}
function wireTokRows(){
  document.querySelectorAll('#admToks .admDel').forEach(b=>{ b.onclick=()=>{ const r=b.closest('.tokrow'); const o=r.nextElementSibling; if(o&&o.classList.contains('admTestOut'))o.remove(); r.remove(); }; });
  document.querySelectorAll('#admToks .admTest').forEach(b=>{ b.onclick=async()=>{
    const row=b.closest('.tokrow');
    const out=row.nextElementSibling;
    const tok=row.querySelector('.ttok').value.trim();
    row.querySelector('.ttok').value=tok;                       // kill pasted spaces/newlines
    out.textContent='🧪 testing…'; out.style.color='var(--dim)';
    try{
      const r=await window.newmile.testSamsara(tok);
      if(r&&r.ok){ out.textContent='✓ Key works — '+r.vehicles+' vehicles ('+r.withGps+' with GPS)'; out.style.color='var(--green)'; }
      else { out.textContent='✗ '+((r&&r.error)||'failed'); out.style.color='var(--red)'; }
    }catch(e){ out.textContent='✗ '+(e.message||e); out.style.color='var(--red)'; }
  };});
}

/* ---------- auto-refresh ---------- */
let autoSecs=0, autoLeft=0, autoTimer=null;
function stopAuto(){ if(autoTimer){ clearInterval(autoTimer); autoTimer=null; } $('#next').textContent=''; }
function startAuto(){
  stopAuto(); if(!autoSecs) return; autoLeft=autoSecs;
  autoTimer=setInterval(async()=>{
    const st=await window.newmile.status();
    if(!st.connected){ $('#next').textContent='paused'; return; }
    autoLeft--;
    if(autoLeft<=0){ autoLeft=autoSecs; snapToday(); await refreshDay(); }
    const m=Math.floor(autoLeft/60), s=autoLeft%60;
    $('#next').textContent='next '+(m?m+'m':'')+(s<10?'0':'')+s+'s';
  },1000);
}
function setAuto(secs){ autoSecs=secs|0; try{localStorage.setItem('nm_auto',String(autoSecs));}catch(e){} if(autoSecs) startAuto(); else stopAuto(); }

/* ---------- wiring ---------- */
function localISO(){ const d=new Date(),p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
/* The Day picker follows TODAY automatically (launch, window focus, every auto-refresh
   tick) unless the user explicitly picked another date this session. */
let dayManual=false;
function snapToday(){
  const t=localISO();
  if(!dayManual && $('#day').value!==t){ $('#day').value=t; return true; }
  return false;
}

window.addEventListener('DOMContentLoaded', async ()=>{
  $('#day').value=localISO();
  $('#day').addEventListener('change',()=>{ dayManual=true; });
  try{ const cfg=await window.newmile.config(); groupsCfg=(cfg&&cfg.groups)||null; }catch(e){}
  try{ const v=await window.newmile.version(); if(v)$('#appVer').textContent='Edición '+v; }catch(e){}   // calendar label, not the raw count
  // tap the version → force a "look for update now" (otherwise it only checks at launch + every 4h)
  try{ const av=$('#appVer'); if(av&&!av._wired){ av._wired=1; av.style.cursor='pointer'; av.title='Click para buscar actualización'; av.onclick=async()=>{ toast('Buscando actualización…'); try{ const r=await window.newmile.checkUpdate(); if(r&&r.update){ toast('🆕 Hay una versión nueva — usa ⬇ Actualizar'); } else if(r&&r.upToDate){ toast('✓ Ya tienes la última versión'); } else if(r&&r.error==='no-config'){ toast('Este build no trae el auto-updater — baja el .exe nuevo una vez del repo',true); } else { toast('No se pudo verificar ahora',true); } }catch(e){ toast('Update check falló: '+(e.message||e),true); } }; } }catch(e){}
  try{ const z=parseFloat(localStorage.getItem('mab_zoom')||'1'); if(z!==1) window.newmile.zoom(z); }catch(e){}
  setStatus(await window.newmile.status());

  // auto-resume + auto-load: open the app → see TODAY, no clicks needed
  try{
    const r=await window.newmile.resume();      // silent only — never pops the sign-in
    if(r&&r.connected){ setStatus(r); toast('Session resumed — loading today…'); refreshDay(); }
  }catch(e){}

  window.addEventListener('focus', async ()=>{
    if(snapToday()){
      const st=await window.newmile.status();
      if(st.connected){ toast('New day — refreshing '+$('#day').value); refreshDay(); }
    }
  });

  $('#btnConnect').onclick=$('#btnReconnect').onclick=async()=>{
    $('#dot').className='dot busy'; $('#stat').textContent='Opening NewMile sign-in…';
    try{ setStatus(await window.newmile.connect()); toast('Connected. Hit Refresh to pull the day.'); }
    catch(e){ setStatus(await window.newmile.status()); toast('Connect failed: '+(e.message||e)); }
  };
  $('#btnDisconnect').onclick=async()=>{ stopAuto(); setStatus(await window.newmile.disconnect()); toast('Disconnected.'); };
  $('#btnRefresh').onclick=refreshDay;

  // Board → shell bridge: push handoff + dashcam snapshot requests.
  window.addEventListener('message', async (e)=>{
    if(!e || !e.data) return;
    if(e.data==='openPush'){
      const st=await window.newmile.status();
      if(!st.connected){ toast('Connect to NewMile first, then push.'); return; }
      openPush();
      return;
    }
    if(e.data.type==='route' && e.data.reqId){
      try{
        const res=await window.newmile.route({from:e.data.from,to:e.data.to,fromCoords:e.data.fromCoords,toCoords:e.data.toCoords});
        board().__routeResult && board().__routeResult(e.data.reqId,res);
      }catch(err){ board().__routeResult && board().__routeResult(e.data.reqId,{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='hos' && e.data.reqId){
      try{ const res=await window.newmile.hos(); board().__hosResult && board().__hosResult(e.data.reqId,res); }
      catch(err){ board().__hosResult && board().__hosResult(e.data.reqId,{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='geocode' && e.data.reqId){
      try{ const res=await window.newmile.geocode(e.data.q); board().__geoResult && board().__geoResult(e.data.reqId,res); }
      catch(err){ board().__geoResult && board().__geoResult(e.data.reqId,null); }
      return;
    }
    if(e.data.type==='ai' && e.data.reqId){
      try{ const res=await window.newmile.ai({messages:e.data.messages,context:e.data.context}); board().__aiResult && board().__aiResult(e.data.reqId,res); }
      catch(err){ board().__aiResult && board().__aiResult(e.data.reqId,{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='calc' && e.data.reqId){
      try{ const res=await window.newmile.calc(e.data.name,e.data.args); board().__calcResult && board().__calcResult(e.data.reqId,res); }
      catch(err){ board().__calcResult && board().__calcResult(e.data.reqId,{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='oncall' && Array.isArray(e.data.list)){
      try{
        const res=await window.newmile.setOnCall(e.data.list);
        board().__tmResult && board().__tmResult('oncall',res);
        appendLog('truck-manager: on/off-call → '+res.filter(x=>x.ok).length+'/'+res.length+' ok');
      }catch(err){ board().__tmResult && board().__tmResult('oncall',{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='reassign'){
      try{
        const d=e.data;
        const useDefault=isOrderDefault({disp:d.disp||'',material:d.material||''});
        const push=await window.newmile.pushOrder({orderId:d.orderId, assignments:d.assignments, useOrderDefault:useDefault});
        let del=[];
        if((push.created||[]).length && (d.deleteIds||[]).length){
          del=await window.newmile.deleteAssignments(d.deleteIds);
        }
        board().__tmResult && board().__tmResult('reassign',{push:push,deleted:del});
        appendLog('truck-manager: reassign → +'+(push.created||[]).length+' created · '+del.filter(x=>x.ok).length+' old removed');
        refreshDay();
      }catch(err){ board().__tmResult && board().__tmResult('reassign',{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='refresh'){ refreshDay(); return; }
    if(e.data.type==='msgdock'){
      if(typeof e.data.translate==='boolean') wvMsgTrans=e.data.translate;
      dockMsg(e.data.off?null:e.data.rect);
      return;
    }
    if(e.data.type==='msgreload'){ try{ wvMsg&&wvMsg.reload(); }catch(err){} return; }
    if(e.data.type==='msgzoom'){
      try{
        let z=parseFloat(localStorage.getItem('mab_msg_zoom')||'1');
        z=e.data.dir==='0'?1:Math.min(1.8,Math.max(0.5,z+(e.data.dir==='+'?0.1:-0.1)));
        localStorage.setItem('mab_msg_zoom',String(z));
        wvMsg&&wvMsg.setZoomFactor(z);
        toast('💬 zoom '+Math.round(z*100)+'%');
      }catch(err){}
      return;
    }
    if(e.data.type==='zoom'){ appZoom(e.data.dir); return; }
    // Excel/plan + rotation bridges — the board iframe has no window.newmile, so it asks the shell.
    if(e.data.type==='readPlan' && e.data.reqId){
      try{ const res=await window.newmile.readPlan(e.data.dateISO); board().__nmResult && board().__nmResult(e.data.reqId,res); }
      catch(err){ board().__nmResult && board().__nmResult(e.data.reqId,{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='pickPlanFile' && e.data.reqId){
      try{ const res=await window.newmile.pickPlanFile(e.data.dateISO); board().__nmResult && board().__nmResult(e.data.reqId,res); }
      catch(err){ board().__nmResult && board().__nmResult(e.data.reqId,{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='updateOrderQty' && e.data.reqId){
      try{ const res=await window.newmile.updateOrderQty(e.data.orderId,e.data.quantity,e.data.flex); board().__nmResult && board().__nmResult(e.data.reqId,res); }
      catch(err){ board().__nmResult && board().__nmResult(e.data.reqId,{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='fuel' && e.data.reqId){
      try{ const res=await window.newmile.fuel(e.data.op,e.data.args); board().__nmResult && board().__nmResult(e.data.reqId,res); }
      catch(err){ board().__nmResult && board().__nmResult(e.data.reqId,{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='rotationHistory' && e.data.reqId){
      try{ const res=await window.newmile.rotationHistory(e.data.date,e.data.days); board().__nmResult && board().__nmResult(e.data.reqId,res); }
      catch(err){ board().__nmResult && board().__nmResult(e.data.reqId,{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='projtrucks' && e.data.reqId){
      try{
        const res=await window.newmile.projectTrucks({projectId:e.data.projectId,excludeOrderId:e.data.excludeOrderId});
        board().__projTrucksResult && board().__projTrucksResult(e.data.reqId,res);
      }catch(err){ board().__projTrucksResult && board().__projTrucksResult(e.data.reqId,{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='msgtrans'){
      wvMsgTrans=!!e.data.on;
      try{ wvMsg&&wvMsg.executeJavaScript('window.__nmTransEnabled='+(wvMsgTrans?'true':'false')+';'); }catch(err){}
      return;
    }
    if(e.data.type==='drivers'){
      try{ const res=await window.newmile.drivers(); board().__driversResult&&board().__driversResult(res||[]); }
      catch(err){ board().__driversResult&&board().__driversResult([]); }
      return;
    }
    if(e.data.type==='sendmsg' && e.data.reqId){
      try{ const res=await window.newmile.sendDriverMsg({driverId:e.data.driverId,tok:e.data.tok,text:e.data.text});
        board().__sendMsgResult&&board().__sendMsgResult(e.data.reqId,res); }
      catch(err){ board().__sendMsgResult&&board().__sendMsgResult(e.data.reqId,{error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='directory'){
      try{
        const st=await window.newmile.status();
        if(!st.connected){ board().__directoryResult&&board().__directoryResult({error:'Connect to NewMile first'}); return; }
        const res=await window.newmile.directory();
        board().__directoryResult && board().__directoryResult(res||{error:'no data'});
      }catch(err){ board().__directoryResult && board().__directoryResult({error:String(err&&err.message||err)}); }
      return;
    }
    if(e.data.type==='camera' && e.data.num){
      const num=e.data.num;
      appendLog('camera: requesting dashcam snapshot for '+num+' (30-60s)');
      try{
        const res=await window.newmile.camera(num);
        try{ board().__snapshotResult && board().__snapshotResult(num, res||{error:'no response'}); }catch(e2){}
        appendLog('camera: '+num+' → '+(res&&res.url?'image ready':''+(res&&res.error||'failed')));
      }catch(err){
        try{ board().__snapshotResult && board().__snapshotResult(num, {error:(err&&err.message)||String(err)}); }catch(e2){}
      }
    }
  });

  $('#pushX').onclick=$('#pushCancel').onclick=closePush;
  $('#pushAll').onclick=()=>runPush(null);

  let saved=0; try{ saved=parseInt(localStorage.getItem('nm_auto')||'0',10)||0; }catch(e){}
  $('#auto').value=String(saved); $('#auto').onchange=(e)=>setAuto(parseInt(e.target.value,10)||0);
  if(saved) setAuto(saved);
});

/* ---------- 🔍 app-wide zoom (Ctrl + / − / 0) — persisted ---------- */
async function appZoom(dir){
  let z=parseFloat(localStorage.getItem('mab_zoom')||'1');
  z=dir==='0'?1:Math.min(2,Math.max(0.5,Math.round((z+(dir==='+'?0.1:-0.1))*10)/10));
  localStorage.setItem('mab_zoom',String(z));
  await window.newmile.zoom(z);
  toast('🔍 zoom '+Math.round(z*100)+'%');
}
window.addEventListener('keydown',(e)=>{
  if(!(e.ctrlKey||e.metaKey)) return;
  if(e.key==='='||e.key==='+'){ e.preventDefault(); appZoom('+'); }
  else if(e.key==='-'){ e.preventDefault(); appZoom('-'); }
  else if(e.key==='0'){ e.preventDefault(); appZoom('0'); }
});
window.addEventListener('wheel',(e)=>{
  if(!e.ctrlKey) return; e.preventDefault();
  appZoom(e.deltaY<0?'+':'-');
},{passive:false});

/* ---------- 💬 messaging webview ----------
   Lives HERE in the main frame — Electron does not render <webview> inside iframes,
   so the board (an iframe) sends us its tab rectangle and we dock the webview over it. */
let wvMsg=null, wvMsgTrans=true;
function ensureWvMsg(){
  if(wvMsg) return wvMsg;
  wvMsg=document.createElement('webview');
  wvMsg.id='wvMsg';
  wvMsg.setAttribute('partition','persist:newmile-auth');
  wvMsg.setAttribute('src','https://app.newmile.com/messaging');
  wvMsg.style.cssText='position:fixed;left:-12000px;top:48px;width:1080px;height:680px;z-index:45;border:0;background:#fff';
  document.body.appendChild(wvMsg);
  wvMsg.addEventListener('dom-ready',()=>{ injectTranslator(); });
  setInterval(pollMsg,8000);
  appendLog('messaging webview mounted (persist:newmile-auth)');
  return wvMsg;
}
function dockMsg(rect){
  ensureWvMsg();
  if(!rect){ wvMsg.style.left='-12000px'; return; }
  const off=document.getElementById('board').getBoundingClientRect();
  wvMsg.style.left=Math.round(off.left+rect.left)+'px';
  wvMsg.style.top =Math.round(off.top +rect.top )+'px';
  wvMsg.style.width=Math.round(rect.width)+'px';
  wvMsg.style.height=Math.round(rect.height)+'px';
}
async function pollMsg(){
  if(!wvMsg) return;
  try{
    const res=await wvMsg.executeJavaScript('(function(){try{var b=document.querySelector("#messaging-menu-unread-count");var n=b?(parseInt((b.textContent||"").trim(),10)||0):0;var l=document.querySelector("[class*=conversation],[id*=conversation]");return {n:n,fp:String(l?l.innerText:document.title).slice(0,300)};}catch(e){return {n:0,fp:"err"};}})()',true);
    if(res){ try{ board().__msgStatus && board().__msgStatus(res); }catch(e){} }
  }catch(e){}
}
function injectTranslator(){
  if(!wvMsg) return;
  const en=wvMsgTrans?'true':'false';
  const js=''
  +'(function(){if(window.__nmTransInstalled)return;window.__nmTransInstalled=1;window.__nmTransEnabled='+en+';'
  +'var cache={},queue=[],busy=false;'
  +'function looksSpanish(s){return /[áéíóúñ¿¡]/i.test(s)||/\\b(el|la|los|las|para|por|pero|donde|cuando|porque|necesito|cargar|carga|cargas|viaje|llego|llegando|estoy|voy|ya|mañana|ahorita|trabajo|camion|troca|gracias|buenos dias|buenas)\\b/i.test(s);}'
  +'function work(){if(busy||!queue.length)return;busy=true;var it=queue.shift();'
  +'fetch("https://api.mymemory.translated.net/get?langpair=es|en&q="+encodeURIComponent(it.text.slice(0,450)))'
  +'.then(function(r){return r.json();}).then(function(j){var tr=j&&j.responseData&&j.responseData.translatedText;'
  +'if(tr&&tr.toLowerCase()!==it.text.toLowerCase()){cache[it.text]=tr;var d=document.createElement("div");'
  +'d.className="nm-trans";d.textContent="\\u2192 "+tr;d.style.cssText="font-size:11px;color:#5a95f9;opacity:.85;margin-top:2px;font-style:italic";'
  +'if(window.__nmTransEnabled)it.el.appendChild(d);else d.remove();}'
  +'busy=false;setTimeout(work,650);}).catch(function(){busy=false;setTimeout(work,1200);});}'
  +'function scan(){if(!window.__nmTransEnabled)return;'
  +'document.querySelectorAll("div,p,span").forEach(function(el){'
  +'if(el.dataset.nmtr||el.children.length>1||el.querySelector(".nm-trans"))return;'
  +'var s=(el.textContent||"").trim();'
  +'if(s.length<8||s.length>400||!looksSpanish(s))return;'
  +'el.dataset.nmtr=1;'
  +'if(cache[s]){var d=document.createElement("div");d.className="nm-trans";d.textContent="\\u2192 "+cache[s];'
  +'d.style.cssText="font-size:11px;color:#5a95f9;opacity:.85;margin-top:2px;font-style:italic";el.appendChild(d);return;}'
  +'queue.push({text:s,el:el});work();});}'
  +'new MutationObserver(function(){clearTimeout(window.__nmTd);window.__nmTd=setTimeout(scan,800);}).observe(document.body,{childList:true,subtree:true});'
  +'setTimeout(scan,1500);})();';
  try{ wvMsg.executeJavaScript(js); }catch(e){}
}

/* ---------- finalized-on-board queue → NewMile (auto-sync) ---------- */
function getPendingSync(){
  try{ return (board().__getPendingSync && board().__getPendingSync())||[]; }catch(e){ return []; }
}
function clearPendingSync(ids){ try{ board().__clearPendingSync && board().__clearPendingSync(ids); }catch(e){} }

async function autoSync(){
  const pend=getPendingSync();
  if(!pend.length) return 0;
  // o.finalize = the dispatcher chose to finalize this one; everything else syncs as DRAFT.
  // The auto-sync NEVER finalizes on its own — drafts stay drafts until the dispatcher clicks Finalize.
  const draftN=pend.filter(o=>!o.finalize).length, finN=pend.length-draftN;
  $('#stat').textContent='Syncing '+draftN+' draft'+(finN?' + '+finN+' finalize':'')+' → NewMile…';
  let done=0, fin=0; const doneIds=[];
  for(const o of pend){
    try{
      const useDefault=isOrderDefault(o);
      const asg=o.assignments.filter(a=>!/ATX Bluewing/i.test(a.truck));
      const r=await window.newmile.pushOrder({orderId:o.order_id, assignments:asg, useOrderDefault:useDefault, removed:(o.removed||[]), finalize:!!o.finalize});
      done++; if(o.finalize)fin++; doneIds.push(o.order_id);
      appendLog('auto-sync '+o.order_id+' ('+(o.disp||'')+') '+(o.finalize?'[FINALIZE]':'[draft]')+': +'+(r.created||[]).length+' new · ~'+(r.updated||[]).length+' updated · −'+(r.removed||[]).length+' removed · ='+(r.skipped||[]).length+' untouched');
    }catch(e){ toast('Auto-sync order '+o.order_id+' failed: '+(e.message||e)); appendLog('auto-sync '+o.order_id+' FAILED: '+(e.message||e)); }
  }
  clearPendingSync(doneIds);
  // end-of-sync: make NewMile's per-truck sequence match the board exactly (creates can't set
  // ordinal, so this corrects any drift). Best-effort — never blocks or fails the sync.
  if(done){
    try{
      const intent=(board().__getSeqIntent&&board().__getSeqIntent())||{};
      if(Object.keys(intent).length){
        const rc=await window.newmile.reconcileSeq(intent);
        if(rc&&rc.reordered&&rc.reordered.length) appendLog('reconcile: fixed sequence for '+rc.reordered.length+' truck(s) → '+rc.reordered.join(', '));
      }
    }catch(e){ appendLog('reconcile skipped: '+(e.message||e)); }
  }
  if(done) toast('✓ Synced '+(done-fin)+' draft'+(fin?' · finalized '+fin:'')+' to NewMile');
  return done;
}

/* ---------- live full sync -> board ---------- */
async function refreshDay(){
  const date=$('#day').value; if(!date) return;
  $('#dot').className='dot busy'; $('#stat').textContent='Syncing '+date+' with NewMile…';
  mileyThink(true);
  try{
    await autoSync();   // finalized board changes go OUT first, then we pull the truth back
    const all=await window.newmile.refreshAll(date);   // Y/T/Tm orders + roster + rotation + live assignments
    const worked=workedSet(all.tickets||[]);
    const trucksMapped=dedupeTrucks(all.trucks||[]).map(t=>mapTruck(t,worked));
    const numToId={}; trucksMapped.forEach(t=>{ numToId[t.num.trim().toLowerCase()]=t.id; });
    const asg=all.assignments||{};
    const onotes=all.orderNotes||{};
    const payload={
      today:date,
      dayMap:{
        3:(all.orders.y ||[]).map(o=>mapOrder(o, asg[o.id], numToId, onotes[o.id])),
        4:(all.orders.t ||[]).map(o=>mapOrder(o, asg[o.id], numToId, onotes[o.id])),
        5:(all.orders.tm||[]).map(o=>mapOrder(o, asg[o.id], numToId, onotes[o.id]))
      },
      trucks:trucksMapped,
      priorDay:all.priorDay
    };
    // deadhead data: pickup coords on orders + Samsara parking position on trucks
    const pc=all.pickupCoords||{}, dc=all.dropCoords||{}, om=all.orderMeta||{};
    [4,5].forEach(k=>payload.dayMap[k].forEach(o=>{
      const id=parseInt((''+o.id).replace(/^o/,''),10);
      const c=pc[id]; if(c){ o.pickupLat=c.lat; o.pickupLng=c.lng; if(c.addr)o.pickupAddr=c.addr; }
      const d=dc[id]; if(d){ o.dropLat=d.lat; o.dropLng=d.lng; if(d.addr)o.dropAddr=d.addr; }
      const m=om[id]; if(m&&m.project_id){ o.projectId=m.project_id; }
    }));
    try{
      const snap=await window.newmile.samsara();   // 5-min cached in main; reused by move-check
      if(snap&&Object.keys(snap).length){
        payload.trucks.forEach(t=>{
          const g=snap[t.num.trim().toUpperCase().replace(/\s+/g,' ')];
          if(g&&g.lat!=null){ t.lat=g.lat; t.lon=g.lon; t.mph=g.speed||0; t.gpsTime=g.time||null; }
        });
      }
    }catch(e){ appendLog('samsara position attach skipped: '+(e.message||e)); }
    // live "rolling": any of TODAY's assignments with an active load_status or loads done.
    // Also keep the live LOAD details (status string + done/limit + which order) so the board
    // can tell "última carga" / "driving to dropoff" apart — same states as the mobile app.
    const rollingNums=new Set();
    const liveLoad={};   // truckNum(lower) -> {load, done, limit, oid}
    (all.orders.t||[]).forEach(o=>{ (asg[o.id]||[]).forEach(r=>{
      const k=(r.truck_number||'').trim().toLowerCase(); if(!k) return;
      if(r.load_status || (r.load_count||0)>0){
        rollingNums.add(k);
        // a row carrying an actual load_status string wins over one that's merely "has loads done"
        if(r.load_status || !liveLoad[k]) liveLoad[k]={ load:String(r.load_status||'').toLowerCase(), done:(r.load_count||0), limit:(r.load_limit==null?null:r.load_limit), oid:o.id };
      }
    });});
    payload.trucks.forEach(t=>{ const k=t.num.trim().toLowerCase();
      if(rollingNums.has(k)) t.status='rolling';
      const lv=liveLoad[k]; if(lv){ t.loadStatus=lv.load; t.loadDone=lv.done; t.loadLimit=lv.limit; t.loadOid=lv.oid; }
    });
    board().__applyLiveData(payload);
    try{ board().__priorDay=all.priorDay; board().render&&board().render(); }catch(e){}
    try{ await samsaraMoveCheck(payload, date); }catch(e){ appendLog('samsara check skipped: '+(e.message||e)); }
    const liveAsg=Object.values(asg).reduce((n,a)=>n+(a?a.length:0),0);
    setStatus(await window.newmile.status());
    if(autoSecs) autoLeft=autoSecs;
    toast('Synced '+date+' · today '+payload.dayMap[4].length+' / tomorrow '+payload.dayMap[5].length+' orders · '+liveAsg+' live assignments · rotation from '+all.priorDay);
    mileyThink(false);
  }catch(e){ setStatus(await window.newmile.status()); mileyThink(false); toast('Refresh failed: '+(e.message||e)); }
}

/* ---------- mappers (NewMile shape -> board shape) ---------- */
function num(v){ const n=parseFloat(v); return isNaN(n)?0:n; }
function hourFromStart(s){ try{ const h=parseInt(String(s).slice(11,13),10); return isNaN(h)?4:h; }catch(e){return 4;} }
function ampm(h){ const x=h%12||12; return x+':00 '+(h<12?'AM':'PM'); }
function unitOf(o){
  const u=(o.quantity_measurement_unit||'').toLowerCase();
  if(u==='ton'||u==='load'||u==='hour') return u;
  const m=(o.material_name||'').toLowerCase(), ht=(o.haul_type||'').toLowerCase();
  if(m.indexOf('hourly')>=0||m.indexOf('onsite hauling')>=0||(ht==='onsite'&&m.indexOf('asphalt')>=0)) return 'hour';
  if(m==='milk'||m.indexOf('fill dirt')>=0||ht==='export') return 'load';
  return 'ton';
}
function statusOf(s){ if(s==='paused') return 'paused'; if(s==='pending') return 'pending'; return 'active'; }
/* Map NewMile order_assignment rows into the board's assigns shape.
   Only trucks that resolve in the roster become chips (others still count via o.nm). */
function mapAssigns(rows, numToId, unit){
  const out=[];
  (rows||[]).forEach(r=>{
    const tid=numToId[(r.truck_number||'').trim().toLowerCase()];
    if(!tid) return;
    // driver ON THIS assignment (an org can run several drivers) + whether NewMile still needs one
    const driver=(r.driver_name||'').trim();
    const noDriver=(String(r.assignment_status||'').toLowerCase()==='missing_driver')||!driver;
    const base={driver:driver, driverId:r.driver_id||null, noDriver:noDriver,
      pay:(r.truck_pay_rate!=null?num(r.truck_pay_rate):null), payUnit:(r.truck_pay_rate_measurement_unit||''), rateSrc:(r.rate_source||''),
      // live assignment state for the chip status badge (mirrors mobile): load > offer > lifecycle
      astatus:String(r.assignment_status||'').toLowerCase(), offer:String(r.offer_status||'').toLowerCase(), load:String(r.load_status||'').toLowerCase()};
    if(unit==='hour'){ out.push(Object.assign({truck:tid, ll:'hourly', done:Math.round(num(r.hours_worked)), seq:r.ordinal||1, aid:r.id}, base)); }
    else { out.push(Object.assign({truck:tid, ll:(r.load_limit==null?'open':r.load_limit), done:r.load_count||0, seq:r.ordinal||1, aid:r.id}, base)); }
  });
  return out;
}
function mapOrder(o, asgRows, numToId, nmNotes){
  const h=hourFromStart(o.start_date), nm=o.assignment_count||0, unit=unitOf(o);
  const target=Math.round(num(o.quantity_requested)), deliv=num(o.weight_delivered);
  const assigns=mapAssigns(asgRows, numToId||{}, unit);
  const completed=(['completed','closed','cancelled'].indexOf(o.status)>=0) || (unit==='ton'&&target>0&&deliv>=target);
  return {
    id:'o'+o.id, projectId:o.project_id||null, projectName:o.project_name||'',
    disp:(o.reference_number||'').trim(), cust:o.customer_name||o.material_name||'', mat:o.material_name||'',
    pickup:(o.vendor_location||'').trim(), drop:(o.delivery_location||'').trim(),
    unit:unit, target:target, flex:Math.round(num(o.quantity_flex_allowed)),
    // LIVE pay + fuel surcharge from NewMile (order default truck pay; FSC = fee_type_id 2)
    payRate:(o.truck_pay_rate!=null?num(o.truck_pay_rate):null), payUnit:(o.truck_pay_rate_measurement_unit||unit),
    fsc:(()=>{const f=(o.payable_fees||[]).find(x=>x.fee_type_id===2);return f?{rate:num(f.rate),unit:f.measurement_unit||'',id:f.id}:null;})(),
    fscRecv:(()=>{const f=(o.receivable_fees||[]).find(x=>x.fee_type_id===2);return f?{rate:num(f.rate),unit:f.measurement_unit||'',id:f.id}:null;})(),
    payableFees:(o.payable_fees||[]), receivableFees:(o.receivable_fees||[]),
    status:statusOf(o.status), nmStatus:o.status, completed:completed, startHr:h, time:ampm(h),
    nm:nm, deliv:deliv, loadsDone:o.load_count||0,
    minTrucks:o.minimum_truck_count||0, planTrucks:o.planned_truck_count||0, priority:o.priority||'medium',
    notes: completed ? '✓ Order COMPLETE in NewMile — do not assign'
         : (assigns.length ? ('NewMile live: '+assigns.length+' truck'+(assigns.length!=1?'s':'')+' on this order') : (nm>0?('NewMile: '+nm+' trucks assigned'):'No trucks yet — to cover')),
    nmNotes:(nmNotes||[]),
    finalized:assigns.length>0, modified:false, assigns:assigns,
    // pristine NewMile snapshot — local edits never touch it; the push diff uses it
    // to know which trucks the dispatcher REMOVED (aid = order_assignment id)
    nmAssigns:(asgRows||[]).map(r=>({aid:r.id, num:(r.truck_number||'').trim(), done:(unit==='hour'?0:(r.load_count||0)),
      final:/^(pending|active|order_assignment_completed)$/.test(String(r.assignment_status||'').toLowerCase())}))
  };
}
const JUNK=/(DOWN|Camera|De-Leased|Train loads|Need)/i;
function dedupeTrucks(rows){
  const seen={}, out=[];
  for(const t of rows){
    const n=(t.truck_number||'').trim(), own=(t.owner_name||'');
    if(!n||JUNK.test(n)||n.length>18) continue;
    if(/ATX Bluewing/i.test(own)) continue;     // standing exclusion
    const k=n+'|'+own; if(seen[k]) continue; seen[k]=1; out.push(t);
  }
  return out;
}
function fleetOf(t){ if(t.fleet_id===5) return 'cactus'; if(t.fleet_id===6) return 'ckj'; return 'sub'; }
/* ADAPTIVE grouping — works for EVERY market, not just Texas:
   trucks WITH a NewMile fleet are grouped by that fleet's real name (well-known names
   get short aliases); fleet-null trucks fall to owner rules (e.g. "- CKJ" subs) and
   finally to SUB. Each market's filters/reports/summary build themselves from these. */
let groupsCfg=null;
const FLEET_ALIASES={'Cactus Express':'CE','CKJ Transport':'KT','Aggship':'AGG+CT','Kennemer':'KT'};
const RULE_LABELS={'CKJ_SUB':'CKJ SUB','AGGCT':'AGG+CT'};
function groupOfTruck(t){
  const als=Object.assign({},FLEET_ALIASES,(groupsCfg&&groupsCfg.fleet_aliases)||{});
  if(t.fleet_name){
    if(als[t.fleet_name]) return als[t.fleet_name];
    const n=String(t.fleet_name).trim();
    return (n.length>9?(n.slice(0,8).trim().toUpperCase()+'…'):n.toUpperCase());
  }
  if(t.fleet_id===6) return 'KT';
  if(t.fleet_id===5) return 'CE';
  if(t.fleet_id===4) return 'AGG+CT';
  const owner=(t.owner_name||'');
  if(groupsCfg){
    const ov=groupsCfg.owner_overrides||{};
    if(ov[owner] && typeof ov[owner]==='string' && ov[owner][0]!=='_') return RULE_LABELS[ov[owner]]||ov[owner];
    for(const r of (groupsCfg.owner_rules||[])){
      if(r.contains && owner.toUpperCase().includes(String(r.contains).toUpperCase())) return RULE_LABELS[r.group]||r.group;
    }
  }
  return 'SUB';
}
function termOf(n){ const m=/^KT-\d+\s+([PRW])$/.exec(n.trim()); if(!m) return null; return {P:'Powderly',R:'Rhome',W:'Whitewright'}[m[1]]; }
function mapTruck(t, worked){
  const n=(t.truck_number||'').trim(), fl=fleetOf(t), term=termOf(n);
  const o={ id:'t'+t.id, num:n, fleet:fl, group:groupOfTruck(t),
    owner:(t.owner_name||(n.indexOf('KT-')===0?'Kennemer (KT)':'Owner-Op')),
    driver:t.driver_name||'', status:'free', onCall:!!t.on_call,
    workedYest:worked(n,fl), daysIdle:null, loads7d:null, prio:false };
  if(term) o.terminal=term;
  return o;
}
function normNum(s){ return (String(s).replace(/^0+/,'')||'0'); }
function workedSet(tickets){
  const CAC={},KT4={},SUB3={},EX={};
  for(const r of tickets){
    const c=(r.truck_number||'').trim().toUpperCase(); let m;
    if((m=/^C(\d+)$/.exec(c))) CAC[normNum(m[1])]=1;
    else if((m=/^CKJ(\d{4})$/.exec(c))) KT4[normNum(m[1])]=1;
    else if((m=/^CKJ(\d{3})$/.exec(c))) SUB3[normNum(m[1])]=1;
    else EX[c.replace(/\s+/g,'')]=1;
  }
  return function(numStr, fleet){
    const n=(numStr||'').trim(), u=n.toUpperCase().replace(/\s+/g,'');
    if(fleet==='cactus') return !!(CAC[normNum(n)]||EX[u]);
    if(fleet==='ckj'){ const m=/^KT-(\d+)/.exec(n); if(m) return !!KT4[normNum(m[1])]; return !!(SUB3[normNum(n)]||KT4[normNum(n)]); }
    return !!(EX[u]||CAC[normNum(n)]);
  };
}
function shiftISO(iso,days){ const d=new Date(iso+'T12:00:00'); d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); }

/* ---------- Samsara move-check (Phase 2b) ----------
   After the board's configured hour, every truck ASSIGNED today that is NOT rolling
   in NewMile and shows ~0 mph in Samsara raises a Live Alert (click → its order). */
async function samsaraMoveCheck(payload, date){
  const clearB=()=>{ try{ board().__samsaraAlerts=[]; board().renderAlerts&&board().renderAlerts(); }catch(e){} };
  if(date!==localISO()){ clearB(); return; }                       // only meaningful for today
  let hr=9; try{ hr=(board().cfg&&board().cfg.moveCheckHr)||9; }catch(e){}
  if(new Date().getHours()<hr){ clearB(); return; }                // too early — nothing to flag yet
  const snap=await window.newmile.samsara();
  if(!snap||!Object.keys(snap).length){ appendLog('samsara: no tokens configured or no data — move-check off'); return; }
  const alerts=[], seen=new Set();
  (payload.dayMap[4]||[]).forEach(o=>{
    if(o.completed) return;
    (o.assigns||[]).forEach(a=>{
      const t=payload.trucks.find(x=>x.id===a.truck);
      if(!t||seen.has(t.id)) return; seen.add(t.id);
      if(t.status==='rolling') return;                             // already hauling per NewMile
      const g=snap[t.num.trim().toUpperCase().replace(/\s+/g,' ')];
      if(!g) return;                                               // not in Samsara (subs etc.)
      if((g.speed||0)<1) alerts.push({num:t.num, oid:o.id, time:g.time||''});
    });
  });
  try{ board().__samsaraAlerts=alerts; board().renderAlerts&&board().renderAlerts(); }catch(e){}
  appendLog('samsara move-check: '+alerts.length+' assigned truck(s) not moving (after '+hr+':00)');
  if(alerts.length) toast('🛰 Samsara: '+alerts.length+' assigned truck(s) not moving — see Live Alerts');
}

/* ---------- push (preview modal -> confirmed write) ---------- */
let pendingPlan=null;
function isOrderDefault(o){ return /watercrest|eyk/i.test((o.disp||'')+' '+(o.material||'')); }
/* Push scope = planner draft ∪ orders finalized on the board (planner wins on conflict) */
function collectPushOrders(){
  let plan={orders:[]};
  try{ plan=board().__getPlan()||{orders:[]}; }catch(e){}
  const byId={};
  getPendingSync().forEach(o=>{ o._src='finalized'; byId[o.order_id]=o; });
  (plan.orders||[]).forEach(o=>{ o._src='planner'; byId[o.order_id]=o; });
  return Object.values(byId);
}
function openPush(){
  const merged=collectPushOrders();
  if(!merged.length){ toast('Nothing to push — plan in the Planner or Finalize orders on the board first.'); return; }
  const plan={orders:merged};
  pendingPlan=plan;
  const tot=plan.orders.reduce((a,o)=>a+o.assignments.length,0);
  const totRm=plan.orders.reduce((a,o)=>a+((o.removed||[]).length),0);
  $('#pushSub').textContent=plan.orders.length+' order(s) · '+tot+' assignment(s)'+(totRm?' · '+totRm+' removal(s)':'');
  const body=$('#pushBody'); body.innerHTML='';
  plan.orders.forEach(o=>{
    const def=isOrderDefault(o);
    let rows=o.assignments.map(a=>{
      const bw=/ATX Bluewing/i.test(a.truck);
      const lds=(typeof a.loads==='number'&&a.loads>0)?(a.loads+' load'+(a.loads==1?'':'s')):'∞ open';
      return `<div class="arow"><span>${esc(a.truck)} · ${lds} ${a.sequence>1?'<span class="seq">seq '+a.sequence+'</span>':''}</span>`+
             `<span>${bw?'<span class="badge b-skip">excluded</span>':(def?'<span class="badge b-def">order_default</span>':'<span class="badge b-rate">contracted</span>')}</span></div>`;
    }).join('');
    rows+=(o.removed||[]).map(rm=>
      `<div class="arow"><span style="color:#ea4e2c">− ${esc(rm.truck)} — will be REMOVED from this order</span>`+
      `<span>${rm.done>0?'<span class="badge b-skip">'+rm.done+' hauled — will be kept</span>':'<span class="badge b-skip">remove</span>'}</span></div>`).join('');
    const div=document.createElement('div'); div.className='ord'; div.dataset.oid=o.order_id;
    div.innerHTML=`<div class="head"><div><div class="t">Order ${o.order_id}${def?'<span class="badge b-def">EYK/Watercrest</span>':''}${o._src==='finalized'?'<span class="badge b-rate">✓ finalized on board</span>':''}</div><div class="m">${esc(o.disp||'')} ${o.material?'· '+esc(o.material):''}</div></div>`+
                  `<button class="warn" data-push="${o.order_id}" style="padding:5px 10px">Push</button></div><div class="rows">${rows}</div>`;
    body.appendChild(div);
  });
  body.querySelectorAll('button[data-push]').forEach(b=>b.onclick=()=>runPush(parseInt(b.dataset.push,10)));
  $('#scrim').classList.add('open');
}
function closePush(){ $('#scrim').classList.remove('open'); pendingPlan=null; }

async function runPush(onlyOrderId){
  if(!pendingPlan) return;
  const orders = onlyOrderId==null ? pendingPlan.orders : pendingPlan.orders.filter(o=>o.order_id===onlyOrderId);
  let pushed=0;
  for(const o of orders){
    const card=$('#pushBody').querySelector(`.ord[data-oid="${o.order_id}"] .head button`);
    if(card){ card.disabled=true; card.textContent='…'; }
    try{
      const useDefault=isOrderDefault(o);
      // drop ATX Bluewing defensively at the edge too
      const asg=o.assignments.filter(a=>!/ATX Bluewing/i.test(a.truck));
      const r=await window.newmile.pushOrder({orderId:o.order_id, assignments:asg, useOrderDefault:useDefault, removed:(o.removed||[])});
      pushed++;
      clearPendingSync([o.order_id]);
      const made=(r.created||[]).length, upd=(r.updated||[]).length, rm=(r.removed||[]).length, sk=(r.skipped||[]).length, un=(r.unresolved||[]).length;
      let summary=`+${made} new`+(upd?` · ~${upd} updated`:'')+(rm?` · −${rm} removed`:'')+(sk?` · ${sk} untouched`:'')+(un?` · ?${un}`:'');
      if(card){ card.textContent=(r.confirmed||made||upd?'✓ ':'')+summary; card.className=un?'res-bad':'res-ok'; }
      if(un) toast(`Order ${o.order_id}: ${un} truck(s) not found in NewMile: ${(r.unresolved||[]).join(', ')}`);
    }catch(e){ if(card){ card.disabled=false; card.textContent='retry'; } toast('Order '+o.order_id+' failed: '+(e.message||e)); }
  }
  if(pushed){ toast('Pushed '+pushed+' order(s). Refreshing…'); setTimeout(()=>{ closePush(); refreshDay(); }, 900); }
}

function esc(s){ return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
