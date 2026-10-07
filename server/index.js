import fs from 'node:fs';
import path from 'node:path';
import { createApplication } from './app.js';
import { createDiscoveryResponder, DISCOVERY_PORT } from './discovery.js';

const DATA_DIR = path.resolve('data');
const PASSWORD_FILE = path.join(DATA_DIR, 'admin-password.txt');
const DEFAULT_ADMIN_PASSWORD = 'admin';

function configuredUsers() {
  if (process.env.HTIT_USERS) return JSON.parse(process.env.HTIT_USERS);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const password = process.env.HTIT_ADMIN_PASSWORD || (fs.existsSync(PASSWORD_FILE)
    ? fs.readFileSync(PASSWORD_FILE, 'utf8').trim()
    : DEFAULT_ADMIN_PASSWORD);
  if (!process.env.HTIT_ADMIN_PASSWORD && !fs.existsSync(PASSWORD_FILE)) fs.writeFileSync(PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
  console.log(`Tài khoản khởi tạo: admin / ${password}`);
  return { admin: password };
}

const port = Number(process.env.PORT || 8362);
const host = process.env.HOST || '0.0.0.0';
const tls = process.env.HTIT_TLS_CERT && process.env.HTIT_TLS_KEY ? {
  cert: fs.readFileSync(process.env.HTIT_TLS_CERT),
  key: fs.readFileSync(process.env.HTIT_TLS_KEY),
} : null;
const { server } = createApplication({
  users: configuredUsers(),
  secureCookie: Boolean(tls) || process.env.HTIT_SECURE_COOKIE === 'true',
  tls,
  savedDevicesFile: path.join(DATA_DIR, 'saved-devices.json'),
});
server.listen(port, host, () => {
  console.log(`HTIT Remote: ${tls ? 'https' : 'http'}://${host}:${port}`);
  createDiscoveryResponder({
    httpPort: port,
    discoveryPort: DISCOVERY_PORT,
    secure: Boolean(tls),
    publicUrl: process.env.HTIT_PUBLIC_URL || '',
    onReady: (discoveryPort) => console.log(`Tự dò Android: UDP 0.0.0.0:${discoveryPort}`),
    onError: (error) => console.error(`Không thể chạy tự dò Android: ${error.message}`),
  });
});
