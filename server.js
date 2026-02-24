// ================= ZOCKER MINI GAME BACKEND =================
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const { nanoid } = require("nanoid");

const app = express();
app.use(cors());
app.use(express.json());

// ================= CONFIG =================
const PORT = 4000;
const ADMIN_SECRET = "zocker-admin-2026"; // đổi nếu cần

// ================= DB =================
const db = new Database("./zocker.db");

// ================= INIT TABLES =================
db.exec(`
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT,
  sex TEXT,
  job TEXT,
  zaloUserId TEXT,
  lastSpinAt INTEGER DEFAULT NULL,
  lastPrizeId TEXT DEFAULT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prize_pool (
  id TEXT PRIMARY KEY,
  spinIndex INTEGER NOT NULL,
  prizeKey TEXT NOT NULL,
  title TEXT NOT NULL,
  total INTEGER DEFAULT NULL,
  remaining INTEGER DEFAULT NULL,
  weight INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS claims (
  code TEXT PRIMARY KEY,
  participantId TEXT NOT NULL,
  prizeId TEXT NOT NULL,
  prizeKey TEXT NOT NULL,
  title TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  redeemedAt INTEGER DEFAULT NULL,
  redeemedBy TEXT DEFAULT NULL
);
`);

// ===== MIGRATION SAFE =====
try {
  db.prepare(`ALTER TABLE participants ADD COLUMN createdAt INTEGER`).run();
} catch (e) {
  // ignore if column exists
}

try {
  db.prepare(`ALTER TABLE participants ADD COLUMN zaloUserId TEXT`).run();
  console.log("✅ Added zaloUserId column to participants table");
} catch (e) {
  // ignore if column exists
}

// ✅ Migration: Thêm cột hasFollowedOA
try {
  db.prepare(`ALTER TABLE participants ADD COLUMN hasFollowedOA INTEGER DEFAULT 0`).run();
  console.log("✅ Added hasFollowedOA column to participants table");
} catch (e) {
  // ignore if column exists
}

// ✅ Migration: Thêm cột lastClaimDate (lưu ngày nhận mã gần nhất)
try {
  db.prepare(`ALTER TABLE participants ADD COLUMN lastClaimDate TEXT DEFAULT NULL`).run();
  console.log("✅ Added lastClaimDate column to participants table");
} catch (e) {
  // ignore if column exists
}

// ✅ Migration: Thêm cột dailyBonusUsed (đã dùng lượt bonus hôm nay chưa)
try {
  db.prepare(`ALTER TABLE participants ADD COLUMN dailyBonusUsed TEXT DEFAULT NULL`).run();
  console.log("✅ Added dailyBonusUsed column to participants table");
} catch (e) {
  // ignore if column exists
}

// ✅ Migration: Thêm cột freeSpinsRemaining
try {
  db.prepare(`ALTER TABLE participants ADD COLUMN freeSpinsRemaining INTEGER DEFAULT 1`).run();
  console.log("✅ Added freeSpinsRemaining column to participants table");
} catch (e) {
  // ignore if column exists
}

// ================= PRIZE CONFIG =================
const PRIZE_SLOTS = [
  { spinIndex: 0, prizeKey: "HAT", title: "Mũ Zocker", total: null, weight: 30 },
  { spinIndex: 1, prizeKey: "ELBOW_GUARD", title: "Đai Bảo Vệ Khuỷu Tay Zocker", total: null, weight: 30 },
  { spinIndex: 2, prizeKey: "KNEE_GUARD", title: "Đai Bảo Vệ Đầu Gối Zocker", total: null, weight: 30 },
  { spinIndex: 3, prizeKey: "VOUCHER_10", title: "Voucher 10%", total: null, weight: 20 }

];

// ================= SEED =================
const FORCE_RESEED = false;
(() => {
  const c = db.prepare("SELECT COUNT(*) c FROM prize_pool").get().c;
  if (!FORCE_RESEED && c > 0) return;

  db.prepare("DELETE FROM prize_pool").run();
  const ins = db.prepare(`
    INSERT INTO prize_pool
    (id, spinIndex, prizeKey, title, total, remaining, weight, enabled)
    VALUES(?,?,?,?,?,?,?,1)
  `);

  for (const s of PRIZE_SLOTS) {
    ins.run(
      `SLOT_${s.spinIndex}`,
      s.spinIndex,
      s.prizeKey,
      s.title,
      s.total,
      s.total === null ? null : s.total,
      s.weight
    );
  }
})();

// ================= HELPERS =================
const now = () => Date.now();
const makeCode = () => "GIFT-" + nanoid(8).toUpperCase();

// Helper: Lấy ngày hiện tại dạng YYYY-MM-DD (múi giờ Việt Nam)
function getTodayVN() {
  const d = new Date();
  // Chuyển sang GMT+7
  const vnTime = new Date(d.getTime() + (7 * 60 * 60 * 1000));
  return vnTime.toISOString().split('T')[0]; // YYYY-MM-DD
}

