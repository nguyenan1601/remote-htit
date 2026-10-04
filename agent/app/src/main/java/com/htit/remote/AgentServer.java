package com.htit.remote;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicReference;

/**
 * TCP agent server, byte-compatible with server-side C# (server/Protocol.cs, AgentLink.cs, CoreCrypto.cs).
 * One live session at a time; further controllers get ERR busy and are closed.
 */
public final class AgentServer {
    public interface Listener {
        /** Show accept/reject on UI thread and block. Returns {"accept":boolean,"w":..,"h":..}. */
        JSONObject onPrompt(String controllerName) throws IOException;

        /** User accepted: UI starts MediaProjection + casting. Called after PROMPT resolved as accept. */
        void onAccepted(AgentSession session, JSONObject acceptInfo);

        void onEnded(String reason);
    }

    /** Wraps the live socket of one session with synchronized packet sending. */
    public static final class AgentSession {
        public final String controllerName;
        public volatile boolean active;
        private final Socket socket;
        private LinkCipher tx;
        private LinkCipher rx;

        AgentSession(String controllerName, Socket socket) {
            this.controllerName = controllerName;
            this.socket = socket;
        }

        void setCiphers(LinkCipher sendCipher, LinkCipher recvCipher) {
            this.tx = sendCipher;
            this.rx = recvCipher;
        }

        public boolean isReady() {
            return tx != null && rx != null;
        }

        /** Synchronized: frame sender thread and packet pump thread share this socket. */
        public synchronized void sendPacket(byte type, byte[] payload) throws IOException {
            try {
                byte[] envelope = tx.encrypt(type, payload);
                int total = 1 + envelope.length;
                byte[] buf = new byte[4 + total];
                buf[0] = (byte) (total >> 24);
                buf[1] = (byte) (total >> 16);
                buf[2] = (byte) (total >> 8);
                buf[3] = (byte) total;
                buf[4] = type;
                System.arraycopy(envelope, 0, buf, 5, envelope.length);
                OutputStream out = socket.getOutputStream();
                out.write(buf);
                out.flush();
            } catch (IOException e) {
                throw e;
            } catch (Exception e) {
                throw new IOException("Không gửi được gói: " + e.getMessage(), e);
            }
        }

        public void sendFrame(byte[] jpeg) throws IOException {
            if (!active) throw new IOException("Phiên chưa được chấp nhận — không gửi frame");
            sendPacket(Wire.T_FRAME, jpeg);
        }

        public void close() {
            try { socket.close(); } catch (IOException ignored) { }
        }
    }

    private static final int GEN_LEN_BYTES = 4;
    public static int LISTEN_PORT = 8262;
    private static final String TAG = "HTITRemote";

    private final Context context;
    private final AtomicReference<AgentSession> sessionRef = new AtomicReference<>();
    private volatile ServerSocket server;
    private Thread acceptThread;
    private volatile boolean running;
    public volatile Listener listener;

    public AgentServer(Context appContext, int port, Listener listener) {
        this.context = appContext.getApplicationContext();
        appCtx = this.context;
        DeviceIdentity.get(this.context);
        LISTEN_PORT = port;
        this.listener = listener;
    }

    static Context appCtx;

    static void slog(String m) {
        try {
            java.io.File f = new java.io.File(appCtx.getExternalFilesDir(null), "agent.log");
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(new java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(new java.util.Date()) + " " + m + "\n");
            w.close();
        } catch (Exception ignored) { }
    }

    public boolean hasSession() {
        return sessionRef.get() != null;
    }

    public boolean isReady() {
        return running && server != null && server.isBound();
    }

    /** UI-initiated end of the current session (user pressed disconnect). */
    public void uiEndSession(String reason) {
        AgentSession s = sessionRef.getAndSet(null);
        if (s != null) {
            s.active = false;
            s.close();
            if (listener != null) {
                try { listener.onEnded(reason); } catch (Exception ignored) { }
            }
        }
    }

    /** UI-initiated deny (e.g. user refused system projection consent). */
    public void uiDeny(String reason) {
        AgentSession s = sessionRef.get();
        if (s != null) {
            try {
                JSONObject deny = new JSONObject();
                deny.put("why", reason);
                s.sendPacket(Wire.T_DENY, deny.toString().getBytes(StandardCharsets.UTF_8));
            } catch (Exception ignored) { }
        }
        uiEndSession("ui-denied");
    }

