# HTIT Remote

Ứng dụng hỗ trợ Android từ xa trong mạng nội bộ công ty. Nhân viên IT đăng nhập và điều khiển bằng trình duyệt; thiết bị Android tự dò máy chủ Node.js trong LAN, sinh mã 9 số không cần tài khoản và phải chấp nhận từng phiên trước khi chia sẻ màn hình.

## Luồng sử dụng

1. Khởi động máy chủ và mở `http://<ip-server>:8362` trên máy tính.
2. Đăng nhập bằng tài khoản nội bộ.
3. Cài APK và mở Android. Ứng dụng tự nhận IP LAN hiện tại, tự tìm máy chủ và đăng ký thiết bị. Địa chỉ máy chủ được ẩn trên giao diện Android; IP thiết bị vẫn hiển thị để kết nối từ web. Nút **Sinh mã truy cập** vẫn cho phép tạo lại mã ngẫu nhiên 9 số.
4. Bật quyền Trợ năng trên Android để cho phép chạm, vuốt, Back, Home và nhập bàn phím.
5. Trên web, chọn **IP thiết bị** (mặc định) và nhập IPv4 hiện tại hiển thị trên Android, hoặc chọn **Mã thiết bị** và nhập mã 9 số.
6. Người dùng Android chấp nhận yêu cầu và cấp quyền chia sẻ màn hình của hệ điều hành.
7. Khi cần gõ, click vào ô nhập đang hiển thị trên màn hình Android rồi nhập trực tiếp bằng bàn phím máy tính. Backspace và Enter được chuyển đến ô đang chọn.

Khi Android xoay dọc hoặc ngang, luồng hình và khung điều khiển trên web tự đổi đúng tỷ lệ trong cùng phiên, không cần kết nối lại.

Ảnh truyền ở độ phân giải màn hình gốc, JPEG chất lượng 90, không thu nhỏ về 720×1600. Web hiển thị kích thước ảnh nhận được; chọn **Xem 100%** để xem một pixel ảnh tương ứng một pixel CSS và cuộn tới phần cần đọc, hoặc **Vừa khung** để thấy toàn màn hình. Độ phân giải cao cần nhiều băng thông và thời gian nén hơn, nên FPS thực tế phụ thuộc thiết bị và mạng.

Android lấy lại IPv4 LAN hiện tại mỗi lần mở hoặc quay lại ứng dụng và mỗi lần đăng ký lại với máy chủ. IP mới được cập nhật trên web ngay cả khi kết nối nền vẫn đang chạy, không cần xóa dữ liệu hay sinh lại mã. Khi chưa có Wi-Fi/Ethernet, ứng dụng hiển thị trạng thái chờ và không dùng IP cũ. Cập nhật IP giữ nguyên mã và phiên đang hoạt động nếu WebSocket còn kết nối; nếu đổi mạng làm mất kết nối, ứng dụng kết nối lại và đăng ký IP hiện tại. App không thay đổi cấu hình IP của hệ điều hành. Cả kết nối bằng IP và bằng mã đều truyền qua máy chủ nội bộ, yêu cầu thiết bị đang trực tuyến và xác nhận trên Android. Nếu có nhiều thiết bị trùng IP, dùng mã để chọn đúng thiết bị.

Mã thiết bị chỉ tồn tại khi APK đang trực tuyến. Mỗi Android chỉ nhận một phiên tại một thời điểm. Khi một bên ngắt kết nối hoặc MediaProjection dừng, relay khóa lệnh điều khiển và kết thúc phiên.

Một trình duyệt có thể hỗ trợ nhiều Android cùng lúc: nhập IP hoặc mã của thiết bị tiếp theo và chọn **Kết nối** để mở thêm tab, giữ nguyên các phiên đã kết nối. Chọn tab để xem và thao tác thiết bị đó; chuột, bàn phím, Back và Home chỉ gửi đến đúng thiết bị trong tab. Các tab khác giữ phiên và nhận frame mới nhất, nhưng không giải mã ảnh khi đang ẩn để giảm tải trình duyệt. Mỗi phiên có **Ngắt kết nối**, **Kết nối lại** và **Đóng** riêng; **Ngắt tất cả** dừng toàn bộ phiên. Đăng xuất hoặc tải lại trang sẽ kết thúc các phiên đang mở. APK 1.1.0 dùng được với giao diện này, không cần cập nhật Android.

## Thiết bị đã lưu và tên dễ nhớ

Giao diện chính gộp **Thiết bị đã lưu** và điều khiển trên cùng một trang, không có menu bên trái. Màn hình remote và các tab thiết bị hiển thị ngay dưới danh sách đã lưu. Phần kết nối bằng mã/danh sách trực tuyến có thể mở thêm bên dưới; kiểm tra mạng nằm trên cùng trang.

