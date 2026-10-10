// ADDED: Business Associates & Franchise module - list / create / update /
// delete records. Follows the same conventions as routes/walkins.js (auth on
// all routes, pool queries, search + category filter, pagination).
const express = require("express");
const { pool } = require("../db");
const { auth, adminOnly } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// Category is stored as VARCHAR (not ENUM) so you can add more categories later
// without a DB migration. Add new ones here AND in
// frontend/src/components/BusinessPartnerModal.jsx (PARTNER_CATEGORIES).
const PARTNER_CATEGORIES = [
  "Business Associates", "Builders", "Contractors", "Franchise Prospect",
  // ADDED: new category
  "Sales",
];

// ADDED: dates come as YYYY-MM-DD from the date inputs; empty -> NULL
const dateOrNull = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);

const readBody = (b) => ({
  person_name: String(b.person_name || "").trim(),
  contact: String(b.contact || "").trim(),
  business_name: String(b.business_name || "").trim(),
  location: String(b.location || "").trim(),
  whatsapp: String(b.whatsapp || "").trim(),
  call_remark_1: String(b.call_remark_1 || "").trim(),
  call_remark_2: String(b.call_remark_2 || "").trim(),
  category: String(b.category || "").trim(),
  // ADDED: calling date + WhatsApp sent date
  calling_date: dateOrNull(b.calling_date),
  whatsapp_sent_date: dateOrNull(b.whatsapp_sent_date),
  // ADDED: 2nd call date + 2nd WhatsApp sent date
  calling_date_2: dateOrNull(b.calling_date_2),
  whatsapp_sent_date_2: dateOrNull(b.whatsapp_sent_date_2),
});

const validate = (d) => {
  if (!d.person_name || !d.contact) return "Person name and contact number are required";
  if (d.category && !PARTNER_CATEGORIES.includes(d.category)) return "Invalid category";
  return null;
};

// GET /api/business-partners  - list with search + category filter + pagination
router.get("/", async (req, res) => {
  try {
    const { search = "", category = "", page = 1, limit = 50 } = req.query;

    const where = [];
    const params = [];
    if (search) {
      where.push("(b.person_name LIKE ? OR b.contact LIKE ? OR b.business_name LIKE ? OR b.location LIKE ? OR b.whatsapp LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (category) {
      where.push("b.category = ?");
      params.push(category);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const lim = Math.min(Number(limit) || 50, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM business_partners b ${whereSql}`, params
    );
    const [rows] = await pool.query(
      // UPDATED: dates returned as plain 'YYYY-MM-DD' text so they never shift
      // by a day because of the server's timezone
      `SELECT b.*, u.name AS created_by_name,
              DATE_FORMAT(b.calling_date, '%Y-%m-%d') AS calling_date,
              DATE_FORMAT(b.whatsapp_sent_date, '%Y-%m-%d') AS whatsapp_sent_date,
              DATE_FORMAT(b.calling_date_2, '%Y-%m-%d') AS calling_date_2,
              DATE_FORMAT(b.whatsapp_sent_date_2, '%Y-%m-%d') AS whatsapp_sent_date_2
       FROM business_partners b LEFT JOIN users u ON u.id = b.created_by
       ${whereSql}
       ORDER BY b.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );

    res.json({ total: countRows[0].total, page: Number(page) || 1, limit: lim, partners: rows });
  } catch (err) {
    console.error("Business partners list error:", err);
    res.status(500).json({ error: "Failed to load records" });
  }
});

// POST /api/business-partners  - create
router.post("/", async (req, res) => {
  try {
    const d = readBody(req.body);
    const bad = validate(d);
    if (bad) return res.status(400).json({ error: bad });

    const [result] = await pool.query(
      `INSERT INTO business_partners
       (person_name, contact, business_name, location, whatsapp, call_remark_1, call_remark_2, category, created_by,
        calling_date, whatsapp_sent_date, calling_date_2, whatsapp_sent_date_2)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.person_name, d.contact, d.business_name, d.location, d.whatsapp,
       d.call_remark_1, d.call_remark_2, d.category, req.user.id,
       // ADDED: calling date + WhatsApp sent date
       d.calling_date, d.whatsapp_sent_date,
       // ADDED: 2nd call date + 2nd WhatsApp sent date
       d.calling_date_2, d.whatsapp_sent_date_2]
    );
    res.status(201).json({ id: result.insertId, message: "Record added" });
  } catch (err) {
    console.error("Business partner create error:", err);
    res.status(500).json({ error: "Failed to add record" });
  }
});

// PUT /api/business-partners/:id  - update
router.put("/:id", async (req, res) => {
  try {
    const d = readBody(req.body);
    const bad = validate(d);
    if (bad) return res.status(400).json({ error: bad });

    const [result] = await pool.query(
      `UPDATE business_partners SET person_name = ?, contact = ?, business_name = ?, location = ?,
       whatsapp = ?, call_remark_1 = ?, call_remark_2 = ?, category = ?,
       calling_date = ?, whatsapp_sent_date = ?,
       calling_date_2 = ?, whatsapp_sent_date_2 = ?
       WHERE id = ?`,
      [d.person_name, d.contact, d.business_name, d.location, d.whatsapp,
       d.call_remark_1, d.call_remark_2, d.category,
       // ADDED: calling date + WhatsApp sent date
       d.calling_date, d.whatsapp_sent_date,
       // ADDED: 2nd call date + 2nd WhatsApp sent date
       d.calling_date_2, d.whatsapp_sent_date_2, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Record not found" });
    res.json({ message: "Record updated" });
  } catch (err) {
    console.error("Business partner update error:", err);
    res.status(500).json({ error: "Failed to update record" });
  }
});

// DELETE /api/business-partners/:id  - admin only (same as walk-ins)
router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const [result] = await pool.query("DELETE FROM business_partners WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Record not found" });
    res.json({ message: "Record deleted" });
  } catch (err) {
    console.error("Business partner delete error:", err);
    res.status(500).json({ error: "Failed to delete record" });
  }
});

module.exports = router;
module.exports.PARTNER_CATEGORIES = PARTNER_CATEGORIES;
