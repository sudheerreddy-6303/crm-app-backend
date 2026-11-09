// ADDED: Client Brief (Interior Design Client Brief form) - CRM side (login needed).
//   POST   /api/client-briefs                 create a link for a client (anyone)
//   GET    /api/client-briefs                 list (search / status / paging)
//   GET    /api/client-briefs/:id             one brief with all answers
//   GET    /api/client-briefs/:id/photos/:slot  a photo the client added
//   DELETE /api/client-briefs/:id             remove a brief (admin only)
// Admin sees every brief. A telecaller sees the briefs they created and the
// briefs linked to leads assigned to them.
// The client fills the form through the public link (routes/publicBriefs.js).
const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db");
const { auth, adminOnly } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// "+91 98490-12345" -> "9849012345"; "" when not a valid Indian mobile number
function cleanPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}

const briefNo = (id) => `DI-CB-${String(id).padStart(4, "0")}`;

// telecaller: own briefs + briefs of leads assigned to them
function scope(req, where, params) {
  if (req.user.role !== "admin") {
    where.push("(b.created_by = ? OR l.assigned_to = ?)");
    params.push(req.user.id, req.user.id);
  }
}

const LIST_COLS = `b.id, b.token, b.client_name, b.phone, b.lead_id, b.created_by, b.status,
  b.submit_count, b.filled_name, b.filled_phone, b.email, b.city_area, b.property_type,
  b.configuration, b.budget,
  UNIX_TIMESTAMP(b.created_at) AS created_ts,
  UNIX_TIMESTAMP(b.opened_at) AS opened_ts,
  UNIX_TIMESTAMP(b.submitted_at) AS submitted_ts,
  u.name AS created_by_name, l.name AS lead_name`;

// create a link
router.post("/", async (req, res) => {
  try {
    const name = String(req.body.client_name || "").trim().slice(0, 150);
    const phone = cleanPhone(req.body.phone);
    if (!name) return res.status(400).json({ error: "Please enter the client name" });
    if (!phone) return res.status(400).json({ error: "Please enter a valid 10-digit WhatsApp number (starting with 6, 7, 8 or 9)" });
    // link to the lead with the same phone number (if there is one)
    let leadId = Number(req.body.lead_id) || null;
    if (!leadId) {
      const [[lead]] = await pool.query(
        "SELECT id FROM leads WHERE RIGHT(REGEXP_REPLACE(primary_phone, '[^0-9]', ''), 10) = ? ORDER BY id DESC LIMIT 1",
        [phone]
      );
      if (lead) leadId = lead.id;
    }
    const token = crypto.randomBytes(18).toString("hex");
    const [r] = await pool.query(
      "INSERT INTO client_briefs (token, client_name, phone, lead_id, created_by) VALUES (?, ?, ?, ?, ?)",
      [token, name, phone, leadId, req.user.id]
    );
    const [[row]] = await pool.query(
      `SELECT ${LIST_COLS} FROM client_briefs b
       LEFT JOIN users u ON u.id = b.created_by LEFT JOIN leads l ON l.id = b.lead_id WHERE b.id = ?`, [r.insertId]
    );
    res.json({ message: `Client brief link created for ${name}`, brief: { ...row, brief_no: briefNo(row.id) } });
  } catch (err) {
    console.error("Client brief create error:", err);
    res.status(500).json({ error: "Could not create the link" });
  }
});

// list
router.get("/", async (req, res) => {
  try {
    const lim = Math.min(Number(req.query.limit) || 50, 1000);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const where = []; const params = [];
    scope(req, where, params);
    const status = String(req.query.status || "");
    if (["sent", "opened", "submitted"].includes(status)) { where.push("b.status = ?"); params.push(status); }
    const q = String(req.query.search || "").trim();
    if (q) {
      const digits = q.replace(/\D/g, "");
      const like = `%${q}%`;
      const parts = ["b.client_name LIKE ?", "b.filled_name LIKE ?", "b.email LIKE ?", "b.city_area LIKE ?"];
      params.push(like, like, like, like);
      if (digits) { parts.push("b.phone LIKE ?", "b.filled_phone LIKE ?"); params.push(`%${digits}%`, `%${digits}%`); }
      const m = q.match(/(\d+)\s*$/);
      if (/^di-?cb/i.test(q) && m) { parts.push("b.id = ?"); params.push(Number(m[1])); }
      where.push(`(${parts.join(" OR ")})`);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = `FROM client_briefs b LEFT JOIN users u ON u.id = b.created_by LEFT JOIN leads l ON l.id = b.lead_id ${w}`;
    const [[cnt]] = await pool.query(`SELECT COUNT(*) AS c ${from}`, params);
    const [rows] = await pool.query(
      `SELECT ${LIST_COLS} ${from} ORDER BY COALESCE(b.submitted_at, b.created_at) DESC, b.id DESC LIMIT ? OFFSET ?`,
      [...params, lim, (page - 1) * lim]
    );
    // counts per status (same visibility) for the filter chips
    const sw = []; const sp = []; scope(req, sw, sp);
    const [st] = await pool.query(
      `SELECT b.status, COUNT(*) AS c FROM client_briefs b LEFT JOIN leads l ON l.id = b.lead_id
       ${sw.length ? `WHERE ${sw.join(" AND ")}` : ""} GROUP BY b.status`, sp
    );
    const counts = { sent: 0, opened: 0, submitted: 0 };
    st.forEach((s) => { counts[s.status] = Number(s.c); });
    res.json({ total: Number(cnt.c), page, limit: lim, counts, briefs: rows.map((r) => ({ ...r, brief_no: briefNo(r.id) })) });
  } catch (err) {
    console.error("Client brief list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

async function findVisible(req, id) {
  const where = ["b.id = ?"]; const params = [id];
  scope(req, where, params);
  const [[row]] = await pool.query(
    `SELECT ${LIST_COLS}, b.answers_json, b.summary_text
     FROM client_briefs b LEFT JOIN users u ON u.id = b.created_by LEFT JOIN leads l ON l.id = b.lead_id
     WHERE ${where.join(" AND ")}`, params
  );
  return row;
}

router.get("/:id", async (req, res) => {
  try {
    const row = await findVisible(req, req.params.id);
    if (!row) return res.status(404).json({ error: "Client brief not found" });
    let answers = [];
    try { answers = JSON.parse(row.answers_json || "[]"); } catch { answers = []; }
    const [photos] = await pool.query("SELECT slot, size_bytes FROM client_brief_photos WHERE brief_id = ? ORDER BY id", [row.id]);
    delete row.answers_json;
    res.json({ brief: { ...row, brief_no: briefNo(row.id), answers, photos } });
  } catch (err) {
    console.error("Client brief view error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/:id/photos/:slot", async (req, res) => {
  try {
    const row = await findVisible(req, req.params.id);
    if (!row) return res.status(404).json({ error: "Client brief not found" });
    const [[p]] = await pool.query("SELECT mime_type, data FROM client_brief_photos WHERE brief_id = ? AND slot = ?", [row.id, req.params.slot]);
    if (!p) return res.status(404).json({ error: "No photo" });
    res.set("Content-Type", p.mime_type);
    res.set("Cache-Control", "private, max-age=300");
    res.send(p.data);
  } catch (err) {
    console.error("Client brief photo error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const [r] = await pool.query("DELETE FROM client_briefs WHERE id = ?", [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: "Client brief not found" });
    res.json({ message: `${briefNo(req.params.id)} removed` });
  } catch (err) {
    console.error("Client brief delete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
module.exports.briefNo = briefNo;
