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
  // ADDED: more service categories
  "Glass Work", "Marbles Work", "Tele Callers", "Sales Executive",
  "Interior Designer", "Builders", "False Ceiling", "AC Repair",
  "Printer Repair", "Chair Repair", "Site Managers",
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
    // ADDED: city + experience (optional) accepted alongside the original fields
    const { name = "", phone = "", category = "", location = "", remarks = "", city = "", experience = "" } = req.body;

    if (!String(name).trim() || !String(phone).trim()) {
      return res.status(400).json({ error: "Name and phone number are required" });
    }
    if (category && !SERVICE_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Invalid category" });
    }

    // ORIGINAL: INSERT (name, phone, category, location, remarks, created_by)
    // ADDED: also stores city + experience (both default '' in the DB)
    const [result] = await pool.query(
      `INSERT INTO service_calls (name, phone, category, location, remarks, city, experience, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(name).trim(), String(phone).trim(), category || "", String(location).trim(), String(remarks).trim(), String(city).trim(), String(experience).trim(), req.user.id]
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
    // ADDED: city + experience (optional) accepted alongside the original fields
    const { name = "", phone = "", category = "", location = "", remarks = "", city = "", experience = "" } = req.body;

    if (!String(name).trim() || !String(phone).trim()) {
      return res.status(400).json({ error: "Name and phone number are required" });
    }
    if (category && !SERVICE_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Invalid category" });
    }

    // ORIGINAL: UPDATE ... SET name, phone, category, location, remarks
    // ADDED: also updates city + experience
    const [result] = await pool.query(
      `UPDATE service_calls SET name = ?, phone = ?, category = ?, location = ?, remarks = ?, city = ?, experience = ?
       WHERE id = ?`,
      [String(name).trim(), String(phone).trim(), category || "", String(location).trim(), String(remarks).trim(), String(city).trim(), String(experience).trim(), req.params.id]
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

// ADDED: POST /api/service-calls/import  (admin bulk import)
// Accepts { rows: [{ name, phone, city, location, experience, category }] }
// mapped from an Excel/CSV with the columns:
//   Fullname, Mobile number, city, location, experience, category
// Follows the same conventions as the leads import (routes/leads.js):
//   - admin only
//   - phone sanitized to digits only and validated (10-15 digits) so Excel
//     scientific-notation corruption cannot crash the insert
//   - duplicate phone numbers (already in the DB, or repeated inside the batch)
//     are rejected so re-importing the same sheet does not create duplicates
//   - category is matched case-insensitively against SERVICE_CATEGORIES and
//     stored in canonical casing; a custom category not in the list is kept
//     as-is (VARCHAR column) so nothing from the sheet is lost
router.post("/import", adminOnly, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows array is required" });
    }

    // Load existing phone numbers once for fast duplicate lookup.
    const [existingRows] = await pool.query("SELECT phone FROM service_calls");
    const existingPhones = new Set(existingRows.map((r) => String(r.phone).replace(/\D/g, "")));

    let inserted = 0, skipped = 0, duplicates = 0, invalidPhone = 0;

    for (const b of rows) {
      const name = String(b.name || "").trim();
      const digitsOnly = String(b.phone || "").replace(/\D/g, "");

      // require a name and a phone
      if (!name || !digitsOnly) { skipped++; continue; }
      // validate phone length (10-15 digits); phone column is VARCHAR(20)
      if (digitsOnly.length < 10 || digitsOnly.length > 15) { invalidPhone++; continue; }
      // reject duplicates (already in DB or repeated within this batch)
      if (existingPhones.has(digitsOnly)) { duplicates++; continue; }
      existingPhones.add(digitsOnly);

      // ORIGINAL (bug: exact, case-sensitive match - a sheet value like
      // "interior designer" or "INTERIOR DESIGNER" did not match the canonical
      // "Interior Designer" and was silently blanked):
      //   const rawCat = String(b.category || "").trim();
      //   const category = SERVICE_CATEGORIES.includes(rawCat) ? rawCat : "";
      // FIXED: match categories case-insensitively (ignoring surrounding spaces)
      // and store the canonical casing from SERVICE_CATEGORIES. If the value is a
      // custom category not in the list, keep the raw value as-is (the column is
      // VARCHAR, not ENUM) instead of dropping it - nothing from the sheet is lost.
      const rawCat = String(b.category || "").trim();
      const canonical = SERVICE_CATEGORIES.find(
        (c) => c.toLowerCase() === rawCat.toLowerCase()
      );
      const category = canonical || rawCat;

      await pool.query(
        `INSERT INTO service_calls (name, phone, category, location, remarks, city, experience, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          digitsOnly,
          category,
          String(b.location || "").trim(),
          String(b.remarks || "").trim(),
          String(b.city || "").trim(),
          String(b.experience || "").trim(),
          req.user.id,
        ]
      );
      inserted++;
    }

    const dupNote = duplicates > 0 ? `, rejected ${duplicates} duplicate(s) already in the database` : "";
    const invNote = invalidPhone > 0 ? `, rejected ${invalidPhone} row(s) with invalid phone numbers` : "";
    res.json({
      message: `Imported ${inserted} service call(s), skipped ${skipped}${dupNote}${invNote}`,
      inserted, skipped, duplicates, invalidPhone,
    });
  } catch (err) {
    console.error("Service call import error:", err);
    res.status(500).json({ error: "Failed to import service calls" });
  }
});

module.exports = router;
module.exports.SERVICE_CATEGORIES = SERVICE_CATEGORIES;
