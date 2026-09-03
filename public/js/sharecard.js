/* =========================================================================
   SHARE CARD RENDERER — pure canvas drawing with no app-state deps.
   Used by app.js (downloadShareCard / downloadLobbyCard) and by
   share-card-preview.html. Two cards:
     battle(canvas, d) — 1v1: both player profiles (avatar, name, rank,
       Elo), their Hz, winner highlighted, headline + reward line.
     lobby(canvas, d)  — all players ranked list: avatar, name, rank, Hz,
       winner row highlighted.
   Both return a Promise (avatars load asynchronously).
   ========================================================================= */
const ShareCard = (() => {
  const FONT = '"JetBrains Mono", "Courier New", monospace';

  function loadImage(src){
    return new Promise(res => {
      if(!src) return res(null);
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = src;
    });
  }

  function short(s, n){
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function frame(ctx, title, subtitle){
    ctx.fillStyle = '#040303';
    ctx.fillRect(0, 0, 900, 900);
    const g = ctx.createRadialGradient(450, 440, 80, 450, 440, 560);
    g.addColorStop(0, 'rgba(122,13,19,0.38)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 900, 900);
    ctx.strokeStyle = '#7a0d13';
    ctx.lineWidth = 10;
    ctx.strokeRect(20, 20, 860, 860);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e2222f';
    ctx.font = 'bold 44px ' + FONT;
    ctx.fillText(title, 450, 92);
    ctx.fillStyle = '#7a7069';
    ctx.font = 'bold 19px ' + FONT;
    ctx.fillText(subtitle, 450, 128);
  }

  function avatar(ctx, img, x, y, size, highlight){
    ctx.fillStyle = '#171210';
    ctx.fillRect(x, y, size, size);
    if(img){
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, size, size);
      ctx.clip();
      const s = Math.max(size / img.width, size / img.height);
      const w = img.width * s, h = img.height * s;
      ctx.drawImage(img, x + (size - w) / 2, y + (size - h) / 2, w, h);
      ctx.restore();
    } else {
      ctx.fillStyle = '#7a7069';
      ctx.font = 'bold ' + Math.round(size / 3.2) + 'px ' + FONT;
      ctx.textAlign = 'center';
      ctx.fillText('MOG', x + size / 2, y + size / 2 + size / 10);
    }
    ctx.lineWidth = highlight ? 6 : 3;
    ctx.strokeStyle = highlight ? '#e2222f' : '#3a332f';
    if(highlight){ ctx.shadowColor = '#ff3b3b'; ctx.shadowBlur = 22; }
    ctx.strokeRect(x, y, size, size);
    ctx.shadowBlur = 0;
  }

  function banner(ctx, text, cx, y, color){
    ctx.font = 'bold 18px ' + FONT;
    const w = ctx.measureText(text).width + 28;
    ctx.fillStyle = color;
    ctx.fillRect(cx - w / 2, y, w, 32);
    ctx.fillStyle = '#040303';
    ctx.textAlign = 'center';
    ctx.fillText(text, cx, y + 22);
  }

  /* ---- 1v1 battle card ---- */
  async function battle(canvas, d){
    const ctx = canvas.getContext('2d');
    const [imgMe, imgOpp] = await Promise.all([
      loadImage(d.me.avatar), loadImage(d.opp.avatar)
    ]);
    frame(ctx, 'VOICEMOG', d.mode || '1V1 BATTLE');

    const L = 245, R = 655, AY = 195, AS = 170;
    banner(ctx, 'WINNER', d.iWon ? L : R, AY - 46, '#e2222f');

    avatar(ctx, imgMe, L - AS / 2, AY, AS, d.iWon);
    avatar(ctx, imgOpp, R - AS / 2, AY, AS, !d.iWon);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#e2222f';
    ctx.font = 'bold 46px ' + FONT;
    ctx.shadowColor = 'rgba(226,34,47,.65)'; ctx.shadowBlur = 16;
    ctx.fillText('VS', 450, AY + AS / 2 + 16);
    ctx.shadowBlur = 0;

    ctx.font = 'bold 28px ' + FONT;
    ctx.fillStyle = '#f0e9de';
    ctx.fillText(short(d.me.name, 14), L, AY + AS + 44);
    ctx.fillText(short(d.opp.name, 14), R, AY + AS + 44);
    ctx.font = 'bold 16px ' + FONT;
    ctx.fillStyle = '#e2222f';
    ctx.fillText(short(d.me.rank || '', 18), L, AY + AS + 72);
    ctx.fillText(short(d.opp.rank || '', 18), R, AY + AS + 72);
    ctx.fillStyle = '#7a7069';
    ctx.fillText(d.me.elo != null ? d.me.elo + ' ELO' : ' ', L, AY + AS + 97);
    ctx.fillText(d.opp.elo != null ? d.opp.elo + ' ELO' : ' ', R, AY + AS + 97);

    ctx.font = 'bold 54px ' + FONT;
    ctx.fillStyle = d.iWon ? '#ff3b3b' : '#7a7069';
    ctx.fillText(d.me.hz + ' Hz', L, AY + AS + 170);
    ctx.fillStyle = d.iWon ? '#7a7069' : '#ff3b3b';
    ctx.fillText(d.opp.hz + ' Hz', R, AY + AS + 170);

    ctx.font = 'bold 66px ' + FONT;
    ctx.fillStyle = d.iWon ? '#ff3b3b' : '#7a7069';
    if(d.iWon){ ctx.shadowColor = 'rgba(255,59,59,.6)'; ctx.shadowBlur = 24; }
    ctx.fillText(short(d.headline, 16), 450, 722);
    ctx.shadowBlur = 0;

    ctx.font = 'bold 22px ' + FONT;
    ctx.fillStyle = '#b8ab9c';
    ctx.fillText(d.sub || '', 450, 772);

    ctx.font = '16px ' + FONT;
    ctx.fillStyle = '#3a332f';
    ctx.fillText('voicemog — think your voice is deeper?', 450, 850);
  }

  /* ---- lobby results card ---- */
  async function lobby(canvas, d){
    const ctx = canvas.getContext('2d');
    const imgs = await Promise.all(d.players.map(p => loadImage(p.avatar)));
    frame(ctx, 'VOICEMOG', (short(d.name, 24) + ' · LOBBY RESULTS').toUpperCase());

    const sorted = [...d.players].sort((a, b) => (b.isWinner ? 1 : 0) - (a.isWinner ? 1 : 0));
    const rowH = Math.min(112, Math.floor(620 / Math.max(sorted.length, 1)));
    const totalH = sorted.length * rowH;
    let y = 175 + Math.max(0, (620 - totalH) / 2);

    sorted.forEach((p, i) => {
      const pi = d.players.indexOf(p);
      const av = Math.min(80, rowH - 24);
      if(p.isWinner){
        ctx.fillStyle = 'rgba(122,13,19,0.35)';
        ctx.fillRect(70, y - 10, 760, rowH - 8);
      }
      avatar(ctx, imgs[pi], 90, y, av, p.isWinner);
      ctx.textAlign = 'left';
      ctx.font = 'bold 26px ' + FONT;
      ctx.fillStyle = '#f0e9de';
      ctx.fillText(short(p.name, 14), 195, y + 34);
      ctx.font = 'bold 14px ' + FONT;
      ctx.fillStyle = '#e2222f';
      ctx.fillText(short(p.rank || 'GRUNTER', 18), 195, y + 58);
      ctx.textAlign = 'right';
      ctx.font = 'bold 34px ' + FONT;
      ctx.fillStyle = p.isWinner ? '#ff3b3b' : '#b8ab9c';
      ctx.fillText(p.hz != null ? (Math.round(p.hz * 10) / 10) + ' Hz' : 'NO SUB', 810, y + 42);
      if(p.isWinner){
        ctx.font = 'bold 14px ' + FONT;
        ctx.fillStyle = '#e2222f';
        ctx.fillText('WINNER', 810, y + 68);
      }
      y += rowH;
    });

    ctx.textAlign = 'center';
    ctx.font = '16px ' + FONT;
    ctx.fillStyle = '#3a332f';
    ctx.fillText('voicemog — think your voice is deeper?', 450, 850);
  }

  return { battle, lobby };
})();