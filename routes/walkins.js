// ADDED: Walk-ins module - list / create / update / delete walk-in records.
// Follows the same conventions as routes/serviceCalls.js (auth on all routes,
// pool queries, search + purpose filter, pagination).
const express = require("express");
const { pool } = require("../db");
// ADDED: State / City / Location from the forms
const { saveAddress } = require("../utils/saveAddress");
const { auth, adminOnly } = require("../middleware/auth");

const router = express.Router();
// ORIGINAL lines (before they were updated) - kept word for word for reference:
//   `SELECT w.*, ${WL_DATE_SQL("w")}, (SELECT au.name FROM users au WHERE au.id = w.assigned_to) AS assigned_to_name, u.name AS created_by_name
router.use(auth);

// ADDED: walk-in form has the same fields as the Add lead form. Saved with a
// separate small UPDATE after the normal save (original statements unchanged).
const WL_CATEGORIES = ["", "NOT INTERESTED", "FOLLOW UP", "INTERESTED", "NOT ANSWERED"];
const WL_YES_NO = ["", "Yes", "No"];
const WL_PRIORITIES = ["none", "hot", "warm", "cold", "dead"];
const WL_PROJECT_TYPES = ["", "2BHK", "3BHK", "4BHK", "Villa", "Commercial", "Others"];
const WL_DATE_COLS = ["first_calling_date", "second_calling_date", "third_calling_date", "whatsapp_sent_date",
  "next_call_date", "whatsapp_date_1", "whatsapp_date_2", "whatsapp_date_3"];
const wlDate = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);
const wlPick = (v, list, fb = "") => (list.includes(v) ? v : fb);
const wlAmount = (v) => {
  if (v === undefined || v === null || String(v).trim() === "" || /-/.test(String(v))) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};
