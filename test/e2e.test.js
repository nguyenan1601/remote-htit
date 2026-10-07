import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { after, before, test } from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApplication } from '../server/app.js';
import { createDiscoveryResponder, DISCOVERY_PROBE } from '../server/discovery.js';

let application;
let baseUrl;

before(async () => {
  application = createApplication({ users: { support: 'StrongPass!123' } });
  application.server.listen(0, '127.0.0.1');
  await once(application.server, 'listening');
  const { port } = application.server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  application.close();
  await new Promise((resolve) => application.server.close(resolve));
});

async function login() {
  return fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'support', password: 'StrongPass!123' }),
  });
}

async function agentToken() {
  const response = await fetch(baseUrl + '/api/agent/token', { method: 'POST' });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  return token;
}

function nextMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket message timeout')), 3000);
    const handler = (data, isBinary) => {
      const value = isBinary ? Buffer.from(data) : JSON.parse(data.toString());
      if (!predicate(value, isBinary)) return;
      clearTimeout(timer);
      socket.off('message', handler);
      resolve(value);
    };
    socket.on('message', handler);
  });
}

test('đăng nhập từ chối sai mật khẩu và cấp cookie cho trình duyệt', async () => {
  const denied = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'support', password: 'wrong' }),
  });
  assert.equal(denied.status, 401);
  const accepted = await login();
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get('set-cookie'), /htit_session=.*HttpOnly.*SameSite=Strict/i);
});

test('giao diện cho phép nhập mã có khoảng trắng và hiển thị ảnh blob', async () => {
  const response = await fetch(baseUrl + '/');
  const html = await response.text();
  assert.match(html, /id="deviceCode"[^>]+maxlength="11"/);
  assert.doesNotMatch(html, /Cloudflare|id="networkScope"/i);
  assert.match(response.headers.get('content-security-policy'), /img-src[^;]+blob:/);
});

test('Android lấy token tạm thời mà không cần tài khoản', async () => {
  await agentToken();
});

test('máy chủ trả lời gói tự dò trong LAN', async () => {
  let responder;
  const port = await new Promise((resolve) => {
    responder = createDiscoveryResponder({ httpPort: 8362, discoveryPort: 0, publicUrl: 'https://remote.noi-bo', onReady: resolve });
  });
  const client = dgram.createSocket('udp4');
  try {
    const message = once(client, 'message');
    client.send(Buffer.from(DISCOVERY_PROBE), port, '127.0.0.1');
    const [payload] = await message;
    assert.deepEqual(JSON.parse(payload.toString()), {
      service: 'htit-remote', version: 1, port: 8362, secure: false, url: 'https://remote.noi-bo',
    });
  } finally {
    client.close();
    responder.close();
  }
});

