// ADDED: Service Calls module - list / create / update / delete service calls.
// Follows the same conventions as routes/leads.js (auth on all routes,
// pool queries, search + category filters, pagination).
const express = require("express");
const { pool } = require("../db");
// ADDED: State / City / Location from the forms
const { saveAddress } = require("../utils/saveAddress");
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
  // ADDED
  "Architects",
];

// ADDED: categories added from the app (table service_call_categories).
async function customCategories() {
  try {
    const [rows] = await pool.query("SELECT id, name FROM service_call_categories ORDER BY name");
    return rows;
  } catch (e) {
    return []; // table not created yet - built-in list only
  }
}
// built-in + added categories (used to validate a saved category)
async function allCategories() {
  return [...SERVICE_CATEGORIES, ...(await customCategories()).map((r) => r.name)];
}

// ADDED: duplicate protection by phone number.
// Two numbers are the same if their last 10 digits match, so "+91 98490 12345",
// "919849012345" and "9849012345" all count as the same person.
const phoneKey = (v) => {
  const d = String(v || "").replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
};
// Finds an existing service call with the same phone (optionally ignoring one id)
async function findByPhone(phone, excludeId = null) {
  const key = phoneKey(phone);
  if (key.length < 10) return null;
  // narrow down in SQL with the last 4 digits, then compare exactly in JS
  const [rows] = await pool.query(
    // follow-up dates as plain YYYY-MM-DD text (no timezone day-shift)
    `SELECT s.*, DATE_FORMAT(s.followup1_date, '%Y-%m-%d') AS followup1_date,
       DATE_FORMAT(s.followup2_date, '%Y-%m-%d') AS followup2_date, DATE_FORMAT(s.followup3_date, '%Y-%m-%d') AS followup3_date,
       u.name AS created_by_name FROM service_calls s
     LEFT JOIN users u ON u.id = s.created_by
     WHERE s.phone LIKE ? ORDER BY s.created_at DESC`,
    [`%${key.slice(-4)}%`]
  );
  return rows.find((r) => phoneKey(r.phone) === key && String(r.id) !== String(excludeId)) || null;
}

// ADDED: GET /api/service-calls/lookup?phone=...  -> { found, call }
// Used by the Add form: when a number already exists, its details are loaded.
router.get("/lookup", async (req, res) => {
  try {
    const existing = await findByPhone(req.query.phone, req.query.exclude || null);
    res.json({ found: Boolean(existing), call: existing });
  } catch (err) {
    console.error("Service call lookup error:", err);
    res.status(500).json({ error: "Failed to check phone number" });
  }
});

// ADDED: Interior Designer details (sent by the form only when the category is
// "Interior Designer"). Saved in a separate UPDATE after the normal insert /
// update, so the existing save logic is not changed at all.
const EXP_RANGES = ["0-1", "1-2", "2-3", "3-4", "4+"];
const designerDate = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);
async function saveDesignerDetails(id, b) {
  if (!b || !("exp_range" in b || "company_name" in b || "followup1_date" in b)) return; // nothing sent
  // ADDED: Interior Designers only - other categories never get these details
  if (String(b.category || "").trim() !== "Interior Designer") return;
  const t = (v, max) => String(v || "").trim().slice(0, max);
  await pool.query(
    `UPDATE service_calls SET exp_range = ?, interview_attended = ?, current_location = ?, company_name = ?,
       designation = ?, salary = ?, followup1_date = ?, followup1_remark = ?, followup2_date = ?,
       followup2_remark = ?, followup3_date = ?, followup3_remark = ? WHERE id = ?`,
    [
      EXP_RANGES.includes(b.exp_range) ? b.exp_range : "",
      ["Yes", "No"].includes(b.interview_attended) ? b.interview_attended : "",
      t(b.current_location, 200), t(b.company_name, 200), t(b.designation, 150), t(b.salary, 50),
      designerDate(b.followup1_date), t(b.followup1_remark, 5000),
      designerDate(b.followup2_date), t(b.followup2_remark, 5000),
      designerDate(b.followup3_date), t(b.followup3_remark, 5000),
      id,
    ]
  );
}

