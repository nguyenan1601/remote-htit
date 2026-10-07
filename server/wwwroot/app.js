const $ = (id) => document.getElementById(id);
const sessions = new Map();
const networkResults = new Map();
let pingState = null;
let onlineDevices = [];
let savedDevices = [];
let editingSavedId = null;
const statusLabels = { idle: 'đã ngắt', connecting: 'đang kết nối', prompting: 'chờ xác nhận', permission: 'chờ cấp quyền', active: 'đang điều khiển', error: 'lỗi' };
let socket = null;
let reconnectTimer = null;
let selectedSession = null;
let nextSessionId = 0;

async function request(path, options = {}) {
  return fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
}

function showLogin() {
  $('loginView').classList.remove('hidden');
  $('appView').classList.add('hidden');
  clearTimeout(reconnectTimer);
  networkResults.clear();
  pingState = null;
  $('pingForm').reset();
  renderPingResult();
  savedDevices = [];
  resetSaveForm();
  renderDevices([]);
  for (const session of [...sessions.values()]) session.close();
  if (socket) socket.close();
}

function showApp() {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  connectSocket();
}

function controllerSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${protocol}//${location.host}/ws/controller`);
}

function connectSocket() {
  clearTimeout(reconnectTimer);
  const ws = controllerSocket();
  socket = ws;
  ws.onmessage = (event) => {
    if (typeof event.data !== 'string' || socket !== ws) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'devices') {
      savedDevices = message.savedDevices || [];
      renderDevices(message.devices);
    }
    if (message.type === 'network-test-started' || message.type === 'network-test-result') {
      networkResults.set(message.deviceId, { ...message, pending: message.type === 'network-test-started' });
      renderDevices(onlineDevices);
    }
    if (message.type === 'ip-ping-started' || message.type === 'ip-ping-result') {
      pingState = { ...pingState, ...message, pending: message.type === 'ip-ping-started' };
      renderPingResult();
      updatePingForm();
    }
  };
  ws.onopen = updatePingForm;
  ws.onclose = () => {
    if (socket === ws) {
      if (pingState?.pending) {
        pingState = { ...pingState, pending: false, message: 'Mất kết nối máy chủ trong khi ping. Hãy thử lại sau khi kết nối lại.' };
        renderPingResult();
      }
      renderDevices([]);
      if (!$('appView').classList.contains('hidden')) reconnectTimer = setTimeout(connectSocket, 1500);
    }
  };
}

function updateSummary() {
  const activeCount = [...sessions.values()].filter((session) => session.status === 'active').length;
  const pendingCount = [...sessions.values()].filter((session) => ['connecting', 'prompting', 'permission'].includes(session.status)).length;
  $('connState').className = `pill ${activeCount ? 'active' : pendingCount ? 'connecting' : 'idle'}`;
  $('connState').textContent = activeCount ? `đang điều khiển ${activeCount} thiết bị` : pendingCount ? 'đang kết nối' : 'chưa kết nối';
  $('disconnectBtn').disabled = !activeCount && !pendingCount;
  $('sessionTabs').classList.toggle('hidden', !sessions.size);
  $('sessionBar').classList.toggle('hidden', !sessions.size);
  $('deviceName').textContent = selectedSession?.name || '';
}

function selectSession(session) {
  if (selectedSession !== session) selectedSession?.deactivate();
  selectedSession = session;
  for (const current of sessions.values()) {
    const selected = current === session;
    current.panel.classList.toggle('hidden', !selected);
    current.tab.setAttribute('aria-selected', String(selected));
    current.tab.tabIndex = selected ? 0 : -1;
  }
  session?.renderLatestFrame(true);
  updateSummary();
}

