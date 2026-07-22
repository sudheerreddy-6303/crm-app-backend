// ADDED: Project Details module - list / create / update / delete projects.
// Follows the same conventions as routes/walkins.js (auth on all routes,
// pool queries, search + type/status filters, pagination).
const express = require("express");
const { pool } = require("../db");
const { auth, adminOnly } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// Stored as VARCHAR (not ENUM) so new options can be added later without a DB
// migration. Validated on the server side. To add options, extend these lists
// here AND in frontend/src/components/ProjectModal.jsx.
const PROJECT_TYPES = ["Open Land", "Flats", "Villas", "Highrise"];
const PROJECT_STATUSES = ["Handovering for Interior", "Construction State", "Pre Launch"];
const YES_NO = ["Yes", "No"];

// Keep a value only if it's in the allowed list, otherwise store empty string.
const clean = (v, list) => (list.includes(v) ? v : "");
// Coerce a numeric counter to a non-negative integer (default 0).
const num = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

// GET /api/projects  - list with search + type/status filter + pagination
router.get("/", async (req, res) => {
  try {
    const { search = "", type = "", status = "", page = 1, limit = 50 } = req.query;

    const where = [];
    const params = [];

    if (search) {
      where.push(`(p.project_name LIKE ? OR p.owner_contact LIKE ? OR p.secondary_number LIKE ?
                   OR p.phone1 LIKE ? OR p.phone2 LIKE ? OR p.location LIKE ? OR p.sales_executive LIKE ?)`);
      const like = `%${search}%`;
      params.push(like, like, like, like, like, like, like);
    }
    if (type) { where.push("p.type = ?"); params.push(type); }
    if (status) { where.push("p.status = ?"); params.push(status); }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const lim = Math.min(Number(limit) || 50, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM projects p ${whereSql}`, params
    );
    const [rows] = await pool.query(
      `SELECT p.*, u.name AS created_by_name
       FROM projects p LEFT JOIN users u ON u.id = p.created_by
       ${whereSql}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );

    res.json({ total: countRows[0].total, page: Number(page) || 1, limit: lim, projects: rows });
  } catch (err) {
    console.error("Projects list error:", err);
    res.status(500).json({ error: "Failed to load projects" });
  }
});

// Shared field extraction for create/update
function extract(body) {
  return {
    project_name: String(body.project_name || "").trim(),
    owner_contact: String(body.owner_contact || "").trim(),
    secondary_number: String(body.secondary_number || "").trim(),
    location: String(body.location || "").trim(),
    address: String(body.address || "").trim(),
    type: clean(body.type, PROJECT_TYPES),
    sales_executive: String(body.sales_executive || "").trim(),
    phone1: String(body.phone1 || "").trim(),
    phone2: String(body.phone2 || "").trim(),
    status: clean(body.status, PROJECT_STATUSES),
    data_in_crm: clean(body.data_in_crm, YES_NO),
    marketing: clean(body.marketing, YES_NO),
    rounds_called: num(body.rounds_called),
    last_calling_date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.last_calling_date || "")) ? body.last_calling_date : null,
    units_booked_interiors: num(body.units_booked_interiors),
    units_sold: num(body.units_sold),
  };
}

// POST /api/projects  - create a project
router.post("/", async (req, res) => {
  try {
    const f = extract(req.body);
    if (!f.project_name) {
      return res.status(400).json({ error: "Project name is required" });
    }

    const [result] = await pool.query(
      `INSERT INTO projects
       (project_name, owner_contact, secondary_number, location, address, type,
        sales_executive, phone1, phone2, status, data_in_crm, marketing,
        rounds_called, last_calling_date, units_booked_interiors, units_sold, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        f.project_name, f.owner_contact, f.secondary_number, f.location, f.address, f.type,
        f.sales_executive, f.phone1, f.phone2, f.status, f.data_in_crm, f.marketing,
        f.rounds_called, f.last_calling_date, f.units_booked_interiors, f.units_sold, req.user.id,
      ]
    );

    res.status(201).json({ id: result.insertId, message: "Project added" });
  } catch (err) {
    console.error("Project create error:", err);
    res.status(500).json({ error: "Failed to add project" });
  }
});

// PUT /api/projects/:id  - update a project
router.put("/:id", async (req, res) => {
  try {
    const f = extract(req.body);
    if (!f.project_name) {
      return res.status(400).json({ error: "Project name is required" });
    }

    const [result] = await pool.query(
      `UPDATE projects SET project_name = ?, owner_contact = ?, secondary_number = ?,
       location = ?, address = ?, type = ?, sales_executive = ?, phone1 = ?, phone2 = ?,
       status = ?, data_in_crm = ?, marketing = ?, rounds_called = ?, last_calling_date = ?,
       units_booked_interiors = ?, units_sold = ?
       WHERE id = ?`,
      [
        f.project_name, f.owner_contact, f.secondary_number, f.location, f.address, f.type,
        f.sales_executive, f.phone1, f.phone2, f.status, f.data_in_crm, f.marketing,
        f.rounds_called, f.last_calling_date, f.units_booked_interiors, f.units_sold, req.params.id,
      ]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Project not found" });

    res.json({ message: "Project updated" });
  } catch (err) {
    console.error("Project update error:", err);
    res.status(500).json({ error: "Failed to update project" });
  }
});

// DELETE /api/projects/:id  - admin only
router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const [result] = await pool.query("DELETE FROM projects WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Project not found" });
    res.json({ message: "Project deleted" });
  } catch (err) {
    console.error("Project delete error:", err);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

module.exports = router;
module.exports.PROJECT_TYPES = PROJECT_TYPES;
module.exports.PROJECT_STATUSES = PROJECT_STATUSES;
