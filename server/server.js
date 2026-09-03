// server.js — VoiceMog backend.
//
// Security posture (spec explicitly asked for this to be treated as
// hostile-client): the client never sends a winner, Elo, rank, or streak —
// only its own measured Hz for its own turn. Every other fact is computed
// here, once, from data the server already trusts.
require('dotenv').config(); // loads .env if present; no-op (and harmless) if it isn't — real envs set these via the platform instead
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');

const db = require('./db');
const elo = require('./elo');
const achievements = require('./achievements');
const challenges = require('./challenges');
const lobbies = require('./lobbies');
const { validateAvatar, MAX_BYTES } = require('./uploads');
const log = require('./log');

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
const UPSET_ELO_GAP = 200;
const TURN_DURATION_MS = 5000;
const TURN_TIMEOUT_MS = 20000;

if(NODE_ENV === 'production' && ALLOWED_ORIGINS.length === 0){
  log.warn('ALLOWED_ORIGINS is not set in production — WebSocket connections will be accepted from ANY origin. Set ALLOWED_ORIGINS to your real domain(s) before exposing this publicly.');
}

const app = express();
app.set('trust proxy', 1); // correct client IPs behind Render/Fly/Railway/any reverse proxy — needed for rate limiting to key on the real caller, not the proxy
app.use(helmet({
  contentSecurityPolicy: false, // the pixel-art UI loads Google Fonts + inline styles; a real CSP is a deployment-specific follow-up, not something to fake here
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(express.json({ limit: '10kb' })); // small: JSON bodies here are just usernames etc.

const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

app.get('/healthz', (req, res) => res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) }));

