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


// ================= PRIZE CONFIG =================
const PRIZE_SLOTS = [
  { spinIndex: 0, prizeKey: "FIRST", title: "Vợt Aspire (Giải nhất)", total: 1, weight: 0 },
  { spinIndex: 1, prizeKey: "SECOND", title: "Giày Pickleball Aspire", total: 2, weight: 3 },
  { spinIndex: 2, prizeKey: "THIRD", title: "Balo Pickleball", total: 5, weight: 8 },
  { spinIndex: 3, prizeKey: "FOURTH", title: "Bóng Pickleball", total: 10, weight: 15 },
  { spinIndex: 4, prizeKey: "VOUCHER_15", title: "Voucher 15%", total: 30, weight: 100 },
  { spinIndex: 5, prizeKey: "VOUCHER_10", title: "Voucher 10%", total: 50, weight: 150 },
  { spinIndex: 6, prizeKey: "LOSE", title: "Chúc may mắn lần sau", total: null, weight: 0 },
  { spinIndex: 7, prizeKey: "LOSE", title: "Chúc may mắn lần sau", total: null, weight: 30 }
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
  const { name, phone, sex, job } = req.body || {};
  if (!name || !phone) return res.json({ ok: false });

  const old = db.prepare("SELECT * FROM participants WHERE phone=?").get(phone);
  if (old) return res.json({ ok: true, participantId: old.id });

  const id = nanoid(12);
  db.prepare(`
    INSERT INTO participants(id,name,phone,sex,job,createdAt)
    VALUES(?,?,?,?,?,?)
  `).run(id, name, phone, sex || "other", job || "other", now());

  res.json({ ok: true, participantId: id });
});

app.post("/spin", (req, res) => {
  const { participantId } = req.body || {};
  const p = db.prepare("SELECT * FROM participants WHERE id=?").get(participantId);
  if (!p) return res.json({ ok: false });

  if (p.lastSpinAt && now() - p.lastSpinAt < 86400000)
    return res.json({ ok: false, message: "Đã quay hôm nay" });

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

    db.prepare(`
      UPDATE participants SET lastSpinAt=?, lastPrizeId=?
      WHERE id=?
    `).run(now(), prize.id, participantId);

    return prize;
  });

  try {
    const prize = tx();
    res.json({
      ok: true,
      prizeKey: prize.prizeKey,
      title: prize.title,
      spinIndex: prize.spinIndex,
      isWin: prize.prizeKey !== "LOSE"
    });
  } catch {
    res.json({ ok: false });
  }
});

app.post("/claim", (req, res) => {
  const { participantId } = req.body || {};
  const p = db.prepare("SELECT * FROM participants WHERE id=?").get(participantId);
  if (!p || !p.lastPrizeId) return res.json({ ok: false });

  const prize = db.prepare("SELECT * FROM prize_pool WHERE id=?").get(p.lastPrizeId);
  if (prize.prizeKey === "LOSE") return res.json({ ok: false });

  const old = db.prepare(`
    SELECT * FROM claims
    WHERE participantId=? AND redeemedAt IS NULL
  `).get(participantId);
  if (old) return res.json({ ok: true, code: old.code });

  const code = makeCode();
  db.prepare(`
    INSERT INTO claims(code,participantId,prizeId,prizeKey,title,createdAt)
    VALUES(?,?,?,?,?,?)
  `).run(code, participantId, prize.id, prize.prizeKey, prize.title, now());

  res.json({ ok: true, code });
});

// ================= ADMIN UI =================
app.get("/admin", (req, res) => {
  res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Zocker Admin</title>
<style>
body{font-family:system-ui;background:#f6f7fb;padding:30px}
.card{background:#fff;padding:20px;border-radius:12px;max-width:900px;margin:auto;box-shadow:0 10px 30px rgba(0,0,0,.1)}
input,button{padding:10px;margin:5px 0;width:100%;font-size:15px}
button{background:#4f46e5;color:#fff;border:none;border-radius:6px;cursor:pointer}
button.alt{background:#059669}
pre{background:#111;color:#0f0;padding:15px;border-radius:8px;max-height:400px;overflow:auto}
.row{display:flex;gap:10px}
.row button{flex:1}
</style>
</head>
<body>
<div class="card">
<h2>🎁 Zocker Admin Panel</h2>

<input id="key" placeholder="Admin key"/>
<input id="code" placeholder="GIFT-XXXX"/>

<div class="row">
<button onclick="check()">🔍 Check mã</button>
<button onclick="redeem()">✅ Redeem</button>
</div>

<div class="row">
<button class="alt" onclick="players()">👥 Danh sách người chơi</button>
<button class="alt" onclick="exportCSV()">⬇ Xuất CSV</button>
</div>

<pre id="out"></pre>
</div>

<script>
const out=document.getElementById('out');
async function check(){
  const r=await fetch('/admin/api/check/'+code.value+'?key='+key.value);
  out.textContent=JSON.stringify(await r.json(),null,2);
}
async function redeem(){
  const r=await fetch('/admin/api/redeem/'+code.value,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key:key.value})
  });
  out.textContent=JSON.stringify(await r.json(),null,2);
}
async function players(){
  const r=await fetch('/admin/api/players?key='+key.value);
  out.textContent=JSON.stringify(await r.json(),null,2);
}
function exportCSV(){
  window.open('/admin/api/export?key='+key.value);
}
</script>
</body>
</html>
`);
});

// ================= ADMIN APIs =================
app.get("/admin/api/check/:code", adminAuth, (req, res) => {
  const row = db.prepare(`
    SELECT c.*, p.name, p.phone
    FROM claims c JOIN participants p ON p.id=c.participantId
    WHERE c.code=?
  `).get(req.params.code.toUpperCase());

  if (!row) return res.json({ ok: false });
  res.json({ ok: true, claim: row });
});

app.post("/admin/api/redeem/:code", adminAuth, (req, res) => {
  const r = db.prepare(`
    UPDATE claims SET redeemedAt=?, redeemedBy='ADMIN'
    WHERE code=? AND redeemedAt IS NULL
  `).run(now(), req.params.code.toUpperCase());

  res.json({ ok: r.changes === 1 });
});

app.get("/admin/api/players", adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.name,p.phone,p.createdAt,
           c.code,c.redeemedAt
    FROM participants p
    LEFT JOIN claims c ON p.id=c.participantId
    ORDER BY p.createdAt DESC
  `).all();
  res.json(rows);
});

app.get("/admin/api/export", adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.name,p.phone,p.createdAt,
           c.code,c.redeemedAt
    FROM participants p
    LEFT JOIN claims c ON p.id=c.participantId
  `).all();

   let csv = "Tên,SĐT,Thời gian chơi,Mã quà,Trạng thái\n";

  for (const r of rows) {
  csv += `"${r.name}","${r.phone}","${new Date(r.createdAt).toLocaleString()}","${r.code || ""}","${r.redeemedAt ? "ĐÃ NHẬN" : "CHƯA"}"\n`;
   }


  res.setHeader("Content-Type","text/csv");
  res.setHeader("Content-Disposition","attachment; filename=zocker_players.csv");
  res.send(csv);
});

// ================= RUN =================
app.listen(PORT, () => {
  console.log("✅ Backend running http://localhost:" + PORT);
});
