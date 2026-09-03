// achievements.js — a real subset of the full list from the spec, wired
// end-to-end (unlock stored in SQLite, no duplicates, sent to the client
// as a notification). Not every achievement in the brief is implemented
// yet — see server/README.md "Scope" section for the honest list of
// what's stubbed vs built.
const { unlockAchievement } = require('./db');

const DEFS = {
  FIRST_BLOOD:    { name: 'FIRST BLOOD',    desc: 'Win your first battle.',                 rarity: 'COMMON' },
  WINNING_WAYS:   { name: 'WINNING WAYS',   desc: 'Win 10 battles.',                        rarity: 'UNCOMMON' },
  HOT_THROAT:     { name: 'HOT THROAT',     desc: 'Reach a 5 win streak.',                  rarity: 'RARE' },
  UNSTOPPABLE:    { name: 'UNSTOPPABLE',    desc: 'Reach a 10 win streak.',                 rarity: 'EPIC' },
  STREAK_BREAKER: { name: 'STREAK BREAKER', desc: "End an opponent's 5+ win streak.",       rarity: 'RARE' },
  GIANT_SLAYER:   { name: 'GIANT SLAYER',   desc: 'Beat an opponent 200+ Elo above you.',   rarity: 'EPIC' },
  SUB_BASS:       { name: 'SUB-BASS',       desc: 'Record a sub-80Hz voice.',               rarity: 'RARE' },
  FOUR_FIGURES:   { name: 'FOUR FIGURES',   desc: 'Reach 1000 Elo.',                        rarity: 'UNCOMMON' },
  RIVALRY:        { name: 'RIVALRY',        desc: 'Play the same opponent 5 times.',        rarity: 'COMMON' },
  HUNDRED_WINS:   { name: '100 WINS',       desc: 'Win 100 battles.',                       rarity: 'LEGENDARY' },
};

// Returns an array of {code, ...def} for anything newly unlocked this battle.
async function evaluate(playerId, { player, win, wasUpset, endedOpponentStreak, youHz }){
  const unlocked = [];
  async function tryUnlock(code){
    if(await unlockAchievement(playerId, code)) unlocked.push({ code, ...DEFS[code] });
  }
  if(win){
    if(player.wins === 1) await tryUnlock('FIRST_BLOOD');
    if(player.wins === 10) await tryUnlock('WINNING_WAYS');
    if(player.wins === 100) await tryUnlock('HUNDRED_WINS');
    if(player.streak === 5) await tryUnlock('HOT_THROAT');
    if(player.streak === 10) await tryUnlock('UNSTOPPABLE');
    if(wasUpset) await tryUnlock('GIANT_SLAYER');
    if(youHz < 80) await tryUnlock('SUB_BASS');
  }
  if(endedOpponentStreak) await tryUnlock('STREAK_BREAKER');
  if(player.elo >= 1000) await tryUnlock('FOUR_FIGURES');
  return unlocked;
}

module.exports = { DEFS, evaluate };