app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------------- REST: read-only + upload endpoints ---------------- */
// Small wrapper so an async route's thrown/rejected error becomes a 500
// instead of an unhandled rejection that crashes nothing but logs nothing.
function asyncRoute(fn){
  return (req, res) => fn(req, res).catch(err => {
    log.error(`Error in ${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
}

app.get('/api/leaderboard', asyncRoute(async (req, res) => {
  res.json({ rows: await db.getLeaderboard(100) });
}));

app.get('/api/season', asyncRoute(async (req, res) => {
  const season = await db.getActiveSeason();
  res.json({ season, leaderboard: await db.getSeasonLeaderboard(season.id, 100) });
}));

app.get('/api/friends/:id', asyncRoute(async (req, res) => {
  if(!(await db.getPlayer(req.params.id))) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({
    friends: await db.listFriends(req.params.id),
    incoming: await db.listIncomingRequests(req.params.id),
  });
}));

app.get('/api/challenges/:id', asyncRoute(async (req, res) => {
  if(!(await db.getPlayer(req.params.id))) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(await challenges.listForPlayer(req.params.id));
}));

app.get('/api/lobbies', (req, res) => {
  res.json({ rows: lobbies.listPublicLobbies() });
});

app.get('/api/profile/:id', asyncRoute(async (req, res) => {
  const p = await db.getPlayer(req.params.id);
  if(!p) return res.status(404).json({ error: 'NOT_FOUND' });
  const rawAchievements = await db.getAchievements(p.id);
  res.json({
    player: p,
    rank: await db.getRank(p.id),
    history: await db.getHistory(p.id, 20),
    achievements: rawAchievements.map(a => ({ ...a, ...achievements.DEFS[a.code] })),
  });
}));

// Raw-body avatar upload, capped, sniffed by magic bytes server-side —
// see uploads.js. Bytes are stored in Postgres (db.setAvatarData), not
// the local filesystem — same reasoning as the database migration
// itself: a container redeploy would otherwise quietly wipe every
// profile picture even though the player record survived.
// `type: () => true` forces this to parse as raw bytes regardless of
// whatever Content-Type header shows up (or doesn't) — '*/*' as a string
// only matches requests that declare *some* content-type, so a request
// with none (or an unexpected one) would silently skip parsing entirely
// and hand validateAvatar something that isn't a Buffer at all. Magic-byte
// sniffing already does the real validation; this just guarantees we
// always get bytes to sniff in the first place.
app.post('/api/avatar/:playerId', uploadLimiter, express.raw({ type: () => true, limit: MAX_BYTES + 1024 }), asyncRoute(async (req, res) => {
  const player = await db.getPlayer(req.params.playerId);
  if(!player) return res.status(404).json({ error: 'NOT_FOUND' });
  try{
    const { mime } = validateAvatar(req.body);
    const avatarPath = await db.setAvatarData(player.id, req.body, mime);
    res.json({ avatarPath: `${avatarPath}?v=${Date.now()}` }); // cache-busting query param, actual route ignores it
  }catch(err){
    res.status(400).json({ error: err.message });
  }
}));

app.get('/api/avatar-image/:playerId', asyncRoute(async (req, res) => {
  const avatar = await db.getAvatarData(req.params.playerId);
  if(!avatar) return res.status(404).end();
  res.set('Content-Type', avatar.mime);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(avatar.data);
}));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024, // hard cap on a single WS frame — this protocol never needs more than a few hundred bytes
  verifyClient: (info, done) => {
    const origin = info.origin || info.req.headers.origin;
    if(ALLOWED_ORIGINS.length === 0) return done(true); // dev mode — see README for production hardening
    done(ALLOWED_ORIGINS.includes(origin));
  },
});

/* ---------------- connection registry + simple rate limiting ---------------- */
const sockets = new Map(); // playerId -> ws
const queue = [];          // waiting sockets: { ws, playerId, mode }
const battles = new Map(); // battleId -> battle state

function send(ws, msg){
  if(ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcastOnlineCount(){
  const count = sockets.size;
  for(const ws of sockets.values()) send(ws, { type: 'online_count', count });
}

function rateLimited(ws){
  const now = Date.now();
  ws._bucket = (ws._bucket || []).filter(t => now - t < 5000);
  ws._bucket.push(now);
  return ws._bucket.length > 40; // ~40 msgs / 5s is generous for this protocol
}

/* ---------------- matchmaking ---------------- */
async function tryMatch(){
  // Only pairs two distinct, currently-connected real players. No bots,
  // no synthetic opponents, no filling an empty slot — per spec.
  while(queue.length >= 2){
    const a = queue.shift();
    const b = queue.shift();
    if(a.ws.readyState !== a.ws.OPEN){ queue.unshift(b); continue; }
    if(b.ws.readyState !== b.ws.OPEN){ queue.unshift(a); continue; }
    await startBattle(a, b);
  }
}

function playerPublic(p){
  return { id: p.id, username: p.username, avatarPath: p.avatar_path, elo: p.elo, rankTag: p.rank_tag, streak: p.streak };
}

async function startBattle(a, b){
  const battleId = crypto.randomBytes(8).toString('hex');
  const [pA, pB] = await Promise.all([db.getPlayer(a.playerId), db.getPlayer(b.playerId)]);
  if(!pA || !pB) return; // one of them vanished between queueing and matching — drop silently, they'll requeue or reconnect
  const order = Math.random() < 0.5 ? [a, b] : [b, a];
  const battle = {
    id: battleId,
    ranked: a.mode === 'ranked' && b.mode === 'ranked',
    sides: [
      { ...a, hz: null, ready: false, preStreak: pA.streak },
      { ...b, hz: null, ready: false, preStreak: pB.streak },
    ],
    order: order.map(x => x.playerId),
    turn: 0,
    settled: false,
    timeoutHandle: null,
  };
  battles.set(battleId, battle);
  battle.sides.forEach(s => { s.ws._battleId = battleId; });

  const byId = { [pA.id]: pA, [pB.id]: pB };
  battle.sides.forEach(s => {
    const opp = battle.sides.find(x => x.playerId !== s.playerId);
    send(s.ws, {
      type: 'match_found',
      battleId,
      ranked: battle.ranked,
      you: playerPublic(byId[s.playerId]),
      opponent: playerPublic(byId[opp.playerId]),
    });
  });
}

function bothReady(battle){
  return battle.sides.every(s => s.ready);
}

function beginTurnSequence(battle){
  const startAt = Date.now() + 600;
  battle.sides.forEach(s => send(s.ws, { type: 'both_ready', startAt }));
  clearTimeout(battle.timeoutHandle);
  battle.timeoutHandle = setTimeout(() => advanceTurn(battle), 600 + 3200); // local 3-2-1-MOG countdown
}

function advanceTurn(battle){
  if(battle.settled) return;
  const activeId = battle.order[battle.turn];
  const active = battle.sides.find(s => s.playerId === activeId);
  const waiting = battle.sides.find(s => s.playerId !== activeId);
  if(!active || !waiting) return;
  send(active.ws, { type: 'your_turn_record', durationMs: TURN_DURATION_MS });
  send(waiting.ws, { type: 'opponent_recording' });
  clearTimeout(battle.timeoutHandle);
  battle.timeoutHandle = setTimeout(() => abortBattle(battle, 'TURN_TIMEOUT'), TURN_TIMEOUT_MS);
}

function abortBattle(battle, reasonCode){
  if(battle.settled) return;
  battle.settled = true;
  clearTimeout(battle.timeoutHandle);
  battle.sides.forEach(s => {
    if(s.ws._battleId === battle.id) s.ws._battleId = null;
    send(s.ws, { type: 'battle_aborted', reason: reasonCode });
  });
  battles.delete(battle.id);
}

function handleSubmitHz(ws, hz){
  const battle = battles.get(ws._battleId);
  if(!battle || battle.settled) return;
  const activeId = battle.order[battle.turn];
  const side = battle.sides.find(s => s.playerId === ws._playerId);
  if(!side || side.playerId !== activeId) return; // not your turn — ignored, not an error worth alerting a hostile client to
  if(typeof hz !== 'number' || !isFinite(hz) || hz < 40 || hz > 600) return; // sane vocal F0 bounds
  side.hz = hz;
  battle.turn++;
  clearTimeout(battle.timeoutHandle);
  if(battle.turn < battle.order.length){
    send(side.ws, { type: 'waiting_for_opponent' });
    advanceTurn(battle);
  } else {
    battle.sides.forEach(s => send(s.ws, { type: 'analyzing' }));
    setTimeout(() => {
      settleBattle(battle).catch(err => log.error('settleBattle failed', err));
    }, 900);
  }
}

async function settleBattle(battle){
  if(battle.settled) return;
  battle.settled = true; // set synchronously, before any await, so a concurrent event can never double-settle this battle
  clearTimeout(battle.timeoutHandle);

  const [s1, s2] = battle.sides;
  if(s1.hz == null || s2.hz == null) return abortBattle(battle, 'MISSING_RESULT');

  const [p1, p2, season] = await Promise.all([
    db.getPlayer(s1.playerId), db.getPlayer(s2.playerId), db.getActiveSeason(),
  ]);
  if(!p1 || !p2) return abortBattle(battle, 'MISSING_RESULT');
  const isFriendMatch = await db.areFriends(p1.id, p2.id);
  const p1Wins = s1.hz < s2.hz; // deeper (lower Hz) wins

  let s1Delta = 0, s2Delta = 0;
  if(battle.ranked){
    const k1 = elo.kFactor(p1.ranked_matches_played);
    const k2 = elo.kFactor(p2.ranked_matches_played);
    s1Delta = elo.ratingDelta(p1.elo, p2.elo, p1Wins ? 1 : 0, k1);
    s2Delta = elo.ratingDelta(p2.elo, p1.elo, p1Wins ? 0 : 1, k2);
  }

  const winnerElo = p1Wins ? p1.elo : p2.elo;
  const loserElo = p1Wins ? p2.elo : p1.elo;
  const isUpset = (loserElo - winnerElo) >= UPSET_ELO_GAP;

  const winnerPreStreak = p1Wins ? s2.preStreak : s1.preStreak; // loser's pre-battle streak
  const endedOpponentStreak = winnerPreStreak >= 5;

  const [updated1, updated2] = await Promise.all([
    db.applySettlement(p1.id, {
      opponentId: p2.id, opponentName: p2.username, playerHz: s1.hz, opponentHz: s2.hz,
      win: p1Wins, ranked: battle.ranked, eloDelta: s1Delta, isUpset: p1Wins && isUpset, seasonId: season.id,
    }),
    db.applySettlement(p2.id, {
      opponentId: p1.id, opponentName: p1.username, playerHz: s2.hz, opponentHz: s1.hz,
      win: !p1Wins, ranked: battle.ranked, eloDelta: s2Delta, isUpset: !p1Wins && isUpset, seasonId: season.id,
    }),
  ]);

  const [ach1, ach2] = await Promise.all([
    achievements.evaluate(p1.id, { player: updated1, win: p1Wins, wasUpset: p1Wins && isUpset, endedOpponentStreak: p1Wins && endedOpponentStreak, youHz: s1.hz }),
    achievements.evaluate(p2.id, { player: updated2, win: !p1Wins, wasUpset: !p1Wins && isUpset, endedOpponentStreak: !p1Wins && endedOpponentStreak, youHz: s2.hz }),
  ]);

  const hzDiff = Math.round(Math.abs(s1.hz - s2.hz)*10)/10;
  const [chal1, chal2] = await Promise.all([
    challenges.evaluateBattle(p1.id, {
      win: p1Wins, ranked: battle.ranked, opponentId: p2.id, opponentRankTag: p2.rank_tag,
      isUpset: p1Wins && isUpset, hzDiff, isFriendMatch, endedOpponentStreak: p1Wins && endedOpponentStreak, streakAfter: updated1.streak,
    }),
    challenges.evaluateBattle(p2.id, {
      win: !p1Wins, ranked: battle.ranked, opponentId: p1.id, opponentRankTag: p1.rank_tag,
      isUpset: !p1Wins && isUpset, hzDiff, isFriendMatch, endedOpponentStreak: !p1Wins && endedOpponentStreak, streakAfter: updated2.streak,
    }),
  ]);

  const [rivalry1, rivalry2] = await Promise.all([db.getRivalry(p1.id, p2.id), db.getRivalry(p2.id, p1.id)]);

  send(s1.ws, resultPayload(updated1, p1Wins, s1.hz, s2.hz, s1Delta, ach1, rivalry1, isUpset && p1Wins, endedOpponentStreak && p1Wins, chal1, isFriendMatch));
  send(s2.ws, resultPayload(updated2, !p1Wins, s2.hz, s1.hz, s2Delta, ach2, rivalry2, isUpset && !p1Wins, endedOpponentStreak && !p1Wins, chal2, isFriendMatch));

  battle.sides.forEach(s => { if(s.ws._battleId === battle.id) s.ws._battleId = null; });
  battles.delete(battle.id);
}

function resultPayload(player, win, youHz, oppHz, eloDelta, unlockedAchievements, rivalry, isUpset, endedOpponentStreak, completedChallenges, isFriendMatch){
  return {
    type: 'battle_result',
    win, youHz, oppHz,
    eloDelta, newElo: player.elo, rankTag: player.rank_tag,
    streak: player.streak, bestStreak: player.best_streak,
    isUpset, endedOpponentStreak, isFriendMatch,
    achievements: unlockedAchievements,
    challengesCompleted: completedChallenges,
    rivalry,
  };
}

/* ---------------- friend requests + direct challenges ---------------- */
const pendingInvites = new Map(); // inviteId -> { fromId, toId, mode, timeout }

function notifyIfOnline(playerId, msg){
  const ws = sockets.get(playerId);
  if(ws) send(ws, msg);
}

/* ---------------- lobbies (2-6 real players) ---------------- */
function lobbyBroadcast(lobby, msg){
  lobby.members.forEach(m => send(m.ws, msg));
}
function publicLobbyMember(m){ return { playerId: m.playerId, username: m.username, eliminated: m.eliminated, elo: m.elo, rank_tag: m.rank_tag, avatar_path: m.avatar_path }; }

function startLobbyRound(lobby){
  const active = lobby.members.filter(m => !m.eliminated);
  if(active.length <= 1){
    lobby.state = 'settled';
    lobbyBroadcast(lobby, { type: 'lobby_final', winner: active[0] ? active[0].username : null });
    lobby.members.forEach(m => { if(m.ws._lobbyId === lobby.id) m.ws._lobbyId = null; });
    lobbies.deleteLobby(lobby.id);
    return;
  }
  lobby.round++;
  lobby.order = shuffleArray(active.map(m => m.playerId));
  lobby.turnIndex = 0;
  lobby.state = 'recording';
  active.forEach(m => m.hz = null);
  lobbyBroadcast(lobby, { type: 'lobby_round_start', round: lobby.round, playersLeft: active.length });
  advanceLobbyTurn(lobby);
}

function advanceLobbyTurn(lobby){
  if(lobby.turnIndex >= lobby.order.length) return settleLobbyRound(lobby);
  const activeId = lobby.order[lobby.turnIndex];
  const activeMember = lobby.members.find(m => m.playerId === activeId);
  if(!activeMember) return; // disconnected mid-round — settleLobbyRound handles missing hz as elimination
  lobby.members.forEach(m => {
    if(m.playerId === activeId) send(m.ws, { type: 'lobby_your_turn', durationMs: lobbies.TURN_DURATION_MS });
    else send(m.ws, { type: 'lobby_waiting', activeUsername: activeMember.username });
  });
  clearTimeout(lobby.timeoutHandle);
  lobby.timeoutHandle = setTimeout(() => {
    // no submission in time — treat as an automatic elimination this round
    activeMember.hz = 99999;
    lobby.turnIndex++;
    advanceLobbyTurn(lobby);
  }, lobbies.TURN_TIMEOUT_MS);
}

function settleLobbyRound(lobby){
  clearTimeout(lobby.timeoutHandle);
  const active = lobby.members.filter(m => !m.eliminated);
  const maxHz = Math.max(...active.map(m => m.hz));
  const results = active.map(m => ({ username: m.username, hz: m.hz === 99999 ? null : m.hz, eliminated: m.hz === maxHz }));
  active.forEach(m => { if(m.hz === maxHz) m.eliminated = true; });
  lobbyBroadcast(lobby, { type: 'lobby_round_result', round: lobby.round, results });
  setTimeout(() => startLobbyRound(lobby), 1600);
}

function shuffleArray(arr){
  const a = [...arr];
  for(let i=a.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}

/* ---------------- ws connection handling ---------------- */
wss.on('connection', (ws) => {
  ws._playerId = null;
  ws._battleId = null;
  ws._lobbyId = null;



  ws.on('message', async (raw) => {
    if(rateLimited(ws)){ send(ws, { type:'error', code:'RATE_LIMITED', message:'Slow down.' }); return; }
    let msg;
    try{ msg = JSON.parse(raw); }catch{ return; }
    if(!msg || typeof msg.type !== 'string') return;

    try{
    switch(msg.type){
      case 'hello': {
        let player;
        const existing = msg.playerId ? await db.getPlayer(msg.playerId) : null;
        if(existing){
          player = existing;
          await db.touch(player.id);
          if(typeof msg.username === 'string' && msg.username.trim()) await db.setUsername(player.id, sanitizeName(msg.username));
        } else {
          player = await db.createPlayer(typeof msg.username === 'string' ? sanitizeName(msg.username) : undefined);
        }
        ws._playerId = player.id;
        sockets.set(player.id, ws);
        send(ws, { type: 'hello_ack', player: await db.getPlayer(player.id) });
        broadcastOnlineCount();
        break;
      }
      case 'set_username': {
        if(!ws._playerId || typeof msg.username !== 'string') return;
        const clean = sanitizeName(msg.username);
        await db.setUsername(ws._playerId, clean);
        send(ws, { type: 'hello_ack', player: await db.getPlayer(ws._playerId) });
        break;
      }
      case 'queue': {
        if(!ws._playerId) return;
        if(queue.some(q => q.playerId === ws._playerId)) return; // already queued
        const mode = msg.mode === 'casual' ? 'casual' : 'ranked';
        queue.push({ ws, playerId: ws._playerId, mode });
        send(ws, { type: 'queue_status', status: 'searching' });
        tryMatch().catch(err => log.error('tryMatch failed', err));
        break;
      }
      case 'cancel_queue': {
        const idx = queue.findIndex(q => q.playerId === ws._playerId);
        if(idx >= 0) queue.splice(idx, 1);
        break;
      }
      case 'ready': {
        const battle = battles.get(ws._battleId);
        if(!battle) return;
        const side = battle.sides.find(s => s.playerId === ws._playerId);
        if(side) side.ready = true;
        if(bothReady(battle)) beginTurnSequence(battle);
        break;
      }
      case 'submit_hz': {
        handleSubmitHz(ws, msg.hz);
        break;
      }
      case 'leave_battle': {
        const battle = battles.get(ws._battleId);
        if(battle) abortBattle(battle, 'PLAYER_LEFT');
        break;
      }

      /* ---------- friends ---------- */
      case 'friend_request': {
        if(!ws._playerId || typeof msg.toId !== 'string') return;
        try{
          await db.sendFriendRequest(ws._playerId, msg.toId);
          send(ws, { type: 'friend_request_sent', toId: msg.toId });
          notifyIfOnline(msg.toId, { type: 'friend_request_received', from: playerPublic(await db.getPlayer(ws._playerId)) });
        }catch(err){ send(ws, { type: 'error', code: err.message, message: 'Could not send friend request.' }); }
        break;
      }
      case 'friend_respond': {
        if(!ws._playerId || typeof msg.requestId !== 'number') return;
        try{
          const fromPlayer = await db.respondFriendRequest(msg.requestId, ws._playerId, !!msg.accept);
          send(ws, { type: 'friend_respond_ack', accepted: !!msg.accept });
          if(msg.accept) notifyIfOnline(fromPlayer.id, { type: 'friend_request_accepted', by: playerPublic(await db.getPlayer(ws._playerId)) });
        }catch(err){ send(ws, { type: 'error', code: err.message, message: 'Could not respond to request.' }); }
        break;
      }
      case 'friend_remove': {
        if(!ws._playerId || typeof msg.friendId !== 'string') return;
        await db.removeFriend(ws._playerId, msg.friendId);
        send(ws, { type: 'friend_removed', friendId: msg.friendId });
        break;
      }

      /* ---------- direct challenge (friend vs friend, bypasses queue) ---------- */
      case 'challenge_friend': {
        if(!ws._playerId || typeof msg.friendId !== 'string') return;
        if(!(await db.areFriends(ws._playerId, msg.friendId))){ send(ws, { type:'error', code:'NOT_FRIENDS', message:'You can only challenge friends.' }); return; }
        const targetWs = sockets.get(msg.friendId);
        if(!targetWs){ send(ws, { type:'error', code:'FRIEND_OFFLINE', message:'That friend is not online.' }); return; }
        if(targetWs._battleId || targetWs._lobbyId){ send(ws, { type:'error', code:'FRIEND_BUSY', message:'That friend is busy right now.' }); return; }
        const inviteId = crypto.randomBytes(6).toString('hex');
        const mode = msg.mode === 'casual' ? 'casual' : 'ranked';
        const timeout = setTimeout(() => {
          pendingInvites.delete(inviteId);
          send(ws, { type: 'challenge_declined', reason: 'TIMED_OUT' });
        }, 30000);
        pendingInvites.set(inviteId, { fromId: ws._playerId, fromWs: ws, toId: msg.friendId, toWs: targetWs, mode, timeout });
        send(targetWs, { type: 'challenge_invite', inviteId, mode, from: playerPublic(await db.getPlayer(ws._playerId)) });
        send(ws, { type: 'challenge_sent' });
        break;
      }
      case 'challenge_respond': {
        const invite = pendingInvites.get(msg.inviteId);
        if(!invite || invite.toId !== ws._playerId) return;
        clearTimeout(invite.timeout);
        pendingInvites.delete(msg.inviteId);
        if(!msg.accept){ send(invite.fromWs, { type: 'challenge_declined', reason: 'DECLINED' }); return; }
        await startBattle({ ws: invite.fromWs, playerId: invite.fromId, mode: invite.mode }, { ws: invite.toWs, playerId: invite.toId, mode: invite.mode });
        break;
      }

      /* ---------- lobbies ---------- */
      case 'lobby_create': {
        if(!ws._playerId || ws._lobbyId) return;
        const player = await db.getPlayer(ws._playerId);
        const lobby = lobbies.createLobby({ hostWs: ws, hostId: ws._playerId, hostUsername: player.username, name: sanitizeName(msg.name || `${player.username}'s Arena`, { maxLen: 30, fallback: "MOG ARENA" }), isPublic: !!msg.isPublic });
        const host = lobby.members[0];
        host.elo = player.elo; host.rank_tag = player.rank_tag; host.avatar_path = player.avatar_path;
        ws._lobbyId = lobby.id;
        send(ws, { type: 'lobby_state', lobby: lobbyStatePayload(lobby) });
        break;
      }
      case 'lobby_join': {
        if(!ws._playerId || ws._lobbyId) return;
        const player = await db.getPlayer(ws._playerId);
        const lobby = msg.code ? lobbies.findByCode(msg.code) : lobbies.getLobby(msg.lobbyId);
        if(!lobby){ send(ws, { type:'error', code:'LOBBY_NOT_FOUND', message:'No lobby with that code.' }); return; }
        try{
          lobbies.joinLobby(lobby, { ws, playerId: ws._playerId, username: player.username });
          const joiner = lobby.members[lobby.members.length - 1];
          joiner.elo = player.elo; joiner.rank_tag = player.rank_tag; joiner.avatar_path = player.avatar_path;
          ws._lobbyId = lobby.id;
          lobbyBroadcast(lobby, { type: 'lobby_state', lobby: lobbyStatePayload(lobby) });
        }catch(err){ send(ws, { type:'error', code: err.message, message:'Could not join that lobby.' }); }
        break;
      }
      case 'lobby_list': {
        send(ws, { type: 'lobby_list', rows: lobbies.listPublicLobbies() });
        break;
      }
      case 'lobby_leave': {
        const lobby = lobbies.getLobby(ws._lobbyId);
        if(!lobby) return;
        const result = lobbies.leaveLobby(lobby, ws._playerId);
        ws._lobbyId = null;
        if(!result.deleted) lobbyBroadcast(lobby, { type: 'lobby_state', lobby: lobbyStatePayload(lobby) });
        break;
      }
      case 'lobby_start': {
        const lobby = lobbies.getLobby(ws._lobbyId);
        if(!lobby || lobby.hostId !== ws._playerId || lobby.state !== 'waiting') return;
        if(lobby.members.length < lobbies.MIN_PLAYERS){ send(ws, { type:'error', code:'NOT_ENOUGH_PLAYERS', message:`Need at least ${lobbies.MIN_PLAYERS} players.` }); return; }
        startLobbyRound(lobby);
        break;
      }
      case 'lobby_submit_hz': {
        const lobby = lobbies.getLobby(ws._lobbyId);
        if(!lobby || lobby.state !== 'recording') return;
        const activeId = lobby.order[lobby.turnIndex];
        if(activeId !== ws._playerId) return;
        if(typeof msg.hz !== 'number' || !isFinite(msg.hz) || msg.hz < 40 || msg.hz > 600) return;
        const member = lobby.members.find(m => m.playerId === ws._playerId);
        member.hz = msg.hz;
        clearTimeout(lobby.timeoutHandle);
        lobby.turnIndex++;
        advanceLobbyTurn(lobby);
        break;
      }

      default: break;
    }
    }catch(err){
      log.error(`Error handling ws message type=${msg.type}`, err);
      send(ws, { type: 'error', code: 'INTERNAL_ERROR', message: 'Something went wrong on our end.' });
    }
  });

  ws.on('close', () => {
    if(ws._playerId) sockets.delete(ws._playerId);
    const qIdx = queue.findIndex(q => q.playerId === ws._playerId);
    if(qIdx >= 0) queue.splice(qIdx, 1);
    const battle = battles.get(ws._battleId);
    if(battle) abortBattle(battle, 'OPPONENT_DISCONNECTED');
    const lobby = lobbies.getLobby(ws._lobbyId);
    if(lobby){
      const result = lobbies.leaveLobby(lobby, ws._playerId);
      if(!result.deleted) lobbyBroadcast(lobby, { type: 'lobby_state', lobby: lobbyStatePayload(lobby) });
    }
    for(const [inviteId, invite] of pendingInvites){
      if(invite.fromId === ws._playerId || invite.toId === ws._playerId){
        clearTimeout(invite.timeout);
        pendingInvites.delete(inviteId);
      }
    }
    broadcastOnlineCount();
  });
});

