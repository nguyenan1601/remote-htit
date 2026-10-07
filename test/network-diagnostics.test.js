import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createApplication } from '../server/app.js';
import { NETWORK_TEST_BYTES, createNetworkDiagnostics } from '../server/network-diagnostics.js';

let application;
let baseUrl;
let cookie;

before(async () => {
  application = createApplication({ users: { support: 'TestPass!123' } });
  application.server.listen(0, '127.0.0.1');
  await once(application.server, 'listening');
  baseUrl = `http://127.0.0.1:${application.server.address().port}`;
  const login = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'support', password: 'TestPass!123' }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  application.close();
  await new Promise((resolve) => application.server.close(resolve));
});

function nextMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const handler = (data, binary) => {
      if (binary) return;
      const value = JSON.parse(data.toString());
      if (value.type !== type) return;
      clearTimeout(timer);
      socket.off('message', handler);
      resolve(value);
    };
    const timer = setTimeout(() => { socket.off('message', handler); reject(new Error(`Timeout: ${type}`)); }, 3000);
    socket.on('message', handler);
  });
}

async function fixture(networkDiagnostics = true) {
  const token = (await (await fetch(baseUrl + '/api/agent/token', { method: 'POST' })).json()).token;
  const agent = new WebSocket(baseUrl.replace('http', 'ws') + '/ws/agent', { headers: { Authorization: `Bearer ${token}` } });
  const controller = new WebSocket(baseUrl.replace('http', 'ws') + '/ws/controller', { headers: { Cookie: cookie, Origin: baseUrl } });
  await Promise.all([once(agent, 'open'), once(controller, 'open')]);
  const deviceId = randomUUID();
  const registered = nextMessage(agent, 'registered');
  const listed = nextMessage(controller, 'devices');
  agent.send(JSON.stringify({ type: 'register', deviceId, name: 'Network test Android', ip: '192.168.1.10', networkDiagnostics }));
  const { code } = await registered;
  assert.ok((await listed).devices.some((device) => device.deviceId === deviceId && device.networkDiagnostics === networkDiagnostics));
  return { agent, controller, deviceId, code, close: () => { controller.close(); agent.close(); } };
}

const result = { pingMs: 10, minPingMs: 8, maxPingMs: 12, jitterMs: 2, lossPercent: 0, downloadMbps: 80, uploadMbps: 40, errors: [] };

test('LAN: phép đo có ticket, giới hạn dữ liệu và giữ phiên remote hoạt động', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(baseUrl + '/api/network-test/unknown/download')).status, 403);
    const sessionRequest = nextMessage(f.agent, 'session-request');
    f.controller.send(JSON.stringify({ type: 'connect', code: f.code }));
    const session = await sessionRequest;
    const permission = nextMessage(f.controller, 'status');
    f.agent.send(JSON.stringify({ type: 'session-response', sessionId: session.sessionId, accept: true }));
    await permission;
    const active = nextMessage(f.controller, 'session-active');
    f.agent.send(JSON.stringify({ type: 'session-active', sessionId: session.sessionId, width: 1080, height: 2400 }));
    const activeDevice = await active;
    assert.equal(activeDevice.deviceId, f.deviceId);
    assert.equal(activeDevice.networkDiagnostics, true);

    const requested = nextMessage(f.agent, 'network-test-request');
    const started = nextMessage(f.controller, 'network-test-started');
    f.controller.send(JSON.stringify({ type: 'network-test', deviceId: f.deviceId, scope: 'lan' }));
    const { testId, scope } = await requested;
    assert.equal(scope, 'lan');
    assert.equal((await started).deviceId, f.deviceId);
    const probeUrl = baseUrl + '/api/network-test/' + testId;
    for (let i = 0; i < 6; i++) assert.equal((await fetch(probeUrl + '/ping')).status, 204);
    assert.equal((await fetch(probeUrl + '/ping')).status, 403);
    const download = await fetch(probeUrl + '/download');
    assert.match(download.headers.get('cache-control'), /no-store/);
    assert.equal((await download.arrayBuffer()).byteLength, NETWORK_TEST_BYTES);
    assert.equal((await fetch(probeUrl + '/download')).status, 403);
    const upload = await fetch(probeUrl + '/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(NETWORK_TEST_BYTES) });
    assert.deepEqual(await upload.json(), { bytes: NETWORK_TEST_BYTES });
    assert.equal((await fetch(probeUrl + '/upload', { method: 'POST' })).status, 403);

    const input = nextMessage(f.agent, 'input');
    f.controller.send(JSON.stringify({ type: 'input', action: 'home' }));
    assert.equal((await input).sessionId, session.sessionId);
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const frame = new Promise((resolve) => {
      const handler = (data, binary) => { if (binary) { f.controller.off('message', handler); resolve(data); } };
      f.controller.on('message', handler);
    });
    f.agent.send(image);
    assert.deepEqual(await frame, image);

    const finished = nextMessage(f.controller, 'network-test-result');
    f.agent.send(JSON.stringify({ type: 'network-test-result', testId, result }));
    const value = await finished;
    assert.equal(value.deviceId, f.deviceId);
    assert.equal(value.scope, 'lan');
    assert.deepEqual(value.result, result);
    assert.ok(Date.parse(value.measuredAt));
    assert.equal((await fetch(probeUrl + '/ping')).status, 403);
    const cooldown = nextMessage(f.controller, 'network-test-result');
    f.controller.send(JSON.stringify({ type: 'network-test', deviceId: f.deviceId, scope: 'lan' }));
    assert.match((await cooldown).message, /30 giây/);
  } finally { f.close(); }
});

