import { execFile } from 'node:child_process';
import { isIP } from 'node:net';

export function parsePingOutput(output) {
  const result = { sent: null, received: null, lossPercent: null, minMs: null, avgMs: null, maxMs: null, output: output.slice(0, 4096), error: '' };
  // Windows statistics use sent/received/lost; Linux uses transmitted/received.
  const windows = output.match(/=\s*(\d+),[^=\n]+=\s*(\d+),[^=\n]+=\s*\d+\s*\(\s*\d+%/);
  const linux = output.match(/(\d+) packets transmitted,\s*(\d+) (?:packets )?received/);
  const counts = windows || linux;
  if (counts && Number(counts[1]) > 0) {
    result.sent = Number(counts[1]);
    // Windows may count ICMP "destination unreachable" errors as received packets.
    result.received = windows ? output.split(/\r?\n/)
      .filter((line) => line.includes(':') && /TTL=\d+|[=<]\s*[\d.,]+\s*ms/.test(line)).length : Number(counts[2]);
    result.lossPercent = (result.sent - result.received) * 100 / result.sent;
    if (!result.received) result.error = 'Không có phản hồi ICMP; đích có thể không truy cập được hoặc chặn ping';
  } else {
    result.error = 'Không đọc được thống kê ping; xem kết quả chi tiết';
  }
  const windowsTimes = output.match(/=\s*(\d+)\s*ms,[^=\n]+=\s*(\d+)\s*ms,[^=\n]+=\s*(\d+)\s*ms/);
  const linuxTimes = output.match(/(?:rtt|round-trip) min\/avg\/max[^=]*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
  if (result.received > 0) {
    if (windowsTimes) [result.minMs, result.maxMs, result.avgMs] = windowsTimes.slice(1).map(Number);
    else if (linuxTimes) [result.minMs, result.avgMs, result.maxMs] = linuxTimes.slice(1).map(Number);
  }
  return result;
}

function runIpPing(targetIp, signal) {
  const windows = process.platform === 'win32';
  const args = windows ? ['-n', '4', '-w', '2000', targetIp] : ['-n', '-c', '4', '-W', '2', '-w', '10', targetIp];
  return new Promise((resolve) => {
    execFile(windows ? 'ping.exe' : 'ping', args, { shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 8192, encoding: 'utf8', signal }, (error, stdout, stderr) => {
      const result = parsePingOutput(`${stdout || ''}${stderr || ''}`);
      if (error?.code === 'ENOENT') result.error = 'Máy chủ chưa có lệnh ping. Cài ping trên hệ điều hành máy chủ.';
      else if (error?.killed) result.error = 'Hết thời gian ping';
      else if (error && result.sent === null) result.error = 'Máy chủ không thực hiện được ping; xem kết quả chi tiết';
      resolve(result);
    });
  });
}

export function createIpPing(sendJson, { run = runIpPing } = {}) {
  const jobs = new Map();
  const lastStarted = new WeakMap();

  async function start(ws, targetIp) {
    const fail = (message) => sendJson(ws, { type: 'ip-ping-result', message });
    if (typeof targetIp !== 'string' || targetIp.length > 45 || !/^[\da-fA-F:.]+$/.test(targetIp) || !isIP(targetIp)) return fail('Nhập địa chỉ IPv4 hoặc IPv6 hợp lệ');
    if (jobs.has(ws)) return fail('Đang ping, vui lòng chờ kết quả');
    if (jobs.size >= 4) return fail('Máy chủ đang ping 4 địa chỉ, vui lòng thử lại sau');
    if (Date.now() - (lastStarted.get(ws) || 0) < 5_000) return fail('Vui lòng chờ 5 giây giữa hai lần ping');
    lastStarted.set(ws, Date.now());
    const job = new AbortController();
    jobs.set(ws, job);
    sendJson(ws, { type: 'ip-ping-started', targetIp });
    try {
      const result = await run(targetIp, job.signal);
      if (jobs.get(ws) === job) sendJson(ws, { type: 'ip-ping-result', targetIp, result, measuredAt: new Date().toISOString() });
    } catch {
      if (jobs.get(ws) === job) fail('Máy chủ không thực hiện được ping');
    } finally {
      if (jobs.get(ws) === job) jobs.delete(ws);
    }
  }

  function cancelFor(ws) {
    const job = jobs.get(ws);
    jobs.delete(ws);
    job?.abort();
  }

  function close() {
    for (const ws of jobs.keys()) cancelFor(ws);
  }

  return { start, cancelFor, close };
}
