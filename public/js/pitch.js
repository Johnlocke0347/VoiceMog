/* =========================================================================
   PITCH DETECTION — autocorrelation-based fundamental frequency (F0)
   estimator, not FFT-peak. Rejects silence and unvoiced frames, uses
   parabolic interpolation for sub-sample accuracy.
   ========================================================================= */
function detectPitch(buf, sampleRate, {minHz = 60, maxHz = 500} = {}){
  const SIZE = buf.length;
  let rms = 0;
  for(let i=0;i<SIZE;i++) rms += buf[i]*buf[i];
  rms = Math.sqrt(rms/SIZE);
  if(rms < 0.01) return null; // silence

  // trim leading/trailing near-zero samples to center the analysis window
  let r1 = 0, r2 = SIZE-1;
  const thres = 0.2;
  for(let i=0;i<SIZE/2;i++){ if(Math.abs(buf[i]) < thres){ r1 = i; break; } }
  for(let i=1;i<SIZE/2;i++){ if(Math.abs(buf[SIZE-i]) < thres){ r2 = SIZE-i; break; } }
  const trimmed = buf.slice(r1, r2);
  const n = trimmed.length;
  if(n < 512) return null;

  const c = new Array(n).fill(0);
  for(let lag=0; lag<n; lag++){
    let sum = 0;
    for(let i=0;i<n-lag;i++) sum += trimmed[i]*trimmed[i+lag];
    c[lag] = sum;
  }

  // skip the initial downward slope from lag 0 before searching for the peak
  let d = 0;
  while(d < n-1 && c[d] > c[d+1]) d++;

  let maxVal = -1, maxPos = -1;
  for(let i=d;i<n;i++){ if(c[i] > maxVal){ maxVal = c[i]; maxPos = i; } }
  let T0 = maxPos;

  // parabolic interpolation around the peak for sub-sample precision
  if(T0 > 0 && T0 < n-1){
    const x1 = c[T0-1], x2 = c[T0], x3 = c[T0+1];
    const a = (x1 + x3 - 2*x2) / 2, b = (x3 - x1) / 2;
    if(a) T0 = T0 - b/(2*a);
  }
  if(T0 <= 0) return null;

  const freq = sampleRate / T0;
  if(freq < minHz || freq > maxHz) return null;
  return freq;
}

function medianOf(arr){
  const sorted = [...arr].sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length/2)];
}