function renderDevices(devices) {
  onlineDevices = devices;
  for (const session of sessions.values()) {
    const saved = savedDevices.find((entry) => entry.deviceId === session.deviceId);
    if (saved && session.status === 'active') {
      session.saveName = saved.name;
      session.name = saved.name;
      session.panel.querySelector('[data-role="deviceName"]').textContent = saved.name;
      session.tab.textContent = `${saved.name} · ${statusLabels[session.status]}`;
    }
  }
  updateSummary();
  renderSavedDevices();
  for (const deviceId of networkResults.keys()) {
    if (!devices.some((device) => device.deviceId === deviceId)) networkResults.delete(deviceId);
  }
  renderNetworkDevices();
  updatePingForm();
  $('onlineDevices').innerHTML = '';
  if (!devices.length) {
    $('onlineDevices').textContent = 'Chưa có thiết bị.';
    return;
  }
  for (const device of devices) {
    const chip = document.createElement('article');
    chip.className = 'device-chip';
    const heading = document.createElement('div');
    heading.className = 'device-heading';
    const name = document.createElement('strong');
    name.textContent = device.ip ? `${device.name} — ${device.ip}` : device.name;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'Kết nối';
    button.setAttribute('aria-label', `Kết nối ${device.name}`);
    button.disabled = !device.ip;
    const existing = savedDevices.find((entry) => entry.deviceId === device.deviceId);
    button.onclick = () => connectTo('ip', device.ip, existing?.name || device.name, existing?.name || device.name);
    const actions = document.createElement('div');
    actions.className = 'device-actions';
    actions.append(button);
    heading.append(name, actions);
    chip.append(heading);
    $('onlineDevices').append(chip);
  }
}

function renderNetworkDevices() {
  for (const session of sessions.values()) session.renderNetwork();
  $('networkDevices').replaceChildren();
  if (!onlineDevices.length) {
    $('networkDevices').textContent = 'Chưa có thiết bị.';
    return;
  }
  for (const device of onlineDevices) {
    const chip = document.createElement('article');
    chip.className = 'device-chip';
    const heading = document.createElement('div');
    heading.className = 'device-heading';
    const name = document.createElement('strong');
    name.textContent = device.ip ? `${device.name} — ${device.ip}` : device.name;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = device.networkDiagnostics ? 'Kiểm tra mạng' : 'Cần APK 1.2.0 để đo mạng';
    button.setAttribute('aria-label', `Kiểm tra mạng ${device.name}`);
    const result = networkResults.get(device.deviceId);
    button.disabled = !device.networkDiagnostics || result?.pending;
    button.onclick = () => checkDeviceNetwork(device.deviceId);
    heading.append(name, button);
    chip.append(heading);
    if (result) chip.append(renderNetworkResult(result));
    $('networkDevices').append(chip);
  }
}

function checkDeviceNetwork(deviceId) {
  if (socket?.readyState !== WebSocket.OPEN || networkResults.get(deviceId)?.pending) return;
  networkResults.set(deviceId, { pending: true });
  socket.send(JSON.stringify({ type: 'network-test', deviceId, scope: 'lan' }));
  renderNetworkDevices();
}

function updatePingForm() {
  const busy = pingState?.pending;
  $('pingTargetIp').disabled = Boolean(busy);
  $('pingBtn').disabled = Boolean(busy) || socket?.readyState !== WebSocket.OPEN;
  $('pingBtn').textContent = busy ? 'Đang ping…' : 'Ping';
  $('checkConnectionBtn').disabled = Boolean(busy) || socket?.readyState !== WebSocket.OPEN;
  for (const button of document.querySelectorAll('[data-check-ip]')) {
    button.disabled = Boolean(busy) || socket?.readyState !== WebSocket.OPEN;
    button.textContent = busy && pingState.savedId === button.dataset.savedId ? 'Đang kiểm tra…' : 'Kiểm tra kết nối';
  }
}

