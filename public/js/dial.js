/* =========================================================================
   THE DIAL — VoiceMog's signature visual motif.
   A pixel-tick frequency gauge, reused across matchmaking (idle sweep),
   recording (live needle tracking real Hz), and the reveal (needle snaps
   to the final measured value). One component, three moods.
   ========================================================================= */
class Dial {
  constructor(canvas, {min=50, max=300} = {}){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.min = min; this.max = max;
    this.value = null;      // current needle value (Hz) or null = resting
    this.mode = 'idle';     // idle | sweep | live | locked
    this._sweepAngle = 0;
    this._raf = null;
    this._dpr = window.devicePixelRatio || 1;
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._loop();
  }
  _resize(){
    const size = this.canvas.clientWidth || 220;
    this.canvas.width = size * this._dpr;
    this.canvas.height = size * this._dpr;
    this.ctx.setTransform(this._dpr,0,0,this._dpr,0,0);
    this.size = size;
  }
  setMode(mode){ this.mode = mode; }
  setValue(hz){ this.value = hz; }
  destroy(){ cancelAnimationFrame(this._raf); }

  _valueToAngle(hz){
    const t = Math.max(0, Math.min(1, (hz - this.min) / (this.max - this.min)));
    // sweep from -220deg to +40deg (a wide dashboard arc)
    return (-220 + t * 260) * Math.PI/180;
  }

  _draw(){
    const {ctx, size} = this;
    const cx = size/2, cy = size/2, r = size*0.42;
    ctx.clearRect(0,0,size,size);

    // outer ring
    ctx.strokeStyle = 'rgba(122,13,19,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke();

    // tick marks
    const ticks = 28;
    for(let i=0;i<=ticks;i++){
      const t = i/ticks;
      const ang = (-220 + t*260) * Math.PI/180;
      const major = i % 4 === 0;
      const rr1 = r - (major ? 12 : 7);
      const rr2 = r - 1;
      const x1 = cx + Math.cos(ang)*rr1, y1 = cy + Math.sin(ang)*rr1;
      const x2 = cx + Math.cos(ang)*rr2, y2 = cy + Math.sin(ang)*rr2;
      ctx.strokeStyle = major ? 'rgba(226,34,47,0.75)' : 'rgba(122,13,19,0.4)';
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    }

    // sweep mode: rotating radar wedge, no fixed needle
    if(this.mode === 'sweep'){
      this._sweepAngle += 0.06;
      const grad = ctx.createConicGradient ? null : null;
      ctx.save();
      ctx.translate(cx,cy);
      ctx.rotate(this._sweepAngle);
      const wedge = ctx.createLinearGradient(0,0,r,0);
      wedge.addColorStop(0,'rgba(226,34,47,0.55)');
      wedge.addColorStop(1,'rgba(226,34,47,0)');
      ctx.fillStyle = wedge;
      ctx.beginPath();
      ctx.moveTo(0,0);
      ctx.arc(0,0,r-2,-0.5,0.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // needle for live / locked
    if((this.mode === 'live' || this.mode === 'locked') && this.value){
      const ang = this._valueToAngle(this.value);
      const nx = cx + Math.cos(ang)*(r-16);
      const ny = cy + Math.sin(ang)*(r-16);
      ctx.strokeStyle = this.mode === 'locked' ? '#ff3b3b' : '#e2222f';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(nx,ny); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(cx,cy,4,0,Math.PI*2); ctx.fill();
      if(this.mode === 'locked'){
        ctx.shadowColor = '#ff3b3b'; ctx.shadowBlur = 14;
        ctx.beginPath(); ctx.arc(nx,ny,4,0,Math.PI*2); ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // idle: slow single tick drifting to suggest dormant listening
    if(this.mode === 'idle'){
      const t = (Math.sin(performance.now()/2200)+1)/2;
      const ang = (-220 + t*40) * Math.PI/180;
      const nx = cx + Math.cos(ang)*(r-16), ny = cy + Math.sin(ang)*(r-16);
      ctx.strokeStyle = 'rgba(226,34,47,0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(nx,ny); ctx.stroke();
    }
  }

  _loop(){
    this._draw();
    this._raf = requestAnimationFrame(() => this._loop());
  }
}
