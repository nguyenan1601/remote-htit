import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createIpPing, parsePingOutput } from '../server/ip-ping.js';
import { createApplication } from '../server/app.js';

test('Đọc ping Windows/Linux, mất gói và lỗi ICMP không phải echo reply', () => {
  const windows = parsePingOutput(`Reply from 192.168.1.1: bytes=32 time=8ms TTL=64
Reply from 192.168.1.1: bytes=32 time=12ms TTL=64
Reply from 192.168.1.1: bytes=32 time=10ms TTL=64
Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),
Minimum = 8ms, Maximum = 12ms, Average = 10ms`);
  assert.deepEqual([windows.sent, windows.received, windows.lossPercent, windows.minMs, windows.avgMs, windows.maxMs], [4, 3, 25, 8, 10, 12]);
  const linux = parsePingOutput('4 packets transmitted, 4 received, 0% packet loss\nrtt min/avg/max/mdev = 1.5/2.5/3.5/0.5 ms');
  assert.deepEqual([linux.sent, linux.received, linux.lossPercent, linux.minMs, linux.avgMs, linux.maxMs], [4, 4, 0, 1.5, 2.5, 3.5]);
  for (const output of [
    '4 packets transmitted, 0 received, 100% packet loss',
    'Reply from 192.168.1.1: Destination host unreachable.\nPackets: Sent = 4, Received = 4, Lost = 0 (0% loss),',
  ]) {
    const failed = parsePingOutput(output);
    assert.equal(failed.received, 0);
    assert.equal(failed.lossPercent, 100);
    assert.equal(failed.avgMs, null);
    assert.match(failed.error, /Không có phản hồi/);
  }
  const unknown = parsePingOutput('ping: permission denied');
  assert.equal(unknown.sent, null);
  assert.equal(unknown.avgMs, null);
  assert.equal(parsePingOutput('x'.repeat(9000)).output.length, 4096);
});

test('Từ chối IP sai/URL/lệnh shell trước khi chạy tiến trình', async () => {
  const messages = [];
  let calls = 0;
  const ping = createIpPing((_ws, value) => messages.push(value), { run: async () => { calls += 1; } });
  for (const ip of ['192.168.1.1 & whoami', '-n 100', 'http://192.168.1.1', 'router.local', '256.0.0.1', '01.2.3.4', null, {}]) await ping.start({}, ip);
  assert.equal(calls, 0);
  assert.equal(messages.length, 8);
  assert.ok(messages.every((value) => value.type === 'ip-ping-result' && /hợp lệ/.test(value.message)));
  ping.close();
});

test('Ping nhận IP tùy ý, trả riêng đúng cửa sổ và giới hạn 5 giây', async () => {
  const a = {};
  const b = {};
  const messages = [];
  const called = [];
  const result = { received: 4 };
  const ping = createIpPing((ws, value) => messages.push({ ws, value }), {
    run: async (ip) => { called.push(ip); return result; },
  });
  await ping.start(a, '172.34.113.75');
  await ping.start(b, '::1');
  assert.deepEqual(called, ['172.34.113.75', '::1']);
  assert.equal(messages[1].ws, a);
  assert.equal(messages[1].value.targetIp, '172.34.113.75');
  assert.deepEqual(messages[1].value.result, result);
  assert.equal(messages[3].ws, b);
  assert.equal(messages[3].value.targetIp, '::1');
  await ping.start(a, '192.168.1.1');
  assert.match(messages.at(-1).value.message, /5 giây/);
  assert.equal(called.length, 2);
  ping.close();
});

test('Giới hạn lượt đồng thời, ngắt kết nối hủy tiến trình và không gửi kết quả muộn', async () => {
  const messages = [];
  const pending = [];
  const ping = createIpPing((ws, value) => messages.push({ ws, value }), {
    run: (_ip, signal) => new Promise((resolve) => pending.push({ resolve, signal })),
  });
  const sockets = Array.from({ length: 5 }, () => ({}));
  const jobs = sockets.slice(0, 4).map((ws) => ping.start(ws, '192.168.1.1'));
  await ping.start(sockets[0], '192.168.1.2');
  assert.match(messages.at(-1).value.message, /Đang ping/);
  await ping.start(sockets[4], '192.168.1.2');
  assert.match(messages.at(-1).value.message, /4 địa chỉ/);
  ping.cancelFor(sockets[0]);
  assert.equal(pending[0].signal.aborted, true);
  const count = messages.length;
  pending[0].resolve({ received: 4 });
  await jobs[0];
  assert.equal(messages.length, count);
  ping.close();
  assert.ok(pending.every(({ signal }) => signal.aborted));
  for (const item of pending.slice(1)) item.resolve({});
  await Promise.all(jobs);
});

test('Web đăng nhập ping loopback thật qua máy chủ khi không có Android đăng ký', async () => {
  const application = createApplication({ users: { support: 'TestPass!123' } });
  application.server.listen(0, '127.0.0.1');
  await once(application.server, 'listening');
  const baseUrl = `http://127.0.0.1:${application.server.address().port}`;
  let ws;
  try {
    const response = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'support', password: 'TestPass!123' }),
    });
    ws = new WebSocket(baseUrl.replace('http', 'ws') + '/ws/controller', {
      headers: { Cookie: response.headers.get('set-cookie').split(';')[0], Origin: baseUrl },
    });
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Ping timeout')), 20_000);
      ws.on('message', (data) => {
        const value = JSON.parse(data.toString());
        if (value.type === 'ip-ping-result') { clearTimeout(timer); resolve(value); }
        if (value.type === 'devices') assert.equal(value.devices.length, 0);
      });
    });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'ip-ping', targetIp: '127.0.0.1' }));
    const value = await result;
    assert.equal(value.targetIp, '127.0.0.1');
    assert.equal(value.result.sent, 4);
    assert.equal(value.result.received, 4);
    assert.equal(value.result.lossPercent, 0);
    assert.ok(Number.isFinite(value.result.avgMs));
    assert.ok(Date.parse(value.measuredAt));
  } finally {
    ws?.terminate();
    application.close();
    await new Promise((resolve) => application.server.close(resolve));
  }
});
