/* =========================================================================
   VOICEMOG — client app. All matchmaking, Elo, rank, streaks, and
   achievements come from the server (see server/server.js) — this file
   only renders what the server says and captures the player's own mic
   audio to measure their own Hz. It never decides who won.
   ========================================================================= */

// Every server-provided string that ends up in an innerHTML template
// (usernames, lobby names, opponent names) goes through this first.
// Server-side sanitizeName() already strips most dangerous characters,
// but this is the client's own line of defense — a field that's ever
// unsanitized upstream (or a future one that forgets to be) still can't
// inject markup here.
function esc(str){
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

/* ---------------- hero atmosphere: procedural arena silhouette ---------------- */
(function buildHeroArena(){
  const el = document.getElementById('heroArena');
  if(!el) return;
  el.innerHTML = `
  <svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="colGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#100d0c"/>
        <stop offset="100%" stop-color="#040303"/>
      </linearGradient>
    </defs>
    <g opacity="0.55">
      <rect x="40" y="280" width="34" height="230" fill="url(#colGrad)" stroke="#2b211f" stroke-width="2"/>
      <rect x="30" y="266" width="54" height="16" fill="#171210" stroke="#2b211f" stroke-width="2"/>
      <rect x="900" y="230" width="34" height="280" fill="url(#colGrad)" stroke="#2b211f" stroke-width="2"/>
      <rect x="890" y="216" width="54" height="16" fill="#171210" stroke="#2b211f" stroke-width="2"/>
      <rect x="180" y="360" width="30" height="150" fill="url(#colGrad)" stroke="#2b211f" stroke-width="1.5" opacity="0.7"/>
      <rect x="770" y="340" width="30" height="170" fill="url(#colGrad)" stroke="#2b211f" stroke-width="1.5" opacity="0.7"/>
    </g>
    <g opacity="0.35" stroke="#7a0d13" stroke-width="1.5" fill="none">
      <path d="M 400 520 Q 500 380 600 520" />
      <circle cx="500" cy="500" r="3" fill="#e2222f" stroke="none"/>
    </g>
    <g id="dustGroup" opacity="0.5"></g>
  </svg>`;
  const dustGroup = el.querySelector('#dustGroup');
  const ns = 'http://www.w3.org/2000/svg';
  for(let i=0;i<18;i++){
    const c = document.createElementNS(ns,'circle');
    const x = Math.random()*1000, y = 100+Math.random()*450, r = 0.6+Math.random()*1.6;
    c.setAttribute('cx',x); c.setAttribute('cy',y); c.setAttribute('r',r);
    c.setAttribute('fill', Math.random()>0.6 ? '#e2222f' : '#7a7069');
    dustGroup.appendChild(c);
    const dur = 8+Math.random()*10;
    c.animate([
      {transform:'translate(0px,0px)', opacity:0.1},
      {transform:`translate(${(Math.random()-0.5)*40}px,${-30-Math.random()*40}px)`, opacity:0.6},
      {transform:`translate(${(Math.random()-0.5)*60}px,${-70-Math.random()*40}px)`, opacity:0}
    ], {duration:dur*1000, iterations:Infinity, delay:-Math.random()*dur*1000});
  }
})();

/* ---------------- state ---------------- */
const state = {
  screen: 'landing',
  settings: { sfx: true, announcer: true, reducedFx: false },
  me: null,             // populated from hello_ack — real server record
  mode: 'ranked',
  battle: null,         // { battleId, ranked, opponent, pendingNextMsg }
};

/* ---------------- dials ---------------- */
const dialMatchmaking = new Dial(document.getElementById('dialMatchmaking'), {min:50,max:300});
dialMatchmaking.setMode('sweep');
const dialWaiting = new Dial(document.getElementById('dialWaiting'), {min:50,max:300});
dialWaiting.setMode('sweep');
const dialRecording = new Dial(document.getElementById('dialRecording'), {min:50,max:300});

/* ---------------- navigation ---------------- */
function go(name, opts = {}){
  if(!opts.silent) SoundMgr.play('ui.click', {priority:1});
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
  state.screen = name;
  document.querySelectorAll('.bottomnav button').forEach(b=>b.classList.toggle('active', b.dataset.nav===name));
  if(name==='leaderboard') loadLeaderboard();
  if(name==='profile') loadProfile();
}
document.querySelectorAll('.bottomnav button').forEach(b=>b.addEventListener('click',()=>go(b.dataset.nav)));

function setMode(mode){
  SoundMgr.play('ui.select', {priority:1});
  state.mode = mode;
  document.getElementById('modeRanked').classList.toggle('active', mode==='ranked');
  document.getElementById('modeCasual').classList.toggle('active', mode==='casual');
}

/* ---------------- settings dropdown menu ---------------- */
function toggleSettingsMenu(e){
  if(e) e.stopPropagation();
  SoundMgr.play('ui.open', {priority:1});
  document.getElementById('settingsMenu').classList.toggle('open');
}
document.addEventListener('click', (e) => {
  const menu = document.getElementById('settingsMenu');
  const btn = document.getElementById('navSettingsBtn');
  if(menu.classList.contains('open') && !menu.contains(e.target) && !btn.contains(e.target)){
    menu.classList.remove('open');
  }
});
document.getElementById('masterVol').addEventListener('input', e => {
  SoundMgr.setVolume('master', e.target.value / 100);
});
document.getElementById('sfxVol').addEventListener('input', e => {
  SoundMgr.setVolume('sfx', e.target.value / 100);
});
document.getElementById('annVol').addEventListener('input', e => {
  SoundMgr.setVolume('announcer', e.target.value / 100);
});
document.getElementById('fxToggle').addEventListener('change', e=>{
  state.settings.reducedFx = e.target.checked;
  document.body.classList.toggle('reduced-fx', e.target.checked);
});
if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){
  document.getElementById('fxToggle').checked = true;
  document.body.classList.add('reduced-fx');
  state.settings.reducedFx = true;
}

