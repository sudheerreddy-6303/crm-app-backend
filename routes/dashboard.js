const express = require("express");
const { pool } = require("../db");
const { auth } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// GET /api/dashboard  (admin: all data + per-telecaller; telecaller: own stats)
// ADDED: optional calendar filter ?from=YYYY-MM-DD&to=YYYY-MM-DD - when given,
// all totals, telecaller performance, and follow-ups reflect only that period.
router.get("/", async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";

    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
    const from = isDate(req.query.from) ? req.query.from : null;
    const to = isDate(req.query.to) ? req.query.to : null;
    const rangeActive = Boolean(from || to);
    const lo = from || "1000-01-01";
    const hi = to || "9999-12-31";
    // A lead is "in range" if any activity date falls within from..to
    const rangeSql = `(DATE(l.updated_at) BETWEEN ? AND ?
                       OR l.first_calling_date BETWEEN ? AND ?
                       OR l.second_calling_date BETWEEN ? AND ?)`;
    const rangeParams = [lo, hi, lo, hi, lo, hi];

    // ORIGINAL: const scope = isAdmin ? "" : "WHERE assigned_to = ?";
    // EXTENDED with the optional range condition
    const conds = [];
    const params = [];
    if (!isAdmin) { conds.push("l.assigned_to = ?"); params.push(req.user.id); }
    if (rangeActive) { conds.push(rangeSql); params.push(...rangeParams); }
    const scope = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const [totals] = await pool.query(
      `SELECT
         COUNT(*) AS total_leads,
         SUM(call_category = 'INTERESTED') AS interested,
         SUM(call_category = 'FOLLOW UP') AS follow_up,
         SUM(call_category = 'NOT INTERESTED') AS not_interested,
         SUM(call_category = 'NOT ANSWERED') AS not_answered,
         SUM(call_category = '' OR call_category IS NULL) AS fresh,
         SUM(quote_sent = 'Yes') AS quotes_sent,
         SUM(order_booked = 'Yes') AS orders_booked,
         SUM(next_call_date = CURDATE()) AS due_today
       FROM leads l ${scope}`,
      params
    );

    let performance = [];
    let unassigned = 0;
    if (isAdmin) {
      // ORIGINAL: joined all leads. Now the same range applies inside the JOIN,
      // so per-telecaller numbers match the selected period.
      const joinCond = rangeActive ? `l.assigned_to = u.id AND ${rangeSql}` : "l.assigned_to = u.id";
      const [perf] = await pool.query(
        `SELECT u.id, u.name, u.status,
           COUNT(l.id) AS total_leads,
           SUM(l.call_category = 'INTERESTED') AS interested,
           SUM(l.call_category = 'FOLLOW UP') AS follow_up,
           SUM(l.call_category = 'NOT INTERESTED') AS not_interested,
           SUM(l.call_category = 'NOT ANSWERED') AS not_answered,
           SUM(l.quote_sent = 'Yes') AS quotes_sent,
           SUM(l.order_booked = 'Yes') AS orders_booked
         FROM users u
         LEFT JOIN leads l ON ${joinCond}
         WHERE u.role = 'telecaller'
         GROUP BY u.id ORDER BY orders_booked DESC, interested DESC`,
        rangeActive ? rangeParams : []
      );
      performance = perf;
      const unConds = ["l.assigned_to IS NULL"];
      const unParams = [];
      if (rangeActive) { unConds.push(rangeSql); unParams.push(...rangeParams); }
      const [[un]] = await pool.query(
        `SELECT COUNT(*) AS c FROM leads l WHERE ${unConds.join(" AND ")}`, unParams
      );
      unassigned = un.c;
    }

    // Follow-ups: ORIGINAL always showed the next 3 days. With a range selected,
    // shows follow-ups whose next call date falls inside the range instead.
    const fuConds = [];
    const fuParams = [];
    if (!isAdmin) { fuConds.push("l.assigned_to = ?"); fuParams.push(req.user.id); }
    if (rangeActive) {
      fuConds.push("l.next_call_date BETWEEN ? AND ?");
      fuParams.push(lo, hi);
    } else {
      fuConds.push("l.next_call_date IS NOT NULL AND l.next_call_date <= DATE_ADD(CURDATE(), INTERVAL 3 DAY)");
    }
    const [followups] = await pool.query(
      `SELECT l.id, l.name, l.primary_phone, l.next_call_date, l.call_category, u.name AS caller_name
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
       WHERE ${fuConds.join(" AND ")}
       ORDER BY l.next_call_date ASC LIMIT 15`,
      fuParams
    );

    res.json({ totals: totals[0], performance, unassigned, followups });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