// Mapping interest code sang tên tiếng Việt
function getInterestName(job) {
  const map = {
    'pickleball': 'Pickleball',
    'football': 'Bóng đá',
    'running': 'Chạy bộ',
    'all': 'Tất cả',
  };
  return map[job] || job || 'Chưa cung cấp';
}

function weightedRandom(rows) {
  const list = rows.filter(r => r.enabled && (r.remaining === null || r.remaining > 0));
  const sum = list.reduce((s, r) => s + r.weight, 0);
  let r = Math.random() * sum;
  for (const p of list) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return list[list.length - 1];
}

function adminAuth(req, res, next) {
  const key = req.query.key || req.headers["x-admin-key"] || req.body?.key;
  if (key !== ADMIN_SECRET)
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  next();
}

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("✅ Zocker backend running");
});

// ================= MINI GAME APIs =================
app.post("/register", (req, res) => {
  const { name, phone, sex, job, zaloUserId } = req.body || {};
  
  if (!name || !phone) {
    return res.json({ ok: false, message: "Thiếu thông tin tên hoặc số điện thoại" });
  }

  const today = getTodayVN();

  // ✅ CHECK 1: Kiểm tra SĐT
  const existingPhone = db.prepare("SELECT * FROM participants WHERE phone=?").get(phone);
  if (existingPhone) {
    console.log(`⚠️  Phone ${phone} đã đăng ký trước đó`);
    
    // ✅ Reset lượt FREE + BONUS nếu sang ngày mới
    if (existingPhone.lastClaimDate !== today) {
      db.prepare(`
        UPDATE participants 
        SET freeSpinsRemaining=1, dailyBonusUsed=NULL 
        WHERE id=?
      `).run(existingPhone.id);
    }
    
    return res.json({ 
      ok: true, 
      participantId: existingPhone.id,
      message: "Số điện thoại đã được đăng ký"
    });
  }

  // ✅ CHECK 2: Kiểm tra Zalo ID
  if (zaloUserId) {
    const existingZalo = db.prepare("SELECT * FROM participants WHERE zaloUserId=?").get(zaloUserId);

    if (existingZalo) {
      db.prepare(`
        UPDATE participants SET name=?, phone=?, sex=?, job=? WHERE id=?
      `).run(name, phone, sex || "other", job || "other", existingZalo.id);

      // Reset lượt nếu sang ngày mới
      if (existingZalo.lastClaimDate !== today) {
        db.prepare(`
          UPDATE participants 
          SET freeSpinsRemaining=1, dailyBonusUsed=NULL 
          WHERE id=?
        `).run(existingZalo.id);
      }

      return res.json({
        ok: true,
        participantId: existingZalo.id,
        message: "Tài khoản đã tham gia trước đó, tiếp tục chơi nhé.",
      });
    }
  }

  // ✅ Đăng ký mới
  const id = nanoid(12);
  try {
    db.prepare(`
      INSERT INTO participants(id, name, phone, sex, job, zaloUserId, createdAt, freeSpinsRemaining, hasFollowedOA, lastClaimDate, dailyBonusUsed)
      VALUES(?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL)
    `).run(id, name, phone, sex || "other", job || "other", zaloUserId || null, now());

    console.log(`✅ Đăng ký thành công: ${name} - ${phone}`);
    res.json({ ok: true, participantId: id });
  } catch (error) {
    console.error("❌ Lỗi đăng ký:", error);
    res.json({ ok: false, message: "Lỗi hệ thống, vui lòng thử lại" });
  }
});

app.post("/spin", (req, res) => {
  const { participantId } = req.body || {};
  const p = db.prepare("SELECT * FROM participants WHERE id=?").get(participantId);
  if (!p) return res.json({ ok: false, message: "Không tìm thấy thông tin người chơi" });

  const today = getTodayVN();
  
  // ✅ Reset lượt FREE nếu sang ngày mới
  if (p.lastClaimDate !== today) {
    db.prepare(`UPDATE participants SET freeSpinsRemaining=1 WHERE id=?`).run(participantId);
    // Reload data
    const updatedP = db.prepare("SELECT * FROM participants WHERE id=?").get(participantId);
    Object.assign(p, updatedP);
  }

  // ✅ Check còn lượt không
  if (!p.freeSpinsRemaining || p.freeSpinsRemaining <= 0) {
    return res.json({ 
      ok: false, 
      message: "Bạn đã hết lượt quay hôm nay!"
    });
  }

  const tx = db.transaction(() => {
    const pool = db.prepare("SELECT * FROM prize_pool ORDER BY spinIndex").all();
    const prize = weightedRandom(pool);

    if (prize.remaining !== null) {
      const r = db.prepare(`
        UPDATE prize_pool SET remaining=remaining-1
        WHERE id=? AND remaining>0
      `).run(prize.id);
      if (!r.changes) throw "race";
    }

    // ✅ Trừ 1 lượt quay
    db.prepare(`
      UPDATE participants 
      SET lastSpinAt=?, lastPrizeId=?, freeSpinsRemaining=freeSpinsRemaining-1
      WHERE id=?
    `).run(now(), prize.id, participantId);

    return prize;
  });

  try {
    const prize = tx();
    console.log(`🎰 ${p.name} (${p.phone}) quay trúng: ${prize.title}`);
    res.json({
      ok: true,
      prizeKey: prize.prizeKey,
      title: prize.title,
      spinIndex: prize.spinIndex,
      isWin: prize.prizeKey !== "LOSE",
      remaining: prize.remaining
    });
  } catch {
    res.json({ ok: false, message: "Lỗi khi quay, vui lòng thử lại" });
  }
});