// ADDED: 3 follow-ups (date + remark) for EVERY other category.
// Interior Designers keep saving them through saveDesignerDetails (unchanged).
async function saveFollowups(id, b) {
  if (!b || !("followup1_date" in b || "followup1_remark" in b)) return; // nothing sent
  if (String(b.category || "").trim() === "Interior Designer") return; // done above
  const t = (v, max) => String(v || "").trim().slice(0, max);
  await pool.query(
    `UPDATE service_calls SET followup1_date = ?, followup1_remark = ?, followup2_date = ?,
       followup2_remark = ?, followup3_date = ?, followup3_remark = ? WHERE id = ?`,
    [
      designerDate(b.followup1_date), t(b.followup1_remark, 5000),
      designerDate(b.followup2_date), t(b.followup2_remark, 5000),
      designerDate(b.followup3_date), t(b.followup3_remark, 5000),
      id,
    ]
  );
}

// GET /api/service-calls  - list with search + category filter + pagination
// ADDED: GET /api/service-calls/categories -> { builtin: [...], custom: [{ id, name }] }
router.get("/categories", async (req, res) => {
  res.json({ builtin: SERVICE_CATEGORIES, custom: await customCategories() });
});

// ADDED: POST /api/service-calls/categories { name }  - add a new category (any logged-in user)
router.post("/categories", async (req, res) => {
  try {
    const name = String(req.body.name || "").replace(/\s+/g, " ").trim();
    if (!name) return res.status(400).json({ error: "Please enter the category name" });
    if (name.length > 60) return res.status(400).json({ error: "Category name is too long (max 60 letters)" });
    const same = (await allCategories()).find((c) => c.toLowerCase() === name.toLowerCase());
    if (same) return res.status(409).json({ error: `"${same}" is already in the list`, name: same });
    const [r] = await pool.query("INSERT INTO service_call_categories (name, created_by) VALUES (?, ?)", [name, req.user.id]);
    res.status(201).json({ id: r.insertId, name, message: `Category "${name}" added` });
  } catch (err) {
    console.error("Service call category add error:", err);
    res.status(500).json({ error: "Failed to add category" });
  }
});

// ADDED: DELETE /api/service-calls/categories/:id  - admin only. Removes it from
// the dropdown; service calls already saved with it keep their category text.
router.delete("/categories/:id", adminOnly, async (req, res) => {
  try {
    const [r] = await pool.query("DELETE FROM service_call_categories WHERE id = ?", [req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: "Category not found" });
    res.json({ message: "Category removed from the list" });
  } catch (err) {
    console.error("Service call category delete error:", err);
    res.status(500).json({ error: "Failed to remove category" });
  }
});