for (const method of ['code', 'ip']) {
test(`luồng đầy đủ bằng ${method}: xác nhận, màn hình, thao tác và ngắt phiên`, async () => {
  const browserLogin = await login();
  const cookie = browserLogin.headers.get('set-cookie').split(';')[0];
  const token = await agentToken();
  const wsUrl = baseUrl.replace('http', 'ws');
  const controller = new WebSocket(wsUrl + '/ws/controller', { headers: { Cookie: cookie, Origin: baseUrl } });
  const agent = new WebSocket(wsUrl + '/ws/agent', { headers: { Authorization: `Bearer ${token}` } });
  await Promise.all([once(controller, 'open'), once(agent, 'open')]);

  const registeredPromise = nextMessage(agent, (message) => message.type === 'registered');
  agent.send(JSON.stringify({ type: 'register', deviceId: `android-test-${method}`, name: `Android test ${method}`, ip: '192.168.1.100' }));
  const registered = await registeredPromise;
  assert.match(registered.code, /^\d{9}$/);

  const requestPromise = nextMessage(agent, (message) => message.type === 'session-request');
  controller.send(JSON.stringify(method === 'ip'
    ? { type: 'connect', method, ip: '192.168.1.100' }
    : { type: 'connect', code: registered.code }));
  const request = await requestPromise;
  assert.equal(request.controllerName, 'support');

  const busy = nextMessage(controller, (message) => message.type === 'error');
  controller.send(JSON.stringify(method === 'ip'
    ? { type: 'connect', code: registered.code }
    : { type: 'connect', method: 'ip', ip: '192.168.1.100' }));
  assert.match((await busy).message, /đang có phiên khác/);

  const permissionPromise = nextMessage(controller, (message) => message.type === 'status' && message.status === 'permission');
  agent.send(JSON.stringify({ type: 'session-response', sessionId: request.sessionId, accept: true }));
  await permissionPromise;
  const activePromise = nextMessage(controller, (message) => message.type === 'session-active');
  agent.send(JSON.stringify({ type: 'session-active', sessionId: request.sessionId, width: 1080, height: 2400 }));
  const active = await activePromise;
  assert.deepEqual({ width: active.width, height: active.height }, { width: 1080, height: 2400 });

  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const framePromise = nextMessage(controller, (_message, binary) => binary);
  agent.send(frame);
  assert.deepEqual(await framePromise, frame);

  const inputPromise = nextMessage(agent, (message) => message.type === 'input');
  controller.send(JSON.stringify({ type: 'input', action: 'tap', x: 0.5, y: 0.25 }));
  const input = await inputPromise;
  assert.equal(input.action, 'tap');
  assert.equal(input.sessionId, request.sessionId);

  for (const command of [
    { action: 'text', text: 'Xin chào 👋' },
    { action: 'backspace' },
    { action: 'enter' },
  ]) {
    const keyboardPromise = nextMessage(agent, (message) => message.type === 'input');
    controller.send(JSON.stringify({ type: 'input', ...command }));
    const keyboardInput = await keyboardPromise;
    assert.equal(keyboardInput.action, command.action);
    assert.equal(keyboardInput.text, command.text);
    assert.equal(keyboardInput.sessionId, request.sessionId);
  }

  if (method === 'ip') {
    const updated = nextMessage(controller, (message) => message.type === 'devices');
    agent.send(JSON.stringify({ type: 'update-ip', ip: '192.168.1.101' }));
    assert.equal((await updated).devices.find((device) => device.name === 'Android test ip').ip, '192.168.1.101');

    const oldIp = nextMessage(controller, (message) => message.type === 'error');
    controller.send(JSON.stringify({ type: 'connect', method: 'ip', ip: '192.168.1.100' }));
    assert.match((await oldIp).message, /chưa trực tuyến/);
    const newIp = nextMessage(controller, (message) => message.type === 'error');
    controller.send(JSON.stringify({ type: 'connect', method: 'ip', ip: '192.168.1.101' }));
    assert.match((await newIp).message, /đang có phiên khác/);

    const stillStreaming = nextMessage(controller, (_message, binary) => binary);
    agent.send(frame);
    assert.deepEqual(await stillStreaming, frame);
    const stillControlling = nextMessage(agent, (message) => message.type === 'input');
    controller.send(JSON.stringify({ type: 'input', action: 'back' }));
    assert.equal((await stillControlling).sessionId, request.sessionId);

    const noIp = nextMessage(controller, (message) => message.type === 'devices');
    agent.send(JSON.stringify({ type: 'update-ip', ip: '' }));
    assert.equal((await noIp).devices.find((device) => device.name === 'Android test ip').ip, '');
    const restored = nextMessage(controller, (message) => message.type === 'devices');
    agent.send(JSON.stringify({ type: 'update-ip', ip: '192.168.1.101' }));
    assert.equal((await restored).devices.find((device) => device.name === 'Android test ip').ip, '192.168.1.101');
  }

  const endedPromise = nextMessage(agent, (message) => message.type === 'session-ended');
  controller.send(JSON.stringify({ type: 'disconnect' }));
  assert.equal((await endedPromise).reason, 'Trình điều khiển đã ngắt kết nối');
  if (method === 'ip') {
    for (const connection of [
      { type: 'connect', method: 'ip', ip: '192.168.1.101' },
      { type: 'connect', code: registered.code },
    ]) {
      const requestedAgain = nextMessage(agent, (message) => message.type === 'session-request');
      controller.send(JSON.stringify(connection));
      const next = await requestedAgain;
      assert.notEqual(next.sessionId, request.sessionId);
      const denied = nextMessage(controller, (message) => message.type === 'session-ended');
      agent.send(JSON.stringify({ type: 'session-response', sessionId: next.sessionId, accept: false }));
      await denied;
    }
  }
  controller.close();
  agent.close();
});
}

test('kết nối IP từ chối địa chỉ sai, IP chưa trực tuyến và phương thức không hợp lệ', async () => {
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  const controller = new WebSocket(baseUrl.replace('http', 'ws') + '/ws/controller', { headers: { Cookie: cookie, Origin: baseUrl } });
  await once(controller, 'open');
  try {
    for (const ip of ['999.1.1.1', 'example.com', '192.168.1.100:8362', 123]) {
      const error = nextMessage(controller, (message) => message.type === 'error');
      controller.send(JSON.stringify({ type: 'connect', method: 'ip', ip }));
      assert.equal((await error).message, 'Địa chỉ IPv4 không hợp lệ');
    }
    const offline = nextMessage(controller, (message) => message.type === 'error');
    controller.send(JSON.stringify({ type: 'connect', method: 'ip', ip: '192.168.99.99' }));
    assert.match((await offline).message, /chưa trực tuyến/);
    const invalidMethod = nextMessage(controller, (message) => message.type === 'error');
    controller.send(JSON.stringify({ type: 'connect', method: 'unknown' }));
    assert.equal((await invalidMethod).message, 'Cách kết nối không hợp lệ');
  } finally {
    controller.close();
  }
});

