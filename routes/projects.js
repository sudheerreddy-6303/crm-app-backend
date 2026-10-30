// ADDED: Project Details module - list / create / update / delete projects.
// Follows the same conventions as routes/walkins.js (auth on all routes,
// pool queries, search + type/status filters, pagination).
const express = require("express");
const { pool } = require("../db");
// ADDED: State / City / Location from the forms
const { saveAddress } = require("../utils/saveAddress");
const { auth, adminOnly } = require("../middleware/auth");
// ADDED: live "Data in CRM (count)" = leads in the CRM for each project
const { attachLeadCounts, countForName } = require("../utils/projectLeadCounts");

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
// ADDED: GET /api/projects/lookup?phone=...  -> { found, project, matches }
// Used by the "Add project" form: when a typed number is already saved on a
// project (owner contact, secondary number, phone 1 or phone 2), that project's
// details are loaded. Numbers match on the last 10 digits, so "+91 98490 12345"
// and "9849012345" are the same. Sales executive phones are NOT matched (one
// sales executive can handle many projects).
const projPhoneKey = (v) => {
  const d = String(v || "").replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
};
router.get("/lookup", async (req, res) => {
  try {
    const key = projPhoneKey(req.query.phone);
    if (key.length < 10) return res.json({ found: false, project: null, matches: 0 });
    const like = `%${key.slice(-4)}%`;
    const [rows] = await pool.query(
      // last_calling_date as plain YYYY-MM-DD text (no timezone day-shift)
      `SELECT p.*, DATE_FORMAT(p.last_calling_date, '%Y-%m-%d') AS last_calling_date, u.name AS created_by_name FROM projects p
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.owner_contact LIKE ? OR p.secondary_number LIKE ? OR p.phone1 LIKE ? OR p.phone2 LIKE ?
       ORDER BY p.updated_at DESC, p.id DESC`,
      [like, like, like, like]
    );
    const hits = rows.filter((p) =>
      [p.owner_contact, p.secondary_number, p.phone1, p.phone2].some((n) => projPhoneKey(n) === key)
      && String(p.id) !== String(req.query.exclude || "")
    );
    // ADDED: live Data in CRM count for the found project
    await attachLeadCounts(hits);
    res.json({ found: hits.length > 0, project: hits[0] || null, matches: hits.length });
  } catch (err) {
    console.error("Project lookup error:", err);
    res.status(500).json({ error: "Failed to check phone number" });
  }
});

// ADDED: GET /api/projects/crm-count?name=...  -> { count }
// Leads in the CRM for a project name typed in the Add / Edit project form.
router.get("/crm-count", async (req, res) => {
  try {
    res.json({ count: await countForName(req.query.name) });
  } catch (err) {
    console.error("Project CRM count error:", err);
    res.status(500).json({ error: "Could not count the data in CRM" });
  }
});

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
      // ORIGINAL: `SELECT p.*, u.name AS created_by_name
      // FIXED: last calling date as plain text (no day shift on India time)
      `SELECT p.*, DATE_FORMAT(p.last_calling_date, '%Y-%m-%d') AS last_calling_date, u.name AS created_by_name
       FROM projects p LEFT JOIN users u ON u.id = p.created_by
       ${whereSql}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );

    // ADDED: live "Data in CRM (count)" for each project (crm_leads_count)
    await attachLeadCounts(rows);
    res.json({ total: countRows[0].total, page: Number(page) || 1, limit: lim, projects: rows });
  } catch (err) {
    console.error("Projects list error:", err);
    res.status(500).json({ error: "Failed to load projects" });
  }
});

// ADDED: sales executive 1 phone + sales executive 2 name / phone. Saved in a
// separate UPDATE after the normal insert / update (the existing save is unchanged).
// Only runs when the form sent these fields.
async function saveSalesExecs(id, b) {
  if (!b || !("sales_exec2_name" in b || "sales_exec1_phone" in b || "sales_exec2_phone" in b)) return;
  const t = (v, max) => String(v || "").trim().slice(0, max);
  await pool.query(
    "UPDATE projects SET sales_exec1_phone = ?, sales_exec2_name = ?, sales_exec2_phone = ? WHERE id = ?",
    [t(b.sales_exec1_phone, 20), t(b.sales_exec2_name, 150), t(b.sales_exec2_phone, 20), id]
  );
}

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
    // ADDED: how many towers / flats, how much data in CRM
    total_towers: num(body.total_towers),
    total_flats: num(body.total_flats),
    crm_data_count: num(body.crm_data_count),
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
        rounds_called, last_calling_date, units_booked_interiors, units_sold, created_by,
        total_towers, total_flats, crm_data_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // UPDATED: + total_towers, total_flats, crm_data_count (3 more "?" and values at the end)
      [
        f.project_name, f.owner_contact, f.secondary_number, f.location, f.address, f.type,
        f.sales_executive, f.phone1, f.phone2, f.status, f.data_in_crm, f.marketing,
        f.rounds_called, f.last_calling_date, f.units_booked_interiors, f.units_sold, req.user.id,
        f.total_towers, f.total_flats, f.crm_data_count,
      ]
    );

    // ADDED: sales executive 1 phone + sales executive 2
    await saveSalesExecs(result.insertId, req.body);
    await saveAddress("projects", result.insertId, req.body); // ADDED: state / city

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
       units_booked_interiors = ?, units_sold = ?,
       total_towers = ?, total_flats = ?, crm_data_count = ?
       WHERE id = ?`,
      // UPDATED: + total_towers, total_flats, crm_data_count (before the id)
      [
        f.project_name, f.owner_contact, f.secondary_number, f.location, f.address, f.type,
        f.sales_executive, f.phone1, f.phone2, f.status, f.data_in_crm, f.marketing,
        f.rounds_called, f.last_calling_date, f.units_booked_interiors, f.units_sold,
        f.total_towers, f.total_flats, f.crm_data_count, req.params.id,
      ]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Project not found" });

    // ADDED: sales executive 1 phone + sales executive 2
    await saveSalesExecs(req.params.id, req.body);
    await saveAddress("projects", req.params.id, req.body); // ADDED: state / city

    res.json({ message: "Project updated" });
  } catch (err) {
    console.error("Project update error:", err);
    res.status(500).json({ error: "Failed to update project" });
  }
});

