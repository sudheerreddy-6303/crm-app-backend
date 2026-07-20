// ADDED: Service Calls module - list / create / update / delete service calls.
// Follows the same conventions as routes/leads.js (auth on all routes,
// pool queries, search + category filters, pagination).
const express = require("express");
const { pool } = require("../db");
const { auth, adminOnly } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// Category is stored as VARCHAR (not ENUM) so you can add more categories
// later without a DB migration. This list is validated on the server side.
const SERVICE_CATEGORIES = [
  "Painter", "Electrician", "Designer", "Sales",
  "Carpenter", "Plumber", "Deep Cleaning", "Other",
];

// GET /api/service-calls  - list with search + category filter + pagination
router.get("/", async (req, res) => {
  try {
    const { search = "", category = "", page = 1, limit = 50 } = req.query;

    const where = [];
    const params = [];

    if (search) {
      where.push("(s.name LIKE ? OR s.phone LIKE ? OR s.location LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (category) {
      where.push("s.category = ?");
      params.push(category);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const lim = Math.min(Number(limit) || 50, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM service_calls s ${whereSql}`, params
    );
    const [rows] = await pool.query(
      `SELECT s.*, u.name AS created_by_name
       FROM service_calls s LEFT JOIN users u ON u.id = s.created_by
       ${whereSql}
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );

    res.json({ total: countRows[0].total, page: Number(page) || 1, limit: lim, serviceCalls: rows });
  } catch (err) {
    console.error("Service calls list error:", err);
    res.status(500).json({ error: "Failed to load service calls" });
  }
});

// POST /api/service-calls  - create a service call
router.post("/", async (req, res) => {
  try {
    const { name = "", phone = "", category = "", location = "", remarks = "" } = req.body;

    if (!String(name).trim() || !String(phone).trim()) {
      return res.status(400).json({ error: "Name and phone number are required" });
    }
    if (category && !SERVICE_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Invalid category" });
    }

    const [result] = await pool.query(
      `INSERT INTO service_calls (name, phone, category, location, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [String(name).trim(), String(phone).trim(), category || "", String(location).trim(), String(remarks).trim(), req.user.id]
    );

    res.status(201).json({ id: result.insertId, message: "Service call added" });
  } catch (err) {
    console.error("Service call create error:", err);
    res.status(500).json({ error: "Failed to add service call" });
  }
});

// PUT /api/service-calls/:id  - update a service call
router.put("/:id", async (req, res) => {
  try {
    const { name = "", phone = "", category = "", location = "", remarks = "" } = req.body;

    if (!String(name).trim() || !String(phone).trim()) {
      return res.status(400).json({ error: "Name and phone number are required" });
    }
    if (category && !SERVICE_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Invalid category" });
    }

    const [result] = await pool.query(
      `UPDATE service_calls SET name = ?, phone = ?, category = ?, location = ?, remarks = ?
       WHERE id = ?`,
      [String(name).trim(), String(phone).trim(), category || "", String(location).trim(), String(remarks).trim(), req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Service call not found" });

    res.json({ message: "Service call updated" });
  } catch (err) {
    console.error("Service call update error:", err);
    res.status(500).json({ error: "Failed to update service call" });
  }
});

// DELETE /api/service-calls/:id  - admin only
router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const [result] = await pool.query("DELETE FROM service_calls WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Service call not found" });
    res.json({ message: "Service call deleted" });
  } catch (err) {
    console.error("Service call delete error:", err);
    res.status(500).json({ error: "Failed to delete service call" });
  }
});

module.exports = router;
module.exports.SERVICE_CATEGORIES = SERVICE_CATEGORIES;
