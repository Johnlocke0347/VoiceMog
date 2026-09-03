/* =========================================================================
   NET — thin WebSocket client. Owns the connection, persists the player's
   MOG ID across sessions (localStorage — safe here since this runs as a
   real page served by our own server, not inside a sandboxed artifact
   preview), and dispatches server messages to whatever app.js registers.
   ========================================================================= */
const Net = (() => {
  let ws = null;
  let handlers = {};
  let reconnectDelay = 1000;
  const STORAGE_KEY = 'voicemog_player_id';

  function on(type, fn){ handlers[type] = fn; }

  function connect(){
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      const storedId = localStorage.getItem(STORAGE_KEY);
      send('hello', { playerId: storedId || undefined });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try{ msg = JSON.parse(ev.data); }catch{ return; }
      if(msg.type === 'hello_ack' && msg.player && msg.player.id){
        localStorage.setItem(STORAGE_KEY, msg.player.id);
      }
      const fn = handlers[msg.type];
      if(fn) fn(msg);
    });
    ws.addEventListener('close', () => {
      handlers._disconnected && handlers._disconnected();
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
    });
    ws.addEventListener('error', () => {});
  }

  function send(type, payload = {}){
    if(!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify({ type, ...payload }));
    return true;
  }

  return { connect, on, send };
})();