/* ---------------- avatar helper ---------------- */
function avatarUrl(path){ return path || 'assets/logo.png'; }

/* =========================================================================
   NETWORK WIRING — every gameplay decision below is just rendering what
   the server told us. No client-side "who won" logic exists anymore.
   ========================================================================= */
Net.on('hello_ack', (msg) => {
  state.me = msg.player;
  if(state.screen === 'profile') loadProfile();
});

Net.on('online_count', (msg) => {
  document.getElementById('onlineCount').textContent = msg.count;
});

Net.on('queue_status', (msg) => {
  document.getElementById('mmStatus').textContent =
    msg.status === 'searching' ? 'Scanning the Mogverse for a real opponent...' : msg.status;
});

Net.on('match_found', (msg) => {
  state.battle = { battleId: msg.battleId, ranked: msg.ranked, opponent: msg.opponent };
  state.lastResult = null;
  document.getElementById('mfYouAvatar').src = avatarUrl(state.me.avatar_path);
  document.getElementById('mfYouName').textContent = state.me.username;
  document.getElementById('mfYouTitle').textContent = state.me.rank_tag;
  document.getElementById('mfYouRating').textContent = state.me.elo + ' ELO' + (msg.ranked ? '' : ' · CASUAL');
  document.getElementById('mfOpAvatar').src = avatarUrl(msg.opponent.avatarPath);
  document.getElementById('mfOpName').textContent = msg.opponent.username;
  document.getElementById('mfOpTitle').textContent = msg.opponent.rankTag;
  document.getElementById('mfOpRating').textContent = msg.opponent.elo + ' ELO';
  SoundMgr.play('battle.fight', {priority:2});
  go('matchfound', {silent:true});
});

document.querySelector('#screen-matchfound .pxbtn.primary').addEventListener('click', () => {
  Net.send('ready');
  document.querySelector('#screen-matchfound .pxbtn.primary').disabled = true;
  document.querySelector('#screen-matchfound .pxbtn.primary').textContent = 'WAITING FOR OPPONENT...';
});

Net.on('both_ready', (msg) => {
  document.querySelector('#screen-matchfound .pxbtn.primary').disabled = false;
  document.querySelector('#screen-matchfound .pxbtn.primary').textContent = 'READY';
  runCountdown();
});

function runCountdown(){
  go('countdown', {silent:true});
  const el = document.getElementById('countnum');
  const seq = ['3','2','1','MOG'];
  let i=0;
  function step(){
    el.textContent = seq[i];
    el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
    i++;
    if(i<seq.length){ setTimeout(step, 700); }
  }
  step();
}

Net.on('your_turn_record', (msg) => {
  startRecording(msg.durationMs || 3000);
});

Net.on('opponent_recording', () => {
  document.getElementById('waitingStatus').textContent = 'OPPONENT IS RECORDING...';
  dialWaiting.setMode('sweep');
  go('waiting', {silent:true});
});

Net.on('waiting_for_opponent', () => {
  document.getElementById('waitingStatus').textContent = 'VOICE LOCKED. WAITING FOR OPPONENT...';
  dialWaiting.setMode('sweep');
  go('waiting', {silent:true});
});

Net.on('analyzing', () => { runAnalysisAnimation(); });

Net.on('battle_result', (msg) => { showResult(msg); });

Net.on('battle_aborted', (msg) => {
  const reasons = {
    OPPONENT_DISCONNECTED: ['CONNECTION LOST', '"Your opponent vanished. THE MOGVERSE WENT DARK."'],
    PLAYER_LEFT: ['BATTLE ENDED', '"You left the arena."'],
    TURN_TIMEOUT: ['TIMED OUT', '"Someone took too long to speak."'],
    MISSING_RESULT: ['SOMETHING WENT WRONG', '"We lost track of that battle. Try again."'],
  };
  const [title, body] = reasons[msg.reason] || ['BATTLE ENDED', '"The connection dropped."'];
  showError(title, body);
});

Net.on('_disconnected', () => {
  if(['recording','countdown','matchfound','matchmaking','waiting','analyzing'].includes(state.screen)){
    showError('CONNECTION LOST', '"THE MOGVERSE WENT DARK. Reconnecting..."');
  }
});

Net.on('error', (msg) => {
  if(msg.code === 'RATE_LIMITED') console.warn('Rate limited by server');
});

/* ---------------- MOG NOW → real matchmaking ---------------- */
document.getElementById('mogNowBtn').addEventListener('click', startMatchmaking);
function startMatchmaking(){
  go('matchmaking');
  dialMatchmaking.setMode('sweep');
  document.getElementById('mmStatus').textContent = 'Scanning the Mogverse for a real opponent...';
  Net.send('queue', { mode: state.mode });
}
function cancelMatchmaking(){
  Net.send('cancel_queue');
  go('landing');
}
function runItBack(){ startMatchmaking(); }

/* ---------------- recording + real pitch detection ---------------- */
let audioCtx, analyser, micStream, rafId;

