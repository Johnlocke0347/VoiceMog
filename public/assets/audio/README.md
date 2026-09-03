# VoiceMog Audio — plug-and-play guide

All sound goes through `assets/audio/manifest.json`. Code never hardcodes a
path — it calls `SoundMgr.play('announcer.firstBlood')` and the manifest
resolves the file. A `null` entry means the ID is wired up and will fire at
the right moment, it just has no file yet — playback silently no-ops.

## Folder structure
```
public/assets/audio/
  manifest.json       — the single source of truth (id → path)
  ui/                  — short interface sounds (click, select, open — see LICENSES.md)
  battle/              — countdown, fight, victory, defeat
  announcer/           — the dramatic kill-streak style callouts
  rank/                — rank up / rank down
  achievements/        — unlock stinger
  notifications/       — personal record, upset, streak ended
  lobby/               — create / join / full
```

## What's already filled in (your original files, remapped)
| Manifest ID | File | Was originally |
|---|---|---|
| `announcer.firstBlood` | `announcer/first-blood.mp3` | `first_blood.mp3` |
| `announcer.doubleKill` | `announcer/double-kill.mp3` | `double_kill.mp3` |
| `announcer.multiKill` | `announcer/multi-kill.mp3` | `multi_kill.mp3` |
| `announcer.killingSpree` | `announcer/killing-spree.mp3` | `killing_spree.mp3` |
| `announcer.rampage` | `announcer/rampage.mp3` | `rampage.mp3` |
| `announcer.ultraKill` | `announcer/ultra-kill.mp3` | `ultra_kill.mp3` |
| `announcer.monsterKill` | `announcer/monster-kill.mp3` | `monster_kill.mp3` |
| `announcer.unstoppable` | `announcer/unstoppable.mp3` | `unstoppable.mp3` |
| `announcer.godlike` | `announcer/godlike.mp3` | `god_like.mp3` |
| `battle.fight` | `battle/fight.mp3` | `pick_up_your_weappons_and_fight.mp3` |
| `battle.defeat` | `battle/defeat.mp3` | `humiliation.mp3` |
| `battle.victory` | reuses `announcer/first-blood.mp3` | — no distinct victory stinger was supplied |
| `rank.rankUp` | `rank/rank-up.mp3` | `headshot.mp3` |
| `achievements.unlock` | `achievements/unlock.mp3` | `the_force_will_be_with_you_always.mp3` |
| `notifications.personalRecord` | `notifications/personal-record.mp3` | `holy_shit.mp3` |

**Read this before you launch:** those original files are the Unreal
Tournament announcer voice pack — Epic Games' IP, not original audio.
They're wired up so the whole priority/cooldown system is demonstrably
working, but they are a real legal exposure in a public product. Replace
everything in `announcer/`, `battle/fight.mp3`, and `achievements/unlock.mp3`
before this goes live — licensed SFX, an AI-voiced announcer, or a voice
actor doing original takes in the same energy.

## What's missing (drop files in, they'll just work)
Countdown ticks (`battle/countdown-3.mp3`, `-2`, `-1`), a real
`battle/victory.mp3`, `rank/rank-down.mp3`, and everything under
`notifications/` and `lobby/` beyond what's listed above have no file yet.
Add the file at the path the manifest already points to (or add a new
manifest entry) and it starts playing — no code change needed.

## UI sounds (ui/click, ui/hover, etc.) — sourced from Mixkit
Three UI sounds were added from **Mixkit** (https://mixkit.co) — free for
commercial use, no attribution required. See `ui/LICENSES.md` for the full
source/license record. `ui.hover` remains unmapped (no hover sound — would
be annoying with only three clips); drop a file at `ui/hover.wav` and add a
manifest entry if you want one.

## Adding a new sound
1. Drop the file anywhere under `assets/audio/<category>/`.
2. Add or update its entry in `manifest.json`.
3. Call it from code: `SoundMgr.play('yourNewId', { priority: 2, cooldown: 300 })`.

Priority: higher-priority sounds interrupt lower-priority ones currently
playing; a lower-or-equal priority sound is dropped instead of queued, so
the app never stacks announcer clips. Cooldown (ms) prevents one ID from
re-firing faster than that interval.
