const express = require("express");
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { auth, adminOnly } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// GET /api/users  (admin: all; telecaller: only active telecaller names for display)
router.get("/", async (req, res) => {
  try {
    if (req.user.role === "admin") {
      const [rows] = await pool.query(
        `SELECT u.id, u.name, u.email, u.phone, u.role, u.status, u.created_at,
                (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id) AS lead_count
         FROM users u ORDER BY u.role, u.name`
      );
      return res.json(rows);
    }
    const [rows] = await pool.query(
      "SELECT id, name FROM users WHERE status='active' ORDER BY name"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/users  (admin creates a telecaller or another admin)
router.post("/", adminOnly, async (req, res) => {
  try {
    const { name, email, phone = "", password, role = "telecaller" } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email and password are required" });
    }
    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "INSERT INTO users (name, email, phone, password, role) VALUES (?, ?, ?, ?, ?)",
      [name, email, phone, hash, role === "admin" ? "admin" : "telecaller"]
    );
    res.status(201).json({ id: result.insertId, message: "User created" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Email already exists" });
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/users/:id  (admin updates user; password optional)
router.put("/:id", adminOnly, async (req, res) => {
  try {
    const { name, email, phone = "", role, status, password } = req.body;
    const fields = [];
    const values = [];
    if (name) { fields.push("name = ?"); values.push(name); }
    if (email) { fields.push("email = ?"); values.push(email); }
    fields.push("phone = ?"); values.push(phone);
    if (role) { fields.push("role = ?"); values.push(role === "admin" ? "admin" : "telecaller"); }
    if (status) { fields.push("status = ?"); values.push(status === "inactive" ? "inactive" : "active"); }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      fields.push("password = ?"); values.push(hash);
    }
    values.push(req.params.id);
    await pool.query(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, values);
    res.json({ message: "User updated" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Email already exists" });
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/users/:id  (admin; cannot delete self)
router.delete("/:id", adminOnly, async (req, res) => {
  try {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: "You cannot delete your own account" });
    }
    await pool.query("DELETE FROM users WHERE id = ?", [req.params.id]);
    res.json({ message: "User deleted. Their leads are now unassigned." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/users/:id/activity  (admin: telecaller detail - daily call counts + all their leads)
router.get("/:id/activity", adminOnly, async (req, res) => {
  try {
    // ADDED: optional calendar filter ?from=YYYY-MM-DD&to=YYYY-MM-DD
    // Filters the calls-per-day table and the leads list to that date range.
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
    const from = isDate(req.query.from) ? req.query.from : null;
    const to = isDate(req.query.to) ? req.query.to : null;

    const [userRows] = await pool.query(
      "SELECT id, name, email, phone, role, status, created_at FROM users WHERE id = ?",
      [req.params.id]
    );
    if (userRows.length === 0) return res.status(404).json({ error: "User not found" });

    // Calls per day from the call log
    // ORIGINAL: fixed last-30-days window. Now uses the calendar range when given.
    const logConds = ["user_id = ?"];
    const logParams = [req.params.id];
    if (from) { logConds.push("DATE(log_date) >= ?"); logParams.push(from); }
    if (to) { logConds.push("DATE(log_date) <= ?"); logParams.push(to); }
    if (!from && !to) logConds.push("log_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)");
    const [daily] = await pool.query(
      `SELECT DATE(log_date) AS day, COUNT(*) AS calls,
              SUM(category = 'INTERESTED') AS interested,
              SUM(category = 'FOLLOW UP') AS follow_up,
              SUM(category = 'NOT INTERESTED') AS not_interested,
              SUM(category = 'NOT ANSWERED') AS not_answered
       FROM call_logs
       WHERE ${logConds.join(" AND ")}
       GROUP BY DATE(log_date)
       ORDER BY day DESC`,
      logParams
    );

    const [[todayRow]] = await pool.query(
      "SELECT COUNT(*) AS calls_today FROM call_logs WHERE user_id = ? AND DATE(log_date) = CURDATE()",
      [req.params.id]
    );

    // Lead totals for this telecaller
    // ORIGINAL: totals were always all-time. Now the same calendar range applies,
    // so the cards (Interested, Quotes sent, etc.) change with the selected dates.
    const leadConds = ["assigned_to = ?"];
    const leadParams = [req.params.id];
    // FIXED (tightened): a lead matches the range only if at least ONE of its
    // activity dates (last update, 1st call, 2nd call) falls WITHIN from..to.
    // The earlier version checked from and to separately with OR, which let a
    // lead match using two different dates.
    if (from || to) {
      const lo = from || "1000-01-01";
      const hi = to || "9999-12-31";
      leadConds.push(
        `(DATE(updated_at) BETWEEN ? AND ?
          OR first_calling_date BETWEEN ? AND ?
          OR second_calling_date BETWEEN ? AND ?)`
      );
      leadParams.push(lo, hi, lo, hi, lo, hi);
    }

    const [[totals]] = await pool.query(
      `SELECT COUNT(*) AS total_leads,
              SUM(call_category = 'INTERESTED') AS interested,
              SUM(call_category = 'FOLLOW UP') AS follow_up,
              SUM(call_category = 'NOT INTERESTED') AS not_interested,
              SUM(call_category = 'NOT ANSWERED') AS not_answered,
              SUM(quote_sent = 'Yes') AS quotes_sent,
              SUM(order_booked = 'Yes') AS orders_booked
       FROM leads WHERE ${leadConds.join(" AND ")}`,
      leadParams
    );

    // All leads assigned to this telecaller
    // Uses the same leadConds/leadParams built above, so the list always
    // matches the card numbers for the selected range.
    const [leads] = await pool.query(
      `SELECT id, name, primary_phone, first_calling_date, second_calling_date,
              call_category, quote_sent, order_booked, whatsapp_sent_date,
              whatsapp_category, calling_remark, next_call_date, priority, updated_at
       FROM leads WHERE ${leadConds.join(" AND ")} ORDER BY updated_at DESC`,
      leadParams
    );

    res.json({ user: userRows[0], daily, calls_today: todayRow.calls_today, totals, leads });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
