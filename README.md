# HTIT Remote — Hỗ trợ Android nội bộ (LAN)

Cặp phần mềm hỗ trợ từ xa nội bộ: **web điều khiển chạy trên PC** + **APK Android**.
Tương tự UltraViewer ở mức cơ bản: xem màn hình Android theo thời gian thực, điều khiển
chạm / giữ / vuốt / Back / Home — chỉ trong LAN, sau khi người dùng trên Android đồng ý.

## Thành phần

| Thư mục | Nội dung |
|---|---|
| `server/` | ASP.NET Core (.NET 8) — máy điều khiển: API + WebSocket + trang web |
| `agent/` | Android app (Java thuần, minSdk 26) — agent: chia sẻ màn hình + thực thi gesture |
| `tests/` | xUnit: mã hóa (RFC 5869/ AES-GCM), protocol loopback e2e (10 test, đã pass) |

## Bảo mật

- Kênh PC ↔ Android: TCP + **AES-256-GCM** 2 chiều, nonce + sequence chéo, chống replay.
- Bắt tay: lẫn nhau HMAC-SHA256 proof từ **mã ghép đối 6 số** hiển thị trên màn hình Android
  và nhập trên web lần đầu; sau đó thiết bị secret 32-byte xoay mỗi phiên (HKDF-SHA256).
- IP **không** là danh tính: pair key theo deviceId; xóa ghép đôi từ web bất cứ lúc nào.
- Người dùng Android phải **«Chấp nhận»** từng phiên; hộp thoại mặc định **từ chối** sau 30 giây.
- Frames/Lệnh chỉ chạy sau khi người dùng cấp phép MediaProjection (system dialog).
- Thoát phiên (ngắt từ bất kỳ bên nào, mất Wi-Fi, MediaProjection dừng) → ngừng truyền
  và app Android về trạng thái chờ an toàn.
- Máy PC nghe web: HTTP nội bộ, **token bảo vệ** (in ra console, lưu `%LOCALAPPDATA%\HTITRemote\webtoken.txt`).
  Không exposes Internet.

## Chạy nhanh (DEV)

### Server web (Windows)
```
cd server
dotnet run
```
- Serves `http://0.0.0.0:5000` (mặc định Kestrel appsettings) — truy cập `http://<IP máy PC>:<port>/`.
- Token: in ra console khi khởi động.

### Android agent
- Build APK (đã kiểm chứng trên máy này):
  ```
  set JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot
  set ANDROID_HOME=G:\Android\Sdk
  G:\Android\gradle-8.9\bin\gradle.bat -p agent clean assembleDebug assembleRelease
  ```
  Lưu ý: `JAVA_HOME` mặc định của Android Studio (jbr) là **JDK 25**, làm hỏng task lint
  của AGP 8.5.2 (`JavaVersion.parse: 25.0.2`) — phải trỏ sang **JDK 17**.
- APK xuất ra: `agent/app/build/outputs/apk/{debug,release}/`; bản phát hành sao chép
  vào `dist/HTITRemote-0.1.0-release.apk` (ký bằng debug keystore, đủ để cài nội bộ).
- Cấu hình: `AgentServer.LISTEN_PORT = 8262` (điều hướng vào UI máy).
- Cài APK trên máy Android → mở app → bật Trợ năng "HTIT Remote Agent — Điều khiển từ xa"
  (Android 13+ cần bật "Allow restricted settings" tự động? bạn sẽ thấy nhắc).

## API máy điều khiển
- `Get /` — web điều khiển (giao diện canvas frame).
- `POST /api/connect {host, port, code?}` — tạo phiên; nếu chưa ghép đôi → trả
   `"pairing-required"`. Android sẽ hiện hộp thoại Chấp nhận / Từ chối.
- `WS /api/ws?t=...` — nhận frame (binary JPEG) + trạng thái; gửi `{"t":"input","a":"tap",...}`.
- `POST /api/disconnect` — kết thúc phiên.
- `POST /api/paired/{deviceId}/forget` — xóa ghép đôi.

## Test
```
cd tests
dotnet test
```
10 tests: HKDF (RFC 5869 A.1/A.2), HMAC, AES-GCM round-trip + replay, e2e loopback
(fake-agent đầy handshake → frames → lệnh → STOP; từ chối phiên; mã sai; busy...).

## Hạn chế hiện tại (MVP)
- Chỉ **một phiên đồng thời** trên một thiết bị (busy nếu xem khác vào tiếp).
- Video hiển thị dạng **JPEG** 8 fps, thu nhỏ max 1080 px (POC); codec H.264/H.265
  nên nâng sau khi đo thực tế LAN.
- Java thuần không dùng AndroidX/Kotlin — giảm rủi ro phụ thuộc, build nhanh.
- Web UI truy cập HTTP (token bảo vệ) — chưa có HTTPS cho trình duyệt;
  kênh PC↔Android đã mã hóa AES-GCM đầy đủ.
- Chưa ký/ví: APK debug build; build release nên đặt keystore riêng khi vận hành.
