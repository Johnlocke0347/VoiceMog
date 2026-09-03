// tests/run.js — `npm test` entry point.
//
// This is not a mocked unit-test suite: it boots the actual server on a
// scratch port with a throwaway database, connects real WebSocket
// clients to it, and asserts on what comes back. If this passes, the
// core gameplay loop actually works right now, not "worked when someone
// wrote it."
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3901;
const BASE = `http://localhost:${PORT}`;
const WS_BASE = `ws://localhost:${PORT}`;

let failures = 0;
function assert(cond, msg){
  if(!cond){ failures++; console.error(`  ✗ FAIL: ${msg}`); }
  else console.log(`  ✓ ${msg}`);
}

function makeClient(username){
  const ws = new WebSocket(WS_BASE);
  const handlers = {};
  const c = { ws, me: null, on:(t,f)=>{handlers[t]=f;}, send:(type,payload={})=>ws.send(JSON.stringify({type,...payload})) };
  ws.on('open', () => c.send('hello', {username}));
  ws.on('error', (err) => { console.error('  (client socket error)', err.message); });
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if(msg.type === 'hello_ack') c.me = msg.player;
    if(handlers[msg.type]) handlers[msg.type](msg);
  });
  return c;
}
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
function once(client, type){ return new Promise(res => client.on(type, res)); }

async function test1v1(){
  console.log('\n[1v1 + Elo]');
  const A = makeClient('Alpha'), B = makeClient('Beta');
  await wait(300);
  const resA = new Promise(res => A.on('battle_result', res));
  const resB = new Promise(res => B.on('battle_result', res));
  A.on('your_turn_record', () => setTimeout(()=>A.send('submit_hz',{hz:95}), 80));
  B.on('your_turn_record', () => setTimeout(()=>B.send('submit_hz',{hz:160}), 80));
  A.on('match_found', () => A.send('ready'));
  B.on('match_found', () => B.send('ready'));
  A.send('queue', {mode:'ranked'}); B.send('queue', {mode:'ranked'});
  const [rA, rB] = await Promise.all([resA, resB]);

  assert(rA.win === true, 'deeper voice (95Hz) wins');
  assert(rB.win === false, 'shallower voice (160Hz) loses');
  assert(rA.newElo > 200, 'winner Elo increased from starting 200');
  assert(rB.newElo < 200, 'loser Elo decreased from starting 200');
  assert(rA.streak === 1, 'winner streak is 1');
  A.ws.close(); B.ws.close();
}

async function testFriendsAndChallenge(){
  console.log('\n[Friends + direct challenge]');
  const A = makeClient('ChallA'), B = makeClient('ChallB');
  await wait(300);
  const reqSent = new Promise(res => A.on('friend_request_sent', res));
  const reqReceived = new Promise(res => B.on('friend_request_received', res));
  A.send('friend_request', { toId: B.me.id });
  await Promise.all([reqSent, reqReceived]);

  const incoming = await fetch(`${BASE}/api/friends/${B.me.id}`).then(r=>r.json());
  assert(incoming.incoming.length === 1, 'friend request appears in recipient inbox');
  const requestId = incoming.incoming[0].request_id;

  const acceptedNotice = new Promise(res => A.on('friend_request_accepted', res));
  B.send('friend_respond', { requestId, accept: true });
  await acceptedNotice;

  const friendsNow = await fetch(`${BASE}/api/friends/${A.me.id}`).then(r=>r.json());
  assert(friendsNow.friends.some(f => f.id === B.me.id), 'accepted friend appears in friends list');

  const inviteReceived = new Promise(res => B.on('challenge_invite', res));
  A.send('challenge_friend', { friendId: B.me.id, mode: 'casual' });
  const invite = await inviteReceived;
  const mfA = new Promise(res => A.on('match_found', res));
  const mfB = new Promise(res => B.on('match_found', res));
  B.send('challenge_respond', { inviteId: invite.inviteId, accept: true });
  await Promise.all([mfA, mfB]);

  A.send('ready'); B.send('ready');
  const crA = new Promise(res => A.on('battle_result', res));
  const crB = new Promise(res => B.on('battle_result', res));
  A.on('your_turn_record', () => setTimeout(()=>A.send('submit_hz',{hz:100}), 80));
  B.on('your_turn_record', () => setTimeout(()=>B.send('submit_hz',{hz:200}), 80));
  const [resultA] = await Promise.all([crA, crB]);
  assert(resultA.isFriendMatch === true, 'direct challenge battle is flagged as a friend match');

  A.ws.close(); B.ws.close();
}

