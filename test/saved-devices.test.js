import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createApplication } from '../server/app.js';

let application;
let baseUrl;
let cookies;
let directory;
let file;

async function start(savedDevicesFile) {
  const app = createApplication({ users: { alice: 'Pass!123', bob: 'Pass!456' }, savedDevicesFile });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  return { app, url: `http://127.0.0.1:${app.server.address().port}` };
}

async function login(url, username, password) {
  const response = await fetch(url + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'htit-saved-devices-'));
  file = path.join(directory, 'devices.json');
  const started = await start(file);
  application = started.app;
  baseUrl = started.url;
  cookies = { alice: await login(baseUrl, 'alice', 'Pass!123'), bob: await login(baseUrl, 'bob', 'Pass!456') };
});

after(async () => {
  application.close();
  await new Promise((resolve) => application.server.close(resolve));
  if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.rmdirSync(directory);
});

function api(username, method = 'GET', body, id = '') {
  return fetch(baseUrl + '/api/saved-devices' + (id ? '/' + id : ''), {
    method, headers: { Cookie: cookies[username] || '', Origin: baseUrl, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

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

async function agent(deviceId, ip) {
  const token = (await (await fetch(baseUrl + '/api/agent/token', { method: 'POST' })).json()).token;
  const socket = new WebSocket(baseUrl.replace('http', 'ws') + '/ws/agent', { headers: { Authorization: `Bearer ${token}` } });
  await once(socket, 'open');
  const registered = nextMessage(socket, 'registered');
  socket.send(JSON.stringify({ type: 'register', deviceId, ip, name: 'Android test' }));
  await registered;
  return socket;
}

async function controller(username = 'alice') {
  const socket = new WebSocket(baseUrl.replace('http', 'ws') + '/ws/controller', { headers: { Cookie: cookies[username], Origin: baseUrl } });
  await once(socket, 'open');
  return socket;
}

test('Lưu IP, đổi tên, khôi phục sau khởi động lại và xóa theo tài khoản', async () => {
  const created = await api('alice', 'POST', { name: '  Tablet kho A  ', ip: '192.168.10.10' });
  assert.equal(created.status, 201);
  const { devices } = await created.json();
  const entry = devices.find((value) => value.ip === '192.168.10.10');
  assert.equal(entry.name, 'Tablet kho A');
  assert.equal(entry.deviceId, null);
  const updated = await api('alice', 'PATCH', { name: 'Tablet kho B' }, entry.id);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).devices.find((value) => value.id === entry.id).name, 'Tablet kho B');
  assert.deepEqual((await (await api('bob')).json()).devices, []);
  assert.equal((await api('bob', 'PATCH', { name: 'Other user' }, entry.id)).status, 404);
  assert.equal((await api('bob', 'DELETE', undefined, entry.id)).status, 404);

  const restarted = await start(file);
  try {
    const cookie = await login(restarted.url, 'alice', 'Pass!123');
    const response = await fetch(restarted.url + '/api/saved-devices', { headers: { Cookie: cookie } });
    assert.equal((await response.json()).devices.find((value) => value.id === entry.id).name, 'Tablet kho B');
  } finally {
    restarted.app.close();
    await new Promise((resolve) => restarted.app.server.close(resolve));
  }
  assert.equal((await api('alice', 'DELETE', undefined, entry.id)).status, 200);
  assert.equal((await api('alice', 'DELETE', undefined, entry.id)).status, 404);
});

test('Lưu Android theo định danh: cập nhật IP, giữ tên và không chọn nhầm thiết bị dùng IP cũ', async () => {
  const deviceId = randomUUID();
  let android = await agent(deviceId, '192.168.10.20');
  const browser = await controller();
  let other = null;
  try {
    const published = nextMessage(browser, 'devices');
    const response = await api('alice', 'POST', { name: 'Tablet lễ tân', deviceId });
    assert.equal(response.status, 201);
    const saved = (await response.json()).devices.find((value) => value.deviceId === deviceId);
    assert.equal((await published).savedDevices.find((value) => value.id === saved.id).name, 'Tablet lễ tân');
    const changed = nextMessage(browser, 'devices');
    android.send(JSON.stringify({ type: 'update-ip', ip: '192.168.10.21' }));
    assert.equal((await changed).savedDevices.find((value) => value.id === saved.id).ip, '192.168.10.21');
    const listed = (await (await api('alice')).json()).devices.find((value) => value.id === saved.id);
    assert.equal(listed.name, 'Tablet lễ tân');
    assert.equal(listed.ip, '192.168.10.21');
    other = await agent(randomUUID(), '192.168.10.20');
    const requested = nextMessage(android, 'session-request');
    browser.send(JSON.stringify({ type: 'connect', method: 'saved', savedId: saved.id }));
    const session = await requested;
    const denied = nextMessage(browser, 'session-ended');
    android.send(JSON.stringify({ type: 'session-response', sessionId: session.sessionId, accept: false }));
    await denied;
    const removed = nextMessage(browser, 'devices');
    android.close();
    await removed;
    const offline = nextMessage(browser, 'error');
    browser.send(JSON.stringify({ type: 'connect', method: 'saved', savedId: saved.id }));
    assert.match((await offline).message, /chưa trực tuyến/);
    android = await agent(deviceId, '192.168.10.22');
    assert.equal((await (await api('alice')).json()).devices.find((value) => value.id === saved.id).ip, '192.168.10.22');
    const duplicate = await api('alice', 'POST', { name: 'Tên mới', ip: '192.168.10.22' });
    assert.equal((await duplicate.json()).devices.filter((value) => value.deviceId === deviceId).length, 1);
    const unauthorized = await controller('bob');
    try {
      const rejected = nextMessage(unauthorized, 'error');
      unauthorized.send(JSON.stringify({ type: 'connect', method: 'saved', savedId: saved.id }));
      assert.match((await rejected).message, /tài khoản/);
    } finally { unauthorized.close(); }
    await api('alice', 'DELETE', undefined, saved.id);
  } finally { android.close(); other?.close(); browser.close(); }
});

test('Xác thực, nguồn yêu cầu và kiểm tra tên/IP khi lưu', async () => {
  assert.equal((await api('anonymous')).status, 401);
  const forged = await fetch(baseUrl + '/api/saved-devices', {
    method: 'POST', headers: { Cookie: cookies.alice, Origin: 'https://other.example', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Wrong origin', ip: '192.168.10.30' }),
  });
  assert.equal(forged.status, 403);
  for (const body of [
    { name: '', ip: '192.168.10.30' }, { name: 'x'.repeat(81), ip: '192.168.10.30' },
    { name: 'Invalid IP', ip: '999.1.1.1' }, { name: 'URL', ip: 'http://example.com' },
    { name: 'Unknown device', deviceId: 'offline' },
  ]) assert.equal((await api('alice', 'POST', body)).status, 400);
});

test('IP chưa nhận diện kết nối theo IP; IP trùng yêu cầu lưu đúng Android từ danh sách trực tuyến', async () => {
  const response = await api('alice', 'POST', { name: 'IP thủ công', ip: '192.168.10.40' });
  const saved = (await response.json()).devices.find((value) => value.ip === '192.168.10.40');
  const first = await agent(randomUUID(), saved.ip);
  const browser = await controller();
  let second = null;
  try {
    const requested = nextMessage(first, 'session-request');
    browser.send(JSON.stringify({ type: 'connect', method: 'saved', savedId: saved.id }));
    const session = await requested;
    const denied = nextMessage(browser, 'session-ended');
    first.send(JSON.stringify({ type: 'session-response', sessionId: session.sessionId, accept: false }));
    await denied;
    second = await agent(randomUUID(), saved.ip);
    const ambiguous = nextMessage(browser, 'error');
    browser.send(JSON.stringify({ type: 'connect', method: 'saved', savedId: saved.id }));
    assert.match((await ambiguous).message, /nhiều thiết bị/);
    assert.equal((await api('alice', 'POST', { name: 'Duplicate IP', ip: saved.ip })).status, 400);
    await api('alice', 'DELETE', undefined, saved.id);
  } finally { first.close(); second?.close(); browser.close(); }
});

test('Sửa tên/IP giữ định danh khi cùng IP, đổi đích khi IP mới và không bị Android cũ ghi đè', async () => {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const first = await agent(firstId, '192.168.10.60');
  const second = await agent(secondId, '192.168.10.61');
  const browser = await controller();
  let id;
  try {
    const created = await api('alice', 'POST', { name: 'Máy ban đầu', deviceId: firstId });
    id = (await created.json()).devices.find((entry) => entry.deviceId === firstId).id;
    const read = async () => (await (await api('alice')).json()).devices.find((entry) => entry.id === id);
    assert.equal((await api('alice', 'PATCH', { name: 'Tên sửa', ip: '192.168.10.60' }, id)).status, 200);
    assert.equal((await read()).deviceId, firstId);
    for (const ip of ['999.1.1.1', 'router.local', 'http://192.168.10.60', '']) {
      assert.equal((await api('alice', 'PATCH', { name: 'IP lỗi', ip }, id)).status, 400);
      assert.equal((await read()).name, 'Tên sửa');
    }
    assert.equal((await api('bob', 'PATCH', { name: 'Sai tài khoản', ip: '192.168.10.61' }, id)).status, 404);
    await api('alice', 'PATCH', { name: 'Chuyển máy', ip: '192.168.10.61' }, id);
    assert.equal((await read()).deviceId, secondId);
    await api('alice', 'PATCH', { name: 'Đích offline', ip: '192.168.10.62' }, id);
    assert.equal((await read()).deviceId, null);
    const updated = nextMessage(browser, 'devices');
    first.send(JSON.stringify({ type: 'update-ip', ip: '192.168.10.63' }));
    await updated;
    assert.equal((await read()).ip, '192.168.10.62');
  } finally {
    if (id) await api('alice', 'DELETE', undefined, id);
    first.close(); second.close(); browser.close();
  }
});

test('Kết nối có tên chỉ tự lưu khi chia sẻ thành công; từ chối/chưa cấp quyền không lưu', async () => {
  const deviceId = randomUUID();
  const android = await agent(deviceId, '192.168.10.70');
  const browser = await controller();
  let savedId;
  const read = async () => (await (await api('alice')).json()).devices.find((entry) => entry.deviceId === deviceId);
  try {
    const requested = nextMessage(android, 'session-request');
    browser.send(JSON.stringify({ type: 'connect', method: 'ip', ip: '192.168.10.70', saveName: 'Tablet tự lưu' }));
    const { sessionId } = await requested;
    assert.equal(await read(), undefined);
    const ended = nextMessage(browser, 'session-ended');
    android.send(JSON.stringify({ type: 'session-response', sessionId, accept: false }));
    await ended;
    assert.equal(await read(), undefined);
    const retry = nextMessage(android, 'session-request');
    browser.send(JSON.stringify({ type: 'connect', method: 'ip', ip: '192.168.10.70', saveName: 'Tablet tự lưu' }));
    const accepted = await retry;
    const permission = nextMessage(browser, 'status');
    android.send(JSON.stringify({ type: 'session-response', sessionId: accepted.sessionId, accept: true }));
    await permission;
    assert.equal(await read(), undefined);
    const active = nextMessage(browser, 'session-active');
    android.send(JSON.stringify({ type: 'session-active', sessionId: accepted.sessionId, width: 1080, height: 2400 }));
    const value = await active;
    assert.equal(value.deviceId, deviceId);
    assert.equal(value.saveError, '');
    const saved = await read();
    assert.equal(saved.name, 'Tablet tự lưu');
    assert.equal(saved.ip, '192.168.10.70');
    savedId = saved.id;
    assert.equal((await (await api('bob')).json()).devices.some((entry) => entry.deviceId === deviceId), false);
  } finally {
    if (savedId) await api('alice', 'DELETE', undefined, savedId);
    android.close(); browser.close();
  }
});