test('IP trùng không chọn nhầm thiết bị; ngắt Android loại bỏ IP khỏi danh sách', async () => {
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  const wsUrl = baseUrl.replace('http', 'ws');
  const controller = new WebSocket(wsUrl + '/ws/controller', { headers: { Cookie: cookie, Origin: baseUrl } });
  await once(controller, 'open');
  const agents = [];
  const ip = '192.168.1.200';
  try {
    for (let i = 0; i < 2; i += 1) {
      const agent = new WebSocket(wsUrl + '/ws/agent', { headers: { Authorization: `Bearer ${await agentToken()}` } });
      agents.push(agent);
      await once(agent, 'open');
      const registered = nextMessage(agent, (message) => message.type === 'registered');
      const devices = nextMessage(controller, (message) => message.type === 'devices');
      agent.send(JSON.stringify({ type: 'register', deviceId: `android-duplicate-${i}`, name: `Android ${i}`, ip }));
      await registered;
      assert.equal((await devices).devices.filter((device) => device.ip === ip).length, i + 1);
    }
    const duplicate = nextMessage(controller, (message) => message.type === 'error');
    controller.send(JSON.stringify({ type: 'connect', method: 'ip', ip }));
    assert.match((await duplicate).message, /nhiều thiết bị cùng IP/);

    const remaining = nextMessage(controller, (message) => message.type === 'devices');
    agents[0].close();
    assert.equal((await remaining).devices.filter((device) => device.ip === ip).length, 1);

    const requested = nextMessage(agents[1], (message) => message.type === 'session-request');
    controller.send(JSON.stringify({ type: 'connect', method: 'ip', ip }));
    const session = await requested;
    const denied = nextMessage(controller, (message) => message.type === 'session-ended');
    agents[1].send(JSON.stringify({ type: 'session-response', sessionId: session.sessionId, accept: false }));
    assert.match((await denied).reason, /từ chối/);

    const removed = nextMessage(controller, (message) => message.type === 'devices');
    agents[1].close();
    assert.equal((await removed).devices.filter((device) => device.ip === ip).length, 0);
    const offline = nextMessage(controller, (message) => message.type === 'error');
    controller.send(JSON.stringify({ type: 'connect', method: 'ip', ip }));
    assert.match((await offline).message, /chưa trực tuyến/);
  } finally {
    for (const agent of agents) agent.close();
    controller.close();
  }
});

