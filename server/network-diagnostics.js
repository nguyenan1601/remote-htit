import { randomUUID } from 'node:crypto';

export const NETWORK_TEST_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 45_000;
const COOLDOWN_MS = 30_000;
const METRICS = ['pingMs', 'minPingMs', 'maxPingMs', 'jitterMs', 'lossPercent', 'downloadMbps', 'uploadMbps'];

export function createNetworkDiagnostics(sendJson) {
  const jobs = new Map();

  function complete(job, value) {
    clearTimeout(job.timer);
    jobs.delete(job.id);
    sendJson(job.controllerWs, { type: 'network-test-result', deviceId: job.agent.deviceId, scope: job.scope, ...value });
  }

  function start(agent, controllerWs, deviceId, scope = 'lan') {
    const fail = (message) => sendJson(controllerWs, { type: 'network-test-result', deviceId, scope, message });
    if (scope !== 'lan') return fail('Chỉ hỗ trợ kiểm tra mạng nội bộ tới máy chủ HTIT');
    if (!agent) return fail('Thiết bị chưa trực tuyến');
    if (!agent.networkDiagnostics) return fail('Cần cập nhật APK 1.2.0 để kiểm tra mạng');
    if ([...jobs.values()].some((job) => job.agent === agent)) return fail('Thiết bị đang đo mạng, vui lòng chờ');
    if (jobs.size >= 4) return fail('Máy chủ đang đo 4 thiết bị, vui lòng thử lại sau');
    if (Date.now() - (agent.lastNetworkTest || 0) < COOLDOWN_MS) return fail('Vui lòng chờ 30 giây giữa hai lần đo');
    agent.lastNetworkTest = Date.now();
    const job = { id: randomUUID(), agent, controllerWs, scope, probes: { ping: 0, download: 0, upload: 0 }, timer: null };
    jobs.set(job.id, job);
    job.timer = setTimeout(() => complete(job, { message: 'Hết thời gian đo — kiểm tra kết nối hoặc cập nhật APK' }), TIMEOUT_MS);
    sendJson(controllerWs, { type: 'network-test-started', deviceId, scope });
    sendJson(agent.ws, { type: 'network-test-request', testId: job.id, scope });
  }

  function authorize(testId, operation) {
    const job = jobs.get(testId);
    const limit = operation === 'ping' ? 6 : 1;
    if (!job || job.scope !== 'lan' || job.agent.ws.readyState !== 1 || !Object.hasOwn(job.probes, operation) || job.probes[operation] >= limit) return false;
    job.probes[operation] += 1;
    return true;
  }

  function finish(agent, message) {
    const job = jobs.get(message.testId);
    if (!job || job.agent !== agent) return;
    const result = {};
    for (const key of METRICS) {
      const value = message.result?.[key];
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > (key === 'lossPercent' ? 100 : 1_000_000))) return;
      result[key] = value;
    }
    result.errors = Array.isArray(message.result.errors)
      ? message.result.errors.filter((value) => typeof value === 'string').slice(0, 3).map((value) => value.slice(0, 160)) : [];
    complete(job, { result, measuredAt: new Date().toISOString() });
  }

  function cancelFor(ws) {
    for (const job of jobs.values()) {
      if (job.agent.ws === ws || job.controllerWs === ws) complete(job, { message: 'Kết nối bị ngắt trong khi đo mạng' });
    }
  }

  function close() {
    for (const job of jobs.values()) clearTimeout(job.timer);
    jobs.clear();
  }

  return { start, authorize, finish, cancelFor, close };
}
