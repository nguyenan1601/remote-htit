const $ = (id) => document.getElementById(id);
const canvas = $('screen'), ctx = canvas.getContext('2d');

let ws = null;
let state = { connected: false };

// --- token ---
let token = localStorage.getItem('htit_token') || '';
async function ensureToken() {
  token = token.trim();
  if (!token) {
    token = prompt('Nhập token truy cập web (in trong console HTITRemote):') || '';
    localStorage.setItem('htit_token', token.trim());
  }
}

function api(path, opts = {}) {
  const headers = { 'X-Htit-Token': token, 'Content-Type': 'application/json', ...(opts.headers || {}) };
  return fetch(path, { ...opts, headers });
}

const STATE_PILL = {
  idle: 'idle',
  connecting: 'intermediate',
  handshake: 'intermediate',
  prompting: 'prompting',
  active: 'active',
  ended: 'idle',
  error: 'error',
  'pairing-required': 'error',
  busy: 'prompting'
};

// --- status handling ---
function onStatus(s, message, info = {}) {
  const pill = $('connState');
  pill.className = 'pill ' + (STATE_PILL[s] || 'idle');
  pill.textContent = { idle: 'chưa kết nối', connecting: 'đang kết nối…', handshake: 'đang xác thực…',
    prompting: 'chờ Android đồng ý…', active: 'đang chia sẻ', ended: 'phiên đã kết thúc',
    error: 'lỗi', 'pairing-required': 'cần ghép đôi', busy: 'có phiên đang chạy' }[s] || s;
  $('statusMsg').textContent = message || '';
  state.connected = s === 'active';
  $('disconnectBtn').disabled = !['active', 'prompting', 'handshake', 'connecting'].includes(s);
  $('viewPanel').classList.toggle('hidden', s !== 'active');
  if (s === 'active' && !ws?.aliveFramesStamp) {
    // handled
  }
  if (s === 'active') $('deviceName').textContent = info.deviceName || info.device_id || '';
  if (info.deviceName) $('deviceName').textContent = info.deviceName;
}

// --- websocket viewer ---
function connect_ws() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/api/ws?t=' + encodeURIComponent(token));
  ws.binaryType = 'blob';
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const m = JSON.parse(ev.data);
        if (m.t === 'status') onStatus(m.s, m.message || m.Message, {
          deviceName: m.deviceName, w: m.w, h: m.h, code: m.code
        });
      } catch { }
    } else {
      drawFrame(ev.data);
    }
  };
  ws.onclose = () => setTimeout(connect_ws, 1200);
}

let bbox = null;
function drawFrame(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    if (canvas.width !== img.width || canvas.height !== img.height) {
      canvas.width = img.width; canvas.height = img.height;
    }
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    bbox = { w: img.width, h: img.height };
    framesSeen++;
    if (framesSeen % 8 === 0) {
      const now = performance.now();
      const elapsed = now - lastStamp;
      const fps = elapsed > 0 ? Math.round(((framesSeen - lastSeen) * 1000 / elapsed) * 10) / 10 : 0;
      $('fps').textContent = 'JPEG ~' + fps + ' fps';
      lastStamp = now; lastSeen = framesSeen;
    }
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

// --- input mapping: click = tap, hold 600ms = long, drag = swipe ---
let pStart = null, holdTimer = null, sentLong = false;
let framesSeen = 0, lastStamp = performance.now(), lastSeen = 0, pLastX = 0, pLastY = 0;
function normOf(ev) {
  const r = canvas.getBoundingClientRect();
  if (!bbox) return null;
  // letterbox-aware "contain" mapping: scale both axes uniformly, then subtract padding
  const s = Math.min(r.width / bbox.w, r.height / bbox.h);
  const dvW = bbox.w * s, dvH = bbox.h * s;
  const offX = (r.width - dvW) / 2, offY = (r.height - dvH) / 2;
  const x = (ev.clientX - r.left - offX) / dvW;
  const y = (ev.clientY - r.top - offY) / dvH;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}
function send(obj) {
  if (!ws || ws.readyState !== 1) return;
  if (obj.t === 'input' && !state.connected) return;
  ws.send(JSON.stringify(obj));
}

function onDown(ev) {
  if (ev.pointerId === undefined) return;
  try { canvas.setPointerCapture(ev.pointerId); } catch { }
  const p = normOf(ev); if (!p) return;
  pStart = p;
  pLastX = ev.clientX; pLastY = ev.clientY;
  sentLong = false;
  holdTimer = setTimeout(() => {
    if (Math.abs(ev.clientX - pLastX) + Math.abs(ev.clientY - pLastY) < 8) {
      send({ t: 'input', a: 'long', x: pStart.x, y: pStart.y, ms: 500 });
      sentLong = true;
    }
  }, 600);
}
function onUp(ev) {
  if (ev.pointerId === undefined) return;
  pLastX = ev.clientX; pLastY = ev.clientY;
  clearTimeout(holdTimer);
  const p = normOf(ev);
  if (!pStart || !p) { pStart = null; return; }
  const d = Math.hypot(p.x - pStart.x, p.y - pStart.y);
  if (!sentLong) {
    if (d < 0.01) send({ t: 'input', a: 'tap', x: pStart.x, y: pStart.y });
    else send({ t: 'input', a: 'swipe', x: pStart.x, y: pStart.y, x2: p.x, y2: p.y, ms: 300 });
  }
  pStart = null;
}
canvas.addEventListener('pointermove', (ev) => { pLastX = ev.clientX; pLastY = ev.clientY; });
canvas.addEventListener('pointerdown', onDown);
canvas.addEventListener('pointerup', onUp);
// pointer events cover mouse/touch/pen on supported browsers; no extra mouse fallback to avoid double taps.

// --- connect form ---
$('connectForm').onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    const resp = await api('/api/connect', {
      method: 'POST',
      body: JSON.stringify({ host: $('host').value.trim(), port: +$('port').value })
    });
    if (!resp.ok) alert('Không thể gửi lệnh kết nối: ' + (await resp.json()).error);
  } catch (e) { alert(e.message); }
};
$('disconnectBtn').onclick = () => send({ t: 'disconnect' });
$('backBtn').onclick = () => send({ t: 'input', a: 'back' });
$('homeBtn').onclick = () => send({ t: 'input', a: 'home' });

