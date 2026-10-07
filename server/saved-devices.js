import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createSavedDevices(file = null) {
  let entries = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  if (!Array.isArray(entries)) throw new Error('Danh sách thiết bị đã lưu không hợp lệ');

  function commit(next) {
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    }
    entries = next;
  }

  function list(username) {
    return entries.filter((entry) => entry.username === username).map(({ id, name, ip, deviceId }) => ({ id, name, ip, deviceId }));
  }

  function find(username, id) {
    return entries.find((entry) => entry.username === username && entry.id === id);
  }

  function save(username, { name, ip, deviceId = null }) {
    const existing = entries.find((entry) => entry.username === username
      && (deviceId ? entry.deviceId === deviceId || (!entry.deviceId && entry.ip === ip) : !entry.deviceId && entry.ip === ip));
    if (!existing && list(username).length >= 100) return null;
    const entry = { username, id: existing?.id || randomUUID(), name, ip, deviceId };
    commit(existing ? entries.map((value) => value === existing ? entry : value) : [...entries, entry]);
    return entry;
  }

  function update(username, id, changes) {
    const entry = find(username, id);
    if (!entry) return false;
    commit(entries.map((value) => value === entry ? { ...entry, ...changes } : value));
    return true;
  }

  function remove(username, id) {
    const entry = find(username, id);
    if (!entry) return false;
    commit(entries.filter((value) => value !== entry));
    return true;
  }

  function updateIp({ deviceId, ip }) {
    if (!ip || !entries.some((entry) => entry.deviceId === deviceId && entry.ip !== ip)) return;
    commit(entries.map((entry) => entry.deviceId === deviceId ? { ...entry, ip } : entry));
  }

  return { list, find, save, update, remove, updateIp };
}