Trên web, nhập **Tên dễ nhớ** và **IP thiết bị**, rồi bấm **Lưu** để giữ thông tin cho lần kết nối sau, kể cả khi thiết bị chưa trực tuyến; nút này không mở phiên remote. Bấm **Kết nối** để remote ngay: nếu Android chấp nhận và bắt đầu chia sẻ màn hình thành công, máy chủ cũng tự lưu thiết bị theo tài khoản. Nếu kết nối thất bại, bị từ chối hoặc chưa cấp quyền chia sẻ, luồng Kết nối không tự lưu thiết bị. Lần sau bấm **Kết nối** ở mục đã lưu. Nút **Sửa** cho phép sửa cả tên và IP rồi **Lưu thay đổi**; **Xóa** bỏ mục khỏi danh sách. Tên riêng này không đổi tên hệ thống Android.

Thiết bị được gắn định danh Android sau khi remote thành công, tự cập nhật IP khi Android báo địa chỉ mới và giữ tên bạn đặt. Khi sửa sang IP khác, mục được gắn Android trực tuyến duy nhất ở IP mới hoặc chuyển sang lưu theo IP nếu đích chưa trực tuyến; Android cũ không ghi đè IP vừa sửa. Bên cạnh **Kết nối** có nút **Kiểm tra kết nối** để máy chủ ping IP đó, kể cả khi thiết bị chưa đăng ký app. Kết quả ping hiện ngay dưới mục đang kiểm tra. Form nhập thiết bị cũng có nút này, không cần nhập tên để kiểm tra IP.

Danh sách lưu riêng theo tài khoản tại `data/saved-devices.json` trên máy chủ, dùng được khi đăng nhập cùng tài khoản từ máy tính khác và giữ lại sau khi khởi động lại máy chủ. Mỗi tài khoản lưu tối đa 100 mục. Không cần cập nhật APK để dùng chức năng này.

## Kiểm tra mạng Android

Trong mục **Kiểm tra mạng**, phần **Ping tới IP** cho phép nhập IPv4 hoặc IPv6 của bất kỳ thiết bị nào trong mạng nội bộ rồi bấm **Ping**. Máy chủ HTIT gửi 4 gói ICMP trực tiếp tới IP đích, không cần thiết bị cài app, đăng ký trực tuyến hoặc mở phiên remote. Dùng cho máy tính, Android, máy in, router và các thiết bị mạng khác. Web hiển thị số gói gửi/nhận, tỷ lệ mất gói, độ trễ thấp nhất/trung bình/cao nhất và kết quả lệnh chi tiết. Kết quả phản ánh đường từ máy chủ tới thiết bị đích. Nếu không có phản hồi, địa chỉ đích có thể không truy cập được hoặc chặn ICMP; không kết luận mất kết nối chỉ từ ping. Chỉ nhận địa chỉ IP, không nhận URL/tên miền. Mỗi cửa sổ web chạy một lượt ping tại một thời điểm, chờ 5 giây giữa hai lượt; máy chủ chạy tối đa 4 lượt cùng lúc, mỗi lượt timeout 15 giây. Không cần cập nhật APK. Máy chủ Windows dùng lệnh `ping.exe`; trên Linux cần có lệnh `ping` (gói `iputils-ping`).

Khi đã remote, bấm **Kiểm tra mạng thiết bị** trong thanh Back/Home để đo từ Android tới máy chủ; kết quả hiện ngay dưới thanh điều khiển của phiên đó. Có thể dùng **Kiểm tra mạng** trong danh sách trực tuyến phía dưới khi chưa mở phiên remote. Android chỉ đo tới chính máy chủ nội bộ HTIT đang kết nối để kiểm tra đường truyền dùng cho remote. Nếu triển khai máy chủ qua proxy hoặc VPN, phép đo bao gồm đường đi đó. Chức năng yêu cầu APK từ **1.2.0**; bản **1.2.1** chỉ giữ phép đo nội bộ.

Web hiển thị ping HTTP trung bình/min/max, jitter HTTP, tỷ lệ phản hồi lỗi trên 5 mẫu, download/upload (Mbps) và giờ đo. Ping là thời gian một yêu cầu HTTP sau bước làm nóng kết nối; tỷ lệ lỗi HTTP không phải tỷ lệ mất gói ICMP. Tốc độ là phép đo mẫu 8 MiB mỗi chiều, bao gồm chi phí HTTP và phản hồi server, không phải tốc độ cực đại hay lưu lượng sử dụng liên tục. Kết quả lỗi/timeout hiển thị **Không đo được**, không ghi thành 0 Mbps. Khi kết nối chậm, dùng kết quả để kiểm tra Wi-Fi/LAN và đường tới máy chủ.

Phép đo chạy ngoài luồng giao diện, không kết thúc phiên remote. Mỗi lần dùng khoảng 16 MiB dữ liệu và có thể làm tăng độ trễ khi đang remote. Mỗi thiết bị chạy một phép đo tại một thời điểm; chờ 30 giây giữa hai lần đo, tối đa 4 thiết bị đo đồng thời trên server. Mỗi yêu cầu tốc độ có timeout 12 giây; toàn phép đo tối đa 45 giây. Khi thiết bị mất kết nối, web báo lỗi và server thu hồi lượt đo. Endpoint đo LAN chỉ nhận ticket ngắn hạn được tạo từ yêu cầu của người đã đăng nhập, giới hạn kích thước và số lần sử dụng.