test('cùng tài khoản hỗ trợ hai thiết bị độc lập, không trộn ảnh/lệnh và ngắt một phiên giữ phiên còn lại', async () => {
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  const wsUrl = baseUrl.replace('http', 'ws');
  const agents = [];
  const controllers = [];
  const requests = [];
  const inputs = [[], []];
  const frames = [[], []];
  try {
    for (let i = 0; i < 2; i += 1) {
      const agent = new WebSocket(wsUrl + '/ws/agent', { headers: { Authorization: `Bearer ${await agentToken()}` } });
      agents.push(agent);
      const controller = new WebSocket(wsUrl + '/ws/controller', { headers: { Cookie: cookie, Origin: baseUrl } });
      controllers.push(controller);
      await Promise.all([once(agent, 'open'), once(controller, 'open')]);
      agent.on('message', (data, binary) => {
        if (!binary) {
          const message = JSON.parse(data.toString());
          if (message.type === 'input') inputs[i].push(message);
        }
      });
      controller.on('message', (data, binary) => { if (binary) frames[i].push(Buffer.from(data)); });
      const registered = nextMessage(agent, (message) => message.type === 'registered');
      agent.send(JSON.stringify({ type: 'register', deviceId: `android-multi-${i}`, name: `Android multi ${i}`, ip: `192.168.2.${10 + i}` }));
      const { code } = await registered;
      const requested = nextMessage(agent, (message) => message.type === 'session-request');
      controller.send(JSON.stringify(i === 0 ? { type: 'connect', method: 'ip', ip: '192.168.2.10' } : { type: 'connect', code }));
      requests.push(await requested);
    }
    assert.notEqual(requests[0].sessionId, requests[1].sessionId);

    const third = new WebSocket(wsUrl + '/ws/controller', { headers: { Cookie: cookie, Origin: baseUrl } });
    controllers.push(third);
    await once(third, 'open');
    const busy = nextMessage(third, (message) => message.type === 'error');
    third.send(JSON.stringify({ type: 'connect', method: 'ip', ip: '192.168.2.10' }));
    assert.match((await busy).message, /đang có phiên khác/);

    for (let i = 0; i < 2; i += 1) {
      const permission = nextMessage(controllers[i], (message) => message.type === 'status' && message.status === 'permission');
      agents[i].send(JSON.stringify({ type: 'session-response', sessionId: requests[i].sessionId, accept: true }));
      await permission;
      const active = nextMessage(controllers[i], (message) => message.type === 'session-active');
      agents[i].send(JSON.stringify({ type: 'session-active', sessionId: requests[i].sessionId, width: 1080, height: 2400 }));
      await active;
    }

    const imageA = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);
    const imageB = Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]);
    const receivedA = nextMessage(controllers[0], (_message, binary) => binary);
    const receivedB = nextMessage(controllers[1], (_message, binary) => binary);
    agents[0].send(imageA);
    agents[1].send(imageB);
    assert.deepEqual(await receivedA, imageA);
    assert.deepEqual(await receivedB, imageB);

    const inputA = nextMessage(agents[0], (message) => message.type === 'input');
    const inputB = nextMessage(agents[1], (message) => message.type === 'input');
    controllers[0].send(JSON.stringify({ type: 'input', action: 'text', text: 'Chỉ gửi Android A' }));
    controllers[1].send(JSON.stringify({ type: 'input', action: 'tap', x: 0.2, y: 0.8 }));
    assert.equal((await inputA).sessionId, requests[0].sessionId);
    assert.equal((await inputB).sessionId, requests[1].sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(frames, [[imageA], [imageB]]);
    assert.equal(inputs[0].length, 1);
    assert.equal(inputs[1].length, 1);
    assert.equal(inputs[0][0].text, 'Chỉ gửi Android A');
    assert.equal(inputs[1][0].action, 'tap');

    const endedA = nextMessage(agents[0], (message) => message.type === 'session-ended');
    controllers[0].close();
    await endedA;
    const stillStreaming = nextMessage(controllers[1], (_message, binary) => binary);
    agents[1].send(imageB);
    assert.deepEqual(await stillStreaming, imageB);
    const stillControlling = nextMessage(agents[1], (message) => message.type === 'input');
    controllers[1].send(JSON.stringify({ type: 'input', action: 'enter' }));
    assert.equal((await stillControlling).sessionId, requests[1].sessionId);
  } finally {
    for (const ws of [...controllers, ...agents]) ws.close();
  }
});

test('lệnh không hợp lệ không được chuyển đến Android', async () => {
  const browserLogin = await login();
  const cookie = browserLogin.headers.get('set-cookie').split(';')[0];
  const controller = new WebSocket(baseUrl.replace('http', 'ws') + '/ws/controller', { headers: { Cookie: cookie, Origin: baseUrl } });
  await once(controller, 'open');
  controller.send(JSON.stringify({ type: 'input', action: 'shell', x: 2 }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(controller.readyState, WebSocket.OPEN);
  controller.close();
});

test('Android từ chối thì phiên kết thúc trước khi truyền màn hình', async () => {
  const browserLogin = await login();
  const cookie = browserLogin.headers.get('set-cookie').split(';')[0];
  const token = await agentToken();
  const wsUrl = baseUrl.replace('http', 'ws');
  const controller = new WebSocket(wsUrl + '/ws/controller', { headers: { Cookie: cookie, Origin: baseUrl } });
  const agent = new WebSocket(wsUrl + '/ws/agent', { headers: { Authorization: `Bearer ${token}` } });
  await Promise.all([once(controller, 'open'), once(agent, 'open')]);
  const registeredPromise = nextMessage(agent, (message) => message.type === 'registered');
  agent.send(JSON.stringify({ type: 'register', deviceId: 'android-deny', name: 'Android deny' }));
  const { code } = await registeredPromise;
  const requestPromise = nextMessage(agent, (message) => message.type === 'session-request');
  controller.send(JSON.stringify({ type: 'connect', code }));
  const request = await requestPromise;
  const endedPromise = nextMessage(controller, (message) => message.type === 'session-ended');
  agent.send(JSON.stringify({ type: 'session-response', sessionId: request.sessionId, accept: false, reason: 'Người dùng đã từ chối' }));
  assert.equal((await endedPromise).reason, 'Người dùng đã từ chối');
  controller.close();
  agent.close();
});

test('WebSocket trình điều khiển từ website khác bị từ chối', async () => {
  const browserLogin = await login();
  const cookie = browserLogin.headers.get('set-cookie').split(';')[0];
  const socket = new WebSocket(baseUrl.replace('http', 'ws') + '/ws/controller', {
    headers: { Cookie: cookie, Origin: 'https://khong-hop-le.example' },
  });
  socket.on('error', () => {});
  const [, response] = await once(socket, 'unexpected-response');
  assert.equal(response.statusCode, 403);
  response.resume();
});
