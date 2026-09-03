/* =========================================================================
   SOUND MANAGER
   Loads assets/audio/manifest.json once, then plays by SOUND ID
   ("announcer.firstBlood") — never a raw path. Priority + cooldown
   prevent overlapping announcer chaos; a null/missing manifest entry
   silently no-ops instead of throwing, since several IDs are wired up
   but have no licensed file yet (see assets/audio/README.md).
   ========================================================================= */
const SoundMgr = (() => {
  let manifest = {};
  let cooldowns = {};
  let current = null;
  let currentPriority = -1;
  let enabled = true;
  // Per-category volume: master applies to everything, sfx covers ui/battle/
  // rank/achievements/notifications, announcer covers the kill-streak callouts.
  let volumes = { master: 1, sfx: 1, announcer: 1 };

  fetch('assets/audio/manifest.json').then(r => r.json()).then(m => { manifest = m; }).catch(() => {});

  function setEnabled(v){ enabled = v; }
  function setVolume(cat, v){ volumes[cat] = Math.max(0, Math.min(1, v)); }

  function categoryFor(id){
    if(id.startsWith('announcer.')) return 'announcer';
    return 'sfx';
  }

  function play(id, {priority = 1, cooldown = 250} = {}){
    if(!enabled) return;
    const src = manifest[id];
    if(!src) return; // no file mapped yet — silent no-op, not an error
    const now = performance.now();
    if(cooldowns[id] && now - cooldowns[id] < cooldown) return;
    if(current && !current.ended && priority < currentPriority) return;
    cooldowns[id] = now;
    if(current) current.pause();
    const a = new Audio(src);
    const cat = categoryFor(id);
    a.volume = 0.85 * volumes.master * volumes[cat];
    current = a; currentPriority = priority;
    a.play().catch(()=>{});
  }

  return { play, setEnabled, setVolume };
})();