// dates as plain YYYY-MM-DD text in every SELECT (no India-time day shift)
const WL_DATE_SQL = (a) => WL_DATE_COLS.map((c) => `DATE_FORMAT(${a}.${c}, '%Y-%m-%d') AS ${c}`).join(", ");
async function saveLeadFields(id, b, isAdmin) {
  if (!id || !b) return;
  const sets = [];
  const vals = [];
  const put = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };
  if ("project_type" in b) put("project_type", wlPick(b.project_type, WL_PROJECT_TYPES));
  // only admin assigns a telecaller (same as the lead form)
  if (isAdmin && "assigned_to" in b) put("assigned_to", b.assigned_to ? Number(b.assigned_to) || null : null);
  WL_DATE_COLS.forEach((c) => { if (c in b) put(c, wlDate(b[c])); });
  if ("call_category" in b) put("call_category", wlPick(String(b.call_category || "").toUpperCase(), WL_CATEGORIES));
  if ("quote_sent" in b) put("quote_sent", wlPick(b.quote_sent, WL_YES_NO));
  if ("order_booked" in b) put("order_booked", wlPick(b.order_booked, WL_YES_NO));
  if ("revenue_booked" in b) put("revenue_booked", wlAmount(b.revenue_booked));
  if ("whatsapp_category" in b) put("whatsapp_category", String(b.whatsapp_category || "").trim().slice(0, 100));
  if ("priority" in b) put("priority", wlPick(String(b.priority || "").toLowerCase(), WL_PRIORITIES, "none"));
  if ("source" in b) put("source", String(b.source || "").trim().slice(0, 100));
  ["calling_remark", "call_remark_1", "call_remark_2", "call_remark_3"].forEach((c) => {
    if (c in b) put(c, String(b[c] || "").trim().slice(0, 5000));
  });
  if (!sets.length) return;
  await pool.query(`UPDATE walkins SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
}

// Purpose is stored as VARCHAR (not ENUM) so you can add more purposes later
// without a DB migration. This list is validated on the server side.
const WALKIN_PURPOSES = [
  "Modular Kitchen", "Wardrobe", "Full Home Interiors", "Living Room",
  "Bedroom", "Kids Room", "Pooja Unit", "TV Unit", "Office Interiors",
  "Renovation", "Just Enquiry", "Other",
];

// GET /api/walkins  - list with search + purpose filter + pagination
// ADDED: GET /api/walkins/lookup?phone=...  -> { found, walkin, matches }
// Used by the "Add walk-in" form: when a typed phone / alternate mobile is
// already saved on a walk-in, that walk-in's details are loaded. Numbers match
// on the last 10 digits ("+91 98490 12345" = "9849012345").
const walkinPhoneKey = (v) => {
  const d = String(v || "").replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
};
router.get("/lookup", async (req, res) => {
  try {
    const key = walkinPhoneKey(req.query.phone);
    if (key.length < 10) return res.json({ found: false, walkin: null, matches: 0 });
    const like = `%${key.slice(-4)}%`;
    const [rows] = await pool.query(
      // visit_date as plain YYYY-MM-DD text so it never shifts a day with the server timezone
      // ORIGINAL: `SELECT w.*, DATE_FORMAT(w.visit_date, '%Y-%m-%d') AS visit_date FROM walkins w WHERE w.phone LIKE ? OR w.alt_phone LIKE ?
      // UPDATED: + the lead-form dates as plain text
      `SELECT w.*, DATE_FORMAT(w.visit_date, '%Y-%m-%d') AS visit_date, ${WL_DATE_SQL("w")} FROM walkins w WHERE w.phone LIKE ? OR w.alt_phone LIKE ?
       ORDER BY w.created_at DESC, w.id DESC`,
      [like, like]
    );
    const hits = rows.filter((w) => [w.phone, w.alt_phone].some((n) => walkinPhoneKey(n) === key));
    res.json({ found: hits.length > 0, walkin: hits[0] || null, matches: hits.length });
  } catch (err) {
    console.error("Walk-in lookup error:", err);
    res.status(500).json({ error: "Failed to check phone number" });
  }
});

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
      // ORIGINAL: `SELECT w.*, u.name AS created_by_name
      // UPDATED: + lead-form dates as plain text + assigned telecaller name
      // FIXED: + visit date as plain text (no day shift on India time)
      `SELECT w.*, DATE_FORMAT(w.visit_date, '%Y-%m-%d') AS visit_date, ${WL_DATE_SQL("w")}, (SELECT au.name FROM users au WHERE au.id = w.assigned_to) AS assigned_to_name, u.name AS created_by_name
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

    await saveAddress("walkins", result.insertId, req.body); // ADDED: state
    await saveLeadFields(result.insertId, req.body, req.user.role === "admin"); // ADDED: lead-form fields
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
    await saveAddress("walkins", req.params.id, req.body); // ADDED: state
    await saveLeadFields(req.params.id, req.body, req.user.role === "admin"); // ADDED: lead-form fields

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
      // ORIGINAL: "SELECT *, DATE_FORMAT(visit_date, '%Y-%m-%d') AS visit_str FROM walkins WHERE id = ?",
      // UPDATED: + the lead-form dates as plain text (copied into the lead below)
      `SELECT *, DATE_FORMAT(visit_date, '%Y-%m-%d') AS visit_str, ${WL_DATE_SQL("walkins")} FROM walkins WHERE id = ?`,
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
    // ORIGINAL: const assignedTo = isAdmin ? (req.body.assigned_to || null) : req.user.id;
    // UPDATED: admin's choice, else the telecaller already assigned on the walk-in form
    const assignedTo = isAdmin ? (req.body.assigned_to || w.assigned_to || null) : req.user.id;

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
    // ADDED: the new lead gets the walk-in's State / City / Location
    await saveAddress("leads", result.insertId, { state: w.state || "", city: w.city || "", location: w.site_location || "" });
    // ADDED: the new lead gets the walk-in's calling / sales / WhatsApp details
    // (only values that were filled in on the walk-in)
    const copy = {};
    if (w.project_type) copy.project_type = w.project_type;
    WL_DATE_COLS.forEach((c) => { if (w[c]) copy[c] = w[c]; });
    if (w.call_category) copy.call_category = w.call_category;
    if (w.quote_sent) copy.quote_sent = w.quote_sent;
    if (w.order_booked) copy.order_booked = w.order_booked;
    if (w.revenue_booked !== null && w.revenue_booked !== undefined) copy.revenue_booked = w.revenue_booked;
    if (w.whatsapp_category) copy.whatsapp_category = w.whatsapp_category;
    if (w.priority && w.priority !== "none") copy.priority = w.priority;
    if (w.source) copy.source = w.source;
    ["call_remark_1", "call_remark_2", "call_remark_3"].forEach((c) => { if (w[c]) copy[c] = w[c]; });
    const keys = Object.keys(copy);
    if (keys.length) {
      await pool.query(`UPDATE leads SET ${keys.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...keys.map((c) => copy[c]), result.insertId]);
    }
    // the walk-in's calling remark goes first in the lead's calling remark
    if (w.calling_remark) {
      await pool.query("UPDATE leads SET calling_remark = CONCAT(?, ' | ', calling_remark) WHERE id = ?", [w.calling_remark, result.insertId]);
    }

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
