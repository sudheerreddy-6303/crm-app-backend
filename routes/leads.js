const express = require("express");
const { pool } = require("../db");
const { auth, adminOnly } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

const CALL_CATEGORIES = ["", "NOT INTERESTED", "FOLLOW UP", "INTERESTED", "NOT ANSWERED"];
const YES_NO = ["", "Yes", "No"];
const PRIORITIES = ["none", "hot", "warm", "cold"];

const clean = (v, allowed, fallback = "") => (allowed.includes(v) ? v : fallback);
const dateOrNull = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);

// GET /api/leads  (admin: all; telecaller: only assigned) with filters + pagination
router.get("/", async (req, res) => {
  try {
    const { search = "", category = "", assigned = "", quote = "", order = "", priority = "",
            due = "", page = 1, limit = 50 } = req.query;

    const where = [];
    const params = [];

    if (req.user.role !== "admin") {
      where.push("l.assigned_to = ?");
      params.push(req.user.id);
    } else if (assigned) {
      if (assigned === "unassigned") where.push("l.assigned_to IS NULL");
      else { where.push("l.assigned_to = ?"); params.push(assigned); }
    }
    if (search) {
      where.push("(l.name LIKE ? OR l.primary_phone LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    // ORIGINAL: if (category) { where.push("l.call_category = ?"); params.push(category); }
    // EXTENDED: 'FRESH' means leads not yet called (empty category), used by the
    // clickable dashboard cards. Normal categories behave exactly as before.
    if (category) {
      if (category === "FRESH") where.push("(l.call_category = '' OR l.call_category IS NULL)");
      else { where.push("l.call_category = ?"); params.push(category); }
    }
    if (quote) { where.push("l.quote_sent = ?"); params.push(quote); }
    if (order) { where.push("l.order_booked = ?"); params.push(order); }
    if (priority) { where.push("l.priority = ?"); params.push(priority); }
    // ADDED: due=today filter for the "Calls due today" dashboard card
    if (due === "today") where.push("l.next_call_date = CURDATE()");

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const lim = Math.min(Number(limit) || 50, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM leads l ${whereSql}`, params
    );
    const [rows] = await pool.query(
      `SELECT l.*, u.name AS caller_name
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
       ${whereSql}
       ORDER BY l.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );
    res.json({ leads: rows, total: countRows[0].total, page: Number(page), limit: lim });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/leads/:id  (telecaller: only own lead)
router.get("/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT l.*, u.name AS caller_name FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to WHERE l.id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Lead not found" });
    const lead = rows[0];
    if (req.user.role !== "admin" && lead.assigned_to !== req.user.id) {
      return res.status(403).json({ error: "This lead is not assigned to you" });
    }
    res.json(lead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/leads  (admin only)
router.post("/", adminOnly, async (req, res) => {
  try {
    const b = req.body;
    if (!b.name || !b.primary_phone) {
      return res.status(400).json({ error: "Name and primary phone are required" });
    }
    const [result] = await pool.query(
      `INSERT INTO leads
       (name, primary_phone, assigned_to, first_calling_date, second_calling_date,
        call_category, quote_sent, order_booked, whatsapp_sent_date, whatsapp_category,
        calling_remark, next_call_date, priority, source, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.name, b.primary_phone, b.assigned_to || null,
        dateOrNull(b.first_calling_date), dateOrNull(b.second_calling_date),
        clean(b.call_category, CALL_CATEGORIES), clean(b.quote_sent, YES_NO),
        clean(b.order_booked, YES_NO), dateOrNull(b.whatsapp_sent_date),
        b.whatsapp_category || "", b.calling_remark || "",
        dateOrNull(b.next_call_date), clean(b.priority, PRIORITIES, "none"),
        b.source || "", req.user.id,
      ]
    );
    res.status(201).json({ id: result.insertId, message: "Lead created" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/leads/:id
// Admin: can update everything. Telecaller: only call-related fields on own leads.
router.put("/:id", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM leads WHERE id = ?", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Lead not found" });
    const lead = rows[0];

    const isAdmin = req.user.role === "admin";
    if (!isAdmin && lead.assigned_to !== req.user.id) {
      return res.status(403).json({ error: "This lead is not assigned to you" });
    }

    const b = req.body;
    const fields = [];
    const values = [];

    // Fields any role (admin + assigned telecaller) can update
    const push = (col, val) => { fields.push(`${col} = ?`); values.push(val); };
    if ("first_calling_date" in b) push("first_calling_date", dateOrNull(b.first_calling_date));
    if ("second_calling_date" in b) push("second_calling_date", dateOrNull(b.second_calling_date));
    if ("call_category" in b) push("call_category", clean(b.call_category, CALL_CATEGORIES));
    if ("quote_sent" in b) push("quote_sent", clean(b.quote_sent, YES_NO));
    if ("order_booked" in b) push("order_booked", clean(b.order_booked, YES_NO));
    if ("whatsapp_sent_date" in b) push("whatsapp_sent_date", dateOrNull(b.whatsapp_sent_date));
    if ("whatsapp_category" in b) push("whatsapp_category", b.whatsapp_category || "");
    if ("calling_remark" in b) push("calling_remark", b.calling_remark || "");
    if ("next_call_date" in b) push("next_call_date", dateOrNull(b.next_call_date));
    if ("priority" in b) push("priority", clean(b.priority, PRIORITIES, "none"));

    // Admin-only fields
    if (isAdmin) {
      if ("name" in b && b.name) push("name", b.name);
      if ("primary_phone" in b && b.primary_phone) push("primary_phone", b.primary_phone);
      if ("assigned_to" in b) push("assigned_to", b.assigned_to || null);
      if ("source" in b) push("source", b.source || "");
    }

    if (fields.length === 0) return res.status(400).json({ error: "Nothing to update" });

    values.push(req.params.id);
    await pool.query(`UPDATE leads SET ${fields.join(", ")} WHERE id = ?`, values);

    // ORIGINAL CODE (only logged when the remark changed, so category-only
    // updates were not counted as calls):
    // if ("calling_remark" in b && b.calling_remark && b.calling_remark !== lead.calling_remark) {
    //   await pool.query(
    //     "INSERT INTO call_logs (lead_id, user_id, remark, category) VALUES (?, ?, ?, ?)",
    //     [req.params.id, req.user.id, b.calling_remark, b.call_category || lead.call_category || ""]
    //   );
    // }
    // FIXED: log a call whenever the remark OR the call category changes,
    // so admin can see how many calls each telecaller made per day
    const remarkChanged = "calling_remark" in b && b.calling_remark && b.calling_remark !== lead.calling_remark;
    const categoryChanged = "call_category" in b && b.call_category && b.call_category !== lead.call_category;
    if (remarkChanged || categoryChanged) {
      await pool.query(
        "INSERT INTO call_logs (lead_id, user_id, remark, category) VALUES (?, ?, ?, ?)",
        [
          req.params.id,
          req.user.id,
          remarkChanged ? b.calling_remark : (lead.calling_remark || ""),
          b.call_category || lead.call_category || "",
        ]
      );
    }

    res.json({ message: "Lead updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/leads/:id (admin only)
router.delete("/:id", adminOnly, async (req, res) => {
  try {
    await pool.query("DELETE FROM leads WHERE id = ?", [req.params.id]);
    res.json({ message: "Lead deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/leads/assign  (admin bulk assign) { lead_ids: [], assigned_to: id|null }
router.post("/assign", adminOnly, async (req, res) => {
  try {
    const { lead_ids, assigned_to } = req.body;
    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res.status(400).json({ error: "lead_ids array is required" });
    }
    await pool.query(
      "UPDATE leads SET assigned_to = ? WHERE id IN (?)",
      [assigned_to || null, lead_ids]
    );
    res.json({ message: `${lead_ids.length} lead(s) updated` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/leads/import  (admin bulk import) { rows: [{name, primary_phone, ...}] }
router.post("/import", adminOnly, async (req, res) => {
  try {
    // ADDED: build a name/email -> id lookup so the Excel "Telecaller" column can
    // assign leads during import. Unknown names simply leave the lead unassigned.
    const [userRows] = await pool.query("SELECT id, name, email FROM users");
    const userLookup = {};
    for (const u of userRows) {
      if (u.name) userLookup[String(u.name).trim().toLowerCase()] = u.id;
      if (u.email) userLookup[String(u.email).trim().toLowerCase()] = u.id;
    }
    const resolveAssigned = (b) => {
      if (b.assigned_to) return b.assigned_to;
      if (b.assigned_to_name) {
        const id = userLookup[String(b.assigned_to_name).trim().toLowerCase()];
        if (id) return id;
      }
      return null;
    };
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows array is required" });
    }
    let inserted = 0, skipped = 0;
    for (const b of rows) {
      if (!b.name || !b.primary_phone) { skipped++; continue; }
      await pool.query(
        `INSERT INTO leads
         (name, primary_phone, assigned_to, first_calling_date, second_calling_date,
          call_category, quote_sent, order_booked, whatsapp_sent_date, whatsapp_category,
          calling_remark, next_call_date, priority, source, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          b.name, String(b.primary_phone),
          // ORIGINAL: b.assigned_to || null,
          // ADDED: also accepts a telecaller name/email from the "Telecaller" column
          resolveAssigned(b),
          dateOrNull(b.first_calling_date), dateOrNull(b.second_calling_date),
          clean((b.call_category || "").toUpperCase(), CALL_CATEGORIES),
          clean(b.quote_sent, YES_NO), clean(b.order_booked, YES_NO),
          dateOrNull(b.whatsapp_sent_date), b.whatsapp_category || "",
          b.calling_remark || "", dateOrNull(b.next_call_date),
          clean(b.priority, PRIORITIES, "none"), b.source || "Import", req.user.id,
        ]
      );
      inserted++;
    }
    res.json({ message: `Imported ${inserted} lead(s), skipped ${skipped}` , inserted, skipped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/leads/:id/logs
router.get("/:id/logs", async (req, res) => {
  try {
    const [leadRows] = await pool.query("SELECT assigned_to FROM leads WHERE id = ?", [req.params.id]);
    if (leadRows.length === 0) return res.status(404).json({ error: "Lead not found" });
    if (req.user.role !== "admin" && leadRows[0].assigned_to !== req.user.id) {
      return res.status(403).json({ error: "This lead is not assigned to you" });
    }
    const [rows] = await pool.query(
      `SELECT c.*, u.name AS user_name FROM call_logs c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.lead_id = ? ORDER BY c.log_date DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
