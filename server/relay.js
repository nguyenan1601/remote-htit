import { randomInt, randomUUID } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { createNetworkDiagnostics } from './network-diagnostics.js';
import { createIpPing } from './ip-ping.js';

const PENDING_TIMEOUT_MS = 35_000;
const PROJECTION_TIMEOUT_MS = 60_000;
const MAX_CONTROLLER_BUFFER_BYTES = 1024 * 1024;
const ALLOWED_ACTIONS = new Set(['tap', 'long', 'swipe', 'back', 'home', 'text', 'backspace', 'enter']);

function sendJson(ws, value) {
  if (ws.readyState === 1) ws.send(JSON.stringify(value));
}

function deviceCode(codes) {
  for (let i = 0; i < 100; i += 1) {
    const code = String(randomInt(100_000_000, 1_000_000_000));
    if (!codes.has(code)) return code;
  }
  throw new Error('Không tạo được mã thiết bị');
}

function validInput(message) {
  if (!ALLOWED_ACTIONS.has(message.action)) return false;
  if (message.action === 'text') {
    return typeof message.text === 'string'
      && message.text.length > 0
      && message.text.length <= 500
      && [...message.text].every((character) => {
        const code = character.codePointAt(0);
        return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
      });
  }
  for (const key of ['x', 'y', 'x2', 'y2']) {
    if (message[key] !== undefined && (!Number.isFinite(message[key]) || message[key] < 0 || message[key] > 1)) return false;
  }
  return message.ms === undefined || (Number.isInteger(message.ms) && message.ms >= 0 && message.ms <= 2000);
}

