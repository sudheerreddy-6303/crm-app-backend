// ADDED: Walk-ins module - list / create / update / delete walk-in records.
// Follows the same conventions as routes/serviceCalls.js (auth on all routes,
// pool queries, search + purpose filter, pagination).
const express = require("express");
const { pool } = require("../db");
const { auth, adminOnly } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// Purpose is stored as VARCHAR (not ENUM) so you can add more purposes later
// without a DB migration. This list is validated on the server side.
const WALKIN_PURPOSES = [
  "Modular Kitchen", "Wardrobe", "Full Home Interiors", "Living Room",
  "Bedroom", "Kids Room", "Pooja Unit", "TV Unit", "Office Interiors",
  "Renovation", "Just Enquiry", "Other",
];

// GET /api/walkins  - list with search + purpose filter + pagination
router.get("/", async (req, res) => {
  try {
    const { search = "", purpose = "", page = 1, limit = 50 } = req.query;

    const where = [];
    const params = [];

    if (search) {
      where.push("(w.name LIKE ? OR w.phone LIKE ? OR w.alt_phone LIKE ? OR w.project_name LIKE ? OR w.location LIKE ? OR w.site_location LIKE ? OR w.city LIKE ? OR w.attended_by LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (purpose) {
      where.push("w.purpose = ?");
      params.push(purpose);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const lim = Math.min(Number(limit) || 50, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM walkins w ${whereSql}`, params
    );
    const [rows] = await pool.query(
      `SELECT w.*, u.name AS created_by_name
       FROM walkins w LEFT JOIN users u ON u.id = w.created_by
       ${whereSql}
       ORDER BY w.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );

    res.json({ total: countRows[0].total, page: Number(page) || 1, limit: lim, walkins: rows });
  } catch (err) {
    console.error("Walk-ins list error:", err);
    res.status(500).json({ error: "Failed to load walk-ins" });
  }
});

// POST /api/walkins  - create a walk-in
router.post("/", async (req, res) => {
  try {
    const {
      name = "", phone = "", alt_phone = "", project_name = "", visit_date = "", purpose = "",
      location = "", site_location = "", city = "", address = "",
      budget = "", attended_by = "", remarks = "",
    } = req.body;

    if (!String(name).trim() || !String(phone).trim()) {
      return res.status(400).json({ error: "Name and phone number are required" });
    }
    if (purpose && !WALKIN_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: "Invalid purpose" });
    }

    const [result] = await pool.query(
      `INSERT INTO walkins (name, phone, alt_phone, project_name, visit_date, purpose, location, site_location, city, address, budget, attended_by, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(name).trim(), String(phone).trim(), String(alt_phone).trim(), String(project_name).trim(),
        visit_date || null, purpose || "",
        String(location).trim(), String(site_location).trim(), String(city).trim(), String(address).trim(),
        String(budget).trim(), String(attended_by).trim(), String(remarks).trim(), req.user.id,
      ]
    );

    res.status(201).json({ id: result.insertId, message: "Walk-in added" });
  } catch (err) {
    console.error("Walk-in create error:", err);
    res.status(500).json({ error: "Failed to add walk-in" });
  }
});

// PUT /api/walkins/:id  - update a walk-in
router.put("/:id", async (req, res) => {
  try {
    const {
      name = "", phone = "", alt_phone = "", project_name = "", visit_date = "", purpose = "",
      location = "", site_location = "", city = "", address = "",
      budget = "", attended_by = "", remarks = "",
    } = req.body;

    if (!String(name).trim() || !String(phone).trim()) {
      return res.status(400).json({ error: "Name and phone number are required" });
    }
    if (purpose && !WALKIN_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: "Invalid purpose" });
    }

    const [result] = await pool.query(
      `UPDATE walkins SET name = ?, phone = ?, alt_phone = ?, project_name = ?, visit_date = ?, purpose = ?,
       location = ?, site_location = ?, city = ?, address = ?, budget = ?, attended_by = ?, remarks = ?
       WHERE id = ?`,
      [
        String(name).trim(), String(phone).trim(), String(alt_phone).trim(), String(project_name).trim(),
        visit_date || null, purpose || "",
        String(location).trim(), String(site_location).trim(), String(city).trim(), String(address).trim(),
        String(budget).trim(), String(attended_by).trim(), String(remarks).trim(), req.params.id,
      ]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Walk-in not found" });

    res.json({ message: "Walk-in updated" });
  } catch (err) {
    console.error("Walk-in update error:", err);
    res.status(500).json({ error: "Failed to update walk-in" });
  }
});

// ADDED: POST /api/walkins/:id/convert  - convert a walk-in into a lead.
// Creates a new row in the leads table (Data page) from the walk-in details and
// marks the walk-in as converted. The walk-in record is KEPT (not deleted).
// Admin can pick the telecaller ({ assigned_to }); a telecaller's conversion is
// assigned to themselves. Blocks a second conversion and duplicate phone numbers.
router.post("/:id/convert", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT *, DATE_FORMAT(visit_date, '%Y-%m-%d') AS visit_str FROM walkins WHERE id = ?",
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Walk-in not found" });
    const w = rows[0];
    if (w.converted_lead_id) {
      return res.status(400).json({ error: "This walk-in is already converted to a lead" });
    }

    const phoneDigits = String(w.phone || "").replace(/\D/g, "");
    const [dup] = await pool.query(
      "SELECT id FROM leads WHERE primary_phone = ? OR primary_phone = ? LIMIT 1",
      [String(w.phone || "").trim(), phoneDigits]
    );
    if (dup.length > 0) {
      return res.status(409).json({ error: "A lead with this phone number already exists in Data" });
    }

    const isAdmin = req.user.role === "admin";
    const assignedTo = isAdmin ? (req.body.assigned_to || null) : req.user.id;

    // Walk-in details are copied into the lead's calling remark so nothing is lost
    const visit = w.visit_str || "";
    const parts = [
      visit && `Walk-in on ${visit}`,
      w.purpose && `Purpose: ${w.purpose}`,
      w.budget && `Budget: ${w.budget}`,
      w.location && `Centre: ${w.location}`,
      (w.site_location || w.city) && `Location: ${[w.site_location, w.city].filter(Boolean).join(", ")}`,
      w.alt_phone && `Alt mobile: ${w.alt_phone}`,
      w.attended_by && `Attended by: ${w.attended_by}`,
      w.remarks && `Remarks: ${w.remarks}`,
    ].filter(Boolean);

    const [result] = await pool.query(
      `INSERT INTO leads (name, project_name, primary_phone, assigned_to, calling_remark, priority, source, created_by)
       VALUES (?, ?, ?, ?, ?, 'none', 'Walk-in', ?)`,
      [w.name, w.project_name || "", String(w.phone).trim(), assignedTo, parts.join(" | "), req.user.id]
    );
    await pool.query("UPDATE walkins SET converted_lead_id = ? WHERE id = ?", [result.insertId, w.id]);

    res.status(201).json({ id: result.insertId, message: `"${w.name}" converted to a lead` });
  } catch (err) {
    console.error("Walk-in convert error:", err);
    res.status(500).json({ error: "Failed to convert walk-in" });
  }
});

// DELETE /api/walkins/:id  - admin only
router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const [result] = await pool.query("DELETE FROM walkins WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Walk-in not found" });
    res.json({ message: "Walk-in deleted" });
  } catch (err) {
    console.error("Walk-in delete error:", err);
    res.status(500).json({ error: "Failed to delete walk-in" });
  }
});

module.exports = router;
module.exports.WALKIN_PURPOSES = WALKIN_PURPOSES;