async function testLobby(){
  console.log('\n[3-player lobby elimination]');
  const L1 = makeClient('Host'), L2 = makeClient('Guest2'), L3 = makeClient('Guest3');
  await wait(300);

  const lobbyStatePromise1 = once(L1, 'lobby_state');
  L1.send('lobby_create', { name: 'Test Arena', isPublic: true });
  const lobbyState1 = await lobbyStatePromise1;
  const code = lobbyState1.lobby.code;

  const joined2 = once(L2, 'lobby_state');
  L2.send('lobby_join', { code });
  await joined2;
  const joined3 = once(L3, 'lobby_state');
  L3.send('lobby_join', { code });
  await joined3;

  const hzMap = { [L1.me?.id]: 70 }; // filled in after we know ids below
  const nameToHz = { 'Host': 70, 'Guest2': 150, 'Guest3': 250 };
  const clientsByName = { Host: L1, Guest2: L2, Guest3: L3 };
  for(const [name, c] of Object.entries(clientsByName)){
    c.on('lobby_your_turn', () => setTimeout(()=>c.send('lobby_submit_hz', {hz: nameToHz[name]}), 80));
  }
  const finalPromises = [L1,L2,L3].map(c => new Promise(res => c.on('lobby_final', res)));
  L1.send('lobby_start');
  const finals = await Promise.race([Promise.all(finalPromises), wait(15000).then(()=>null)]);
  assert(!!finals, 'lobby completed within timeout');
  if(finals) assert(finals[0].winner === 'Host', 'deepest voice (Host, 70Hz) wins the lobby');

  [L1,L2,L3].forEach(c=>c.ws.close());
}

async function testChallengesAndSeason(){
  console.log('\n[Challenges + season tracking]');
  const A = makeClient('ChalTester'), B = makeClient('ChalRival');
  await wait(300);
  const resA = new Promise(res => A.on('battle_result', res));
  const resB = new Promise(res => B.on('battle_result', res));
  A.on('your_turn_record', () => setTimeout(()=>A.send('submit_hz',{hz:80}), 80));
  B.on('your_turn_record', () => setTimeout(()=>B.send('submit_hz',{hz:250}), 80));
  A.on('match_found', () => A.send('ready'));
  B.on('match_found', () => B.send('ready'));
  A.send('queue', {mode:'ranked'}); B.send('queue', {mode:'ranked'});
  await Promise.all([resA, resB]);
  await wait(200);

  const chal = await fetch(`${BASE}/api/challenges/${A.me.id}`).then(r=>r.json());
  const win3 = chal.daily.find(c=>c.code==='WIN_3');
  const bigDiff = chal.daily.find(c=>c.code==='BIG_DIFFERENCE');
  assert(win3.progress === 1, 'WIN_3 challenge progressed after a win');
  assert(bigDiff.completed_at !== null, 'BIG_DIFFERENCE challenge auto-completed on a 40+Hz win');

  const season = await fetch(`${BASE}/api/season`).then(r=>r.json());
  const inSeason = season.leaderboard.find(p => p.id === A.me.id);
  assert(!!inSeason && inSeason.wins === 1, 'season leaderboard reflects the battle immediately');

  A.ws.close(); B.ws.close();
}

async function testSecurity(){
  console.log('\n[Security spot-checks]');
  const bad = await fetch(`${BASE}/api/avatar/NONEXISTENT-ID`, { method:'POST', body: Buffer.from('not an image') });
  assert(bad.status === 404, 'avatar upload to a nonexistent player id is rejected');

  const A = makeClient('SecTester');
  await wait(300);
  const fakeAvatarRes = await fetch(`${BASE}/api/avatar/${A.me.id}`, { method:'POST', body: Buffer.from('<script>alert(1)</script>') });
  const fakeAvatarJson = await fakeAvatarRes.json();
  assert(fakeAvatarRes.status === 400 && fakeAvatarJson.error === 'UNSUPPORTED_FILE_TYPE', 'non-image bytes are rejected by magic-byte sniffing, not trusted content-type');

  // A real (tiny, 1x1) PNG — valid magic bytes — should be accepted, stored
  // in Postgres (not the filesystem), and served back correctly.
  const tinyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000155a5c4270000000049454e44ae426082', 'hex');
  const uploadRes = await fetch(`${BASE}/api/avatar/${A.me.id}`, { method:'POST', body: tinyPng });
  const uploadJson = await uploadRes.json();
  assert(uploadRes.status === 200 && typeof uploadJson.avatarPath === 'string', 'a real PNG upload is accepted');

  const imgRes = await fetch(`${BASE}${uploadJson.avatarPath}`);
  const imgBuf = Buffer.from(await imgRes.arrayBuffer());
  assert(imgRes.headers.get('content-type') === 'image/png', 'served avatar has the correct content-type');
  assert(imgBuf.equals(tinyPng), 'served avatar bytes match exactly what was uploaded (round-tripped through Postgres, not disk)');

  A.ws.close();
}

async function main(){
  const databaseUrl = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/voicemog_test';
  console.log(`Booting server on :${PORT} against a scratch test database...`);

  // Wipe the test database's tables so each run starts clean — the schema
  // gets recreated by the server's own migrate() on boot, we just need to
  // drop old rows from a previous run first.
  const { Client } = require('pg');
  const cleanupClient = new Client({ connectionString: databaseUrl });
  await cleanupClient.connect();
  await cleanupClient.query(`
    DROP TABLE IF EXISTS challenge_progress, friend_requests, season_stats, seasons, achievements, battles, players CASCADE;
  `);
  await cleanupClient.end();

  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
    stdio: 'inherit',
  });

  process.on('exit', () => { try{ server.kill(); }catch{} });

  await wait(1800); // let it boot

  try{
    await test1v1();
    await testFriendsAndChallenge();
    await testLobby();
    await testChallengesAndSeason();
    await testSecurity();
  } catch(err){
    console.error('\nTest run threw an unexpected error:', err);
    failures++;
  }

  server.kill();

  console.log(`\n${failures === 0 ? '✅ ALL TESTS PASSED' : `❌ ${failures} ASSERTION(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