function lobbyStatePayload(lobby){
  return {
    id: lobby.id, name: lobby.name, code: lobby.code, isPublic: lobby.isPublic,
    hostId: lobby.hostId, state: lobby.state,
    members: lobby.members.map(publicLobbyMember),
    max: lobbies.MAX_PLAYERS, min: lobbies.MIN_PLAYERS,
  };
}


function sanitizeName(name, { maxLen = 20, fallback = 'MOGGER' } = {}){
  const cleaned = String(name ?? '').trim().slice(0, maxLen).replace(/[^\w \-']/g, '');
  return cleaned || fallback;
}

// heartbeat to clear dead connections
setInterval(() => {
  wss.clients.forEach(ws => {
    if(ws._dead){ ws.terminate(); return; }
    ws._dead = true;
    ws.ping(() => { ws._dead = false; });
  });
}, 30000);
wss.on('connection', (ws) => ws.on('pong', () => { ws._dead = false; }));

async function boot(){
  await db.migrate();
  log.info('Database schema ready');
  server.listen(PORT, () => log.info(`VoiceMog server listening on :${PORT} (env=${NODE_ENV}, allowedOrigins=${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(',') : 'ANY (dev mode)'})`));
}
boot().catch(err => { log.error('Fatal error during startup', err); process.exit(1); });

/* ---------------- graceful shutdown ---------------- */
// Hosting platforms send SIGTERM before killing a container/process on
// redeploy or scale-down. Without this, in-flight WebSocket connections
// get dropped mid-battle with no notice and the Postgres pool's
// in-flight connections are torn down uncleanly instead of released.
let shuttingDown = false;
function shutdown(signal){
  if(shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received — shutting down gracefully`);

  for(const ws of wss.clients){
    try{ send(ws, { type: 'server_shutdown', message: 'Server is restarting. Please reconnect in a moment.' }); ws.close(1001, 'Server restarting'); }
    catch{ /* best effort */ }
  }

  wss.close();
  server.close(async () => {
    log.info('HTTP/WebSocket server closed');
    try{ await db.close(); log.info('Database pool closed cleanly'); }
    catch(err){ log.error('Error closing database pool', err); }
    process.exit(0);
  });

  // Don't hang forever if a connection refuses to close
  setTimeout(() => { log.warn('Forcing exit after shutdown timeout'); process.exit(1); }, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Logged, not fatal-by-default: exiting immediately on any uncaught error
// would drop every in-progress battle for one bad code path. This is a
// judgment call, not a guarantee — if you see these in your logs, treat
// them as bugs to fix, not noise to ignore.
process.on('uncaughtException', (err) => { log.error('Uncaught exception', err); });
process.on('unhandledRejection', (err) => { log.error('Unhandled rejection', err); });