    public AgentSession currentSession() {
        AgentSession s = sessionRef.get();
        return (s != null && s.active) ? s : null;
    }

    public synchronized boolean start() {
        if (running) return true;
        try {
            server = new ServerSocket();
            server.setReuseAddress(true);
            server.bind(new InetSocketAddress("0.0.0.0", LISTEN_PORT));
        } catch (IOException e) {
            Log.e(TAG, "Không mở được cổng " + LISTEN_PORT, e);
            return false;
        }
        running = true;
        acceptThread = new Thread(() -> {
            while (running) {
                try {
                    Socket s = server.accept();
                    if (sessionRef.get() != null) {
                        refuse(s);
                    } else {
                        new Thread(() -> handle(s), "agent-session").start();
                    }
                } catch (IOException e) {
                    if (running) {
                        try { Thread.sleep(200); } catch (InterruptedException ig) { break; }
                    }
                }
            }
        }, "agent-accept");
        acceptThread.start();
        return true;
    }

    public synchronized void stop() {
        running = false;
        AgentSession s = sessionRef.getAndSet(null);
        if (s != null) {
            s.close();
        }
        try {
            if (server != null) server.close();
        } catch (IOException ignored) { }
        if (acceptThread != null) acceptThread.interrupt();
    }

    private void refuse(Socket s) {
        try {
            writePacket(s, Wire.T_ERR,
                    "{\"code\":\"busy\",\"msg\":\"Thiết bị đang có một phiên chia sẻ khác\"}".getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) { }
        close(s);
    }

    private void handle(Socket socket) {
        AgentSession session = null;
        try {
            socket.setTcpNoDelay(true);
            socket.setSoTimeout(10000);
            dlog("conn from " + socket.getInetAddress());

            InputStream in = socket.getInputStream();

            // ---- 1. magic + controller nonce ----
            byte[] magicAndAd = new byte[Wire.MAGIC.length + 16];
            readFully(in, magicAndAd);
            if (!Arrays.equals(Wire.MAGIC, Arrays.copyOfRange(magicAndAd, 0, Wire.MAGIC.length))) {
                throw new IOException("Sai giao thức bắt tay");
            }
            byte[] ad = Arrays.copyOfRange(magicAndAd, Wire.MAGIC.length, magicAndAd.length);
            byte[] an = LinkCipher.randomBytes(16);
            byte[] gen = LinkCipher.randomBytes(GEN_LEN_BYTES);
            byte[] transcript = concat(ad, an);

            // ---- 2. HELLO ----
            DeviceIdentity identity = DeviceIdentity.get(context);
            JSONObject hello = new JSONObject();
            hello.put("v", Wire.PROTOCOL_VERSION);
            hello.put("id", identity.deviceId());
            hello.put("dn", identity.deviceName());
            hello.put("an", b64(an));
            hello.put("g", b64(gen));
            writePacket(socket, Wire.T_HELLO, hello.toString().getBytes(StandardCharsets.UTF_8));

            // ---- 3. AUTH ----
            byte[] authPacket = readPacket(in);
            if (authPacket[0] != Wire.T_AUTH) throw new IOException("Chưa xác thực mà đã gửi gói khác loại");
            JSONObject auth = payloadJson(authPacket);
            byte[] proofGot = unb64(auth.optString("p1", ""));
            if (proofGot.length != 32) {
                // controller says it has no pairing for this device: ask operator for the code
                writePacket(socket, Wire.T_RESULT,
                        "{\"ok\":false,\"why\":\"Chưa ghép đôi — cần mã ghép đôi trên Android\"}".getBytes(StandardCharsets.UTF_8));
                close(socket);
                return;
            }

            // IP-only: accept the stored secret, the legacy pairing code, or the fixed open secret.
            byte[] matchedSecret = null;
            byte[] stored = identity.storedSecret();
            boolean matchedPairingCode = false;
            if (stored != null && matches(stored, proofGot, transcript)) matchedSecret = stored;
            else if (matches(DeviceIdentity.secretFromCode(identity.pairingCode()), proofGot, transcript)) {
                matchedSecret = DeviceIdentity.secretFromCode(identity.pairingCode());
                matchedPairingCode = true;
            } else if (matches(DeviceIdentity.openSecret(), proofGot, transcript)) {
                matchedSecret = DeviceIdentity.openSecret();
            }
            if (matchedSecret == null) {
                writePacket(socket, Wire.T_RESULT,
                        "{\"ok\":false,\"why\":\"Mã ghép đôi không đúng / chưa ghép đôi\"}".getBytes(StandardCharsets.UTF_8));
                close(socket);
                return;
            }
            Log.i(TAG, "auth ok from " + socket.getInetAddress() + " stored=" + (stored != null) + " code=" + matchedPairingCode);
            dlog("auth ok stored=" + (stored != null) + " code=" + matchedPairingCode);

            byte[] prk = Crypto.hkdfExtract("HTR-PWR-v1".getBytes(StandardCharsets.US_ASCII),
                    concat(transcript, matchedSecret));
            byte[] cKey = Crypto.hkdfExpand(prk, "htr c2s v1 key", 32);
            byte[] sKey = Crypto.hkdfExpand(prk, "htr s2c v1 key", 32);
            byte[] proofS = Crypto.hmacSha256(Crypto.hkdfExpand(prk, "htr s2c v1 proof", 32), transcript,
                    "S".getBytes(StandardCharsets.US_ASCII));
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("p2", b64(proofS));
            result.put("g", b64(gen));
            writePacket(socket, Wire.T_RESULT, result.toString().getBytes(StandardCharsets.UTF_8));

            // Keep the paired secret stable. On first pairing (or after a re-pair),
            // persist the derived session secret so future sessions do not need the code.
            if (matchedPairingCode) {
                identity.storeSecret(Crypto.hkdfExpand(prk, "htr device secret v1", 32));
            }
            socket.setSoTimeout(15000);

            // ---- 4. encrypted session ----
            session = new AgentSession(auth.optString("cn", "Trạm điều khiển"), socket);
            session.setCiphers(new LinkCipher(sKey, gen), new LinkCipher(cKey, gen));
            if (!sessionRef.compareAndSet(null, session)) {
                refuseTo(session, "Thiết bị đang có một phiên chia sẻ khác");
                return;
            }
            try {
                pumpEnvelope(session, in);
            } finally {
                endSession(session, "ended");
            }
        } catch (Exception e) {
            Log.w(TAG, "session error: " + e, e);
            dlog("ERR " + e);
            try {
                JSONObject err = new JSONObject();
                err.put("code", "proto-error");
                err.put("msg", "Lỗi phiên: " + e.getMessage());
                byte[] payload = err.toString().getBytes(StandardCharsets.UTF_8);
                if (session != null && session.isReady()) session.sendPacket(Wire.T_ERR, payload);
                else if (socket.isConnected()) writePacket(socket, Wire.T_ERR, payload);
            } catch (Exception ignored) { }
            close(socket);
            if (session != null) endSession(session, "error");
        }
    }

    private void dlog(String msg) {
        try {
            java.io.File f = new java.io.File(context.getExternalFilesDir(null), "agent.log");
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(new java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(new java.util.Date()) + " " + msg + "\n");
            w.close();
        } catch (Exception ignored) { }
    }

    private void refuseTo(AgentSession s, String msg) {
        try {
            s.sendPacket(Wire.T_ERR,
                    ("{\"code\":\"busy\",\"msg\":\"" + msg + "\"}").getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) { }
        s.close();
    }

    private boolean matches(byte[] secret, byte[] proof, byte[] transcript) throws Exception {
        byte[] prk = Crypto.hkdfExtract("HTR-PWR-v1".getBytes(StandardCharsets.US_ASCII), concat(transcript, secret));
        byte[] want = Crypto.hmacSha256(Crypto.hkdfExpand(prk, "htr c2s v1 proof", 32), transcript,
                "C".getBytes(StandardCharsets.US_ASCII));
        return Crypto.fixedTimeEquals(want, proof);
    }

    /** Reads encrypted packets forever; ACCEPT/PROMPT flow is driven by listener callbacks. */
    private void pumpEnvelope(AgentSession session, InputStream in) throws Exception {
        while (true) {
            byte[] packet = readPacket(in);
            byte type = packet[0];
            byte[] envelope = new byte[packet.length - 1];
            System.arraycopy(packet, 1, envelope, 0, envelope.length);
            byte[] plain = session.rx.decrypt(type, envelope);
            switch (type) {
                case Wire.T_REQ: {
                    Log.i(TAG, "REQ received from " + session.controllerName + " listener=" + (listener != null));
                    dlog("REQ listener=" + (listener != null));
                    if (listener == null) throw new IOException("Không có UI đăng ký xử lý yêu cầu");
                    JSONObject ans = listener.onPrompt(session.controllerName);
                    Log.i(TAG, "prompt result: " + ans);
                    dlog("prompt result=" + ans);
                    boolean acc = ans.optBoolean("accept", false);
                    if (!acc) {
                        JSONObject deny = new JSONObject();
                        deny.put("why", ans.optString("why", "Người dùng đã từ chối"));
                        try {
                            session.sendPacket(Wire.T_DENY, deny.toString().getBytes(StandardCharsets.UTF_8));
                        } catch (IOException ignored) { }
                        endSession(session, "denied");
                        return;
                    }
                    session.active = true;
                    listener.onAccepted(session, ans);
                    break;
                }
                case Wire.T_INPUT:
                    InputExecutor.apply(context, plain);
                    break;
                case Wire.T_PING:
                    session.sendPacket(Wire.T_PONG, new byte[0]);
                    break;
                case Wire.T_STOP:
                    endSession(session, "controller-stop");
                    return;
                default:
                    break; // forward compatibility
            }
        }
    }

    private void endSession(AgentSession session, String reason) {
        dlog("endSession " + reason);
        sessionRef.compareAndSet(session, null);
        session.active = false;
        session.close();
        if (listener != null)
            try { listener.onEnded(reason); } catch (Exception ignored) { }
    }

    private static void close(Socket s) {
        try { s.close(); } catch (IOException ignored) { }
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] r = new byte[a.length + b.length];
        System.arraycopy(a, 0, r, 0, a.length);
        System.arraycopy(b, 0, r, a.length, b.length);
        return r;
    }

    private static JSONObject payloadJson(byte[] packetWithHeader) throws Exception {
        byte[] payload = new byte[packetWithHeader.length - 1];
        System.arraycopy(packetWithHeader, 1, payload, 0, payload.length);
        if (payload.length == 0) return new JSONObject();
        return new JSONObject(new String(payload, StandardCharsets.UTF_8));
    }

    static void writePacket(Socket s, byte type, byte[] payload) throws IOException {
        OutputStream out = s.getOutputStream();
        int total = 1 + payload.length;
        byte[] hdr = new byte[5];
        hdr[0] = (byte) (total >> 24);
        hdr[1] = (byte) (total >> 16);
        hdr[2] = (byte) (total >> 8);
        hdr[3] = (byte) total;
        hdr[4] = type;
        out.write(hdr);
        out.write(payload);
        out.flush();
    }

    /** Returns [type][payload]. */
    static byte[] readPacket(InputStream in) throws IOException {
        byte[] hdr = new byte[4];
        readFully(in, hdr);
        int total = ((hdr[0] & 0xFF) << 24) | ((hdr[1] & 0xFF) << 16) | ((hdr[2] & 0xFF) << 8) | (hdr[3] & 0xFF);
        if (total < 1 || total > 16 * 1024 * 1024) throw new IOException("Kích thước gói sai");
        byte[] full = new byte[total];
        readFully(in, full);
        return full;
    }

    static void readFully(InputStream in, byte[] target) throws IOException {
        int off = 0;
        while (off < target.length) {
            int n = in.read(target, off, target.length - off);
            if (n < 0) throw new IOException("Thiết bị đã ngắt kết nối");
            off += n;
        }
    }

    static String b64(byte[] data) {
        return java.util.Base64.getEncoder().encodeToString(data);
    }

    static byte[] unb64(String s) {
        return java.util.Base64.getDecoder().decode(s);
    }
}