async function startRecording(durationMs){
  go('recording', {silent:true});
  dialRecording.setMode('live');
  document.getElementById('recInstruction').textContent = 'SPEAK.';
  const readings = [];
  try{
    micStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}});
  }catch(err){
    showError('MIC ACCESS DENIED', '"Give us permission to hear you."');
    return;
  }
  audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const startT = performance.now();
  function frame(){
    analyser.getFloatTimeDomainData(buf);
    const f0 = detectPitch(buf, audioCtx.sampleRate);
    if(f0){ readings.push(f0); dialRecording.setValue(f0); }
    document.getElementById('hzLive').textContent = f0 ? Math.round(f0) : '—';

    const elapsed = performance.now()-startT;
    const remain = Math.max(0,(durationMs-elapsed)/1000);
    document.getElementById('recTimer').textContent = remain.toFixed(1)+'s';
    if(elapsed < durationMs){ rafId = requestAnimationFrame(frame); }
    else finishRecording(readings);
  }
  frame();
}

function finishRecording(readings){
  cancelAnimationFrame(rafId);
  if(micStream) micStream.getTracks().forEach(t=>t.stop());
  if(audioCtx) audioCtx.close();

  let finalHz = null;
  if(readings.length >= 5) finalHz = medianOf(readings);

  if(!finalHz){
    // We still owe the server a value or the battle stalls — send a
    // clearly-invalid sentinel so the server times the turn out cleanly
    // rather than hanging on a phantom submission.
    showError('VOICE NOT DETECTED', "\"We didn't catch that. Get close to the mic and really speak — run it back.\"");
    return;
  }
  const hz = Math.round(finalHz*10)/10;
  dialRecording.setMode('locked');
  dialRecording.setValue(finalHz);
  state.battle.myHz = hz;
  Net.send('submit_hz', { hz });
  document.getElementById('waitingStatus').textContent = 'VOICE LOCKED. WAITING FOR OPPONENT...';
  dialWaiting.setMode('sweep');
  go('waiting', {silent:true});
}

function showError(title, body){
  SoundMgr.play('ui.error', {priority:1});
  document.getElementById('errTitle').textContent = title;
  document.getElementById('errBody').textContent = body;
  go('error', {silent:true});
}

/* ---------------- analyzing screen ---------------- */
function runAnalysisAnimation(){
  go('analyzing', {silent:true});
  const barIds = ['anzBar1','anzBar2','anzBar3'];
  barIds.forEach(id=>document.getElementById(id).style.width='0%');
  let i=0;
  const titles = ['Analyzing...','Analyzing...','Pitch locked.'];
  function step(){
    if(i<3){
      document.getElementById(barIds[i]).style.width='100%';
      document.getElementById('anzTitle').textContent = titles[Math.min(i,2)];
      i++;
      setTimeout(step, 260);
    }
  }
  step();
}

/* ---------------- result reveal ---------------- */
function flash(){
  const f = document.getElementById('flash');
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
}
function burstParticles(){
  if(state.settings.reducedFx) return;
  const wrap = document.getElementById('burst');
  wrap.innerHTML='';
  for(let i=0;i<26;i++){
    const p = document.createElement('i');
    const ang = Math.random()*Math.PI*2, dist = 80+Math.random()*260;
    p.style.left='50%'; p.style.top='40%';
    p.style.background = Math.random()>0.4 ? 'var(--ember)' : 'var(--bone)';
    wrap.appendChild(p);
    p.animate([
      {transform:'translate(0,0)', opacity:1},
      {transform:`translate(${Math.cos(ang)*dist}px, ${Math.sin(ang)*dist}px)`, opacity:0}
    ], {duration:650+Math.random()*300, easing:'cubic-bezier(.2,.7,.3,1)'});
  }
  setTimeout(()=>wrap.innerHTML='', 1000);
}

function showResult(msg){
  state.lastResult = { win: msg.win, isUpset: msg.isUpset, opp: msg.opponent || (state.battle ? state.battle.opponent : null) };
  go('result', {silent:true});
  document.getElementById('revYouHz').textContent='???';
  document.getElementById('revOpHz').textContent='???';
  document.getElementById('revYouHz').classList.add('mystery');
  document.getElementById('revOpHz').classList.add('mystery');
  document.getElementById('resultHeadline').style.display='none';
  document.getElementById('diffTag').style.display='none';
  document.getElementById('rewardRow').style.display='none';
  document.getElementById('postCtas').style.display='none';

  setTimeout(() => {
    document.getElementById('revYouHz').textContent = msg.youHz+' Hz';
    document.getElementById('revOpHz').textContent = msg.oppHz+' Hz';
    document.getElementById('revYouHz').classList.remove('mystery');
    document.getElementById('revOpHz').classList.remove('mystery');
    flash();
    burstParticles();
    renderResultDetails(msg);
  }, 1100);
}

