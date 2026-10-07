import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const AGENT_TOKEN_TTL_MS = 5 * 60 * 1000;

function hashPassword(password, salt) {
  return scryptSync(password, salt, 32);
}

function safeEqual(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAuth(users) {
  const records = new Map(
    Object.entries(users).map(([username, password]) => {
      const salt = randomBytes(16);
      return [username, { salt, hash: hashPassword(password, salt) }];
    }),
  );
  const tokens = new Map();

  function issue(username, kind, ttlMs = TOKEN_TTL_MS) {
    const token = randomBytes(32).toString('base64url');
    tokens.set(token, { username, kind, expiresAt: Date.now() + ttlMs });
    return token;
  }

  function login(username, password, kind) {
    const record = records.get(username);
    if (!record || !safeEqual(record.hash, hashPassword(password, record.salt))) return null;
    return issue(username, kind);
  }

  function resolve(token, kind, consume = false) {
    const session = token ? tokens.get(token) : null;
    if (!session || session.kind !== kind || session.expiresAt <= Date.now()) {
      if (token) tokens.delete(token);
      return null;
    }
    if (consume) tokens.delete(token);
    return session;
  }

  function logout(token) {
    if (token) tokens.delete(token);
  }

  return {
    issueAgent: () => issue('android-device', 'agent', AGENT_TOKEN_TTL_MS),
    login,
    resolve,
    logout,
  };
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => part.trim().split('=')).filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}
