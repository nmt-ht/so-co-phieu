# Sổ Cổ Phiếu

Web app phân tích cổ phiếu Việt Nam, cho xác suất tăng giảm và khoảng giá trong 1 tuần, 1 tháng tới. Cùng cấu trúc với Sổ Vàng, cài được lên điện thoại, không cần khóa API.

## Cài lên điện thoại

1. Mở https://nmt-ht.github.io/so-co-phieu/ bằng **Safari** trên iPhone, hoặc Chrome trên Android.
2. Bấm nút **Chia sẻ**, chọn **Thêm vào MH chính**. Trên Android, mở menu rồi chọn **Thêm vào màn hình chính**.

App tự lấy giá mới mỗi lần mở, và vẫn xem được dữ liệu đã lưu khi không có mạng.

## Mô hình làm được gì

Số liệu đầy đủ nằm trong tab **Độ tin cậy** của app, tính ngoài mẫu bằng walk-forward.

- **Hướng tăng giảm:** gần như không hơn mức nền. Vì vậy app hiện xác suất kèm mức nền, không có nhãn mua bán và không có danh sách mã nên mua.
- **Khoảng giá:** khá chuẩn, khoảng 80% chứa giá thật khoảng 76–83% số lần tùy giai đoạn.
- **Rủi ro biến động mạnh trong 1 tuần:** có ích vừa phải. Với kỳ 1 tháng chưa chứng minh được, nên app không hiện xác suất này.

## Bảng xếp hạng và máy tính rủi ro

- **Xếp hạng** xếp mặc định theo rủi ro giảm, không theo xác suất tăng, và nói rõ thứ tự theo xác suất tăng chưa có bằng chứng hơn ngẫu nhiên. App không có dự báo 1 ngày.
- **Máy tính rủi ro** trong tab Cổ phiếu: số tiền tối đa = vốn × % chấp nhận lỗ ÷ mức giảm tham chiếu (cận dưới khoảng 80%), không vượt quá vốn, làm tròn xuống lô 100 cổ. Khoảng 10% trường hợp giá xuống dưới mức tham chiếu, nên đây không phải mức lỗ tối đa. Công cụ không chọn mã và không chia tỉ lệ giữa các mã.
- Giả định phí 0,15% mỗi chiều và thuế bán 0,1%, khai báo ở `COSTS` trong `src/engine.js`.

## Cập nhật

```bash
node scripts/fetch_data.js
```

```bash
node scripts/train.js
```

```bash
node scripts/build.js
```

`fetch_data.js` tải 12 năm giá ngày, `train.js` kiểm định rồi huấn luyện mô hình cuối, `build.js` tạo app ở thư mục gốc và `dist/`. `node scripts/experiment.js` tái hiện việc chọn cấu hình trên 2020–2023. `node scripts/serve.js` chạy app ở `http://localhost:4174`.

## Cấu trúc

- `src/engine.js`: chỉ báo, đặc trưng, hồi quy logistic, dự báo biến động, khoảng giá. Không phụ thuộc giao diện.
- `src/universe.js`: danh sách chỉ số, mã và ngành.
- `src/app.js`, `src/tokens.css`, `src/app.css`, `src/body.html`: giao diện.
- `data/`: `history.json` dùng để huấn luyện, `model.json` là mô hình và kết quả kiểm định, `names.json` là tên công ty.
- `index.html`, `sw.js`, `manifest.webmanifest`, `icon-*.png` ở thư mục gốc: app do `build.js` tạo ra. `dist/so-co-phieu.html`: bản xem nhanh, không tự cập nhật giá.

## Nguồn dữ liệu

- VNDirect (`dchart-api.vndirect.com.vn`): giá ngày đã điều chỉnh, gọi trực tiếp từ trình duyệt.
- SSI iBoard (`iboard-query.ssi.com.vn`): danh sách mã và tên công ty, chỉ dùng khi tạo dữ liệu nhúng.

Đây là công cụ thống kê, không phải khuyến nghị đầu tư.