function renderPingResult() {
  $('pingResult').replaceChildren();
  $('savedPingResult').replaceChildren();
  for (const result of document.querySelectorAll('[data-ping-result]')) result.replaceChildren();
  if (!pingState) return;
  const section = document.createElement('section');
  section.className = 'network-result';
  const title = document.createElement('strong');
  title.textContent = `Máy chủ HTIT → ${pingState.targetIp}`;
  const status = document.createElement('p');
  status.className = 'muted';
  status.textContent = pingState.pending ? 'Máy chủ đang ping tới IP đích…'
    : pingState.message || `Đo lúc ${new Date(pingState.measuredAt).toLocaleTimeString('vi-VN')}`;
  section.append(title, status);
  const result = pingState.result;
  if (result) {
    const metrics = document.createElement('dl');
    metrics.className = 'network-metrics';
    for (const [label, value] of [
      ['Gói gửi / nhận', Number.isInteger(result.sent) ? `${result.sent} / ${result.received}` : 'Không đo được'],
      ['Mất gói', Number.isFinite(result.lossPercent) ? `${result.lossPercent.toFixed(1)} %` : 'Không đo được'],
      ...[['Ping thấp nhất', 'minMs'], ['Ping trung bình', 'avgMs'], ['Ping cao nhất', 'maxMs']]
        .map(([label, key]) => [label, Number.isFinite(result[key]) ? `${result[key].toFixed(2)} ms` : 'Không đo được']),
    ]) {
      const cell = document.createElement('div');
      const name = document.createElement('dt');
      name.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      cell.append(name, detail);
      metrics.append(cell);
    }
    section.append(metrics);
    if (result.error) {
      const error = document.createElement('p');
      error.className = 'error-text';
      error.textContent = result.error;
      section.append(error);
    }
    if (result.output) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Kết quả ping chi tiết';
      const output = document.createElement('pre');
      output.className = 'ping-output';
      output.textContent = result.output;
      details.append(summary, output);
      section.append(details);
    }
  }
  const container = pingState.savedId ? document.getElementById(`saved-ping-${pingState.savedId}`) || $('savedPingResult')
    : pingState.fromSaved ? $('savedPingResult') : $('pingResult');
  container.append(section);
}

function resetSaveForm() {
  editingSavedId = null;
  $('saveDeviceForm').reset();
  $('savedDeviceIp').readOnly = false;
  $('saveDeviceBtn').textContent = 'Kết nối';
  $('saveForLaterBtn').classList.remove('hidden');
  $('cancelSaveBtn').classList.add('hidden');
  $('savedDevicesError').textContent = '';
}

async function changeSavedDevice(path, options) {
  try {
    const response = await request(path, options);
    if (response.status === 401) { showLogin(); return false; }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Chưa cập nhật được danh sách thiết bị');
    }
    savedDevices = (await response.json()).devices;
    $('savedDevicesError').textContent = '';
    renderDevices(onlineDevices);
    return true;
  } catch (error) {
    $('savedDevicesError').textContent = error.message;
    return false;
  }
}