app.post("/follow-bonus", (req, res) => {
  const { participantId } = req.body || {};
  if (!participantId) return res.json({ ok: false, message: "Thiếu participantId" });

  const p = db.prepare("SELECT * FROM participants WHERE id=?").get(participantId);
  if (!p) return res.json({ ok: false, message: "Không tìm thấy thông tin người chơi" });

  const today = getTodayVN();

  // ✅ CHECK: Đã dùng lượt bonus hôm nay chưa?
  if (p.dailyBonusUsed === today) {
    return res.json({ 
      ok: false, 
      message: "Bạn đã nhận lượt bonus hôm nay rồi!" 
    });
  }

  // ✅ Cấp lượt bonus + đánh dấu đã dùng
  db.prepare(`
    UPDATE participants
    SET hasFollowedOA=1, freeSpinsRemaining=freeSpinsRemaining+1, dailyBonusUsed=?
    WHERE id=?
  `).run(today, participantId);

  console.log(`🎁 ${p.name} (${p.phone}) follow OA → +1 lượt quay (${today})`);

  return res.json({ 
    ok: true, 
    message: "Bạn đã nhận thêm 1 lượt quay! 🎉" 
  });
});

app.get("/can-spin/:participantId", (req, res) => {
  const participantId = req.params.participantId;

  const p = db.prepare("SELECT * FROM participants WHERE id=?").get(participantId);
  if (!p) {
    return res.json({
      ok: false,
      canSpin: false,
      message: "Không tìm thấy thông tin người chơi",
    });
  }

  const today = getTodayVN();

  // ✅ Reset lượt nếu sang ngày mới
  let freeSpins = p.freeSpinsRemaining || 0;
  if (p.lastClaimDate !== today) {
    freeSpins = 1;
  }

  if (freeSpins > 0) {
    return res.json({ 
      ok: true, 
      canSpin: true,
      message: "Bạn còn lượt quay!"
    });
  }

  return res.json({
    ok: true,
    canSpin: false,
    message: "Bạn đã hết lượt quay hôm nay"
  });
});

app.post("/claim", (req, res) => {
  const { participantId } = req.body || {};
  const p = db.prepare("SELECT * FROM participants WHERE id=?").get(participantId);
  if (!p || !p.lastPrizeId) return res.json({ ok: false, message: "Không có giải thưởng để nhận" });

  const today = getTodayVN();

  // ✅ CHECK: Đã nhận mã hôm nay chưa?
  if (p.lastClaimDate === today) {
    // Đã nhận rồi → trả về mã cũ
    const old = db.prepare(`
      SELECT * FROM claims WHERE participantId=? AND prizeId=? ORDER BY createdAt DESC LIMIT 1
    `).get(participantId, p.lastPrizeId);

    if (old) {
      return res.json({ 
        ok: true, 
        code: old.code, 
        title: old.title, 
        prizeKey: old.prizeKey,
        message: "Bạn đã nhận mã hôm nay rồi!"
      });
    }
  }

  const prize = db.prepare("SELECT * FROM prize_pool WHERE id=?").get(p.lastPrizeId);
  if (!prize) return res.json({ ok: false, message: "Không tìm thấy phần thưởng" });
  if (prize.prizeKey === "LOSE") return res.json({ ok: false, message: "Bạn chưa trúng giải" });

  // ✅ Tạo mã mới
  const code = makeCode();
  db.prepare(`
    INSERT INTO claims(code,participantId,prizeId,prizeKey,title,createdAt)
    VALUES(?,?,?,?,?,?)
  `).run(code, participantId, prize.id, prize.prizeKey, prize.title, now());

  // ✅ Cập nhật lastClaimDate
  db.prepare(`UPDATE participants SET lastClaimDate=? WHERE id=?`).run(today, participantId);

  console.log(`🎁 ${p.name} nhận mã quà: ${code} - ${prize.title}`);
  res.json({ ok: true, code, title: prize.title, prizeKey: prize.prizeKey });
});


