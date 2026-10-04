# Bàn giao yêu cầu: phần mềm điều khiển từ xa nội bộ

## Mục tiêu

Tự xây một phần mềm hỗ trợ từ xa trong mạng nội bộ (LAN), có trải nghiệm gần với UltraViewer ở mức cơ bản:

- Nhân viên IT dùng ứng dụng **Windows** để kết nối đến thiết bị theo **địa chỉ IP**.
- Thiết bị Android cần được hỗ trợ cài một **APK** do dự án cung cấp.
- IT xem được màn hình Android và điều khiển thiết bị sau khi người dùng trên Android đồng ý.

Ứng dụng chỉ phục vụ thiết bị thuộc quyền quản lý/được người dùng cho phép. Biết IP **không** được xem là quyền truy cập.

## Phạm vi đã chốt

### MVP ưu tiên: Windows -> Android

1. Ứng dụng Windows có ô nhập IPv4/hostname và cổng của thiết bị Android trong LAN.
2. Ứng dụng Windows gửi yêu cầu hỗ trợ đến APK Android.
3. APK Android hiển thị rõ ai đang yêu cầu hỗ trợ và các quyền sẽ cấp; người dùng có thể **Chấp nhận** hoặc **Từ chối**.
4. Chỉ sau khi chấp nhận, Windows mới nhận được ảnh màn hình và gửi lệnh điều khiển.
5. Windows hiển thị màn hình Android theo thời gian thực ở mức đủ dùng cho hỗ trợ kỹ thuật.
6. Windows gửi được ít nhất: chạm, giữ/chạm kéo, vuốt, nút Back và Home.
7. Cả Windows và Android đều có nút **Ngắt kết nối**. Android phải dừng chia sẻ màn hình và từ chối lệnh điều khiển ngay khi phiên kết thúc, khi người dùng từ chối, hoặc khi kết nối mất.
8. Chỉ cho phép **một phiên điều khiển đồng thời** trên một Android trong MVP.

### Nền tảng

- Máy điều khiển: Windows 10/11.
- Thiết bị đích: Android **8.0 trở lên** (`minSdk 26`).
- APK được phân phối/cài trực tiếp, không phụ thuộc Play Store cho MVP.
- Mạng: chỉ LAN. Kết nối trực tiếp theo IP; không cần Internet và không dùng máy chủ relay/trung gian ở MVP.

## Luồng bắt buộc về bảo mật và đồng ý

1. IT nhập IP/cổng và khởi tạo yêu cầu.
2. Hai thiết bị thiết lập kết nối **mã hóa** và xác thực danh tính thiết bị. Không gửi ảnh màn hình hay lệnh điều khiển qua TCP/UDP thuần văn bản.
3. Ở lần ghép đôi đầu tiên, cần cơ chế chống giả mạo: ví dụ xác nhận mã ngắn/fingerprint ở cả hai đầu, hoặc quét QR do Android hiển thị. Agent lập kế hoạch cần chọn một cơ chế cụ thể.
4. Android hiển thị hộp thoại yêu cầu hỗ trợ; mặc định là từ chối nếu người dùng không thao tác.
5. Người dùng Android cấp quyền chia sẻ màn hình của hệ điều hành và quyền điều khiển trước khi phiên bắt đầu.
6. Phiên chỉ còn hiệu lực khi kết nối tồn tại. Không lưu mật khẩu cố định hay tự bật lại quyền truy cập không giám sát trong MVP.
7. Mọi gói điều khiển phải bị bỏ nếu không thuộc phiên đã xác thực/đang được người dùng chấp nhận.

## Ràng buộc Android cần tôn trọng

- Chụp/chia sẻ màn hình dùng API hệ thống **MediaProjection**. Người dùng phải cấp quyền chia sẻ màn hình; không được tìm cách vượt qua hộp thoại quyền.
- Android hiện cảnh báo khi màn hình đang được chia sẻ; trên các phiên bản mới, hệ thống/người dùng có thể dừng việc chia sẻ hoặc việc chia sẻ có thể dừng khi khóa màn hình. Ứng dụng phải xử lý callback dừng và hủy phiên an toàn.
- Điều khiển chạm/vuốt dùng `AccessibilityService` với khả năng thực hiện gesture. Người dùng phải tự bật dịch vụ Trợ năng trong phần cài đặt Android.
- APK cài ngoài Play Store có thể bị Android 13+ chặn một số cài đặt nhạy cảm. Người dùng có thể phải bật **Allow restricted settings** trước khi bật Trợ năng. APK không thể tự cấp quyền này.
- Khả năng hoạt động còn tùy thiết bị/hãng Android. Không cam kết điều khiển được màn hình khóa, màn hình hệ thống bảo vệ, ứng dụng tài chính/DRM, hoặc màn hình mà hệ điều hành chặn capture/input.
- Không root thiết bị, không dùng ADB/debugging, không yêu cầu quyền hệ thống/Device Owner trong MVP.

## Kiến trúc/triển khai định hướng (cần xác nhận khi lập kế hoạch)