function renderResultDetails(msg){
  const diff = Math.round(Math.abs(msg.youHz - msg.oppHz)*10)/10;
  let headline, headlineClass;
  if(msg.win){
    headlineClass='win';
    if(diff < 0.5) headline = 'BARELY.';
    else if(msg.isUpset){ headline='GIANT SLAYER'; SoundMgr.play('announcer.ultraKill',{priority:5}); }
    else if(diff > 40){ headline='BRUTAL'; SoundMgr.play('announcer.monsterKill',{priority:4}); }
    else headline='MOGGED';
  } else {
    headlineClass='lose';
    headline = diff<0.5 ? 'BARELY.' : 'YOU GOT MOGGED.';
  }

  const hl = document.getElementById('resultHeadline');
  hl.textContent = headline; hl.className = 'result-headline '+headlineClass;
  hl.style.display='block';
  document.getElementById('diffTag').textContent = diff+' Hz DIFFERENCE';
  document.getElementById('diffTag').style.display='block';

  const rr = document.getElementById('rewardRow');
  const eloPart = state.battle.ranked
    ? `<span class="${msg.eloDelta>=0?'up':'down'}">${msg.eloDelta>=0?'+':''}${msg.eloDelta} ELO</span>`
    : `<span>CASUAL · NO ELO CHANGE</span>`;
  rr.innerHTML = eloPart + (msg.streak>0 ? `<span class="streakfire">🔥 ${msg.streak} WIN STREAK</span>` : (msg.win?'':'<span>STREAK BROKEN</span>'));
  rr.style.display='flex';
  document.getElementById('postCtas').style.display='flex';

  if(msg.win) SoundMgr.play('announcer.firstBlood',{priority:2}); else SoundMgr.play('battle.defeat',{priority:2});
  if(msg.streak===2) SoundMgr.play('announcer.doubleKill',{priority:3});
  else if(msg.streak===3) SoundMgr.play('announcer.multiKill',{priority:3});
  else if(msg.streak===4) SoundMgr.play('announcer.killingSpree',{priority:3});
  else if(msg.streak===5) { SoundMgr.play('announcer.rampage',{priority:4}); toast('HOT THROAT','5 wins in a row.', 'HIGH'); }
  else if(msg.streak===10){ SoundMgr.play('announcer.unstoppable',{priority:5}); toast('UNSTOPPABLE','10 wins in a row.', 'HIGH'); }
  else if(msg.streak>=15){ SoundMgr.play('announcer.godlike',{priority:5}); toast('GODLIKE','15 wins in a row.', 'HIGH'); }
  if(msg.endedOpponentStreak) toast('STREAK BREAKER', "You ended their run.", 'HIGH');

  if(msg.win && state.me && msg.rankTag && msg.rankTag !== state.me.rank_tag){
    SoundMgr.play('rank.rankUp',{priority:4});
    toast('RANK UP', `You are now ${msg.rankTag}.`, 'HIGH');
  }
  if(msg.win && state.me && (state.me.personal_best_hz == null || msg.youHz < state.me.personal_best_hz)){
    SoundMgr.play('notifications.personalRecord',{priority:3});
    toast('PERSONAL BEST', `New deepest voice: ${msg.youHz} Hz.`, 'HIGH');
  }

  (msg.achievements || []).forEach((a, i) => {
    setTimeout(() => { SoundMgr.play('achievements.unlock',{priority:3}); toast(a.name, a.desc, 'HIGH'); }, 900 + i*1400);
  });

  if(msg.rivalry && msg.rivalry.unlocked){
    setTimeout(() => toast('RIVALRY', `${msg.rivalry.wins}-${msg.rivalry.losses} lifetime vs this opponent.`, 'LOW'), 2600);
  }

  (msg.challengesCompleted?.daily || []).forEach((c, i) => {
    setTimeout(() => toast('CHALLENGE COMPLETE', c.name, 'MEDIUM'), 3200 + i*1000);
  });
  (msg.challengesCompleted?.weekly || []).forEach((c, i) => {
    setTimeout(() => toast('WEEKLY CHALLENGE COMPLETE', c.name, 'MEDIUM'), 3200 + i*1000);
  });
}

/* ---------------- notification priority queue ---------------- */
// Priorities: CRITICAL > HIGH > MEDIUM > LOW > BACKGROUND. Higher-priority
// items are inserted above lower ones already showing; each cleans itself
// up on its own timer so nothing lingers forever, and a visible-count cap
// plus per-title dedupe stop one spammy event from flooding the screen.
const NotifyQueue = (() => {
  const PRIORITY = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, BACKGROUND: 4 };
  const DURATIONS = { CRITICAL: 5000, HIGH: 4000, MEDIUM: 3200, LOW: 2400, BACKGROUND: 1800 };
  const MAX_VISIBLE = 4;
  const stack = document.getElementById('notifyStack');
  const recent = new Map(); // "title|body" -> timestamp, for dedupe

  function push(title, body, priority = 'MEDIUM'){
    const key = title + '|' + body;
    const now = performance.now();
    if(recent.has(key) && now - recent.get(key) < 2000) return; // dedupe rapid repeats
    recent.set(key, now);

    while(stack.children.length >= MAX_VISIBLE) stack.removeChild(stack.lastElementChild);

    const el = document.createElement('div');
    el.className = 'notify-item ' + priority.toLowerCase();
    el.innerHTML = `<div class="badge"></div><div><b>${esc(title)}</b><span>${esc(body)}</span></div>`;
    const rank = PRIORITY[priority] ?? 2;
    let inserted = false;
    for(const child of stack.children){
      if((PRIORITY[child.dataset.priority] ?? 2) > rank){ stack.insertBefore(el, child); inserted = true; break; }
    }
    el.dataset.priority = priority;
    if(!inserted) stack.appendChild(el);

    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(-10px)'; el.style.transition='.25s'; setTimeout(()=>el.remove(), 250); },
      DURATIONS[priority] || 3200);
  }

  return { push };
})();
function toast(title, body, priority = 'MEDIUM'){ NotifyQueue.push(title, body, priority); }