// ================= WEBHOOK ZALO =================
// VERIFY TOKEN bí mật - bạn tự đặt, nhớ ghi lại để dán vào Zalo dashboard
const VERIFY_TOKEN = 'zocker-webhook-secret-2026'; // Đổi thành chuỗi mạnh hơn nếu muốn

app.get('/zalo-webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Zalo');
    return res.status(200).send(challenge);
  }

  console.log('Webhook verification failed');
  res.status(403).send('Verification failed');
});

app.post('/zalo-webhook', (req, res) => {
  const event = req.body;
  console.log('📥 Received Zalo event:', JSON.stringify(event, null, 2));

  // Xử lý ví dụ: Khi user follow OA → tự động cấp lượt quay hoặc lưu Zalo ID
  if (event.event === 'user.follow_oa') {
    const userId = event.user_id;
    console.log(`User ${userId} vừa follow OA`);

    // Tìm user trong DB bằng Zalo ID (nếu đã đăng ký trước)
    const participant = db.prepare("SELECT * FROM participants WHERE zaloUserId = ?").get(userId);

    if (participant) {
      // Đã đăng ký → có thể reset lượt quay nếu cần (ví dụ tặng thêm lượt)
      // db.prepare("UPDATE participants SET lastSpinAt = NULL WHERE id = ?").run(participant.id);
      console.log(`User ${participant.name} (${participant.phone}) follow OA - đã tham gia`);
    } else {
      // Chưa đăng ký → log để sau xử lý (có thể gửi tin nhắn OA mời quay)
      console.log(`New follow from Zalo ID ${userId} - chưa đăng ký`);
    }
  }

  // Luôn trả 200 OK nhanh để Zalo không retry
  res.status(200).send('OK');
});

// ✅ API MỚI: Lấy thông tin lượt quay còn lại
app.get("/spins-remaining/:participantId", (req, res) => {
  const participantId = req.params.participantId;

  const p = db.prepare("SELECT * FROM participants WHERE id=?").get(participantId);
  if (!p) {
    return res.json({
      ok: false,
      message: "Không tìm thấy thông tin người chơi",
    });
  }

  const today = getTodayVN();

  // ✅ Reset lượt nếu sang ngày mới
  let freeSpins = p.freeSpinsRemaining || 0;
  let canFollowBonus = true;

  if (p.lastClaimDate !== today) {
    freeSpins = 1;
    canFollowBonus = true; // Ngày mới → reset lượt bonus
  } else {
    // Cùng ngày → check đã dùng bonus chưa
    canFollowBonus = (p.dailyBonusUsed !== today);
  }

  return res.json({
    ok: true,
    totalSpins: freeSpins,
    freeSpins: freeSpins,
    bonusSpins: 0,
    hasFollowedOA: !!p.hasFollowedOA,
    canFollowForBonus: canFollowBonus, // ✅ Trả về để frontend biết
    dailyBonusUsed: p.dailyBonusUsed === today, // ✅ THÊM field này
  });
});

// ✅ API: Lấy thông tin phần quà đã trúng
app.get("/participant-prize/:participantId", (req, res) => {
  const participantId = req.params.participantId;

  const p = db.prepare("SELECT * FROM participants WHERE id=?").get(participantId);
  if (!p) {
    return res.json({
      ok: false,
      message: "Không tìm thấy thông tin người chơi",
    });
  }

  if (!p.lastPrizeId) {
    return res.json({
      ok: true,
      prize: null,
      message: "Chưa có phần thưởng",
    });
  }

  const prize = db.prepare("SELECT * FROM prize_pool WHERE id=?").get(p.lastPrizeId);
  
  return res.json({
    ok: true,
    prize: {
      id: prize.id,
      prizeKey: prize.prizeKey,
      title: prize.title,
      spinIndex: prize.spinIndex,
    },
  });
});

