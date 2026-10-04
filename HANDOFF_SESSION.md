# Bàn giao session — HTIT Remote (Windows controller + Android agent)

Ngày: 2026-10-04 · Repo: `G:\Workspace\vmt-app`

## 1. Mục tiêu

Điều khiển từ xa **Windows (web UI) → Android agent** qua LAN. Phase Windows→Windows để sau.
Hiện đang ở bước **gỡ nốt lỗi để phiên chạy tới `active` trên máy thật**.

Thiết kế bảo mật đã đổi theo yêu cầu người dùng: **bỏ mã ghép đôi, chỉ cần nhập IP** (xem mục 4).

## 2. Trạng thái hiện tại (đọc trước)

Đã chạy được tới đây trên máy thật:

```
connect (chỉ IP) → connecting → prompting  (hộp thoại xin phép hiện trên điện thoại)
   → bấm "CHẤP NHẬN" → agent ghi prompt result={"accept":true}  ✅
   → hộp thoại cấp quyền chia sẻ màn hình hệ thống → getMediaProjection OK  ✅
   → gửi gói ACCEPT  ❌  ("accept-failed")  ← LỖI CUỐI CÒN LẠI
```

- Session **không còn tự chết lúc chờ** (đã sống qua 17s chờ).
- Xác thực/giải mã hai chiều **đã chạy** (trước đây luôn hỏng — xem mục 4).
- **Chưa bao giờ đạt `active`** vì gói ACCEPT gửi thất bại.

## 3. Môi trường / lệnh

