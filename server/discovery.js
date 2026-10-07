import dgram from 'node:dgram';

export const DISCOVERY_PORT = 8363;
export const DISCOVERY_PROBE = 'HTIT_REMOTE_DISCOVER_V1';

export function discoveryPayload({ httpPort, secure = false, publicUrl = '' }) {
  return JSON.stringify({
    service: 'htit-remote',
    version: 1,
    port: httpPort,
    secure,
    url: publicUrl,
  });
}

export function createDiscoveryResponder({
  httpPort,
  discoveryPort = DISCOVERY_PORT,
  secure = false,
  publicUrl = '',
  onReady = () => {},
  onError = () => {},
}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const payload = Buffer.from(discoveryPayload({ httpPort, secure, publicUrl }));

  socket.on('message', (message, remote) => {
    if (message.toString('utf8').trim() !== DISCOVERY_PROBE) return;
    socket.send(payload, remote.port, remote.address);
  });
  socket.on('error', onError);
  socket.bind(discoveryPort, '0.0.0.0', () => onReady(socket.address().port));
  return socket;
}