// ================= ADMIN UI =================
app.get("/admin", (req, res) => {
  res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Zocker Admin Panel</title>
<style>
body{font-family:system-ui;background:#f6f7fb;padding:20px;margin:0}
.container{max-width:1200px;margin:0 auto}
.card{background:#fff;padding:25px;border-radius:12px;margin-bottom:20px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
h2{color:#1f2937;margin:0 0 20px 0;display:flex;align-items:center;gap:10px}
input,button,select{padding:12px 16px;margin:5px 0;font-size:15px;border-radius:8px;border:1px solid #d1d5db}
input{width:100%;box-sizing:border-box}
button{background:#4f46e5;color:#fff;border:none;cursor:pointer;font-weight:500;transition:all .2s}
button:hover{background:#4338ca;transform:translateY(-1px)}
button.secondary{background:#059669}
button.secondary:hover{background:#047857}
button.danger{background:#dc2626}
button.danger:hover{background:#b91c1c}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:15px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:15px;margin-bottom:20px}
.stat-card{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:20px;border-radius:10px;color:#fff}
.stat-card.green{background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%)}
.stat-card.blue{background:linear-gradient(135deg,#4facfe 0%,#00f2fe 100%)}
.stat-card.orange{background:linear-gradient(135deg,#fa709a 0%,#fee140 100%)}
.stat-value{font-size:32px;font-weight:bold;margin:5px 0}
.stat-label{font-size:14px;opacity:.9}
table{width:100%;border-collapse:collapse;margin-top:15px}
th,td{padding:12px;text-align:left;border-bottom:1px solid #e5e7eb}
th{background:#f9fafb;font-weight:600;color:#374151;position:sticky;top:0}
tr:hover{background:#f9fafb}
.badge{display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:500}
.badge.success{background:#d1fae5;color:#065f46}
.badge.warning{background:#fef3c7;color:#92400e}
.badge.info{background:#dbeafe;color:#1e40af}
.badge.danger{background:#fee2e2;color:#991b1b}
.filter-bar{display:flex;gap:10px;margin-bottom:15px;flex-wrap:wrap}
.filter-bar select,.filter-bar input{flex:1;min-width:200px}
#playerTable{max-height:500px;overflow-y:auto}
.tab-buttons{display:flex;gap:10px;margin-bottom:20px;border-bottom:2px solid #e5e7eb}
.tab-button{padding:12px 24px;background:none;border:none;border-bottom:3px solid transparent;cursor:pointer;font-weight:500;color:#6b7280;transition:all .2s}
.tab-button.active{color:#4f46e5;border-bottom-color:#4f46e5}
.tab-content{display:none}
.tab-content.active{display:block}
.search-box{position:relative}
.search-box input{padding-left:40px}
.search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#9ca3af}
.fraud-badge{background:#fef2f2;color:#991b1b;border:1px solid #fca5a5}
</style>
</head>
<body>
<div class="container">
  <div class="card">
    <h2>🎁 Zocker Admin Panel</h2>
    <div class="row">
      <input id="key" type="password" placeholder="🔑 Admin key"/>
    </div>
  </div>

  <div class="tab-buttons">
    <button class="tab-button active" onclick="switchTab('dashboard')">📊 Tổng quan</button>
    <button class="tab-button" onclick="switchTab('players')">👥 Khách hàng</button>
    <button class="tab-button" onclick="switchTab('fraud')">🚨 Phát hiện gian lận</button>
    <button class="tab-button" onclick="switchTab('prizes')">🎁 Quà tặng</button>
  </div>

  <!-- TAB: DASHBOARD -->
  <div id="tab-dashboard" class="tab-content active">
    <div class="stats" id="statsContainer">
      <div class="stat-card">
        <div class="stat-label">Tổng người chơi</div>
        <div class="stat-value" id="totalPlayers">0</div>
      </div>
      <div class="stat-card green">
        <div class="stat-label">Đã nhận quà</div>
        <div class="stat-value" id="claimedPrizes">0</div>
      </div>
      <div class="stat-card blue">
        <div class="stat-label">Chưa nhận quà</div>
        <div class="stat-value" id="unclaimedPrizes">0</div>
      </div>
      <div class="stat-card orange">
        <div class="stat-label">Chưa có quà</div>
        <div class="stat-value" id="noPrizes">0</div>
      </div>
    </div>
  </div>

  <!-- TAB: PLAYERS -->
  <div id="tab-players" class="tab-content">
    <div class="card">
      <h2>👥 Danh sách khách hàng</h2>
      
      <div class="filter-bar">
        <div class="search-box" style="flex:2">
          <span class="search-icon">🔍</span>
          <input id="searchInput" type="text" placeholder="Tìm theo tên, SĐT, mã quà..." onkeyup="filterTable()"/>
        </div>
        <select id="statusFilter" onchange="filterTable()">
          <option value="">Tất cả trạng thái</option>
          <option value="claimed">Đã nhận quà</option>
          <option value="unclaimed">Chưa nhận quà</option>
          <option value="noprize">Chưa có quà</option>
        </select>
        <select id="interestFilter" onchange="filterTable()">
          <option value="">Tất cả sản phẩm</option>
          <option value="pickleball">Pickleball</option>
          <option value="football">Bóng đá</option>
          <option value="running">Chạy bộ</option>
          <option value="all">Tất cả</option>
        </select>
      </div>

      <div class="row">
        <button class="secondary" onclick="loadPlayers()">🔄 Tải lại</button>
        <button class="secondary" onclick="exportCSV()">⬇️ Xuất CSV</button>
        <button class="secondary" onclick="exportFilteredCSV()">⬇️ Xuất CSV (Đã lọc)</button>
      </div>

      <div id="playerTable"></div>
    </div>
  </div>

  <!-- TAB: FRAUD DETECTION -->
  <div id="tab-fraud" class="tab-content">
    <div class="card">
      <h2>🚨 Phát hiện gian lận</h2>
      <p style="color:#6b7280;margin-bottom:20px">Hệ thống đã chặn các tài khoản cố gắng đăng ký nhiều lần với cùng Zalo ID</p>
      <div id="fraudTable"></div>
    </div>
  </div>

  <!-- TAB: PRIZES -->
  <div id="tab-prizes" class="tab-content">
    <div class="card">
      <h2>🎁 Kiểm tra & Redeem mã quà</h2>
      <input id="code" placeholder="Nhập mã quà (VD: GIFT-XXXX)"/>
      <div class="row">
        <button onclick="checkCode()">🔍 Kiểm tra mã</button>
        <button class="danger" onclick="redeemCode()">✅ Redeem (Đã trao quà)</button>
      </div>
      <pre id="codeResult" style="background:#f9fafb;padding:15px;border-radius:8px;max-height:300px;overflow:auto;display:none"></pre>
    </div>
  </div>
</div>

<script>
let allPlayers = [];

function switchTab(tabName) {
  document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  
  event.target.classList.add('active');
  document.getElementById('tab-' + tabName).classList.add('active');
  
  if (tabName === 'dashboard') loadDashboard();
  if (tabName === 'players') loadPlayers();
  if (tabName === 'fraud') loadFraudDetection();
}

async function loadDashboard() {
  const key = document.getElementById('key').value;
  if (!key) return alert('Vui lòng nhập admin key');
  
  try {
    const response = await fetch('/admin/api/stats?key=' + key);
    const stats = await response.json();
    
    document.getElementById('totalPlayers').textContent = stats.total || 0;
    document.getElementById('claimedPrizes').textContent = stats.claimed || 0;
    document.getElementById('unclaimedPrizes').textContent = stats.unclaimed || 0;
    document.getElementById('noPrizes').textContent = stats.noPrize || 0;
  } catch (e) {
    alert('Lỗi tải thống kê');
  }
}

async function loadPlayers() {
  const key = document.getElementById('key').value;
  if (!key) return alert('Vui lòng nhập admin key');
  
  try {
    const response = await fetch('/admin/api/players?key=' + key);
    allPlayers = await response.json();
    renderTable(allPlayers);
  } catch (e) {
    alert('Lỗi tải danh sách');
  }
}

async function loadFraudDetection() {
  const key = document.getElementById('key').value;
  if (!key) return alert('Vui lòng nhập admin key');
  
  try {
    const response = await fetch('/admin/api/fraud?key=' + key);
    const fraudData = await response.json();
    
    if (fraudData.length === 0) {
      document.getElementById('fraudTable').innerHTML = '<p style="color:#059669">✅ Không phát hiện gian lận</p>';
      return;
    }
    
    const html = \`
      <table>
        <thead>
          <tr>
            <th>Zalo User ID</th>
            <th>Số lần thử đăng ký</th>
            <th>SĐT đã thử</th>
            <th>Thời gian gần nhất</th>
          </tr>
        </thead>
        <tbody>
          \${fraudData.map(f => \`
            <tr>
              <td><code>\${f.zaloUserId}</code></td>
              <td><span class="badge danger">\${f.attempts} lần</span></td>
              <td>\${f.phones.join(', ')}</td>
              <td>\${new Date(f.lastAttempt).toLocaleString('vi-VN')}</td>
            </tr>
          \`).join('')}
        </tbody>
      </table>
    \`;
    document.getElementById('fraudTable').innerHTML = html;
  } catch (e) {
    alert('Lỗi tải dữ liệu gian lận');
  }
}

function renderTable(data) {
  let rows = '';
  data.forEach(function(r) {
    rows += '<tr>';
    rows += '<td>' + (r.name || '') + '</td>';
    rows += '<td>' + (r.phone || '') + '</td>';
    rows += '<td><span class="badge info">' + (r.interest || 'N/A') + '</span></td>';
    rows += '<td>' + new Date(r.displayTime).toLocaleString('vi-VN') + '</td>';
    rows += '<td><strong>' + (r.code || '-') + '</strong></td>';
    rows += '<td>' + (r.prizeTitle || '-') + '</td>';
    rows += '<td>' + getStatusBadge(r) + '</td>';
    rows += '</tr>';
  });

  const html = '<table>'
    + '<thead><tr>'
    + '<th>Tên</th>'
    + '<th>SĐT</th>'
    + '<th>Sản phẩm quan tâm</th>'
    + '<th>Thời gian nhận mã</th>'
    + '<th>Mã quà</th>'
    + '<th>Tên quà</th>'
    + '<th>Trạng thái</th>'
    + '</tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '</table>';

  document.getElementById('playerTable').innerHTML = html;
}

function getStatusBadge(row) {
  if (!row.code) return '<span class="badge">Chưa có quà</span>';
  if (row.redeemedAt) return '<span class="badge success">Đã nhận quà</span>';
  return '<span class="badge warning">Chưa nhận quà</span>';
}

function filterTable() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const status = document.getElementById('statusFilter').value;
  const interest = document.getElementById('interestFilter').value;
  
  let filtered = allPlayers.filter(row => {
    const matchSearch = !search || 
      (row.name && row.name.toLowerCase().includes(search)) ||
      (row.phone && row.phone.includes(search)) ||
      (row.code && row.code.toLowerCase().includes(search));
    
    const matchStatus = !status ||
      (status === 'claimed' && row.redeemedAt) ||
      (status === 'unclaimed' && row.code && !row.redeemedAt) ||
      (status === 'noprize' && !row.code);
    
    const matchInterest = !interest || 
      (row.job && row.job.toLowerCase() === interest.toLowerCase());
    
    return matchSearch && matchStatus && matchInterest;
  });
  
  renderTable(filtered);
}

async function checkCode() {
  const key = document.getElementById('key').value;
  const code = document.getElementById('code').value.trim();
  if (!key || !code) return alert('Vui lòng nhập admin key và mã quà');
  
  try {
    const response = await fetch('/admin/api/check/' + code + '?key=' + key);
    const result = await response.json();
    document.getElementById('codeResult').style.display = 'block';
    document.getElementById('codeResult').textContent = JSON.stringify(result, null, 2);
  } catch (e) {
    alert('Lỗi kiểm tra mã');
  }
}

async function redeemCode() {
  const key = document.getElementById('key').value;
  const code = document.getElementById('code').value.trim();
  if (!key || !code) return alert('Vui lòng nhập admin key và mã quà');
  if (!confirm('Xác nhận đã trao quà cho khách hàng?')) return;
  
  try {
    const response = await fetch('/admin/api/redeem/' + code, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({key})
    });
    const result = await response.json();
    document.getElementById('codeResult').style.display = 'block';
    document.getElementById('codeResult').textContent = JSON.stringify(result, null, 2);
    if (result.ok) {
      alert('✅ Redeem thành công!');
      loadPlayers();
    }
  } catch (e) {
    alert('Lỗi redeem');
  }
}

function exportCSV() {
  const key = document.getElementById('key').value;
  if (!key) return alert('Vui lòng nhập admin key');
  window.open('/admin/api/export?key=' + key);
}

function exportFilteredCSV() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const status = document.getElementById('statusFilter').value;
  const interest = document.getElementById('interestFilter').value;
  
  const key = document.getElementById('key').value;
  if (!key) return alert('Vui lòng nhập admin key');
  
  const params = new URLSearchParams({
    key,
    search: search || '',
    status: status || '',
    interest: interest || ''
  });
  
  window.open('/admin/api/export?' + params.toString());
}

window.onload = () => {
  const key = document.getElementById('key').value;
  if (key) loadDashboard();
};
</script>
</body>
</html>
`);
});

// ================= ADMIN APIs =================

// Thống kê tổng quan
app.get("/admin/api/stats", adminAuth, (req, res) => {
  const total = db.prepare("SELECT COUNT(*) as count FROM participants").get().count;
  
  const claimed = db.prepare(`
    SELECT COUNT(DISTINCT c.participantId) as count 
    FROM claims c 
    WHERE c.redeemedAt IS NOT NULL
  `).get().count;
  
  const unclaimed = db.prepare(`
    SELECT COUNT(DISTINCT c.participantId) as count 
    FROM claims c 
    WHERE c.redeemedAt IS NULL
  `).get().count;
  
  const noPrize = total - claimed - unclaimed;
  
  res.json({
    total,
    claimed,
    unclaimed,
    noPrize
  });
});

// Danh sách người chơi
app.get("/admin/api/players", adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT 
      p.id,
      p.name,
      p.phone,
      p.sex,
      p.job,
      p.zaloUserId,
      p.createdAt,
      p.lastSpinAt,
      c.code,
      c.title as prizeTitle,
      c.prizeKey,
      c.createdAt as claimCreatedAt,
      c.redeemedAt,
      c.redeemedBy
    FROM participants p
    LEFT JOIN claims c ON p.id = c.participantId
    ORDER BY c.createdAt DESC, p.createdAt DESC
  `).all();
  
  const result = rows.map(r => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    sex: r.sex,
    job: r.job,
    interest: getInterestName(r.job),
    zaloUserId: r.zaloUserId,
    createdAt: r.createdAt,
    lastSpinAt: r.lastSpinAt,
    // ✅ Dùng thời gian nhận mã (claimCreatedAt) nếu có, fallback về createdAt
    displayTime: r.claimCreatedAt || r.createdAt,
    code: r.code,
    prizeTitle: r.prizeTitle,
    prizeKey: r.prizeKey,
    claimCreatedAt: r.claimCreatedAt,
    redeemedAt: r.redeemedAt,
    redeemedBy: r.redeemedBy,
    status: !r.code ? 'noprize' : (r.redeemedAt ? 'claimed' : 'unclaimed')
  }));
  
  res.json(result);
});

// ✅ MỚI: API phát hiện gian lận
app.get("/admin/api/fraud", adminAuth, (req, res) => {
  // Tìm các Zalo ID có nhiều hơn 1 tài khoản
  const frauds = db.prepare(`
    SELECT 
      zaloUserId,
      COUNT(*) as attempts,
      GROUP_CONCAT(phone) as phones,
      MAX(createdAt) as lastAttempt
    FROM participants
    WHERE zaloUserId IS NOT NULL AND zaloUserId != ''
    GROUP BY zaloUserId
    HAVING attempts > 1
    ORDER BY attempts DESC, lastAttempt DESC
  `).all();
  
  const result = frauds.map(f => ({
    zaloUserId: f.zaloUserId,
    attempts: f.attempts,
    phones: f.phones.split(','),
    lastAttempt: f.lastAttempt
  }));
  
  res.json(result);
});

// Check mã quà
app.get("/admin/api/check/:code", adminAuth, (req, res) => {
  const row = db.prepare(`
    SELECT 
      c.*,
      p.name,
      p.phone,
      p.sex,
      p.job,
      p.zaloUserId
    FROM claims c 
    JOIN participants p ON p.id = c.participantId
    WHERE c.code = ?
  `).get(req.params.code.toUpperCase());

  if (!row) return res.json({ ok: false, message: "Mã không tồn tại" });
  
  res.json({ 
    ok: true, 
    claim: {
      ...row,
      interest: getInterestName(row.job),
      status: row.redeemedAt ? 'Đã nhận quà' : 'Chưa nhận quà'
    }
  });
});

// Redeem mã quà
app.post("/admin/api/redeem/:code", adminAuth, (req, res) => {
  const code = req.params.code.toUpperCase();
  
  const claim = db.prepare("SELECT * FROM claims WHERE code = ?").get(code);
  if (!claim) return res.json({ ok: false, message: "Mã không tồn tại" });
  if (claim.redeemedAt) return res.json({ ok: false, message: "Mã đã được redeem trước đó" });
  
  const result = db.prepare(`
    UPDATE claims 
    SET redeemedAt = ?, redeemedBy = 'ADMIN'
    WHERE code = ? AND redeemedAt IS NULL
  `).run(now(), code);

  res.json({ 
    ok: result.changes === 1,
    message: result.changes === 1 ? "Redeem thành công!" : "Redeem thất bại"
  });
});

// Export CSV
app.get("/admin/api/export", adminAuth, (req, res) => {
  const { search, status, interest } = req.query;
  
  let rows = db.prepare(`
    SELECT 
      p.name,
      p.phone,
      p.sex,
      p.job,
      p.zaloUserId,
      p.createdAt,
      c.code,
      c.title as prizeTitle,
      c.redeemedAt
    FROM participants p
    LEFT JOIN claims c ON p.id = c.participantId
    ORDER BY p.createdAt DESC
  `).all();
  
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter(r => 
      (r.name && r.name.toLowerCase().includes(s)) ||
      (r.phone && r.phone.includes(s)) ||
      (r.code && r.code.toLowerCase().includes(s))
    );
  }
  
  if (status) {
    rows = rows.filter(r => {
      if (status === 'claimed') return r.redeemedAt;
      if (status === 'unclaimed') return r.code && !r.redeemedAt;
      if (status === 'noprize') return !r.code;
      return true;
    });
  }
  
  if (interest) {
    rows = rows.filter(r => r.job && r.job.toLowerCase() === interest.toLowerCase());
  }
  
  let csv = "Tên,SĐT,Giới tính,Sản phẩm quan tâm,Zalo User ID,Thời gian nhận mã,Mã quà,Tên quà,Trạng thái\n";
  
  for (const r of rows) {
    const statusText = !r.code ? "Chưa có quà" : (r.redeemedAt ? "Đã nhận quà" : "Chưa nhận quà");
    const interestName = getInterestName(r.job);
    const sexMap = { male: 'Nam', female: 'Nữ', other: 'Khác' };
    const sexText = sexMap[r.sex] || r.sex || '';
    const zaloId = r.zaloUserId ? r.zaloUserId.substring(0, 20) : 'N/A';
    
    // ✅ Dùng thời gian nhận mã nếu có, fallback về thời gian đăng ký
const displayTime = r.redeemedAt || r.createdAt;
csv += `"${r.name || ''}","${r.phone || ''}","${sexText}","${interestName}","${zaloId}","${new Date(displayTime).toLocaleString('vi-VN')}","${r.code || ''}","${r.prizeTitle || ''}","${statusText}"\n`;
  }
  
  const filename = `zocker_khachhang_${new Date().toISOString().split('T')[0]}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
  res.send("\uFEFF" + csv);
});

// ================= RUN =================
app.listen(PORT, () => {
  console.log("✅ Backend running http://localhost:" + PORT);
  console.log("🛡️  Fraud prevention: Zalo User ID tracking enabled");
});