## Chạy máy chủ Node.js

Yêu cầu Node.js 22 trở lên.

```powershell
npm install
npm start
```

Lần chạy đầu, máy chủ tạo tài khoản `admin` với mật khẩu mặc định `admin` trong `data/admin-password.txt`, đồng thời in tài khoản ra console. Đây chỉ là mặc định tiện thử nghiệm, nên đổi mật khẩu trước khi dùng thật. Có thể cấu hình tài khoản công ty bằng biến môi trường:

```powershell
$env:HTIT_USERS = '{"it01":"MatKhauManh1!","it02":"MatKhauManh2!"}'
npm start
```

Các biến cấu hình:

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Địa chỉ lắng nghe |
| `PORT` | `8362` | Cổng web và WebSocket |
| `HTIT_PUBLIC_URL` | trống | URL HTTPS công khai/nội bộ cần quảng bá thay cho IP nhận được từ UDP |
| `HTIT_USERS` | tài khoản `admin` tự tạo | JSON tên đăng nhập → mật khẩu |
| `HTIT_ADMIN_PASSWORD` | `admin` | Mật khẩu admin khi không đặt `HTIT_USERS` |
| `HTIT_TLS_CERT` / `HTIT_TLS_KEY` | trống | File chứng thư và private key để chạy HTTPS/WSS |
| `HTIT_SECURE_COOKIE` | `false` | Đặt `true` khi HTTPS được kết thúc tại reverse proxy |

Cho phép UDP cổng `8363` trên firewall của máy chủ. Discovery dạng broadcast hoạt động khi Android và server ở cùng LAN/VLAN; nếu dùng reverse proxy, đặt `HTIT_PUBLIC_URL`, ví dụ `https://remote.noi-bo`. Trong môi trường công ty, nên dùng HTTPS/WSS bằng chứng thư nội bộ hoặc đặt server sau reverse proxy HTTPS. Android vẫn cho phép HTTP để thử nghiệm LAN; tài khoản web và nội dung màn hình chỉ được mã hóa trên đường truyền khi dùng HTTPS.

## Build APK Android

Yêu cầu JDK 17 và Android SDK Platform 34. Đặt đường dẫn SDK trong `agent/local.properties`, sau đó:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-17'
cd agent
.\gradlew.bat clean assembleDebug assembleRelease
```

APK sinh ra tại `agent/app/build/outputs/apk/`. Bản dựng đã kiểm tra cũng được đặt trong `dist/`:

- `HTITRemote-1.2.2-debug.apk`
- `HTITRemote-1.2.2-release.apk`

Bản release hiện ký bằng debug keystore để cài nội bộ thuận tiện. Trước khi phân phối chính thức, thay `signingConfig` bằng keystore ổn định do công ty quản lý.

Android 13 trở lên có thể yêu cầu **Allow restricted settings** trước khi bật Accessibility Service cho APK cài ngoài. Ứng dụng không thể điều khiển màn hình khóa, nội dung DRM hoặc ứng dụng chặn capture. Một số ô nhập bảo mật hoặc giao diện tùy biến có thể chặn thao tác nhập qua Trợ năng của Android.

## Kiểm thử

```powershell
npm test
npm run lint
npm audit --audit-level=high
```

Bộ test Node chạy discovery UDP và luồng thật qua HTTP/WebSocket: đăng nhập web, cấp token Android không cần tài khoản, đăng ký thiết bị, cấp mã, xác nhận phiên, kích hoạt chia sẻ, relay JPEG, relay thao tác chuột/bàn phím và ngắt kết nối. Các test mạng kiểm tra đo khi đang remote, giới hạn ticket/dữ liệu, cách ly kết quả, APK cũ, từ chối đích ngoài nội bộ, mất kết nối và timeout. Build Android kiểm tra mã Java, manifest, resource và đóng gói cả debug/release APK.

## Kiến trúc

- `server/`: Express + WebSocket relay, xác thực web điều khiển và UDP discovery cho Android.
- `agent/`: APK Java tự dò server trong LAN, dùng MediaProjection để chụp màn hình ở độ phân giải gốc, AccessibilityService để thao tác và OkHttp WebSocket để nối ra relay. Luồng hình giới hạn khoảng 15 fps, JPEG chất lượng 90 và bỏ frame cũ khi kết nối bị nghẽn để ưu tiên độ trễ thấp. IPv4 LAN được đọc lại khi mở ứng dụng và cập nhật với relay; định danh thiết bị vẫn ổn định dù IP thay đổi.
- `test/`: kiểm thử đầu-cuối cho API và relay.

Server không lưu ảnh màn hình. Frame JPEG được chuyển trực tiếp từ WebSocket Android sang đúng trình duyệt đang có phiên hoạt động.
