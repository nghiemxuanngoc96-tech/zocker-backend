# 🎰 Zocker Mini Game Backend

Backend cho chương trình vòng quay may mắn trên Zalo Mini App.

## 🚀 Hướng dẫn Deploy

### Deploy trên Railway.app:
1. Đăng nhập Railway.app bằng GitHub
2. Tạo New Project → Deploy from GitHub repo
3. Chọn repository này
4. Railway sẽ tự động deploy

### Sau khi deploy:
- URL backend của bạn: `https://ten-project.up.railway.app`
- Admin panel: `https://ten-project.up.railway.app/admin`
- Admin key mặc định: `zocker-admin-2026` (nên đổi trong Railway Variables)

## 📋 API Endpoints

- `POST /register` - Đăng ký người chơi
- `POST /spin` - Quay vòng
- `POST /claim` - Nhận quà
- `GET /admin` - Trang quản trị

## 🎁 Cấu hình giải thưởng

Xem trong file `server.js`, mục `PRIZE_SLOTS`:
- Giải nhất: 1 vợt Aspire
- Giải nhì: 2 giày Pickleball
- Giải ba: 5 balo
- Giải tư: 10 bóng
- Voucher 15%: 30 phần
- Voucher 10%: 50 phần
- Chúc may mắn: không giới hạn

## 🔒 Bảo mật

Nhớ đổi `ADMIN_SECRET` trong Railway Environment Variables!