- **Windows:** ứng dụng desktop .NET/C#; WPF là lựa chọn native phù hợp cho giao diện xem màn hình và bắt sự kiện chuột/bàn phím.
- **Android:** APK native Java hoặc Kotlin, sử dụng API Android chuẩn (`MediaProjection`, foreground service khi cần, `AccessibilityService`, `MediaCodec` nếu chọn video H.264/H.265).
- **Truyền dữ liệu:** một kênh điều khiển và một kênh ảnh/video đều nằm trong kết nối đã mã hóa. Cần định nghĩa framing, giới hạn kích thước gói, timeout, keep-alive và xử lý reconnect an toàn.
- **Video ảnh:** POC có thể dùng JPEG có giới hạn kích thước/FPS để chứng minh luồng đầu-cuối. Agent cần quyết định sớm giữa JPEG đơn giản và H.264 qua codec nền tảng; không thêm thư viện chưa được xác nhận chỉ để tối ưu sớm.
- **Tọa độ input:** Windows gửi tọa độ đã chuẩn hóa theo kích thước khung hình nguồn; Android quy đổi về kích thước/chiều xoay hiện tại và từ chối tọa độ ngoài phạm vi.
- **Danh tính:** mỗi Android cần có định danh cục bộ và cặp khóa/chứng thư lưu an toàn. IP có thể thay đổi, không dùng IP làm danh tính tin cậy.

## Không nằm trong MVP

- Điều khiển thiết bị chỉ bằng IP khi chưa cài APK, chưa ghép đôi hoặc chưa được người dùng đồng ý.
- Truy cập không giám sát, mật khẩu vĩnh viễn, tự động chấp nhận phiên, chạy ẩn không có chỉ báo.
- Truyền tệp, clipboard, chat, ghi hình phiên, âm thanh, camera, in từ xa.
- Tìm thiết bị tự động, address book, tài khoản người dùng, quản trị tập trung, audit server, Internet/NAT traversal, relay server.
- Điều khiển Android từ Android/iOS.
- Điều khiển **Windows -> Windows**. Đây là giai đoạn sau khi Windows -> Android đã được kiểm thử trên thiết bị thật.

## Tiêu chí nghiệm thu MVP

Trên Windows và một thiết bị Android thật cùng LAN:

1. Nhập đúng IP/cổng dẫn đến yêu cầu hiện trên Android; nhập IP/cổng không hợp lệ hoặc không kết nối được phải báo lỗi rõ ràng, không treo ứng dụng.
2. Khi Android từ chối hoặc không phản hồi, Windows không nhận ảnh và không điều khiển được thiết bị.
3. Khi Android chấp nhận và các quyền hệ thống đã được cấp, Windows xem được màn hình và thực hiện được chạm, vuốt, Back, Home.
4. Ngắt từ bất kỳ bên nào, mất Wi-Fi hoặc Android thu hồi/dừng MediaProjection đều dừng truyền ảnh và lệnh điều khiển; Android quay về trạng thái chờ an toàn.
5. Thiết bị/lệnh từ phiên chưa xác thực bị từ chối. Không có nội dung màn hình hoặc dữ liệu điều khiển đi qua mạng dưới dạng đọc được.
6. Thử ít nhất trên Android 8–10 và Android 13+ khi có thiết bị để kiểm tra khác biệt về quyền và cài APK ngoài Play Store.

## Tình trạng workspace và môi trường hiện biết

- Workspace: `G:\Workspace\vmt-app` chưa có mã nguồn ứng dụng hoặc repository Git; chỉ có `G:\Workspace\vmt-app\.commandcode\taste\taste.md` rỗng.
- Có .NET SDK 8, 9, 10 và Windows Desktop targeting packs; có JDK 21 và Android Studio.
- Chưa phát hiện Android SDK, `adb`, `sdkmanager` hoặc Gradle trên `PATH`. Agent lập kế hoạch cần xác minh/cài Android SDK phù hợp trước khi hứa build APK.
- Chưa xác định hãng/model Android và chưa có thiết bị thật để kiểm thử. Cần kiểm chứng sớm quyền MediaProjection/Trợ năng, kết nối LAN và độ tương thích OEM trước khi đầu tư tối ưu giao thức.

## Việc agent tiếp theo cần làm khi lập kế hoạch

1. Xác minh toolchain Android, lựa chọn phiên bản compile/target SDK và cách build APK có thể lặp lại.
2. Chốt giao thức bảo mật/ghép đôi cụ thể bằng API nền tảng, bao gồm lưu khóa, xác minh fingerprint/mã ghép đôi và xử lý hết hạn phiên.
3. Lập POC nhỏ nhất chạy trên thiết bị Android thật: người dùng cấp MediaProjection, Windows nhận ảnh màn hình, sau đó kiểm chứng lệnh gesture qua Trợ năng.
4. Chỉ sau POC mới chốt codec, FPS, độ phân giải và mục tiêu độ trễ theo kết quả trên mạng LAN thực tế.
5. Chia công việc thành các lát cắt có build/test được; đặt kiểm thử lỗi mạng, thu hồi quyền, xoay màn hình, background/lock screen trước khi mở rộng sang Windows -> Windows.

## Câu hỏi còn mở

- IP/hostname và cổng sẽ được nhập thủ công hoàn toàn, hay cho phép LAN discovery ở giai đoạn sau?
- Có yêu cầu số lượng thiết bị đồng thời, mức độ mượt/độ trễ hoặc chất lượng hình ảnh cụ thể không?
- APK sẽ được ký/phân phối nội bộ bằng cách nào, và tổ chức có chính sách MDM/Device Owner không?
- Model/hãng Android mục tiêu đầu tiên là gì? Điều này ảnh hưởng lớn đến quy trình bật Trợ năng và khả năng chạy nền.