/* ---------------- share cards ---------------- */
function downloadShareCard(){
  SoundMgr.play('ui.click', {priority:1});
  const cv = document.getElementById('shareCanvas');
  const me = state.me || {};
  const opp = (state.lastResult && state.lastResult.opp) || {};
  const headline = document.getElementById('resultHeadline').textContent;
  ShareCard.battle(cv, {
    iWon: state.lastResult ? state.lastResult.win : false,
    mode: state.battle && state.battle.ranked ? 'RANKED 1V1' : 'CASUAL 1V1',
    headline: headline || 'BATTLE',
    sub: (state.lastResult && state.lastResult.isUpset) ? 'GIANT SLAYER UPSET' :
         (msg => msg)(document.getElementById('diffTag').textContent),
    me:   { name: me.username || 'YOU', avatar: me.avatar_path || null, rank: me.rank_tag, elo: me.elo,
            hz: document.getElementById('revYouHz').textContent.replace(' Hz','') },
    opp:  { name: opp.username || 'OPPONENT', avatar: opp.avatarPath || null, rank: opp.rankTag, elo: opp.elo,
            hz: document.getElementById('revOpHz').textContent.replace(' Hz','') },
  }).then(() => {
    const link = document.createElement('a');
    link.download = 'voicemog-battle.png';
    link.href = cv.toDataURL('image/png');
    link.click();
  });
}
function downloadLobbyCard(){
  SoundMgr.play('ui.click', {priority:1});
  if(!state.lobbyResults) return;
  const cv = document.getElementById('shareCanvas');
  ShareCard.lobby(cv, state.lobbyResults).then(() => {
    const link = document.createElement('a');
    link.download = 'voicemog-lobby.png';
    link.href = cv.toDataURL('image/png');
    link.click();
  });
}

/* ---------------- leaderboard (real, from the server) ---------------- */
async function loadLeaderboard(){
  const list = document.getElementById('lbList');
  list.innerHTML = '<div class="status-sub" style="text-align:center;">Loading...</div>';
  try{
    const res = await fetch('/api/leaderboard');
    const { rows } = await res.json();
    list.innerHTML = '';
    rows.forEach((row, i) => {
      const isYou = state.me && row.id === state.me.id;
      const div = document.createElement('div');
      div.className = 'lb-row'+(i===0?' top1':'')+(isYou?' lb-you':'');
      div.innerHTML = `<div class="lb-rank">#${i+1}</div>
        <img class="lb-avatar" src="${avatarUrl(row.avatar_path)}">
        <div class="lb-info"><div class="lb-name">${esc(row.username)}${isYou?' (you)':''}</div><div class="lb-title2">${esc(row.rank_tag)}</div></div>
        <div class="lb-rating">${row.elo}</div>`;
      list.appendChild(div);
    });
    if(rows.length === 0) list.innerHTML = '<div class="status-sub" style="text-align:center;">No players yet. Be the first to MOG.</div>';
  }catch(e){
    list.innerHTML = '<div class="status-sub" style="text-align:center;">Could not reach the server.</div>';
  }
}

/* ---------------- profile (real, from the server) ---------------- */
document.getElementById('avatarInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if(!f || !state.me) return;
  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById('pfAvatar').src = reader.result;
    document.getElementById('pfAvatar').style.display='block';
    document.getElementById('pfPlus').style.display='none';
  };
  reader.readAsDataURL(f);
  try{
    const buf = await f.arrayBuffer();
    // fetch() sets no Content-Type for a raw ArrayBuffer body — without
    // one, some server-side raw-body parsers decode it as text first,
    // silently corrupting binary bytes. Always set it explicitly for
    // binary uploads; the browser already knows the real type from the
    // file picker.
    const res = await fetch(`/api/avatar/${state.me.id}`, {
      method: 'POST',
      body: buf,
      headers: { 'Content-Type': f.type || 'application/octet-stream' },
    });
    const json = await res.json();
    if(json.avatarPath){ state.me.avatar_path = json.avatarPath; }
    else { toast('UPLOAD FAILED', json.error || 'Try a different image.', 'HIGH'); }
  }catch(err){ toast('UPLOAD FAILED', 'Network error.', 'HIGH'); }
});

function showModal({ title, message, action, showInput = true, inputValue = '' }){
  const modal = document.getElementById('renameModal');
  modal.querySelector('h4').textContent = title;
  modal.querySelector('.status-sub').textContent = message;
  const input = document.getElementById('renameInput');
  input.style.display = showInput ? 'block' : 'none';
  input.value = inputValue;
  modal.dataset.action = action;
  modal.style.display = 'flex';
  if(showInput) setTimeout(() => input.focus(), 50);
}
function renameSelf(){
  SoundMgr.play('ui.click', {priority:1});
  showModal({
    title: 'RENAME',
    message: 'Enter a new username (max 20 characters).',
    action: 'rename',
    inputValue: state.me ? state.me.username : '',
  });
}
function confirmModal(){
  const modal = document.getElementById('renameModal');
  const action = modal.dataset.action;
  SoundMgr.play('ui.success', {priority:1});
  if(action === 'rename'){
    const name = document.getElementById('renameInput').value.trim();
    if(!name) return;
    Net.send('set_username', { username: name });
  } else if(action === 'removeFriend'){
    Net.send('friend_remove', { friendId: modal.dataset.friendId });
    setTimeout(loadFriends, 200);
  } else if(action === 'challenge'){
    Net.send('challenge_respond', { inviteId: modal.dataset.inviteId, accept: true });
  } else if(action === 'challengeDecline'){
    Net.send('challenge_respond', { inviteId: modal.dataset.inviteId, accept: false });
  }
  closeModal();
}
function cancelModal(){
  SoundMgr.play('ui.close', {priority:1});
  const modal = document.getElementById('renameModal');
  if(modal.dataset.action === 'challenge' && modal.dataset.inviteId){
    Net.send('challenge_respond', { inviteId: modal.dataset.inviteId, accept: false });
  }
  closeModal();
}
function closeModal(){
  SoundMgr.play('ui.close', {priority:1});
  document.getElementById('renameModal').style.display = 'none';
}
document.getElementById('renameModal').addEventListener('click', (e) => {
  if(e.target.id === 'renameModal') cancelModal();
});
document.getElementById('renameInput').addEventListener('keydown', (e) => {
  if(e.key === 'Enter') confirmModal();
  if(e.key === 'Escape') cancelModal();
});

