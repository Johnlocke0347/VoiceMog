// challenges.js — daily/weekly challenge definitions + evaluation.
// Reset is "automatic" by construction: progress is keyed by a period
// string (today's date, or this ISO week), so a new day/week is simply a
// new row starting at 0 — no cron job, no reset script, nothing to forget
// to run.
const db = require('./db');

const DAILY = [
  { code: 'WIN_3',            name: 'WIN 3',                  target: 3 },
  { code: 'WIN_5_RANKED',     name: 'WIN 5 RANKED',            target: 5 },
  { code: 'PLAY_3_DIFFERENT', name: 'PLAY 3 DIFFERENT PLAYERS',target: 3, distinct: true },
  { code: 'DEFEAT_HIGHER',    name: 'DEFEAT HIGHER-RATED PLAYER', target: 1 },
  { code: 'BIG_DIFFERENCE',   name: 'BIG DIFFERENCE (40+ Hz)', target: 1 },
  { code: 'PLAY_A_FRIEND',    name: 'PLAY A FRIEND',           target: 1 },
  { code: 'END_A_STREAK',     name: 'END A STREAK',            target: 1 },
];
// Meta-challenge evaluated separately: complete 5 of the above in one day.
const COMPLETE_5 = { code: 'COMPLETE_5', name: 'COMPLETE 5 CHALLENGES', target: 5 };

const WEEKLY = [
  { code: 'WIN_15_RANKED',    name: 'WIN 15 RANKED',           target: 15 },
  { code: 'PLAY_25_MATCHES',  name: 'PLAY 25 MATCHES',         target: 25 },
  { code: 'STREAK_5',         name: 'ACHIEVE A 5 WIN STREAK',  target: 1 },
  { code: 'GET_3_UPSETS',     name: 'GET 3 UPSETS',            target: 3 },
  { code: 'DIFFERENT_RANKS',  name: 'PLAY AGAINST 3 DIFFERENT RANKS', target: 3, distinct: true },
  { code: 'FRIEND_MATCHES',   name: 'PLAY 5 FRIEND MATCHES',   target: 5 },
];

function dailyKey(d = new Date()){ return d.toISOString().slice(0,10); } // YYYY-MM-DD (UTC)
function weeklyKey(d = new Date()){
  // ISO week number, UTC-based
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2,'0')}`;
}

// Called once per settled 1v1 battle, for each participant, with facts
// the server already trusts. Returns { daily: [...newlyCompleted], weekly: [...] }.
async function evaluateBattle(playerId, facts){
  const dKey = dailyKey(), wKey = weeklyKey();
  const completed = { daily: [], weekly: [] };

  async function bump(list, def, amount, periodKey, isWeekly){
    if(def.distinct) return; // distinct challenges use bumpDistinct instead
    const r = await db.incrementProgress(playerId, def.code, periodKey, amount, def.target);
    if(r.justCompleted) (isWeekly?completed.weekly:completed.daily).push(def);
    return r;
  }
  async function bumpDistinct(def, value, periodKey, isWeekly){
    const r = await db.incrementDistinct(playerId, def.code, periodKey, value, def.target);
    if(r.justCompleted) (isWeekly?completed.weekly:completed.daily).push(def);
    return r;
  }

  // --- daily ---
  if(facts.win) await bump(DAILY, DAILY[0], 1, dKey, false);                                  // WIN_3
  if(facts.win && facts.ranked) await bump(DAILY, DAILY[1], 1, dKey, false);                   // WIN_5_RANKED
  await bumpDistinct(DAILY[2], facts.opponentId, dKey, false);                                 // PLAY_3_DIFFERENT
  if(facts.win && facts.isUpset) await bump(DAILY, DAILY[3], 1, dKey, false);                  // DEFEAT_HIGHER
  if(facts.win && facts.hzDiff >= 40) await bump(DAILY, DAILY[4], 1, dKey, false);             // BIG_DIFFERENCE
  if(facts.isFriendMatch) await bump(DAILY, DAILY[5], 1, dKey, false);                         // PLAY_A_FRIEND
  if(facts.win && facts.endedOpponentStreak) await bump(DAILY, DAILY[6], 1, dKey, false);      // END_A_STREAK

  // meta: count how many daily challenges are now complete today
  const dailyRows = await db.listProgress(playerId, [dKey]);
  const doneToday = dailyRows.filter(r => r.completed_at && r.code !== COMPLETE_5.code).length;
  const meta = await db.incrementProgress(playerId, COMPLETE_5.code, dKey, 0, COMPLETE_5.target); // read current
  if(doneToday > meta.progress){
    const bumped = await db.incrementProgress(playerId, COMPLETE_5.code, dKey, doneToday - meta.progress, COMPLETE_5.target);
    if(bumped.justCompleted) completed.daily.push(COMPLETE_5);
  }

  // --- weekly ---
  if(facts.win && facts.ranked) await bump(WEEKLY, WEEKLY[0], 1, wKey, true);                  // WIN_15_RANKED
  await bump(WEEKLY, WEEKLY[1], 1, wKey, true);                                                // PLAY_25_MATCHES
  if(facts.streakAfter >= 5) await bump(WEEKLY, WEEKLY[2], 1, wKey, true);                     // STREAK_5 (one-shot)
  if(facts.win && facts.isUpset) await bump(WEEKLY, WEEKLY[3], 1, wKey, true);                 // GET_3_UPSETS
  await bumpDistinct(WEEKLY[4], facts.opponentRankTag, wKey, true);                            // DIFFERENT_RANKS
  if(facts.isFriendMatch) await bump(WEEKLY, WEEKLY[5], 1, wKey, true);                        // FRIEND_MATCHES

  return completed;
}

async function listForPlayer(playerId){
  const dKey = dailyKey(), wKey = weeklyKey();
  const rows = await db.listProgress(playerId, [dKey, wKey]);
  const byCode = Object.fromEntries(rows.map(r => [r.code+'|'+r.period_key, r]));
  const daily = [...DAILY, COMPLETE_5].map(def => ({ ...def, ...(byCode[def.code+'|'+dKey] || { progress:0, completed_at:null }) }));
  const weekly = WEEKLY.map(def => ({ ...def, ...(byCode[def.code+'|'+wKey] || { progress:0, completed_at:null }) }));
  return { daily, weekly, dailyKey: dKey, weeklyKey: wKey };
}

module.exports = { DAILY, WEEKLY, COMPLETE_5, dailyKey, weeklyKey, evaluateBattle, listForPlayer };