(async () => {
  await ensureToken();
  connect_ws();
  setInterval(async () => {
    try {
      const r = await api('/api/state');
      if (r.status === 401) {
        token = prompt('Token không đúng. Nhập lại:') || ''; localStorage.setItem('htit_token', token.trim());
      } else if (r.ok) {
        const d = await r.json();
        $('deviceName').textContent = d.deviceName || '';
        const list = $('pairedList');
        const rows = (d.paired || []).map(p =>
          `<tr><td>${p.deviceName}</td><td>${p.lastIp}</td><td>${(p.pairedAt || '').slice(0, 10)}</td>` +
          `<td><button class="secondary" onclick="forget(${JSON.stringify(p.deviceId)})">Xóa ghép đôi</button></td></tr>`).join('');
        list.innerHTML = rows ? `<table><tr><th>Thiết bị</th><th>IP gần nhất</th><th>Ghép đôi</th><th></th></tr>${rows}</table>` : 'Chưa ghép đôi thiết bị nào.';
        $('pairedPanel').classList.toggle('hidden', !(d.paired || []).length);
        if (!state.connected && d.status === 'idle') onStatus('idle', '');
      }
    } catch { }
  }, 2000);
})();

window.forget = async (deviceId) => {
  if (!confirm('Xóa ghép đôi thiết bị này?')) return;
  try {
    const r = await api(`/api/paired/${encodeURIComponent(deviceId)}/forget`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert(body.error || `Không thể xóa ghép đôi (HTTP ${r.status})`);
      return;
    }
    alert('Đã xóa ghép đôi. Lần kết nối tiếp theo cần nhập mã 6 số trên Android.');
    const stateResp = await api('/api/state');
    if (stateResp.ok) {
      const d = await stateResp.json();
      const list = $('pairedList');
      const rows = (d.paired || []).map(p =>
        `<tr><td>${p.deviceName}</td><td>${p.lastIp}</td><td>${(p.pairedAt || '').slice(0, 10)}</td>` +
        `<td><button class="secondary" onclick="forget(${JSON.stringify(p.deviceId)})">Xóa ghép đôi</button></td></tr>`).join('');
      list.innerHTML = rows ? `<table><tr><th>Thiết bị</th><th>IP gần nhất</th><th>Ghép đôi</th><th></th></tr>${rows}</table>` : 'Chưa ghép đôi thiết bị nào.';
      $('pairedPanel').classList.toggle('hidden', !(d.paired || []).length);
    }
  } catch (e) {
    alert('Không thể xóa ghép đôi: ' + e.message);
  }
};
