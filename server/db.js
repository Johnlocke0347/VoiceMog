// db.js — Postgres persistence for players, battles, seasons, friends,
// and challenges. Async throughout (node-postgres), because the whole
// point of this migration is: your data survives a Render free-tier
// spin-down, a redeploy, or a crash — none of which a local SQLite file
// on an ephemeral filesystem can promise.
//
// DATABASE_URL is required. Locally, docker-compose runs a Postgres
// container for you. In production, point it at a free Neon or Supabase
// database — see server/README.md for exact setup steps.
const { Pool } = require('pg');

if(!process.env.DATABASE_URL){
  throw new Error('DATABASE_URL is not set. See server/.env.example and server/README.md for how to get one (local Docker Postgres or a free Neon/Supabase database).');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon/Supabase both require SSL; a local Docker Postgres doesn't
  // present a cert at all, so we only demand SSL when the connection
  // string doesn't point at localhost.
  ssl: /localhost|127\.0\.0\.1|postgres:5432/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  require('./log').error('Unexpected idle Postgres client error', err);
});

async function migrate(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      avatar_path TEXT,
      avatar_data BYTEA,
      avatar_mime TEXT,
      elo INTEGER NOT NULL DEFAULT 200,
      rank_tag TEXT NOT NULL DEFAULT 'GRUNTER',
      ranked_matches_played INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      battles INTEGER NOT NULL DEFAULT 0,
      personal_best_hz REAL,
      highest_elo INTEGER NOT NULL DEFAULT 200,
      created_at BIGINT NOT NULL,
      last_seen BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS battles (
      id SERIAL PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      opponent_id TEXT NOT NULL,
      opponent_name TEXT NOT NULL,
      player_hz REAL NOT NULL,
      opponent_hz REAL NOT NULL,
      win INTEGER NOT NULL,
      ranked INTEGER NOT NULL DEFAULT 1,
      elo_delta INTEGER NOT NULL DEFAULT 0,
      is_upset INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      season_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS achievements (
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      unlocked_at BIGINT NOT NULL,
      PRIMARY KEY (player_id, code)
    );

    CREATE TABLE IF NOT EXISTS seasons (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      start_at BIGINT NOT NULL,
      end_at BIGINT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS season_stats (
      season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      elo INTEGER NOT NULL DEFAULT 200,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      matches INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (season_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL,
      responded_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS challenge_progress (
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      period_key TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      meta TEXT,
      completed_at BIGINT,
      PRIMARY KEY (player_id, code, period_key)
    );

    CREATE INDEX IF NOT EXISTS idx_battles_player ON battles(player_id);
    CREATE INDEX IF NOT EXISTS idx_battles_opponent ON battles(player_id, opponent_id);
    CREATE INDEX IF NOT EXISTS idx_players_elo ON players(elo DESC);
    CREATE INDEX IF NOT EXISTS idx_friend_to ON friend_requests(to_id, status);
    CREATE INDEX IF NOT EXISTS idx_friend_from ON friend_requests(from_id, status);
  `);

  // Column additions for databases that already had a `players` table
  // from before these columns existed — CREATE TABLE IF NOT EXISTS is a
  // no-op against an existing table, so new columns need an explicit
  // migration step. Postgres's ADD COLUMN IF NOT EXISTS makes this safe
  // to run on every boot, including against a brand-new database.
  await pool.query(`
    ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar_data BYTEA;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar_mime TEXT;
  `);
}

function makeMogId(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let s = ''; for(let i=0;i<6;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return 'MOG-' + s;
}

async function createPlayer(username){
  let id, exists = true;
  do {
    id = makeMogId();
    const { rows } = await pool.query('SELECT 1 FROM players WHERE id=$1', [id]);
    exists = rows.length > 0;
  } while (exists);
  const now = Date.now();
  await pool.query(
    'INSERT INTO players (id, username, created_at, last_seen) VALUES ($1,$2,$3,$4)',
    [id, username || ('MOGGER-' + id.slice(4,8)), now, now]
  );
  return getPlayer(id);
}

const PLAYER_COLUMNS = `id, username, avatar_path, avatar_mime, elo, rank_tag, ranked_matches_played,
  streak, best_streak, wins, losses, battles, personal_best_hz, highest_elo, created_at, last_seen`;
// Deliberately excludes avatar_data (can be up to 2MB) from every normal
// player read — that column is only ever fetched by getAvatarData(), the
// one place that actually needs the bytes (serving the image itself).

async function getPlayer(id){
  const { rows } = await pool.query(`SELECT ${PLAYER_COLUMNS} FROM players WHERE id=$1`, [id]);
  return rows[0] || null;
}

async function setAvatarData(id, buffer, mime){
  const avatarPath = `/api/avatar-image/${id}`;
  await pool.query('UPDATE players SET avatar_data=$1, avatar_mime=$2, avatar_path=$3 WHERE id=$4', [buffer, mime, avatarPath, id]);
  return avatarPath;
}

async function getAvatarData(id){
  const { rows } = await pool.query('SELECT avatar_data, avatar_mime FROM players WHERE id=$1', [id]);
  if(!rows[0] || !rows[0].avatar_data) return null;
  return { data: rows[0].avatar_data, mime: rows[0].avatar_mime };
}

async function touch(id){
  await pool.query('UPDATE players SET last_seen=$1 WHERE id=$2', [Date.now(), id]);
}

async function setUsername(id, username){
  await pool.query('UPDATE players SET username=$1 WHERE id=$2', [username, id]);
}

async function unlockAchievement(id, code){
  const { rows } = await pool.query('SELECT 1 FROM achievements WHERE player_id=$1 AND code=$2', [id, code]);
  if(rows.length) return false;
  await pool.query('INSERT INTO achievements (player_id, code, unlocked_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, code, Date.now()]);
  return true;
}

async function getAchievements(id){
  const { rows } = await pool.query('SELECT code, unlocked_at FROM achievements WHERE player_id=$1 ORDER BY unlocked_at DESC', [id]);
  return rows;
}

async function applySettlement(id, { opponentId, opponentName, playerHz, opponentHz, win, ranked, eloDelta, isUpset, seasonId }){
  const now = Date.now();
  const p = await getPlayer(id);
  if(!p) return null;

  const streak = win ? p.streak + 1 : 0;
  const bestStreak = Math.max(p.best_streak, streak);
  const wins = p.wins + (win?1:0);
  const losses = p.losses + (win?0:1);
  const battles = p.battles + 1;
  let personalBest = p.personal_best_hz;
  if(win && (personalBest === null || playerHz < personalBest)) personalBest = playerHz;

  const newElo = ranked ? p.elo + eloDelta : p.elo;
  const newHighest = Math.max(p.highest_elo, newElo);
  const rankedMatchesPlayed = ranked ? p.ranked_matches_played + 1 : p.ranked_matches_played;

  const { rankFor } = require('./elo');
  const rankTag = rankFor(newElo);

  await pool.query(
    `UPDATE players SET elo=$1, rank_tag=$2, ranked_matches_played=$3, streak=$4, best_streak=$5,
     wins=$6, losses=$7, battles=$8, personal_best_hz=$9, highest_elo=$10, last_seen=$11 WHERE id=$12`,
    [newElo, rankTag, rankedMatchesPlayed, streak, bestStreak, wins, losses, battles, personalBest, newHighest, now, id]
  );

  await pool.query(
    `INSERT INTO battles (player_id, opponent_id, opponent_name, player_hz, opponent_hz, win, ranked, elo_delta, is_upset, created_at, season_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, opponentId, opponentName, playerHz, opponentHz, win?1:0, ranked?1:0, ranked?eloDelta:0, isUpset?1:0, now, seasonId || null]
  );

  if(ranked && seasonId){
    await getOrCreateSeasonStats(seasonId, id);
    await pool.query(
      `UPDATE season_stats SET elo = elo + $1, wins = wins + $2, losses = losses + $3, matches = matches + 1
       WHERE season_id = $4 AND player_id = $5`,
      [eloDelta, win?1:0, win?0:1, seasonId, id]
    );
  }

  return getPlayer(id);
}

async function getLeaderboard(limit = 100){
  const { rows } = await pool.query('SELECT id, username, avatar_path, elo, rank_tag FROM players ORDER BY elo DESC LIMIT $1', [limit]);
  return rows;
}

async function getRank(id){
  const { rows } = await pool.query(
    `SELECT COUNT(*) + 1 as rnk FROM players WHERE elo > (SELECT elo FROM players WHERE id = $1)`, [id]
  );
  return rows[0] ? Number(rows[0].rnk) : null;
}

async function getHistory(id, limit = 20){
  const { rows } = await pool.query('SELECT * FROM battles WHERE player_id=$1 ORDER BY created_at DESC LIMIT $2', [id, limit]);
  return rows;
}

async function getRivalry(id, opponentId){
  const { rows } = await pool.query('SELECT win FROM battles WHERE player_id=$1 AND opponent_id=$2', [id, opponentId]);
  if(rows.length < 5) return { matches: rows.length, unlocked: false };
  const wins = rows.filter(r=>r.win).length;
  return { matches: rows.length, unlocked: true, wins, losses: rows.length - wins };
}

/* ---------------- seasons ---------------- */
const SEASON_LENGTH_MS = 8 * 7 * 24 * 60 * 60 * 1000; // 8 weeks

async function ensureActiveSeason(){
  const { rows } = await pool.query('SELECT * FROM seasons WHERE is_active = 1 ORDER BY id DESC LIMIT 1');
  const active = rows[0];
  if(active && Number(active.end_at) > Date.now()) return active;
  if(active) await pool.query('UPDATE seasons SET is_active = 0 WHERE id = $1', [active.id]);
  const { rows: countRows } = await pool.query('SELECT COUNT(*) as c FROM seasons');
  const count = Number(countRows[0].c);
  const now = Date.now();
  const names = ['DESCENT', 'REVERBERATION', 'THE ABYSS CALLS', 'LOWER OCTAVE'];
  const name = `SEASON ${String(count+1).padStart(2,'0')} — ${names[count % names.length]}`;
  const { rows: inserted } = await pool.query(
    'INSERT INTO seasons (name, start_at, end_at, is_active) VALUES ($1,$2,$3,1) RETURNING *',
    [name, now, now + SEASON_LENGTH_MS]
  );
  return inserted[0];
}

async function getActiveSeason(){ return ensureActiveSeason(); }

async function getOrCreateSeasonStats(seasonId, playerId){
  const { rows } = await pool.query('SELECT * FROM season_stats WHERE season_id=$1 AND player_id=$2', [seasonId, playerId]);
  if(rows[0]) return rows[0];
  await pool.query('INSERT INTO season_stats (season_id, player_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [seasonId, playerId]);
  const { rows: after } = await pool.query('SELECT * FROM season_stats WHERE season_id=$1 AND player_id=$2', [seasonId, playerId]);
  return after[0];
}

async function getSeasonLeaderboard(seasonId, limit = 100){
  const { rows } = await pool.query(`
    SELECT p.id, p.username, p.avatar_path, s.elo, s.wins, s.losses, s.matches
    FROM season_stats s JOIN players p ON p.id = s.player_id
    WHERE s.season_id = $1 ORDER BY s.elo DESC LIMIT $2`, [seasonId, limit]);
  return rows;
}

/* ---------------- friends ---------------- */
async function friendStatus(a, b){
  const { rows } = await pool.query(`SELECT * FROM friend_requests WHERE
    ((from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)) AND status IN ('pending','accepted')
    ORDER BY id DESC LIMIT 1`, [a,b]);
  return rows[0] || null;
}

async function sendFriendRequest(fromId, toId){
  if(fromId === toId) throw new Error('CANNOT_ADD_SELF');
  if(!(await getPlayer(toId))) throw new Error('PLAYER_NOT_FOUND');
  const existing = await friendStatus(fromId, toId);
  if(existing) throw new Error(existing.status === 'accepted' ? 'ALREADY_FRIENDS' : 'REQUEST_ALREADY_PENDING');
  await pool.query("INSERT INTO friend_requests (from_id, to_id, status, created_at) VALUES ($1,$2,'pending',$3)", [fromId, toId, Date.now()]);
  return true;
}

async function respondFriendRequest(requestId, byId, accept){
  const { rows } = await pool.query('SELECT * FROM friend_requests WHERE id=$1', [requestId]);
  const req = rows[0];
  if(!req || req.to_id !== byId || req.status !== 'pending') throw new Error('INVALID_REQUEST');
  await pool.query('UPDATE friend_requests SET status=$1, responded_at=$2 WHERE id=$3', [accept ? 'accepted' : 'declined', Date.now(), requestId]);
  return getPlayer(req.from_id);
}

async function removeFriend(playerId, otherId){
  await pool.query(`UPDATE friend_requests SET status='declined', responded_at=$1 WHERE
    ((from_id=$2 AND to_id=$3) OR (from_id=$3 AND to_id=$2)) AND status='accepted'`,
    [Date.now(), playerId, otherId]);
}

async function listFriends(playerId){
  const { rows } = await pool.query(`
    SELECT p.id, p.username, p.avatar_path, p.elo, p.rank_tag FROM friend_requests f
    JOIN players p ON p.id = (CASE WHEN f.from_id = $1 THEN f.to_id ELSE f.from_id END)
    WHERE (f.from_id = $1 OR f.to_id = $1) AND f.status = 'accepted'`, [playerId]);
  return rows;
}

async function listIncomingRequests(playerId){
  const { rows } = await pool.query(`
    SELECT f.id as request_id, p.id, p.username, p.avatar_path, p.elo, p.rank_tag FROM friend_requests f
    JOIN players p ON p.id = f.from_id
    WHERE f.to_id = $1 AND f.status = 'pending'`, [playerId]);
  return rows;
}

async function areFriends(a, b){
  const s = await friendStatus(a, b);
  return !!(s && s.status === 'accepted');
}

/* ---------------- daily/weekly challenges ---------------- */
async function getProgress(playerId, code, periodKey){
  const { rows } = await pool.query('SELECT * FROM challenge_progress WHERE player_id=$1 AND code=$2 AND period_key=$3', [playerId, code, periodKey]);
  return rows[0] || { player_id: playerId, code, period_key: periodKey, progress: 0, completed_at: null, meta: null };
}

async function incrementProgress(playerId, code, periodKey, amount, target){
  const now = Date.now();
  const current = await getProgress(playerId, code, periodKey);
  if(current.completed_at) return { progress: current.progress, justCompleted: false, alreadyDone: true };
  const newProgress = Math.min(target, current.progress + amount);
  const justCompleted = newProgress >= target;
  await pool.query(
    `INSERT INTO challenge_progress (player_id, code, period_key, progress, completed_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (player_id, code, period_key) DO UPDATE SET progress=EXCLUDED.progress, completed_at=EXCLUDED.completed_at`,
    [playerId, code, periodKey, newProgress, justCompleted ? now : null]
  );
  return { progress: newProgress, justCompleted, alreadyDone: false };
}

async function incrementDistinct(playerId, code, periodKey, value, target){
  const now = Date.now();
  const current = await getProgress(playerId, code, periodKey);
  if(current.completed_at) return { progress: current.progress, justCompleted: false, alreadyDone: true };
  const seen = current.meta ? JSON.parse(current.meta) : [];
  if(!seen.includes(value)) seen.push(value);
  const newProgress = Math.min(target, seen.length);
  const justCompleted = newProgress >= target;
  await pool.query(
    `INSERT INTO challenge_progress (player_id, code, period_key, progress, meta, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (player_id, code, period_key) DO UPDATE SET progress=EXCLUDED.progress, meta=EXCLUDED.meta, completed_at=EXCLUDED.completed_at`,
    [playerId, code, periodKey, newProgress, JSON.stringify(seen), justCompleted ? now : null]
  );
  return { progress: newProgress, justCompleted, alreadyDone: false };
}

async function listProgress(playerId, periodKeys){
  const { rows } = await pool.query(
    `SELECT * FROM challenge_progress WHERE player_id=$1 AND period_key = ANY($2::text[])`,
    [playerId, periodKeys]
  );
  return rows;
}

async function close(){ await pool.end(); }

module.exports = {
  pool, migrate, close,
  createPlayer, getPlayer, touch, setUsername, setAvatarData, getAvatarData,
  unlockAchievement, getAchievements, applySettlement,
  getLeaderboard, getRank, getHistory, getRivalry,
  ensureActiveSeason, getActiveSeason, getOrCreateSeasonStats, getSeasonLeaderboard,
  sendFriendRequest, respondFriendRequest, removeFriend, listFriends, listIncomingRequests, areFriends,
  getProgress, incrementProgress, incrementDistinct, listProgress,
};
