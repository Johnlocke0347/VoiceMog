# VoiceMog — real-time voice battler

A working full-stack build: Node/Express/WebSocket backend with real
matchmaking (two actual connected humans, never a bot), server-authoritative
Elo, a Postgres-backed persistence layer that survives a redeploy, and a
pixel-art frontend that talks to it live.

## Run it

```bash
cd server
npm install
cp .env.example .env   # then set DATABASE_URL — see "Database" below
npm start
```

Then open `http://localhost:3000` in two different browser windows (or two
devices on the same network) to actually battle — you need a second real
connection, because matchmaking will not pair you with anything else.
`localhost` is fine for mic access; if you open it from another device on
your LAN you'll need HTTPS (see Deployment below) or Chrome's
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` for local testing.

Run the test suite any time with `npm test` — it boots a real instance on
a scratch port against a real Postgres database, drives it with real
WebSocket clients, and asserts on real outcomes. 18 checks, all passing as
of this build (set `TEST_DATABASE_URL` if your test database isn't the
default `postgres://postgres:postgres@localhost:5432/voicemog_test`).

## Database

Every player, battle, avatar, friend request, season, and challenge lives
in Postgres now — not a local file. That's the entire point: a local
SQLite file (or local disk avatars) on a container's own filesystem gets
wiped on every redeploy, crash, or free-tier spin-down. Postgres doesn't
care what happens to your app server.

**Local dev**: `docker compose up` already runs a throwaway local Postgres
for you — nothing to set up.

