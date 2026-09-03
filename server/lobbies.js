// lobbies.js — 2-6 player lobbies. In-memory only (lobbies are ephemeral
// sessions, not historical records — matches the "online status stays
// ephemeral" rule from the spec). Never fills an empty slot with anything
// but a real connected player.
//
// Scope note: lobby results do NOT touch 1v1 Elo, streak, or the 1v1
// achievement set in this pass — a 6-person elimination bracket doesn't
// map cleanly onto "win/loss" without more design work than fits in one
// session. Lobbies track placement and are casual by definition. See
// server/README.md.

const crypto = require('crypto');

const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const TURN_DURATION_MS = 5000;
const TURN_TIMEOUT_MS = 20000;

const lobbies = new Map(); // lobbyId -> lobby

function makeCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for(let i=0;i<5;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function publicLobby(l){
  return {
    id: l.id, name: l.name, isPublic: l.isPublic, code: l.isPublic ? undefined : l.code,
    hostId: l.hostId, hostName: l.members.find(m=>m.playerId===l.hostId)?.username,
    count: l.members.length, max: MAX_PLAYERS, state: l.state,
  };
}

function listPublicLobbies(){
  return [...lobbies.values()].filter(l => l.isPublic && l.state === 'waiting').map(publicLobby);
}

function createLobby({ hostWs, hostId, hostUsername, name, isPublic }){
  const id = crypto.randomBytes(6).toString('hex');
  const lobby = {
    id, name: (name || `${hostUsername}'s Arena`).slice(0, 30),
    isPublic: !!isPublic, code: makeCode(), hostId,
    members: [{ ws: hostWs, playerId: hostId, username: hostUsername, hz: null, eliminated: false }],
    state: 'waiting', // waiting | recording | settled
    round: 0, order: [], turnIndex: 0, timeoutHandle: null,
  };
  lobbies.set(id, lobby);
  return lobby;
}

function findByCode(code){
  return [...lobbies.values()].find(l => l.code.toUpperCase() === String(code).toUpperCase() && l.state === 'waiting');
}

function joinLobby(lobby, { ws, playerId, username }){
  if(lobby.state !== 'waiting') throw new Error('LOBBY_ALREADY_STARTED');
  if(lobby.members.length >= MAX_PLAYERS) throw new Error('LOBBY_FULL');
  if(lobby.members.some(m => m.playerId === playerId)) throw new Error('ALREADY_IN_LOBBY');
  lobby.members.push({ ws, playerId, username, hz: null, eliminated: false });
}

function leaveLobby(lobby, playerId){
  lobby.members = lobby.members.filter(m => m.playerId !== playerId);
  if(lobby.members.length === 0){ lobbies.delete(lobby.id); return { deleted: true }; }
  if(lobby.hostId === playerId){
    lobby.hostId = lobby.members[0].playerId; // host migration
    return { deleted: false, newHostId: lobby.hostId };
  }
  return { deleted: false };
}

function findLobbyByPlayer(playerId){
  for(const l of lobbies.values()){
    if(l.members.some(m => m.playerId === playerId)) return l;
  }
  return null;
}

function getLobby(id){ return lobbies.get(id); }
function deleteLobby(id){ lobbies.delete(id); }

module.exports = {
  MAX_PLAYERS, MIN_PLAYERS, TURN_DURATION_MS, TURN_TIMEOUT_MS,
  lobbies, publicLobby, listPublicLobbies, createLobby, findByCode,
  joinLobby, leaveLobby, findLobbyByPlayer, getLobby, deleteLobby,
};