async function loadProfile(){
  if(!state.me) return;
  document.getElementById('pfName').textContent = state.me.username;
  document.getElementById('pfMogId').textContent = state.me.id;
  document.getElementById('pfTitle').textContent = state.me.rank_tag;
  document.getElementById('pfRating').textContent = state.me.elo;
  document.getElementById('pfBattles').textContent = state.me.battles;
  document.getElementById('pfWinrate').textContent = state.me.battles ? Math.round(100*state.me.wins/state.me.battles)+'%' : '0%';
  document.getElementById('pfPB').textContent = state.me.personal_best_hz ? state.me.personal_best_hz+' Hz' : '—';
  document.getElementById('pfStreak').textContent = state.me.streak;
  document.getElementById('pfBestStreak').textContent = state.me.best_streak;
  if(state.me.avatar_path){
    document.getElementById('pfAvatar').src = avatarUrl(state.me.avatar_path);
    document.getElementById('pfAvatar').style.display='block';
    document.getElementById('pfPlus').style.display='none';
  }
  try{
    const res = await fetch(`/api/profile/${state.me.id}`);
    const data = await res.json();
    const achEl = document.getElementById('pfAchList');
    const achEmpty = document.getElementById('pfEmptyAch');
    if(!data.achievements || data.achievements.length===0){
      achEmpty.style.display='block'; achEl.innerHTML='';
    } else {
      achEmpty.style.display='none';
      achEl.innerHTML = data.achievements.map(a => `
        <div class="pf-ach"><b>${esc(a.name||a.code)}</b><span>${esc(a.desc||'')}</span><div class="rarity">${esc(a.rarity||'')}</div></div>
      `).join('');
    }
    const histEl = document.getElementById('pfHistList');
    const histEmpty = document.getElementById('pfEmptyHist');
    if(!data.history || data.history.length===0){
      histEmpty.style.display='block'; histEl.innerHTML='';
    } else {
      histEmpty.style.display='none';
      histEl.innerHTML = data.history.map(h => `
        <div class="lb-row"><div class="lb-info"><div class="lb-name">${h.win?'WIN':'LOSS'} vs ${esc(h.opponent_name)}</div>
        <div class="lb-title2">${h.player_hz} Hz vs ${h.opponent_hz} Hz ${h.ranked ? '· RANKED' : '· CASUAL'}</div></div>
        <div class="lb-rating" style="color:${h.elo_delta>=0?'#7fd996':'#7a7069'}">${h.ranked ? (h.elo_delta>=0?'+':'')+h.elo_delta : '—'}</div></div>
      `).join('');
    }
  }catch(e){ /* profile detail is best-effort; header fields above already rendered */ }
}

/* ---------------- boot ---------------- */
Net.connect();

/* =========================================================================
   FRIENDS
   ========================================================================= */
Net.on('friend_request_received', (msg) => {
  toast('FRIEND REQUEST', `${msg.from.username} wants to be friends.`, 'MEDIUM');
  if(state.screen === 'friends') loadFriends();
});
Net.on('friend_request_accepted', (msg) => {
  toast('FRIEND ADDED', `${msg.by.username} accepted your request.`, 'MEDIUM');
  if(state.screen === 'friends') loadFriends();
});
Net.on('friend_removed', () => { if(state.screen === 'friends') loadFriends(); });