test('LAN: cách ly kết quả thiết bị, từ chối giả mạo và nhận kết quả đo lỗi một phần', async () => {
  const a = await fixture();
  const b = await fixture();
  try {
    const requested = nextMessage(a.agent, 'network-test-request');
    a.controller.send(JSON.stringify({ type: 'network-test', deviceId: a.deviceId }));
    const { testId, scope } = await requested;
    assert.equal(scope, 'lan');
    assert.equal((await fetch(baseUrl + '/api/network-test/' + testId + '/ping')).status, 204);
    const received = [];
    a.controller.on('message', (data, binary) => { if (!binary && JSON.parse(data).type === 'network-test-result') received.push(JSON.parse(data)); });
    b.agent.send(JSON.stringify({ type: 'network-test-result', testId, result }));
    a.agent.send(JSON.stringify({ type: 'network-test-result', testId, result: { ...result, lossPercent: 101 } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 0);
    const partial = { ...result, uploadMbps: null, lossPercent: 20, errors: ['Upload timeout'] };
    const finished = nextMessage(a.controller, 'network-test-result');
    a.agent.send(JSON.stringify({ type: 'network-test-result', testId, result: partial }));
    assert.deepEqual((await finished).result, partial);
  } finally { a.close(); b.close(); }
});

test('Từ chối APK cũ, thiết bị offline và đích đo tùy ý', async () => {
  const f = await fixture(false);
  try {
    for (const [deviceId, scope, expected] of [[f.deviceId, 'lan', /APK 1.2.0/], ['offline', 'lan', /chưa trực tuyến/], [f.deviceId, 'http://example.com', /Chỉ hỗ trợ/], [f.deviceId, 'internet', /Chỉ hỗ trợ/]]) {
      const rejected = nextMessage(f.controller, 'network-test-result');
      f.controller.send(JSON.stringify({ type: 'network-test', deviceId, scope }));
      assert.match((await rejected).message, expected);
    }
  } finally { f.close(); }
});

test('Thiết bị chỉ chạy một phép đo; mất kết nối thu hồi ticket', async () => {
  const f = await fixture();
  try {
    const requested = nextMessage(f.agent, 'network-test-request');
    f.controller.send(JSON.stringify({ type: 'network-test', deviceId: f.deviceId, scope: 'lan' }));
    const { testId } = await requested;
    const busy = nextMessage(f.controller, 'network-test-result');
    f.controller.send(JSON.stringify({ type: 'network-test', deviceId: f.deviceId, scope: 'lan' }));
    assert.match((await busy).message, /đang đo mạng/);
    const disconnected = nextMessage(f.controller, 'network-test-result');
    f.agent.close();
    assert.match((await disconnected).message, /bị ngắt/);
    assert.equal((await fetch(baseUrl + '/api/network-test/' + testId + '/ping')).status, 403);
  } finally { f.close(); }
});

test('Hết thời gian đo thu hồi ticket và báo lỗi cho đúng controller', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const messages = [];
  const controller = {};
  const agent = { deviceId: 'slow-device', networkDiagnostics: true, ws: { readyState: 1 } };
  const diagnostics = createNetworkDiagnostics((ws, value) => messages.push({ ws, value }));
  try {
    diagnostics.start(agent, controller, agent.deviceId, 'lan');
    const ticket = messages.find(({ value }) => value.type === 'network-test-request').value.testId;
    t.mock.timers.tick(45_000);
    const last = messages.at(-1);
    assert.equal(last.ws, controller);
    assert.match(last.value.message, /Hết thời gian/);
    assert.equal(diagnostics.authorize(ticket, 'ping'), false);
  } finally { diagnostics.close(); }
});