// DELETE /api/projects/:id  - admin only
// ADDED: "Image of project" - upload / view / remove (JPG, PNG or WEBP, max 5 MB).
// The image is sent as-is (not JSON). Same rules as editing a project.
const IMG_TYPES = { "image/jpeg": true, "image/png": true, "image/webp": true };
const IMG_MAX = 5 * 1024 * 1024;
router.post("/:id/image", express.raw({ type: () => true, limit: "6mb" }), async (req, res) => {
  try {
    const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!IMG_TYPES[mime]) return res.status(400).json({ error: "Image must be a JPG, PNG or WEBP file" });
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length === 0) return res.status(400).json({ error: "No image received" });
    if (data.length > IMG_MAX) return res.status(400).json({ error: "Image is too big - maximum 5 MB" });
    let name = "Project image";
    try { name = decodeURIComponent(String(req.headers["x-file-name"] || name)); } catch { /* keep default */ }
    name = name.replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "Project image";
    const [[proj]] = await pool.query("SELECT id FROM projects WHERE id = ?", [req.params.id]);
    if (!proj) return res.status(404).json({ error: "Project not found" });
    await pool.query(
      `INSERT INTO project_images (project_id, file_name, mime_type, size_bytes, data, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE file_name = VALUES(file_name), mime_type = VALUES(mime_type),
         size_bytes = VALUES(size_bytes), data = VALUES(data), uploaded_by = VALUES(uploaded_by),
         uploaded_at = CURRENT_TIMESTAMP`,
      [req.params.id, name, mime, data.length, data, req.user.id]
    );
    await pool.query("UPDATE projects SET image_name = ? WHERE id = ?", [name, req.params.id]);
    res.json({ message: "Project image uploaded", image_name: name });
  } catch (err) {
    if (err && err.type === "entity.too.large") return res.status(400).json({ error: "Image is too big - maximum 5 MB" });
    console.error("Project image upload error:", err);
    res.status(500).json({ error: "Failed to upload the image" });
  }
});
router.get("/:id/image", async (req, res) => {
  try {
    const [[img]] = await pool.query("SELECT file_name, mime_type, data FROM project_images WHERE project_id = ?", [req.params.id]);
    if (!img) return res.status(404).json({ error: "No image for this project" });
    res.setHeader("Content-Type", img.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(img.file_name)}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(img.data);
  } catch (err) {
    console.error("Project image load error:", err);
    res.status(500).json({ error: "Failed to load the image" });
  }
});
router.delete("/:id/image", async (req, res) => {
  try {
    await pool.query("DELETE FROM project_images WHERE project_id = ?", [req.params.id]);
    await pool.query("UPDATE projects SET image_name = '' WHERE id = ?", [req.params.id]);
    res.json({ message: "Project image removed" });
  } catch (err) {
    console.error("Project image remove error:", err);
    res.status(500).json({ error: "Failed to remove the image" });
  }
});

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