export function createRelay({ savedDevices = null } = {}) {
  const agents = new Map();
  const codes = new Map();
  const controllers = new Map();
  const diagnostics = createNetworkDiagnostics(sendJson);
  const ipPing = createIpPing(sendJson);

  function listDevices() {
    return [...agents.values()].map(({ deviceId, name, ip, networkDiagnostics }) => ({ deviceId, name, ip, networkDiagnostics }));
  }

  function publishDevices() {
    const devices = listDevices();
    for (const [ws, controller] of controllers) sendJson(ws, { type: 'devices', devices, savedDevices: savedDevices?.list(controller.username) || [] });
  }

  function updateSavedIp(agent) {
    try { savedDevices?.updateIp(agent); }
    catch (error) { console.error('Không cập nhật được IP thiết bị đã lưu:', error.message); }
  }

  function endSession(session, reason, notifyAgent = true) {
    if (!session || session.ended) return;
    session.ended = true;
    clearTimeout(session.timer);
    session.agent.session = null;
    const controller = controllers.get(session.controllerWs);
    if (controller) controller.session = null;
    sendJson(session.controllerWs, { type: 'session-ended', reason });
    if (notifyAgent) sendJson(session.agent.ws, { type: 'session-ended', sessionId: session.id, reason });
  }

  function attachAgent(ws, username) {
    let agent = null;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (agent?.session?.state === 'active'
          && agent.session.controllerWs.readyState === 1
          && agent.session.controllerWs.bufferedAmount <= MAX_CONTROLLER_BUFFER_BYTES
          && data.length <= 8 * 1024 * 1024) {
          agent.session.controllerWs.send(data, { binary: true });
        }
        return;
      }
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type === 'register') {
        if (agent || typeof message.deviceId !== 'string' || !message.deviceId || message.deviceId.length > 128) return;
        const existing = agents.get(message.deviceId);
        if (existing) {
          if (existing.session) endSession(existing.session, 'Thiết bị đăng nhập ở nơi khác', false);
          codes.delete(existing.code);
          existing.ws.close(4001, 'Thiết bị đăng nhập ở nơi khác');
        }
        const ip = typeof message.ip === 'string' && isIPv4(message.ip) ? message.ip : '';
        agent = { ws, username, deviceId: message.deviceId, name: String(message.name || 'Android').slice(0, 80), ip, code: deviceCode(codes), session: null, networkDiagnostics: message.networkDiagnostics === true };
        agents.set(agent.deviceId, agent);
        codes.set(agent.code, agent.deviceId);
        sendJson(ws, { type: 'registered', code: agent.code });
        updateSavedIp(agent);
        publishDevices();
        return;
      }
      if (message.type === 'update-ip') {
        if (!agent || typeof message.ip !== 'string' || (message.ip !== '' && !isIPv4(message.ip))) return;
        if (agent.ip !== message.ip) {
          agent.ip = message.ip;
          updateSavedIp(agent);
          publishDevices();
        }
        return;
      }
      if (message.type === 'network-test-result') {
        if (agent) diagnostics.finish(agent, message);
        return;
      }
      const session = agent?.session;
      if (!session || message.sessionId !== session.id) return;
      if (message.type === 'session-response') {
        if (session.state !== 'pending') return;
        if (!message.accept) {
          endSession(session, String(message.reason || 'Người dùng đã từ chối'), false);
          return;
        }
        session.state = 'consented';
        clearTimeout(session.timer);
        session.timer = setTimeout(() => endSession(session, 'Hết thời gian cấp quyền chia sẻ'), PROJECTION_TIMEOUT_MS);
        sendJson(session.controllerWs, { type: 'status', status: 'permission', message: 'Thiết bị đã chấp nhận, đang chờ quyền chia sẻ màn hình' });
      } else if (message.type === 'session-active' && session.state === 'consented') {
        session.state = 'active';
        clearTimeout(session.timer);
        let saveError = '';
        if (session.saveName) {
          try {
            const username = controllers.get(session.controllerWs)?.username;
            if (!username || !savedDevices?.save(username, { name: session.saveName, ip: agent.ip, deviceId: agent.deviceId })) saveError = 'Đã kết nối nhưng chưa lưu được thiết bị: danh sách tối đa 100 mục';
          } catch {
            saveError = 'Đã kết nối nhưng chưa lưu được thiết bị vào danh sách';
          }
          publishDevices();
        }
        sendJson(session.controllerWs, { type: 'session-active', deviceId: agent.deviceId, deviceName: agent.name, ip: agent.ip, networkDiagnostics: agent.networkDiagnostics, width: message.width, height: message.height, saveError });
      } else if (message.type === 'session-denied') {
        endSession(session, String(message.reason || 'Thiết bị không cấp quyền'), false);
      } else if (message.type === 'session-ended') {
        endSession(session, String(message.reason || 'Thiết bị đã ngắt kết nối'), false);
      }
    });
    ws.on('close', () => {
      diagnostics.cancelFor(ws);
      if (!agent) return;
      if (agent.session) endSession(agent.session, 'Thiết bị đã mất kết nối', false);
      if (agents.get(agent.deviceId) !== agent) return;
      agents.delete(agent.deviceId);
      codes.delete(agent.code);
      publishDevices();
    });
  }

  function attachController(ws, username) {
    const controller = { username, session: null, attempts: [] };
    controllers.set(ws, controller);
    sendJson(ws, { type: 'ready', username });
    publishDevices();
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type === 'network-test') {
        const deviceId = typeof message.deviceId === 'string' ? message.deviceId.slice(0, 128) : '';
        diagnostics.start(agents.get(deviceId), ws, deviceId, message.scope);
      } else if (message.type === 'ip-ping') {
        ipPing.start(ws, message.targetIp);
      } else if (message.type === 'connect') {
        let saveName = '';
        if (message.saveName !== undefined) {
          if (typeof message.saveName !== 'string' || !message.saveName.trim() || message.saveName.trim().length > 80) return sendJson(ws, { type: 'error', message: 'Tên thiết bị cần có từ 1 đến 80 ký tự' });
          saveName = message.saveName.trim();
        }
        const now = Date.now();
        controller.attempts = controller.attempts.filter((value) => value > now - 60_000);
        if (controller.attempts.length >= 10) {
          sendJson(ws, { type: 'error', message: 'Thử kết nối quá nhiều lần, vui lòng chờ một phút' });
          return;
        }
        controller.attempts.push(now);
        let agent;
        if (message.method === 'ip') {
          const ip = typeof message.ip === 'string' ? message.ip.trim() : '';
          if (!isIPv4(ip)) return sendJson(ws, { type: 'error', message: 'Địa chỉ IPv4 không hợp lệ' });
          const matches = [...agents.values()].filter((device) => device.ip === ip);
          if (matches.length > 1) return sendJson(ws, { type: 'error', message: 'Có nhiều thiết bị cùng IP, hãy kết nối bằng mã thiết bị' });
          [agent] = matches;
          if (!agent) return sendJson(ws, { type: 'error', message: 'Thiết bị có IP này chưa trực tuyến — hãy mở ứng dụng Android' });
        } else if (message.method === 'saved') {
          const saved = savedDevices?.find(username, message.savedId);
          if (!saved) return sendJson(ws, { type: 'error', message: 'Thiết bị không có trong danh sách đã lưu của tài khoản' });
          saveName = saved.name;
          if (saved.deviceId) agent = agents.get(saved.deviceId);
          else {
            const matches = [...agents.values()].filter((device) => device.ip === saved.ip);
            if (matches.length > 1) return sendJson(ws, { type: 'error', message: 'Có nhiều thiết bị cùng IP, hãy dùng mã hoặc lưu từ danh sách trực tuyến' });
            [agent] = matches;
          }
          if (!agent) return sendJson(ws, { type: 'error', message: 'Thiết bị đã lưu chưa trực tuyến — hãy mở ứng dụng Android' });
        } else if (message.method === undefined || message.method === 'code') {
          const deviceId = codes.get(String(message.code || '').replace(/\D/g, ''));
          agent = deviceId ? agents.get(deviceId) : null;
          if (!agent) return sendJson(ws, { type: 'error', message: 'Mã thiết bị không tồn tại hoặc đã hết hạn' });
        } else {
          return sendJson(ws, { type: 'error', message: 'Cách kết nối không hợp lệ' });
        }
        if (agent.session || controller.session) return sendJson(ws, { type: 'error', message: 'Thiết bị hoặc trình duyệt đang có phiên khác' });
        const session = { id: randomUUID(), agent, controllerWs: ws, saveName: agent.ip ? saveName : '', state: 'pending', ended: false, timer: null };
        session.timer = setTimeout(() => endSession(session, 'Hết thời gian chờ xác nhận'), PENDING_TIMEOUT_MS);
        agent.session = session;
        controller.session = session;
        sendJson(agent.ws, { type: 'session-request', sessionId: session.id, controllerName: username });
        sendJson(ws, { type: 'status', status: 'prompting', message: 'Đang chờ người dùng trên Android chấp nhận' });
      } else if (message.type === 'input' && controller.session?.state === 'active' && validInput(message)) {
        sendJson(controller.session.agent.ws, { ...message, sessionId: controller.session.id });
      } else if (message.type === 'disconnect' && controller.session) {
        endSession(controller.session, 'Trình điều khiển đã ngắt kết nối');
      }
    });
    ws.on('close', () => {
      diagnostics.cancelFor(ws);
      if (controller.session) endSession(controller.session, 'Trình điều khiển đã mất kết nối');
      ipPing.cancelFor(ws);
      controllers.delete(ws);
    });
  }

  function close() {
    diagnostics.close();
    ipPing.close();
    for (const agent of agents.values()) agent.ws.close();
    for (const ws of controllers.keys()) ws.close();
  }

  return { attachAgent, attachController, close, listDevices, publishDevices, authorizeNetworkProbe: diagnostics.authorize };
}
