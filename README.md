# VoiceMog

Real-time voice battle game. Queue up, get matched with a real person, and the deepest voice wins. Built with Node/Express/WebSocket, Postgres, and a pixel-art frontend.

## Quick start

```bash
cd server
npm install
cp .env.example .env   # set DATABASE_URL (see below)
npm start
```

Open `http://localhost:3000` in two browser windows to battle. Run tests with `npm test`.

## Database

All data lives in Postgres (players, battles, avatars, friends, seasons, challenges). The schema auto-creates on first boot.

- **Local dev:** `docker compose up` runs a local Postgres — no setup needed.
- **Production:** create a free database at [neon.tech](https://neon.tech) or [supabase.com](https://supabase.com) and set its connection string as `DATABASE_URL`.

## Docker

```bash
docker compose up --build
```

The app container is fully stateless — point `DATABASE_URL` at a real database for production.

## Features

- **1v1 matchmaking** — real humans only, never bots. Sequential 5-second turns with server-enforced order so voices never interfere.
- **Elo ranking** — server-authoritative rating with rank tiers, streaks, upsets, and rivalries.
- **Lobbies** — 2–6 player private or public rooms with sequential elimination brackets.
- **Friends** — add by MOG ID, send live challenges, accept/decline with a themed modal.
- **Seasons & challenges** — auto-created 8-week seasons plus daily/weekly challenges with automatic period resets.
- **Share cards** — downloadable 900×900 battle result cards with both player profiles.
- **Audio** — announcer kill-streak callouts, UI sounds, and per-category volume controls.
- **Responsive** — works across phones, tablets, and desktops with touch-friendly targets and notch-safe layouts.

## Tech stack

Node · Express · WebSocket (`ws`) · PostgreSQL (`pg`) · vanilla JS frontend · Docker

## Security

Helmet headers, rate limiting (120/min API, 10/min uploads), WebSocket origin allowlist, 64KB frame cap, server-side input sanitization, magic-byte avatar validation, and graceful shutdown.

## Deployment

Deploy to **Render** (free tier, WebSocket-supported) with a **Neon or Supabase** database (free). Set `ALLOWED_ORIGINS` to your domain and `DATABASE_URL` to your connection string. HTTPS and `wss://` are handled automatically.

## Project structure

```
server/
  server.js         — Express + WebSocket, matchmaking, battles, lobbies, friends
  db.js             — Postgres schema + queries
  elo.js            — rating math + rank tiers
  achievements.js   — achievement definitions + evaluation
  challenges.js     — daily/weekly challenges + progress
  lobbies.js        — 2–6 player lobby + elimination bracket
  uploads.js        — avatar upload validation (magic bytes)
  log.js            — structured logger
  tests/run.js      — end-to-end test suite
public/
  index.html, css/, js/
  assets/audio/     — sound manifest + files
Dockerfile, docker-compose.yml, .dockerignore