**Production, free**: create a free database at
[neon.tech](https://neon.tech) or [supabase.com](https://supabase.com),
copy its connection string, and set it as `DATABASE_URL`. Both persist
independently of your app server and comfortably handle a hobby app at
this scale. Neon's connection string looks like
`postgres://user:pass@ep-something.region.aws.neon.tech/dbname?sslmode=require`
— paste it in as-is, the app handles SSL automatically based on whether
the host looks local.

The schema is created automatically on first boot (`db.migrate()` runs
before the server starts listening) — no separate migration command to
run, no schema file to apply by hand.

## Run it with Docker

```bash
docker compose up --build
```

Spins up the app plus a local Postgres container, wired together
automatically — zero external accounts needed for local testing. The
container itself is fully stateless (no volume to manage) since all
persistence lives in Postgres; point `DATABASE_URL` at Neon/Supabase for
a real deployment instead of the bundled local Postgres service. Set
`ALLOWED_ORIGINS` in your shell or a `.env` file before running this
anywhere but your own machine — see `server/.env.example`.

**Honest caveat**: this sandbox has no Docker daemon, so the Dockerfile
and compose file are verified by careful reading and by confirming
`package-lock.json` is in sync (so `npm ci` won't fail) — not by an actual
`docker build`. Everything else in this README — including the Postgres
migration, the persistence-survives-a-restart claim, and the avatar
upload bug fix below — was run for real, against a real locally-installed
Postgres server, not simulated.

## What's real, end-to-end, tested

Verified with automated multi-client WebSocket tests (real socket
connections, no mocking) — the full suite run before packaging covers all
of this in one pass:

- **1v1**: queue → match found → synced countdown → sequential recording →
  server-computed winner → Elo settlement → achievement unlock.
- **Friends**: send request → recipient notified live if online → accept →
  both sides updated. Tested via `POST`-free WebSocket round trip plus the
  `/api/friends/:id` read endpoint.
- **Direct friend challenges**: challenge a friend by MOG ID → they get a
  live invite (30s to respond) → accept → battle starts immediately,
  bypassing the public queue. Confirmed the resulting battle is flagged
  `isFriendMatch: true`.
- **Lobbies (2–6 real players)**: create (public or private-with-code),
  join by code or from the public list, host-only start, then a genuine
  sequential elimination bracket — every remaining player takes one turn
  per round, highest Hz is eliminated, repeat until one remains. Tested
  live with 3 simulated players across 2 rounds; the deepest voice won,
  as it should.
- **Seasons**: an active season is created automatically on first boot
  ("SEASON 01 — DESCENT", 8 weeks) and every ranked 1v1 result updates a
  season-scoped Elo/win/loss row, separate from all-time stats. Verified
  the season leaderboard reflects a battle immediately after it settles.
- **Daily/weekly challenges**: period-keyed progress (today's date /
  ISO week), so a new day or week is just a new row starting at zero — no
  cron job to forget to run. Verified `WIN_3`, `PLAY_3_DIFFERENT`, and
  `BIG_DIFFERENCE` all incremented correctly from one real battle.
- **A real notification priority queue** on the client (CRITICAL > HIGH >
  MEDIUM > LOW > BACKGROUND — higher priority items jump the stack,
  everything auto-dismisses on its own timer, repeats within 2s are
  deduped, and a visible-count cap stops one spammy event from flooding
  the screen).
- **No bots, anywhere** — checked again after this pass: matchmaking,
  direct challenges, and lobbies all only ever pair real, currently-
  connected sockets. There is still no fallback-opponent code path.
- Everything from the previous pass still holds: server-authoritative
  Elo (client sends only its own Hz), real pitch detection, avatar upload
  validated by magic bytes, rank tiers, streaks, upsets, rivalries,
  WebSocket origin allowlist + rate limiting.

## Postgres migration (this pass)

The entire persistence layer moved from a local SQLite file to Postgres,
async throughout. This wasn't a config change — every function in `db.js`
was rewritten, and every caller in `server.js`, `achievements.js`, and
`challenges.js` had to become `async`/`await` (a message handler that
touches the database is now genuinely asynchronous, where it used to be
a synchronous local file read).

**Proven, not asserted**: I installed a real PostgreSQL server, ran the
migration against it, then created a player, killed the server process
with `SIGTERM` (the exact signal a redeploy sends), started a fresh
process, and confirmed the player was still there. Ran the full 18-check
test suite against it afterward — all passing.

**Avatars moved too, and a real bug got caught doing it.** Avatar images
were still being written to local disk even after the database moved —
which would have been just as ephemeral as SQLite was, quietly
undermining the whole point of this migration. Moving them into Postgres
(as `BYTEA`) surfaced a genuine, previously-shipped bug: the browser's
`fetch()` doesn't set a `Content-Type` header on a raw binary body, and
without one, the upload was getting silently corrupted server-side —
meaning **avatar uploads likely didn't work correctly in the version
handed over last time.** Fixed on both ends: the client now sets the
file's real MIME type explicitly, and the server no longer trusts the
client to do that at all (`express.raw({ type: () => true })` — it parses
raw bytes regardless of what Content-Type shows up, since magic-byte
sniffing is the actual validation anyway). Verified with a byte-for-byte
round-trip test: upload a real PNG, restart the server, fetch it back,
`diff` against the original — identical.

## What's honestly still not built

- **Share cards** are still a manual 900×900 PNG export, not the spec's
  1080×1920 auto-triggered-on-milestone version.
- **Full CRITICAL/HIGH/MEDIUM/LOW/BACKGROUND *server-side* notification
  routing** doesn't exist — the priority queue above is real, but it's a
  client-side rendering concern fed by whatever the server already sends
  (battle results, friend events, achievements). There's no separate
  server-side notification service with its own priority/cleanup logic.
- **UI click/hover sound sourcing** — still blocked on this environment
  not having general internet access (see `public/assets/audio/README.md`).
- **Provisional-status UI, promotion/demotion animations, rank-progress
  bars** — the data exists (elo, rank_tag, ranked_matches_played) but
  there's no dedicated "you're 40 Elo from LOW FREQUENCY" progress widget.
- **Lobby results don't touch 1v1 Elo, streaks, or achievements** — a
  6-person elimination bracket doesn't map cleanly onto "win/loss" without
  more design work than fit in this pass. This is a deliberate scope cut
  to avoid corrupting 1v1 rating integrity with half-designed multiplayer
  math — see the comment at the top of `server/lobbies.js`.
- **WSS/TLS** is still a deployment concern, not application code.

## Production hardening in this pass

All of the following were added and verified working (curl'd the actual
response headers, ran the actual test suite) — not just declared:

- **Fixed a real XSS gap**: lobby names weren't sanitized server-side, and
  usernames/lobby names/opponent names were interpolated straight into
  `innerHTML` in a dozen places on the client (leaderboard, friends,
  lobby rosters, notifications). Added an `esc()` helper applied
  everywhere user-controlled text renders, plus server-side name
  sanitization on lobby creation. This was exploitable before; it isn't
  now.
- `helmet` (security headers — confirmed `X-Content-Type-Options`,
  `X-Frame-Options`, `Strict-Transport-Security` present on responses)
  and `compression` (confirmed `Content-Encoding: gzip` on a real request).
- Rate limiting on every `/api/` route (120/min), a tighter limit
  specifically on avatar upload (10/min) — confirmed via `RateLimit-*`
  response headers.
- A hard 64KB cap on WebSocket frame size (there was none before).
- `GET /healthz` for load balancer / hosting-platform health checks.
- Graceful shutdown on `SIGTERM`/`SIGINT` — notifies connected clients,
  closes the WebSocket server, closes the Postgres connection pool
  cleanly, then exits. Verified in the test suite's own teardown.
- **Postgres persistence** (see the section above) — every player,
  battle, avatar, friend, and season now survives a redeploy, a crash, or
  a free-tier spin-down, none of which the earlier SQLite-on-local-disk
  version could promise.
- Structured, timestamped logging (`server/log.js`) instead of raw
  `console.log`.
- `.env.example` + `dotenv` support for real environment-based config.
- `Dockerfile` + `docker-compose.yml` — the container itself is now fully
  stateless (no volume needed at all, since persistence moved to an
  external Postgres), and `pg` being pure JS means the image no longer
  needs native-compile build tools either.
- A **permanent test suite** (`npm test`, `server/tests/run.js`) — boots
  the real server against a real Postgres database, drives it with real
  WebSocket clients, asserts on real outcomes. Not a demo script that
  gets deleted after I show you it works. 18 checks as of this pass.

## The honest scalability limit

Matchmaking queue, active battles, and lobbies all live in server process
memory (`Map`s and arrays in `server.js`/`lobbies.js`). That means this
runs correctly on **exactly one server instance**. It will not work
correctly behind a load balancer routing to multiple instances — two
players could end up queued on different instances and never match.
Scaling beyond one instance needs a shared store (Redis, most likely) for
queue/battle/lobby state — a real architecture change, not a config flag.
Postgres itself isn't the bottleneck here — a single instance's worth of
traffic is nowhere near what a free-tier Postgres database can handle —
the in-memory matchmaking state is.

## Deployment (zero-cost options)

This needs a host that runs a persistent Node process with WebSocket
support — not a static host. As of this writing, the free-tier landscape
looks like this:

- **Render** (Web Service, free tier) — genuinely free, no card required,
  confirmed WebSocket support on free web services. The one caveat: free
  services spin down after 15 minutes of inactivity and their *local*
  filesystem is ephemeral — but since persistence now lives in Postgres
  (Neon/Supabase, also free), that no longer matters. This is the
  realistic free option.
- **Fly.io** — no longer has a real free tier; new accounts get a small
  trial credit, then it's pay-as-you-go (a hobby instance runs a few
  dollars a month).
- **Railway** — same story: a one-time trial credit, then usage-based.

Both Fly and Railway still work fine and deploy the included `Dockerfile`
directly if you're willing to pay a small amount — they're just not free
anymore the way they used to be. For genuinely zero cost, pair **Render**
(app) with **Neon or Supabase** (database) — both halves free, both
independent of each other, so one spinning down doesn't affect the other.

Whichever you pick: set `ALLOWED_ORIGINS` to your real domain before going
live (leaving it unset allows any origin — fine for local testing, a real
gap in production), set `DATABASE_URL` to your Neon/Supabase connection
string, and put it behind HTTPS (Render/Fly/Railway all do this for you
automatically) so `wss://` and mic access both work correctly.

## File map
```
server/
  server.js         — Express + WebSocket, matchmaking, battles, lobbies, friends
  log.js            — minimal structured logger
  db.js             — Postgres schema + async queries (players, battles, seasons, friends, challenges, avatars)
  elo.js            — rating math + rank tiers (shared source of truth)
  achievements.js   — achievement definitions + unlock evaluation
  challenges.js     — daily/weekly challenge definitions + period-keyed progress
  lobbies.js        — in-memory 2-6 player lobby + elimination bracket logic
  uploads.js        — avatar upload validation (magic bytes, size cap) — no filesystem access
  .env.example      — environment variables to set before deploying (DATABASE_URL, etc.)
  tests/run.js      — real end-to-end test suite (`npm test`)
public/
  index.html, css/, js/  — the frontend (lobbies, friends, challenges, seasons included)
  assets/audio/            — sound manifest + files (see its own README.md)
Dockerfile, docker-compose.yml, .dockerignore — container deployment (stateless app + local Postgres for dev)
```