async function loadFriends(){
  if(!state.me) return;
  const listEl = document.getElementById('friendsList');
  const incEl = document.getElementById('incomingRequestsList');
  try{
    const res = await fetch(`/api/friends/${state.me.id}`);
    const data = await res.json();
    incEl.innerHTML = data.incoming.length === 0 ? '<div class="status-sub">None right now.</div>' :
      data.incoming.map(r => `
        <div class="friend-row">
          <img class="lb-avatar" src="${avatarUrl(r.avatar_path)}">
          <div class="info"><b>${esc(r.username)}</b><span>${esc(r.rank_tag)} · ${r.elo} ELO</span></div>
          <div class="btnrow">
            <button class="accept" onclick="respondFriend(${r.request_id}, true)">ACCEPT</button>
            <button onclick="respondFriend(${r.request_id}, false)">DECLINE</button>
          </div>
        </div>`).join('');
    listEl.innerHTML = data.friends.length === 0 ? '<div class="status-sub">No friends added yet.</div>' :
      data.friends.map(f => `
        <div class="friend-row">
          <img class="lb-avatar" src="${avatarUrl(f.avatar_path)}">
          <div class="info"><b>${esc(f.username)}</b><span>${esc(f.rank_tag)} · ${f.elo} ELO</span></div>
          <div class="btnrow">
            <button class="accept" onclick="challengeFriend('${f.id}')">CHALLENGE</button>
            <button onclick="removeFriendConfirm('${f.id}', '${esc(f.username).replace(/'/g,"&#39;")}')">REMOVE</button>
          </div>
        </div>`).join('');
  }catch(e){
    listEl.innerHTML = '<div class="status-sub">Could not reach the server.</div>';
  }
}
function sendFriendReq(){
  const id = document.getElementById('addFriendInput').value.trim().toUpperCase();
  if(!id) return;
  SoundMgr.play('ui.friendRequest', {priority:1});
  Net.send('friend_request', { toId: id });
  document.getElementById('addFriendInput').value = '';
}
function respondFriend(requestId, accept){
  SoundMgr.play('ui.click', {priority:1});
  Net.send('friend_respond', { requestId, accept });
  setTimeout(loadFriends, 200);
}
function removeFriendConfirm(friendId, username){
  SoundMgr.play('ui.click', {priority:1});
  showModal({
    title: 'REMOVE FRIEND',
    message: `Remove ${username} from your friends?`,
    action: 'removeFriend',
    showInput: false,
  });
  document.getElementById('renameModal').dataset.friendId = friendId;
}
function challengeFriend(friendId){
  SoundMgr.play('ui.challenge', {priority:1});
  Net.send('challenge_friend', { friendId, mode: state.mode });
  toast('CHALLENGE SENT', 'Waiting for them to accept...', 'MEDIUM');
}
Net.on('challenge_sent', () => { SoundMgr.play('ui.success', {priority:1}); });
Net.on('challenge_invite', (msg) => {
  SoundMgr.play('ui.challenge', {priority:2});
  showModal({
    title: 'CHALLENGE',
    message: `${msg.from.username} (${msg.from.elo} ELO) wants a ${msg.mode.toUpperCase()} MOG. Accept?`,
    action: 'challenge',
    showInput: false,
  });
  document.getElementById('renameModal').dataset.inviteId = msg.inviteId;
});
Net.on('challenge_declined', (msg) => {
  toast('CHALLENGE DECLINED', msg.reason === 'TIMED_OUT' ? 'They didn\'t respond in time.' : 'They said no.', 'MEDIUM');
});

/* =========================================================================
   CHALLENGES (daily/weekly)
   ========================================================================= */
async function loadChallenges(){
  if(!state.me) return;
  try{
    const res = await fetch(`/api/challenges/${state.me.id}`);
    const data = await res.json();
    document.getElementById('dailyChallengeList').innerHTML = data.daily.map(challengeRow).join('');
    document.getElementById('weeklyChallengeList').innerHTML = data.weekly.map(challengeRow).join('');
  }catch(e){ /* best effort */ }
}
function challengeRow(c){
  const done = !!c.completed_at;
  const pct = Math.min(100, Math.round(100 * c.progress / c.target));
  return `<div class="challenge-row ${done?'done':''}">
    <div class="top"><span>${esc(c.name)}</span><span class="status">${done?'COMPLETE':`${c.progress}/${c.target}`}</span></div>
    <div class="barwrap"><div class="barfill" style="width:${pct}%"></div></div>
  </div>`;
}

/* =========================================================================
   LOBBIES (2-6 real players)
   ========================================================================= */
const dialLobby = new Dial(document.getElementById('dialLobby'), {min:50,max:300});
dialLobby.setMode('sweep');

async function loadPublicLobbies(){
  const el = document.getElementById('publicLobbyList');
  try{
    const res = await fetch('/api/lobbies');
    const { rows } = await res.json();
    el.innerHTML = rows.length === 0 ? '<div class="status-sub" style="text-align:center;">No public lobbies right now — create one.</div>' :
      rows.map(l => `
        <div class="lobby-member">
          <span class="dot"></span>
          <div class="name">${esc(l.name)} <span class="host-tag">host: ${esc(l.hostName)}</span></div>
          <span class="status-sub">${l.count}/${l.max}</span>
          <button class="pxbtn ghost" style="padding:6px 12px;font-size:12px;" onclick="joinLobbyById('${l.id}')">JOIN</button>
        </div>`).join('');
  }catch(e){ el.innerHTML = '<div class="status-sub">Could not reach the server.</div>'; }
}
function createLobby(){
  const name = document.getElementById('lobbyNameInput').value.trim();
  const isPublic = document.getElementById('lobbyPublicToggle').checked;
  SoundMgr.play('ui.create', {priority:1});
  Net.send('lobby_create', { name, isPublic });
}
function joinLobbyByCode(){
  const code = document.getElementById('lobbyCodeInput').value.trim();
  if(!code) return;
  SoundMgr.play('ui.join', {priority:1});
  Net.send('lobby_join', { code });
}
function joinLobbyById(lobbyId){ SoundMgr.play('ui.join', {priority:1}); Net.send('lobby_join', { lobbyId }); }
function leaveLobby(){ SoundMgr.play('ui.leave', {priority:1}); Net.send('lobby_leave'); go('lobbyMenu', {silent:true}); loadPublicLobbies(); }
function startLobby(){ SoundMgr.play('ui.click', {priority:1}); Net.send('lobby_start'); }