**Server (C#/.NET 8)**
```powershell
dotnet run --project G:\Workspace\vmt-app\server\HTITRemote.csproj   # nghe 0.0.0.0:8362
```
- Web UI: `http://localhost:8362/`
- API token: `<token trong %LOCALAPPDATA%\HTITRemote\webtoken.txt>` (cũng nằm ở `%LOCALAPPDATA%\HTITRemote\webtoken.txt`)
- Nếu báo `address already in use`: còn tiến trình `HTITRemote.exe`/`dotnet` cũ giữ cổng — tắt trước.
- Không ghi `htr-link.log` nữa (dòng ghi log đã bị gỡ khỏi `Program.cs`).

**Android (Gradle)**
```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot'
$env:ANDROID_HOME='G:\Android\Sdk'; $env:ANDROID_SDK_ROOT='G:\Android\Sdk'
& 'G:\Android\gradle-8.9\bin\gradle.bat' -p 'G:\Workspace\vmt-app\agent' --console=plain --no-daemon assembleRelease
```
- **BẮT BUỘC JDK 17.** `JAVA_HOME` mặc định (JBR của Android Studio = JDK 25) làm `lintVitalAnalyzeRelease` crash.
- APK ra: `agent/app/build/outputs/apk/release/app-release.apk` (đã ký **debug cert** — cố ý cho sideload nội bộ).
- `dist/HTITRemote-0.1.0-*.apk` là bản cũ, **đừng dùng**.

**adb / máy thật**
```powershell
$adb='G:\Android\Sdk\platform-tools\adb.exe'; $dev='10CF1P1TSA0028B'
```
- Máy: **V2361A, Android 16**, deviceId `0032`, agent nghe `8262`.
- IP điện thoại: `172.34.113.129` · IP máy tính: `172.34.96.100` · IP controller nhìn từ máy: `172.34.113.94`
- **Lỗi hay gặp khi cài:** `INSTALL_FAILED_ABORTED: User rejected permissions` → trên điện thoại phải bấm Cho phép/Cài đặt (hộp thoại hệ thống), hoặc tắt Play Protect scan / bật Install via USB.

**Log chẩn đoán của agent (do code tạm ghi ra file)**
```
/sdcard/Android/data/com.htit.remote/files/agent.log
/sdcard/Android/data/com.htit.remote/files/cast.log
```

## 4. Các bug đã sửa (5)

1. **Crash khi mở app** (`AndroidManifest.xml`): `AgentService` thiếu `foregroundServiceType` → Android 14+ chặn FGS. Thêm `android:foregroundServiceType="dataSync"` + `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC"/>`.

2. **Chế độ IP-only** (theo yêu cầu người dùng — đã chốt “bỏ hẳn mã”):
   - `server/AgentLink.cs`: `OpenSecret = SHA256(ASCII("HTR-OPEN-pairing-v1"))`; controller **luôn** dùng `OpenSecret` để dẫn khoá phiên (bỏ nhánh `pairing-required`).
   - `agent/.../DeviceIdentity.java`: thêm `openSecret()` cùng giá trị.
   - `agent/.../AgentServer.java`: khi xác thực thử lần lượt `stored` → `secretFromCode` → `openSecret`.
   - Web: bỏ `<input id="code">` (`wwwroot/index.html`) và `code` trong body (`wwwroot/app.js`).
   - App: bỏ hiển thị mã ghép đôi (`MainActivity.java`, `tvCode`).
   - ⚠️ **Đánh đổi đã biết:** kênh vẫn mã hoá nhưng **không còn xác thực chống giả mạo**; ai trong LAN biết IP đều thử được. Cổng chặn thật là **hộp thoại “Chấp nhận” trên máy**. Trái với yêu cầu "IP không phải là quyền truy cập" trong `REMOTE_APP_HANDOFF.md` — cần ghi chú lại nếu muốn khôi phục.

3. **AAD sai giữa Java và C#** (`agent/.../LinkCipher.java`) — *bug gốc khiến máy thật chưa từng chạy*:
   - C# `CipherLink.Aad`: `aad[1..7] = seqBytes[1..7]` (7 byte **thấp**).
   - Java cũ: `high = seq >>> 8` (7 byte **cao**) → tag GCM sai → mọi gói giải mã lỗi.
   - Đã sửa Java: `System.arraycopy(seqBytesBE(seq), 1, aad, 1, 7)`.

4. **Java decrypt cắt mất tag** (`LinkCipher.java`): GCM của Java cần `doFinal(ciphertext || tag)`, code cũ trừ `TAG_LEN` rồi mới `doFinal` → `AEADBadTagException`. Đã bỏ việc cắt tag.

5. **Controller tự ngắt sau 15s** (`server/AgentLink.cs`, `ReadFully`): mọi lần đọc đều dùng `IdleMaxMs = 15000`, kể cả khi đang chờ người dùng bấm (agent không gửi gì). Đã đổi:
   ```csharp
   readTimeout.CancelAfter(CurrentState == LinkState.Prompting ? PromptWaitMs : IdleMaxMs);
   ```

## 5. LỖI CÒN LẠI (ưu tiên số 1)

Khi đã cấp quyền chia sẻ màn hình:

```
cast.log:
  onStart data=true s=true active=true ready=true code=-1
  projection created
  accept-failed: java.io.IOException: Không gửi được gói: null   ← LỖI
  teardown accept-failed
agent.log (seq agent gửi):
  tx type=0x12 seq=3   (ACCEPT)
  tx type=0x22 seq=4   (STOP từ teardown)
  tx type=0x31 seq=5   (PONG)
controller: "Lỗi phiên: seq 5 replay/reorder"
```

**Diễn giải:** `ScreenCastService.startStream()` gọi `JSONObjectAccept()` → `AgentSession.sendPacket(T_ACCEPT)` → ném `IOException("Không gửi được gói: null")`.
- Chuỗi `"Không gửi được gói: " + e.getMessage()` sinh ra ở `catch (Exception e)` trong `AgentServer.AgentSession.sendPacket` → nghĩa là exception gốc **KHÔNG phải IOException** và **message = null** (rất giống **NullPointerException** trên Android).
- Vị trí nghi vấn: `java.io.OutputStream out = socket.getOutputStream(); out.write(buf); out.flush();` hoặc `socket` null — cần soi kỹ `AgentSession.sendPacket` (khoảng dòng 56–80) và xem `AgentSession` được tạo/đóng ở đâu.
- Vì ACCEPT không tới nơi (hoặc tới rồi STOP không tới), controller thấy lệch seq và báo `replay/reorder`.

**Việc cần làm để chốt:**
1. Cài bản mới nhất (đã thêm log in **tên lớp exception**: `dlog("accept-failed: " + e.getClass().getName() + " : " + e)` trong `ScreenCastService.java`) → chạy lại → đọc `cast.log`. (Bước này đang bị chặn vì cài APK bị từ chối trên máy.)
2. Từ tên lớp exception, sửa đúng chỗ trong `sendPacket`.
3. Lưu ý phụ: khi agent `close()` socket mà còn dữ liệu chưa đọc, TCP gửi **RST** → controller có thể mất gói đang đệm (DENY/STOP). Cân nhắc gửi gói “chia tay” rồi mới đóng, hoặc chỉ ngắt khi đã đọc hết.

## 6. File đã sửa

**Android**
- `agent/app/src/main/AndroidManifest.xml` — FGS `dataSync` + quyền.
- `agent/.../LinkCipher.java` — sửa AAD + bỏ cắt tag khi decrypt. *(quan trọng nhất)*
- `agent/.../DeviceIdentity.java` — thêm `openSecret()`.
- `agent/.../AgentServer.java` — nhận `openSecret`; **thêm logging tạm** `dlog()/slog()` + gọi ở đầu phiên/auth/REQ/prompt/endSession/catch.
- `agent/.../MainActivity.java` — bỏ `tvCode`; `onDestroy` xoá `activeInstance`; guard dialog; **thêm logging tạm** + log `onActivityResult`.
- `agent/.../ScreenCastService.java` — refresh `holder` từ `pendingSession` trong `onStartCommand`; **log tạm** `dlog()` + `teardown(reason)` + `accept-failed`.
- `agent/.../AgentService.java` — (từ trước) bind lại cổng khi service restart.

**Server**
- `server/AgentLink.cs` — `OpenSecret`, bỏ `pairing-required`, timeout khi Prompting.
- `server/wwwroot/index.html`, `server/wwwroot/app.js` — bỏ ô mã ghép đôi.

**Test**
- `tests/FakeAgent.cs` — chấp nhận thêm `openSecret`.
- `tests/EndToEndTests.cs` — thay `Wrong_code_is_rejected_no_enter` bằng `Ip_only_connect_without_code_reaches_active`.
- `tests/WebE2ETests.cs` — thay test `pairing-required` bằng `Connect_without_code_succeeds_via_open_secret`.

Lần chạy gần nhất: `dotnet test` → **14/14 PASS**.

## 7. Việc dọn dẹp còn nợ

- **Gỡ logging tạm** (ghi file `agent.log`/`cast.log`) trong `AgentServer.java`, `MainActivity.java`, `ScreenCastService.java` sau khi fix xong lỗi mục 5.
- Dọn vài entry rác `fakehost-*` trong danh sách paired: `POST /api/paired/{deviceId}/forget`.
- Cập nhật `README.md` / `REMOTE_APP_HANDOFF.md` cho khớp chế độ IP-only (đã bỏ mã ghép đôi).

## 8. Cảnh báo

- **Có tiến trình/agent KHÁC đang sửa song song cùng các file này** (đã nhiều lần thấy file đổi giữa hai lần đọc). Trước khi sửa phải **đọc lại file**, và nên **dừng phiên song song** để tránh ghi đè.
- APK ký **debug cert** — chỉ để sideload nội bộ; muốn phát hành chính thức cần keystore riêng.

## 9. Luồng UI cấp quyền MediaProjection trên máy này (HyperOS)

1. Hộp thoại app: nút viết HOA — **“CHẤP NHẬN”** / “TỪ CHỐI” (tìm `Chấp nhận` sẽ KHÔNG khớp vì viết hoa).
2. Bottom-sheet hệ thống “Ghi hoặc chia sẻ màn hình với HTIT Remote” → nút **“Tiếp tục”**; có spinner “Phạm vi ghi hoặc chia sẻ” (mặc định “Chia sẻ một ứng dụng” — muốn cả màn hình phải đổi).
3. Màn `MediaProjectionAppSelectorActivity` — chọn app/màn hình để chia sẻ.

Tọa độ tham khảo (màn 1260x2800): “CHẤP NHẬN” ≈ (948, 1797) · “Tiếp tục” ≈ (630, 2695).

## 10. Bước tiếp theo, theo thứ tự

1. Trên điện thoại: cho phép cài đặt (hộp thoại hệ thống) → cài bản release mới nhất.
2. Chạy lại luồng: `connect` (chỉ IP) → bấm CHẤP NHẬN → cấp quyền chia sẻ → xem `cast.log` để biết **tên lớp exception** ở `sendPacket`.
3. Sửa `AgentServer.AgentSession.sendPacket` theo exception đó → xác nhận controller đạt **`active`** (có `screenW/screenH`) và có frame.
4. Thử chạm/vuốt từ web UI → xác nhận input tới máy.
5. Gỡ logging tạm, chạy lại `dotnet test` (kỳ vọng 14/14), dọn danh sách paired, cập nhật docs.