router.get("/", async (req, res) => {
  try {
    // ORIGINAL: const { search = "", category = "", page = 1, limit = 50 } = req.query;
    // UPDATED: + location and experience filters
    // ADDED: + assigned filter ("" = all, "none" = not assigned, "me" = mine, or a telecaller id)
    // ORIGINAL (full line): const { search = "", category = "", location = "", experience = "", page = 1, limit = 50 } = req.query;
    const { search = "", category = "", location = "", experience = "", assigned = "", page = 1, limit = 50 } = req.query;

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
    // ADDED: location / experience filters (ignore capitals and extra spaces,
    // so "Fresher" and "fresher " are the same)
    if (location) {
      where.push("LOWER(TRIM(s.location)) = LOWER(TRIM(?))");
      params.push(location);
    }
    if (experience) {
      where.push("LOWER(TRIM(s.experience)) = LOWER(TRIM(?))");
      params.push(experience);
    }
    // ADDED: assigned-to filter
    if (assigned === "none") {
      where.push("s.assigned_to IS NULL");
    } else if (assigned === "me") {
      where.push("s.assigned_to = ?");
      params.push(req.user.id);
    } else if (assigned && /^\d+$/.test(String(assigned))) {
      where.push("s.assigned_to = ?");
      params.push(Number(assigned));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const lim = Math.min(Number(limit) || 50, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM service_calls s ${whereSql}`, params
    );
    const [rows] = await pool.query(
      // ORIGINAL: `SELECT s.*, u.name AS created_by_name
      // FIXED: follow-up dates as plain YYYY-MM-DD text (they showed 1 day early in India time)
      `SELECT s.*, DATE_FORMAT(s.followup1_date, '%Y-%m-%d') AS followup1_date,
         DATE_FORMAT(s.followup2_date, '%Y-%m-%d') AS followup2_date, DATE_FORMAT(s.followup3_date, '%Y-%m-%d') AS followup3_date,
         u.name AS created_by_name,
         -- ADDED: assigned telecaller name + date
         au.name AS assigned_to_name, DATE_FORMAT(s.assigned_at, '%Y-%m-%d') AS assigned_on
       FROM service_calls s LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN users au ON au.id = s.assigned_to
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

// ADDED: GET /api/service-calls/stats  - count of service calls per category
// (whole table, not paginated) for the category cards on the Service Calls page.
// Returns every category in SERVICE_CATEGORIES (0 if none), plus any custom
// categories that came in from Excel imports, plus "Uncategorized" for blanks.
// ADDED: GET /api/service-calls/filter-options -> { locations: [...], experiences: [...] }
// The values already saved, for the Location / Experience filter dropdowns.
// Same word with different capitals is listed once.
router.get("/filter-options", async (req, res) => {
  try {
    const distinct = async (col) => {
      const [rows] = await pool.query(
        `SELECT TRIM(${col}) AS v, COUNT(*) AS c FROM service_calls
         WHERE ${col} IS NOT NULL AND TRIM(${col}) <> '' GROUP BY TRIM(${col})`
      );
      const byKey = new Map();
      rows.forEach((r) => {
        const key = String(r.v).toLowerCase();
        const cur = byKey.get(key);
        // keep the spelling used most often
        if (!cur || Number(r.c) > cur.c) byKey.set(key, { v: r.v, c: Number(r.c) + (cur ? cur.c : 0) });
        else cur.c += Number(r.c);
      });
      return [...byKey.values()].map((x) => x.v).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    };
    res.json({ locations: await distinct("location"), experiences: await distinct("experience") });
  } catch (err) {
    console.error("Service call filter options error:", err);
    res.status(500).json({ error: "Failed to load filter options" });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS category, COUNT(*) AS count
       FROM service_calls
       GROUP BY COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized')`
    );
    const map = new Map();
    SERVICE_CATEGORIES.forEach((c) => map.set(c, 0));
    // ADDED: categories added from the app also get a card (0 if none yet)
    (await customCategories()).forEach((c) => { if (!map.has(c.name)) map.set(c.name, 0); });
    let total = 0;
    rows.forEach((r) => {
      const n = Number(r.count) || 0;
      total += n;
      map.set(r.category, (map.get(r.category) || 0) + n);
    });
    const categories = [...map.entries()].map(([category, count]) => ({ category, count }));
    res.json({ total, categories });
  } catch (err) {
    console.error("Service calls stats error:", err);
    res.status(500).json({ error: "Failed to load service call stats" });
  }
});

// ADDED: PUT /api/service-calls/assign  { ids: [..], telecaller_id }  - ADMIN ONLY
// Assigns one or many service calls to a telecaller. telecaller_id = null/"" -> unassign.
router.put("/assign", adminOnly, async (req, res) => {
  try {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id])
      .map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return res.status(400).json({ error: "Select at least one service call" });
    const raw = req.body.telecaller_id;
    let tcId = null, tcName = "";
    if (raw !== null && raw !== undefined && raw !== "") {
      const [u] = await pool.query("SELECT id, name, role FROM users WHERE id = ?", [Number(raw)]);
      if (!u.length) return res.status(400).json({ error: "Telecaller not found" });
      if (u[0].role !== "telecaller") return res.status(400).json({ error: "Service calls can be assigned to telecallers only" });
      tcId = u[0].id; tcName = u[0].name;
    }
    const [r] = await pool.query(
      `UPDATE service_calls SET assigned_to = ?, assigned_at = ${tcId ? "NOW()" : "NULL"}, assigned_by = ? WHERE id IN (?)`,
      [tcId, tcId ? req.user.id : null, ids]
    );
    const n = r.affectedRows;
    res.json({
      updated: n,
      message: tcId
        ? `${n} service call${n === 1 ? "" : "s"} assigned to ${tcName}`
        : `${n} service call${n === 1 ? "" : "s"} unassigned`,
    });
  } catch (err) {
    console.error("Service call assign error:", err);
    res.status(500).json({ error: "Failed to assign service call" });
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
    // ORIGINAL: if (category && !SERVICE_CATEGORIES.includes(category)) {
    // UPDATED: also accepts categories added from the app
    if (category && !(await allCategories()).includes(category)) {
      return res.status(400).json({ error: "Invalid category" });
    }
    // ADDED: no duplicates - the same phone number cannot be added twice
    const dup = await findByPhone(phone);
    if (dup) {
      return res.status(409).json({
        error: `This phone number is already saved for ${dup.name}${dup.category ? ` (${dup.category})` : ""}. Open that record instead of adding it again.`,
        existing: dup,
      });
    }

    // ORIGINAL: INSERT (name, phone, category, location, remarks, created_by)
    // ADDED: also stores city + experience (both default '' in the DB)
    const [result] = await pool.query(
      `INSERT INTO service_calls (name, phone, category, location, remarks, city, experience, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(name).trim(), String(phone).trim(), category || "", String(location).trim(), String(remarks).trim(), String(city).trim(), String(experience).trim(), req.user.id]
    );

    // ADDED: Interior Designer details (only when the form sent them)
    await saveDesignerDetails(result.insertId, req.body);
    // ADDED: follow-ups for all other categories
    await saveFollowups(result.insertId, req.body);
    await saveAddress("service_calls", result.insertId, req.body); // ADDED: state

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
    // ORIGINAL: if (category && !SERVICE_CATEGORIES.includes(category)) {
    // UPDATED: also accepts categories added from the app
    if (category && !(await allCategories()).includes(category)) {
      return res.status(400).json({ error: "Invalid category" });
    }
    // ADDED: no duplicates - can't change a number to one another record already has
    const dup = await findByPhone(phone, req.params.id);
    if (dup) {
      return res.status(409).json({
        error: `This phone number is already saved for ${dup.name}${dup.category ? ` (${dup.category})` : ""}. Use a different number.`,
        existing: dup,
      });
    }

    // ORIGINAL: UPDATE ... SET name, phone, category, location, remarks
    // ADDED: also updates city + experience
    const [result] = await pool.query(
      `UPDATE service_calls SET name = ?, phone = ?, category = ?, location = ?, remarks = ?, city = ?, experience = ?
       WHERE id = ?`,
      [String(name).trim(), String(phone).trim(), category || "", String(location).trim(), String(remarks).trim(), String(city).trim(), String(experience).trim(), req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Service call not found" });
    // ADDED: Interior Designer details (only when the form sent them)
    await saveDesignerDetails(req.params.id, req.body);
    // ADDED: follow-ups for all other categories
    await saveFollowups(req.params.id, req.body);
    await saveAddress("service_calls", req.params.id, req.body); // ADDED: state

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
    // ORIGINAL: const existingPhones = new Set(existingRows.map((r) => String(r.phone).replace(/\D/g, "")));
    // UPDATED: compare by the last 10 digits (same rule as the Add form), so
    // "+91 98490 12345" and "9849012345" are treated as the same number
    const existingPhones = new Set(existingRows.map((r) => phoneKey(r.phone)));

    let inserted = 0, skipped = 0, duplicates = 0, invalidPhone = 0;
    // ADDED: built-in + added categories (loaded once for the whole sheet)
    const importCats = await allCategories();

    for (const b of rows) {
      const name = String(b.name || "").trim();
      const digitsOnly = String(b.phone || "").replace(/\D/g, "");

      // require a name and a phone
      if (!name || !digitsOnly) { skipped++; continue; }
      // validate phone length (10-15 digits); phone column is VARCHAR(20)
      if (digitsOnly.length < 10 || digitsOnly.length > 15) { invalidPhone++; continue; }
      // reject duplicates (already in DB or repeated within this batch)
      // ORIGINAL: if (existingPhones.has(digitsOnly)) { duplicates++; continue; }
      // ORIGINAL: existingPhones.add(digitsOnly);
      if (existingPhones.has(phoneKey(digitsOnly))) { duplicates++; continue; }
      existingPhones.add(phoneKey(digitsOnly));

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
      // UPDATED: also matches categories added from the app
      // ORIGINAL: const canonical = SERVICE_CATEGORIES.find(
      const canonical = importCats.find(
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

// ADDED: CV upload / view / remove for a service call (Interior Designers).
// The file is sent as-is (not JSON), max 5 MB: PDF, Word or image.
const CV_TYPES = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/jpeg": "jpg",
  "image/png": "png",
};
const CV_MAX = 5 * 1024 * 1024;

// POST /api/service-calls/:id/cv   body = the file, header X-File-Name = file name
router.post("/:id/cv", express.raw({ type: () => true, limit: "6mb" }), async (req, res) => {
  try {
    const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!CV_TYPES[mime]) return res.status(400).json({ error: "CV must be a PDF, Word document, JPG or PNG" });
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length === 0) return res.status(400).json({ error: "No file received" });
    if (data.length > CV_MAX) return res.status(400).json({ error: "CV is too big - maximum 5 MB" });
    let name = "CV";
    try { name = decodeURIComponent(String(req.headers["x-file-name"] || "CV")); } catch { /* keep default */ }
    name = name.replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "CV";

    // UPDATED: also reads the category - CVs are for Interior Designers only
    const [[call]] = await pool.query("SELECT id, category FROM service_calls WHERE id = ?", [req.params.id]);
    if (!call) return res.status(404).json({ error: "Service call not found" });
    if (String(call.category || "").trim() !== "Interior Designer") {
      return res.status(400).json({ error: "CV can be attached only for Interior Designers" });
    }

    await pool.query(
      `INSERT INTO service_call_cvs (service_call_id, file_name, mime_type, size_bytes, data, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE file_name = VALUES(file_name), mime_type = VALUES(mime_type),
         size_bytes = VALUES(size_bytes), data = VALUES(data), uploaded_by = VALUES(uploaded_by),
         uploaded_at = CURRENT_TIMESTAMP`,
      [req.params.id, name, mime, data.length, data, req.user.id]
    );
    await pool.query("UPDATE service_calls SET cv_name = ? WHERE id = ?", [name, req.params.id]);
    res.json({ message: "CV uploaded", cv_name: name });
  } catch (err) {
    if (err && err.type === "entity.too.large") return res.status(400).json({ error: "CV is too big - maximum 5 MB" });
    console.error("CV upload error:", err);
    res.status(500).json({ error: "Failed to upload CV" });
  }
});

// GET /api/service-calls/:id/cv  -> the file (opened by the "View CV" button)
router.get("/:id/cv", async (req, res) => {
  try {
    const [[cv]] = await pool.query(
      "SELECT file_name, mime_type, data FROM service_call_cvs WHERE service_call_id = ?", [req.params.id]
    );
    if (!cv) return res.status(404).json({ error: "No CV uploaded" });
    res.setHeader("Content-Type", cv.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(cv.file_name)}"`);
    res.send(cv.data);
  } catch (err) {
    console.error("CV download error:", err);
    res.status(500).json({ error: "Failed to load CV" });
  }
});

// DELETE /api/service-calls/:id/cv  -> remove the CV
router.delete("/:id/cv", async (req, res) => {
  try {
    await pool.query("DELETE FROM service_call_cvs WHERE service_call_id = ?", [req.params.id]);
    await pool.query("UPDATE service_calls SET cv_name = '' WHERE id = ?", [req.params.id]);
    res.json({ message: "CV removed" });
  } catch (err) {
    console.error("CV remove error:", err);
    res.status(500).json({ error: "Failed to remove CV" });
  }
});

module.exports = router;
module.exports.SERVICE_CATEGORIES = SERVICE_CATEGORIES;