Net.on('lobby_state', (msg) => {
  state.lobby = msg.lobby;
  document.getElementById('lobbyRoomName').textContent = msg.lobby.name;
  document.getElementById('lobbyCodeDisplay').textContent = msg.lobby.isPublic ? 'PUBLIC LOBBY' : `CODE: ${msg.lobby.code}`;
  document.getElementById('lobbyMemberList').innerHTML = msg.lobby.members.map(m => `
    <div class="lobby-member ${m.eliminated?'eliminated':''}">
      <img class="lb-avatar" src="${avatarUrl(m.avatar_path)}">
      <div class="name">${esc(m.username)}<div class="lb-title2">${esc(m.rank_tag || 'GRUNTER')} · ${m.elo != null ? m.elo + ' ELO' : '—'}</div></div>
      ${m.playerId === msg.lobby.hostId ? '<span class="host-tag">HOST</span>' : ''}
    </div>`).join('');
  const isHost = state.me && msg.lobby.hostId === state.me.id;
  const startBtn = document.getElementById('lobbyStartBtn');
  document.getElementById('lobbyStartCount').textContent = msg.lobby.members.length;
  startBtn.style.display = isHost ? 'inline-block' : 'none';
  document.getElementById('lobbyWaitNote').style.display = isHost ? 'none' : 'block';
  go('lobbyRoom', {silent:true});
});
Net.on('lobby_round_start', (msg) => {
  document.getElementById('lobbyRoundLabel').textContent = `ROUND ${msg.round} · ${msg.playersLeft} LEFT`;
  document.getElementById('lobbyRoundResults').innerHTML = '';
  if(!state.lobbyResults || msg.round === 1) state.lobbyResults = null;
  go('lobbyBattle', {silent:true});
});
Net.on('lobby_your_turn', (msg) => { startLobbyRecording(msg.durationMs || 5000); });
Net.on('lobby_waiting', (msg) => {
  dialLobby.setMode('sweep');
  document.getElementById('lobbyInstruction').textContent = 'WAITING...';
  document.getElementById('lobbyTurnNote').textContent = `${msg.activeUsername} is recording...`;
  go('lobbyBattle', {silent:true});
});
Net.on('lobby_round_result', (msg) => {
  const el = document.getElementById('lobbyRoundResults');
  el.innerHTML = `<div class="pf-section-title">ROUND ${msg.round} RESULTS</div>` + msg.results.map(r => `
    <div class="lobby-member ${r.eliminated?'eliminated':''}">
      <span class="dot"></span><div class="name">${esc(r.username)}</div>
      <span class="status-sub">${r.hz ? r.hz+' Hz' : 'no submission'} ${r.eliminated?'· ELIMINATED':''}</span>
    </div>`).join('');
  // Track the deepest Hz each player posted across the whole lobby for the share card
  if(!state.lobbyResults) state.lobbyResults = { name: (state.lobby && state.lobby.name) || 'LOBBY', players: [] };
  const map = Object.fromEntries(state.lobbyResults.players.map(p => [p.name, p]));
  msg.results.forEach(r => {
    const roster = (state.lobby && state.lobby.members) || [];
    const meta = roster.find(m => m.username === r.username) || {};
    if(!map[r.username]){
      map[r.username] = { name: r.username, avatar: meta.avatar_path || null, rank: meta.rank_tag || 'GRUNTER', elo: meta.elo, hz: r.hz };
      state.lobbyResults.players.push(map[r.username]);
    } else if(r.hz != null && (map[r.username].hz == null || r.hz < map[r.username].hz)){
      map[r.username].hz = r.hz; // keep each player's deepest (best) reading
    }
  });
});
Net.on('lobby_final', (msg) => {
  document.getElementById('lobbyInstruction').textContent = msg.winner ? `${msg.winner} WINS THE LOBBY` : 'LOBBY ENDED';
  document.getElementById('lobbyTurnNote').textContent = '';
  toast('LOBBY COMPLETE', msg.winner ? `${msg.winner} takes it.` : 'No winner.', 'HIGH');
  if(state.lobbyResults){
    state.lobbyResults.players.forEach(p => { p.isWinner = p.name === msg.winner; });
    const el2 = document.getElementById('lobbyRoundResults');
    el2.insertAdjacentHTML('beforeend',
      `<div style="text-align:center;margin-top:16px;"><button class="pxbtn primary" onclick="downloadLobbyCard()">SHARE RESULTS CARD</button></div>`);
  }
  setTimeout(() => go('lobbyMenu', {silent:true}), 12000);
});

async function startLobbyRecording(durationMs){
  document.getElementById('lobbyInstruction').textContent = 'SPEAK.';
  document.getElementById('lobbyTurnNote').textContent = 'Your turn.';
  dialLobby.setMode('live');
  const readings = [];
  let stream, ctx;
  try{ stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true } }); }
  catch(e){ toast('MIC ACCESS DENIED', 'Could not record your turn.', 'CRITICAL'); Net.send('lobby_submit_hz', { hz: 999 }); return; }
  ctx = new (window.AudioContext||window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const startT = performance.now();
  function frame(){
    analyser.getFloatTimeDomainData(buf);
    const f0 = detectPitch(buf, ctx.sampleRate);
    if(f0){ readings.push(f0); dialLobby.setValue(f0); }
    document.getElementById('lobbyHzLive').textContent = f0 ? Math.round(f0) : '—';
    if(performance.now() - startT < durationMs){ requestAnimationFrame(frame); }
    else {
      stream.getTracks().forEach(t=>t.stop()); ctx.close();
      const hz = readings.length >= 5 ? medianOf(readings) : 200; // no signal — safe high default, not a win
      dialLobby.setMode('locked'); dialLobby.setValue(hz);
      Net.send('lobby_submit_hz', { hz: Math.round(hz*10)/10 });
    }
  }
  frame();
}

/* ---------------- extend go() for the new data-backed screens ---------------- */
const _originalGo = go;
go = function(name, opts){
  _originalGo(name, opts);
  if(name === 'friends') loadFriends();
  if(name === 'challenges') loadChallenges();
  if(name === 'lobbyMenu') loadPublicLobbies();
};