function renderSavedDevices() {
  $('savedDevices').replaceChildren();
  if (!savedDevices.length) {
    $('savedDevices').textContent = 'Chưa có thiết bị đã lưu.';
    renderPingResult();
    updatePingForm();
    return;
  }
  for (const entry of savedDevices) {
    const online = entry.deviceId ? onlineDevices.find((device) => device.deviceId === entry.deviceId)
      : onlineDevices.find((device) => device.ip === entry.ip);
    const row = document.createElement('article');
    row.className = 'device-chip';
    const heading = document.createElement('div');
    heading.className = 'device-heading';
    const name = document.createElement('strong');
    name.textContent = `${entry.name} — ${online?.ip || entry.ip}`;
    const actions = document.createElement('div');
    actions.className = 'device-actions';
    for (const [label, action] of [
      ['Kết nối', () => connectTo('saved', entry.id, entry.name)],
      ['Kiểm tra kết nối', () => pingIp(online?.ip || entry.ip, entry.id, true)],
      ['Sửa', () => {
        resetSaveForm();
        editingSavedId = entry.id;
        $('savedDeviceName').value = entry.name;
        $('savedDeviceIp').value = entry.ip;
        $('saveDeviceBtn').textContent = 'Lưu thay đổi';
        $('saveForLaterBtn').classList.add('hidden');
        $('cancelSaveBtn').classList.remove('hidden');
        $('savedDeviceName').focus();
        $('savedDeviceName').select();
      }],
      ['Xóa', async () => {
        if (await changeSavedDevice(`/api/saved-devices/${entry.id}`, { method: 'DELETE' }) && editingSavedId === entry.id) resetSaveForm();
      }],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = label;
      button.setAttribute('aria-label', `${label} ${entry.name}`);
      button.onclick = action;
      if (label === 'Kiểm tra kết nối') {
        button.dataset.checkIp = online?.ip || entry.ip;
        button.dataset.savedId = entry.id;
      }
      actions.append(button);
    }
    heading.append(name, actions);
    const status = document.createElement('p');
    status.className = 'muted';
    status.textContent = online ? 'Đang trực tuyến' : 'Chưa trực tuyến — cần mở ứng dụng Android để kết nối';
    const pingResult = document.createElement('div');
    pingResult.id = `saved-ping-${entry.id}`;
    pingResult.dataset.pingResult = entry.id;
    row.append(heading, status, pingResult);
    $('savedDevices').append(row);
  }
  renderPingResult();
  updatePingForm();
}

function renderNetworkResult(state) {
  const section = document.createElement('section');
  section.className = 'network-result';
  section.setAttribute('aria-live', 'polite');
  const title = document.createElement('strong');
  title.textContent = 'Mạng nội bộ — máy chủ HTIT';
  const status = document.createElement('p');
  status.className = 'muted';
  status.textContent = state.pending ? 'Đang đo trên Android…' : state.message || `Đo lúc ${new Date(state.measuredAt).toLocaleTimeString('vi-VN')}`;
  section.append(title, status);
  if (!state.result) return section;
  const result = state.result;
  const metrics = document.createElement('dl');
  metrics.className = 'network-metrics';
  const format = (value, unit) => Number.isFinite(value) ? `${value.toFixed(1)} ${unit}` : 'Không đo được';
  for (const [label, key, unit] of [
    ['Ping HTTP (TB)', 'pingMs', 'ms'], ['Jitter HTTP', 'jitterMs', 'ms'],
    ['Phản hồi lỗi (5 mẫu)', 'lossPercent', '%'], ['Download', 'downloadMbps', 'Mbps'], ['Upload', 'uploadMbps', 'Mbps'],
  ]) {
    const cell = document.createElement('div');
    const name = document.createElement('dt');
    name.textContent = label;
    const value = document.createElement('dd');
    value.textContent = format(result[key], unit);
    cell.append(name, value);
    metrics.append(cell);
  }
  const detail = document.createElement('p');
  detail.className = 'muted';
  detail.textContent = `Ping min/max: ${format(result.minPingMs, 'ms')} / ${format(result.maxPingMs, 'ms')}. Tốc độ đo mẫu, từ phía Android.`;
  section.append(metrics, detail);
  if (result.errors.length) {
    const error = document.createElement('p');
    error.className = 'error-text';
    error.textContent = result.errors.join('. ');
    section.append(error);
  }
  return section;
}

function createSession(method, target, label = target, saveName = '') {
  const panel = $('sessionTemplate').content.firstElementChild.cloneNode(true);
  const field = (role) => panel.querySelector(`[data-role="${role}"]`);
  const canvas = field('screen');
  const context = canvas.getContext('2d');
  const keyboardInput = field('keyboardInput');
  const tab = document.createElement('button');
  const id = `session-${++nextSessionId}`;
  panel.id = id;
  tab.id = `${id}-tab`;
  tab.type = 'button';
  tab.className = 'session-tab';
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', id);
  panel.setAttribute('aria-labelledby', tab.id);
  const session = { key: `${method}:${target}`, name: label, saveName, panel, tab, status: 'connecting', start, disconnect, close, deactivate, renderLatestFrame, renderNetwork };
  let sessionSocket = null;
  let connected = false;
  let closed = false;
  let frameSize = null;
  let framesSeen = 0;
  let frameStamp = performance.now();
  let pendingFrame = null;
  let renderingFrame = false;
  let frameEpoch = 0;
  let pendingKeyboardText = '';
  let keyboardTimer = null;
  let pointerStart = null;
  let pointerLast = null;
  let holdTimer = null;
  let sentLong = false;

  function setStatus(status, message = '') {
    session.status = status;
    field('connState').className = `pill ${status}`;
    field('connState').textContent = statusLabels[status] || status;
    field('statusMsg').textContent = message;
    field('deviceName').textContent = session.name;
    tab.textContent = `${session.name} · ${statusLabels[status] || status}`;
    connected = status === 'active';
    renderNetwork();
    field('viewPanel').classList.toggle('hidden', !connected);
    field('disconnectBtn').disabled = !['connecting', 'prompting', 'permission', 'active'].includes(status);
    field('reconnectBtn').classList.toggle('hidden', !['idle', 'error'].includes(status));
    for (const role of ['backBtn', 'homeBtn', 'nativeSizeBtn', 'keyboardInput']) field(role).disabled = !connected;
    if (!connected) {
      deactivate();
      keyboardInput.value = '';
      pendingFrame = null;
      frameSize = null;
      frameEpoch += 1;
    }
    updateSummary();
  }

  function send(message) {
    if (!closed && sessionSocket?.readyState === WebSocket.OPEN) sessionSocket.send(JSON.stringify(message));
  }

  function renderNetwork() {
    const state = networkResults.get(session.deviceId);
    field('networkTestBtn').disabled = !connected || !session.networkDiagnostics || Boolean(state?.pending) || socket?.readyState !== WebSocket.OPEN;
    field('networkTestBtn').textContent = state?.pending ? 'Đang kiểm tra mạng…'
      : connected && !session.networkDiagnostics ? 'Cần APK 1.2.0 để đo mạng' : 'Kiểm tra mạng thiết bị';
    field('networkResult').classList.toggle('hidden', !state);
    field('networkResult').replaceChildren();
    if (state) field('networkResult').append(renderNetworkResult(state));
  }

  function start() {
    sessionSocket?.close();
    const ws = controllerSocket();
    sessionSocket = ws;
    ws.binaryType = 'blob';
    setStatus('connecting', 'Đang tìm thiết bị');
    field('resolution').textContent = '';
    field('fps').textContent = '';
    context.clearRect(0, 0, canvas.width, canvas.height);
    ws.onopen = () => {
      if (sessionSocket !== ws || closed) return;
      const message = method === 'ip' ? { type: 'connect', method, ip: target }
        : method === 'saved' ? { type: 'connect', method, savedId: target } : { type: 'connect', method, code: target };
      if (session.saveName) message.saveName = session.saveName;
      send(message);
    };
    ws.onmessage = (event) => {
      if (sessionSocket !== ws || closed) return;
      if (typeof event.data !== 'string') {
        if (connected) {
          pendingFrame = event.data;
          renderLatestFrame();
        }
        return;
      }
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'status') setStatus(message.status, message.message);
      if (message.type === 'error') { setStatus('error', message.message); ws.close(); }
      if (message.type === 'session-active') {
        session.deviceId = message.deviceId;
        session.ip = message.ip;
        session.networkDiagnostics = message.networkDiagnostics;
        session.name = session.saveName || (method === 'saved' ? label : `${message.deviceName || 'Android'} — ${target}`);
        framesSeen = 0;
        frameStamp = performance.now();
        setStatus('active', message.saveError || 'Kết nối đã sẵn sàng');
        if (session.saveName && !message.saveError && !editingSavedId
          && $('savedDeviceName').value.trim() === session.saveName && $('savedDeviceIp').value.trim() === target) resetSaveForm();
      }
      if (message.type === 'session-ended') { setStatus('idle', message.reason || 'Phiên đã kết thúc'); ws.close(); }
    };
    ws.onclose = () => {
      if (sessionSocket === ws && !closed && !['idle', 'error'].includes(session.status)) setStatus('error', 'Mất kết nối — chọn Kết nối lại để tạo phiên mới');
    };
  }

  function flushKeyboardText() {
    clearTimeout(keyboardTimer);
    keyboardTimer = null;
    if (connected && pendingKeyboardText) send({ type: 'input', action: 'text', text: pendingKeyboardText });
    pendingKeyboardText = '';
  }

  function deactivate() {
    flushKeyboardText();
    clearTimeout(holdTimer);
    pointerStart = null;
  }

  function disconnect() {
    deactivate();
    send({ type: 'disconnect' });
    sessionSocket?.close();
    setStatus('idle', 'Đã ngắt kết nối thiết bị');
  }

  function close() {
    deactivate();
    closed = true;
    pendingFrame = null;
    frameEpoch += 1;
    sessionSocket?.close();
    sessions.delete(session.key);
    panel.remove();
    tab.remove();
    if (selectedSession === session) selectSession(sessions.values().next().value || null);
    else updateSummary();
  }

  async function renderLatestFrame(resetRate = false) {
    if (resetRate) {
      framesSeen = 0;
      frameStamp = performance.now();
      field('fps').textContent = '';
    }
    if (closed || !connected || selectedSession !== session || renderingFrame || !pendingFrame) return;
    renderingFrame = true;
    const blob = pendingFrame;
    const epoch = frameEpoch;
    pendingFrame = null;
    try {
      const image = await createImageBitmap(blob);
      if (closed || epoch !== frameEpoch) { image.close(); return; }
      if (canvas.width !== image.width || canvas.height !== image.height) {
        canvas.width = image.width;
        canvas.height = image.height;
      }
      context.drawImage(image, 0, 0);
      frameSize = { width: image.width, height: image.height };
      field('resolution').textContent = `${image.width} × ${image.height}`;
      image.close();
      framesSeen += 1;
      if (framesSeen % 8 === 0) {
        const now = performance.now();
        field('fps').textContent = `${Math.round(80000 / (now - frameStamp)) / 10} fps`;
        frameStamp = now;
      }
    } catch {
      // A newer frame will replace an invalid or incomplete one.
    } finally {
      renderingFrame = false;
      if (pendingFrame) renderLatestFrame();
    }
  }

  function normalizedPoint(event) {
    if (!connected || !frameSize) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / frameSize.width, rect.height / frameSize.height);
    const width = frameSize.width * scale;
    const height = frameSize.height * scale;
    const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
    const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }

  canvas.addEventListener('pointerdown', (event) => {
    pointerStart = normalizedPoint(event);
    pointerLast = { x: event.clientX, y: event.clientY };
    sentLong = false;
    if (!pointerStart) return;
    canvas.setPointerCapture(event.pointerId);
    holdTimer = setTimeout(() => {
      if (pointerStart && Math.hypot(event.clientX - pointerLast.x, event.clientY - pointerLast.y) < 8) {
        send({ type: 'input', action: 'long', ...pointerStart, ms: 800 });
        sentLong = true;
      }
    }, 600);
  });
  canvas.addEventListener('pointermove', (event) => { pointerLast = { x: event.clientX, y: event.clientY }; });
  canvas.addEventListener('pointercancel', deactivate);
  canvas.addEventListener('pointerup', (event) => {
    clearTimeout(holdTimer);
    const end = normalizedPoint(event);
    if (!pointerStart || !end || sentLong) {
      pointerStart = null;
      if (connected) keyboardInput.focus({ preventScroll: true });
      return;
    }
    const distance = Math.hypot(end.x - pointerStart.x, end.y - pointerStart.y);
    send(distance < 0.01
      ? { type: 'input', action: 'tap', ...pointerStart }
      : { type: 'input', action: 'swipe', ...pointerStart, x2: end.x, y2: end.y, ms: 300 });
    pointerStart = null;
    keyboardInput.focus({ preventScroll: true });
  });

  field('close').onclick = close;
  field('disconnectBtn').onclick = disconnect;
  field('reconnectBtn').onclick = start;
  field('backBtn').onclick = () => { flushKeyboardText(); send({ type: 'input', action: 'back' }); };
  field('homeBtn').onclick = () => { flushKeyboardText(); send({ type: 'input', action: 'home' }); };
  field('networkTestBtn').onclick = () => checkDeviceNetwork(session.deviceId);
  field('nativeSizeBtn').onclick = () => {
    const nativeSize = field('canvasWrap').classList.toggle('native-size');
    field('nativeSizeBtn').setAttribute('aria-pressed', String(nativeSize));
    field('nativeSizeBtn').textContent = nativeSize ? 'Vừa khung' : 'Xem 100%';
  };
  keyboardInput.addEventListener('keydown', (event) => {
    if (!connected || event.isComposing) return;
    if (event.key === 'Backspace' || event.key === 'Enter') {
      event.preventDefault();
      flushKeyboardText();
      send({ type: 'input', action: event.key === 'Enter' ? 'enter' : 'backspace' });
    }
  });
  keyboardInput.addEventListener('input', (event) => {
    if (!connected || event.isComposing) return;
    const text = typeof event.data === 'string' && event.data ? event.data : keyboardInput.value;
    keyboardInput.value = '';
    if (!text) return;
    pendingKeyboardText += text;
    if (pendingKeyboardText.length >= 500) {
      pendingKeyboardText = pendingKeyboardText.slice(0, 500);
      flushKeyboardText();
      return;
    }
    clearTimeout(keyboardTimer);
    keyboardTimer = setTimeout(flushKeyboardText, 40);
  });
  tab.onclick = () => selectSession(session);
  tab.onkeydown = (event) => {
    const list = [...sessions.values()];
    const index = list.indexOf(session);
    let next;
    if (event.key === 'ArrowRight') next = list[(index + 1) % list.length];
    else if (event.key === 'ArrowLeft') next = list[(index - 1 + list.length) % list.length];
    else if (event.key === 'Home') [next] = list;
    else if (event.key === 'End') next = list.at(-1);
    else return;
    event.preventDefault();
    selectSession(next);
    next.tab.focus();
  };
  $('sessions').append(panel);
  $('sessionTabs').append(tab);
  return session;
}

