import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import { createAuth, parseCookies } from './auth.js';
import { createRelay } from './relay.js';
import { NETWORK_TEST_BYTES } from './network-diagnostics.js';
import { createSavedDevices } from './saved-devices.js';
import { isIPv4 } from 'node:net';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wwwroot');
const COOKIE_NAME = 'htit_session';
const NETWORK_TEST_PAYLOAD = randomBytes(NETWORK_TEST_BYTES);

function bearer(request) {
  const value = request.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : null;
}

function sameOrigin(request) {
  try {
    return new URL(request.headers.origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export function createApplication({ users, secureCookie = false, tls = null, savedDevicesFile = null }) {
  const app = express();
  const server = tls ? createHttpsServer(tls, app) : createHttpServer(app);
  const auth = createAuth(users);
  const savedDevices = createSavedDevices(savedDevicesFile);
  const relay = createRelay({ savedDevices });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const heartbeat = setInterval(() => {
    for (const ws of websocketServer.clients) {
      if (ws.isAlive === false) ws.terminate();
      else { ws.isAlive = false; ws.ping(); }
    }
  }, 30_000);

  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"],
    connectSrc: ["'self'", 'ws:', 'wss:'],
    imgSrc: ["'self'", 'data:', 'blob:']
  } } }));
  app.use(express.json({ limit: '16kb' }));
  const loginLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const agentLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  app.use('/api/auth/login', loginLimiter);
  app.use('/api/agent/token', agentLimiter);

  // Short-lived tickets are issued only for a logged-in controller's chosen online agent.
  app.use('/api/network-test/:testId/:operation', (request, response, next) => {
    const { testId, operation } = request.params;
    if (!((request.method === 'GET' && ['ping', 'download'].includes(operation))
      || (request.method === 'POST' && operation === 'upload'))) return response.sendStatus(405);
    if (!relay.authorizeNetworkProbe(testId, operation)) return response.sendStatus(403);
    response.set('Cache-Control', 'no-store, no-transform');
    next();
  });
  app.get('/api/network-test/:testId/ping', (_request, response) => response.sendStatus(204));
  app.get('/api/network-test/:testId/download', (_request, response) => response.type('application/octet-stream').send(NETWORK_TEST_PAYLOAD));
  app.post('/api/network-test/:testId/upload', express.raw({ type: 'application/octet-stream', limit: NETWORK_TEST_BYTES }), (request, response) => {
    if (!Buffer.isBuffer(request.body) || request.body.length !== NETWORK_TEST_BYTES) return response.sendStatus(400);
    return response.json({ bytes: request.body.length });
  });

  app.post('/api/auth/login', (request, response) => {
    const token = auth.login(String(request.body?.username || ''), String(request.body?.password || ''), 'browser');
    if (!token) return response.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
    response.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'strict', secure: secureCookie, maxAge: 8 * 60 * 60 * 1000, path: '/' });
    return response.json({ username: request.body.username });
  });
  app.post('/api/agent/token', (_request, response) => {
    return response.json({ token: auth.issueAgent(), expiresIn: 5 * 60 });
  });
  app.get('/api/auth/me', (request, response) => {
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    const session = auth.resolve(token, 'browser');
    return response.json(session ? { username: session.username } : { username: null });
  });
  app.post('/api/auth/logout', (request, response) => {
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    auth.logout(token);
    response.clearCookie(COOKIE_NAME, { path: '/' });
    return response.json({ ok: true });
  });

  app.use('/api/saved-devices', (request, response, next) => {
    const session = auth.resolve(parseCookies(request.headers.cookie)[COOKIE_NAME], 'browser');
    if (!session) return response.sendStatus(401);
    if (request.method !== 'GET' && !sameOrigin(request)) return response.sendStatus(403);
    response.locals.username = session.username;
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/saved-devices', (_request, response) => response.json({ devices: savedDevices.list(response.locals.username) }));
  app.post('/api/saved-devices', (request, response) => {
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    if (!name || name.length > 80) return response.status(400).json({ error: 'Tên thiết bị cần có từ 1 đến 80 ký tự' });
    let device;
    if (request.body.deviceId !== undefined) {
      device = relay.listDevices().find((value) => value.deviceId === request.body.deviceId);
      if (!device) return response.status(400).json({ error: 'Thiết bị chưa trực tuyến, hãy lưu bằng IP' });
    } else {
      const ip = typeof request.body.ip === 'string' ? request.body.ip.trim() : '';
      if (!isIPv4(ip)) return response.status(400).json({ error: 'Địa chỉ IPv4 không hợp lệ' });
      const matches = relay.listDevices().filter((value) => value.ip === ip);
      if (matches.length > 1) return response.status(400).json({ error: 'Có nhiều thiết bị cùng IP, hãy lưu từ danh sách đang trực tuyến' });
      device = matches[0] || { ip, deviceId: null };
    }
    if (!isIPv4(device.ip)) return response.status(400).json({ error: 'Thiết bị chưa có IPv4 LAN để lưu' });
    const saved = savedDevices.save(response.locals.username, { name, ip: device.ip, deviceId: device.deviceId });
    if (!saved) return response.status(400).json({ error: 'Mỗi tài khoản lưu tối đa 100 thiết bị' });
    relay.publishDevices();
    return response.status(201).json({ devices: savedDevices.list(response.locals.username) });
  });
  app.patch('/api/saved-devices/:id', (request, response) => {
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    if (!name || name.length > 80) return response.status(400).json({ error: 'Tên thiết bị cần có từ 1 đến 80 ký tự' });
    const existing = savedDevices.find(response.locals.username, request.params.id);
    if (!existing) return response.sendStatus(404);
    const changes = { name };
    if (request.body.ip !== undefined) {
      const ip = typeof request.body.ip === 'string' ? request.body.ip.trim() : '';
      if (!isIPv4(ip)) return response.status(400).json({ error: 'Địa chỉ IPv4 không hợp lệ' });
      changes.ip = ip;
      if (ip !== existing.ip) {
        const matches = relay.listDevices().filter((device) => device.ip === ip);
        if (matches.length > 1) return response.status(400).json({ error: 'Có nhiều thiết bị cùng IP, hãy dùng mã để chọn đúng thiết bị' });
        changes.deviceId = matches[0]?.deviceId || null;
      }
    }
    savedDevices.update(response.locals.username, request.params.id, changes);
    relay.publishDevices();
    return response.json({ devices: savedDevices.list(response.locals.username) });
  });
  app.delete('/api/saved-devices/:id', (request, response) => {
    if (!savedDevices.remove(response.locals.username, request.params.id)) return response.sendStatus(404);
    relay.publishDevices();
    return response.json({ devices: savedDevices.list(response.locals.username) });
  });
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    let session = null;
    let kind = null;
    if (url.pathname === '/ws/controller') {
      if (!sameOrigin(request)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      session = auth.resolve(parseCookies(request.headers.cookie)[COOKIE_NAME], 'browser');
      kind = 'controller';
    } else if (url.pathname === '/ws/agent') {
      session = auth.resolve(bearer(request), 'agent', true);
      kind = 'agent';
    }
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      if (kind === 'agent') relay.attachAgent(ws, session.username);
      else relay.attachController(ws, session.username);
    });
  });

  return { app, server, close: () => { clearInterval(heartbeat); relay.close(); websocketServer.close(); } };
}
