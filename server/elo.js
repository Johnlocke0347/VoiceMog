// elo.js — server-authoritative Elo settlement. Client never supplies
// winner/rating/rank — only its own measured Hz. This module decides
// everything else from data the server already trusts.

const RANKS = [
  { min: 0,    tag: 'GRUNTER' },
  { min: 400,  tag: 'LOW FREQUENCY' },
  { min: 800,  tag: 'BASS BRUTE' },
  { min: 1200, tag: 'VOCAL MENACE' },
  { min: 1600, tag: 'VOICE OF DOOM' },
  { min: 2000, tag: 'THE MOG' },
  { min: 2400, tag: 'MOG LEGEND' },
  { min: 2800, tag: 'THE ABYSS' },
];

function rankFor(elo){
  let tag = RANKS[0].tag;
  for(const r of RANKS){ if(elo >= r.min) tag = r.tag; }
  return tag;
}

function nextRankThreshold(elo){
  for(const r of RANKS){ if(elo < r.min) return r.min; }
  return null; // already at max tier
}

// K = 48 for a player's first 10 ranked matches (provisional), 32 after.
function kFactor(rankedMatchesPlayed){
  return rankedMatchesPlayed < 10 ? 48 : 32;
}

function expectedScore(ratingA, ratingB){
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// Returns the integer rating delta for the winner's perspective is handled
// by calling this twice (once per player) with the correct `score`.
function ratingDelta(myRating, oppRating, score, k){
  const expected = expectedScore(myRating, oppRating);
  return Math.round(k * (score - expected));
}

module.exports = { RANKS, rankFor, nextRankThreshold, kFactor, expectedScore, ratingDelta };