$('loginForm').onsubmit = async (event) => {
  event.preventDefault();
  const response = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value }) });
  if (!response.ok) { $('loginError').textContent = (await response.json()).error; return; }
  $('password').value = '';
  $('loginError').textContent = '';
  showApp();
};
function connectTo(method, target, label = target, saveName = '') {
  const saved = method === 'saved' ? savedDevices.find((entry) => entry.id === target) : null;
  const targetIp = saved?.ip || (method === 'ip' ? target : '');
  const deviceId = saved?.deviceId || onlineDevices.find((entry) => entry.ip === targetIp)?.deviceId;
  const key = method === 'saved' ? `${method}:${target}:${saved?.deviceId || targetIp}`
    : method === 'ip' && deviceId ? `${method}:${target}:${deviceId}` : `${method}:${target}`;
  let session = sessions.get(key);
  if (deviceId) session ||= [...sessions.values()].find((entry) => entry.deviceId === deviceId && entry.status === 'active');
  if (!session) {
    session = createSession(method, target, label, saveName);
    session.key = key;
    sessions.set(key, session);
    selectSession(session);
    session.start();
  } else {
    if (saveName) session.saveName = saveName;
    selectSession(session);
    if (['idle', 'error'].includes(session.status)) session.start();
    else if (session.status === 'active' && saveName) changeSavedDevice('/api/saved-devices', {
      method: 'POST', body: JSON.stringify({ name: saveName, deviceId: session.deviceId }),
    });
  }
}
$('connectForm').onsubmit = (event) => {
  event.preventDefault();
  const method = $('connectMethod').value;
  const target = method === 'ip' ? $('deviceIp').value.trim() : $('deviceCode').value.replace(/\D/g, '');
  connectTo(method, target);
};
$('saveDeviceForm').onsubmit = async (event) => {
  event.preventDefault();
  const name = $('savedDeviceName').value.trim();
  if (!name) { $('savedDevicesError').textContent = 'Nhập tên dễ nhớ của thiết bị'; return; }
  const editingId = editingSavedId;
  const ip = $('savedDeviceIp').value.trim();
  if (!editingId && event.submitter !== $('saveForLaterBtn')) {
    $('savedDevicesError').textContent = '';
    connectTo('ip', ip, name, name);
    return;
  }
  const body = { name, ip };
  $('saveDeviceBtn').disabled = true;
  $('saveForLaterBtn').disabled = true;
  const saved = await changeSavedDevice(editingId ? `/api/saved-devices/${editingId}` : '/api/saved-devices', {
    method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(body),
  });
  $('saveDeviceBtn').disabled = false;
  $('saveForLaterBtn').disabled = false;
  if (saved) resetSaveForm();
};
$('cancelSaveBtn').onclick = resetSaveForm;
$('checkConnectionBtn').onclick = () => {
  if ($('savedDeviceIp').reportValidity()) pingIp($('savedDeviceIp').value.trim(), null, true);
};
function pingIp(targetIp, savedId = null, fromSaved = false) {
  if (pingState?.pending || socket?.readyState !== WebSocket.OPEN) return;
  pingState = { targetIp, savedId, fromSaved, pending: true };
  socket.send(JSON.stringify({ type: 'ip-ping', targetIp }));
  renderPingResult();
  updatePingForm();
}
$('pingForm').onsubmit = (event) => {
  event.preventDefault();
  pingIp($('pingTargetIp').value.trim());
};
$('connectMethod').onchange = () => {
  const useIp = $('connectMethod').value === 'ip';
  $('codeField').classList.toggle('hidden', useIp);
  $('ipField').classList.toggle('hidden', !useIp);
  $('deviceCode').disabled = useIp;
  $('deviceCode').required = !useIp;
  $('deviceIp').disabled = !useIp;
  $('deviceIp').required = useIp;
};
$('disconnectBtn').onclick = () => {
  for (const session of sessions.values()) if (!['idle', 'error'].includes(session.status)) session.disconnect();
};
$('logoutBtn').onclick = async () => { await request('/api/auth/logout', { method: 'POST' }); showLogin(); };
request('/api/auth/me').then((response) => response.json()).then((session) => session.username ? showApp() : showLogin());
