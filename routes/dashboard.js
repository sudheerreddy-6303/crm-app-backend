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
    // ADDED: optional project filter ?project=<project_name>. When given, every
    // card/total/performance number below counts only leads whose project_name
    // matches. Leads link to projects by this name string (leads.project_name).
    const project = String(req.query.project || "").trim();
    const projectActive = Boolean(project);
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
    // ADDED: project filter for the top KPI cards
    if (projectActive) { conds.push("l.project_name = ?"); params.push(project); }
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
    // ADDED: total walk-ins (admin only). When a date range is active it counts
    // walk-ins whose visit_date falls in the range; otherwise it counts all.
    let walkins = 0;
    if (isAdmin) {
      // ORIGINAL: joined all leads. Now the same range applies inside the JOIN,
      // so per-telecaller numbers match the selected period.
      // ADDED: the project filter is applied inside the JOIN too, so each
      // telecaller's row reflects only the selected project.
      const joinParts = ["l.assigned_to = u.id"];
      const joinParams = [];
      if (rangeActive) { joinParts.push(rangeSql); joinParams.push(...rangeParams); }
      if (projectActive) { joinParts.push("l.project_name = ?"); joinParams.push(project); }
      const joinCond = joinParts.join(" AND ");
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
        joinParams
      );
      performance = perf;
      const unConds = ["l.assigned_to IS NULL"];
      const unParams = [];
      if (rangeActive) { unConds.push(rangeSql); unParams.push(...rangeParams); }
      // ADDED: project filter for unassigned leads
      if (projectActive) { unConds.push("l.project_name = ?"); unParams.push(project); }
      const [[un]] = await pool.query(
        `SELECT COUNT(*) AS c FROM leads l WHERE ${unConds.join(" AND ")}`, unParams
      );
      unassigned = un.c;

      // ADDED: count walk-ins. Range (when active) applies to visit_date.
      const wkConds = [];
      const wkParams = [];
      if (rangeActive) { wkConds.push("visit_date BETWEEN ? AND ?"); wkParams.push(lo, hi); }
      // ADDED: project filter for walk-ins (walkins also has a project_name column)
      if (projectActive) { wkConds.push("project_name = ?"); wkParams.push(project); }
      const wkWhere = wkConds.length ? `WHERE ${wkConds.join(" AND ")}` : "";
      const [[wk]] = await pool.query(
        `SELECT COUNT(*) AS c FROM walkins ${wkWhere}`, wkParams
      );
      walkins = wk.c;
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
    // ADDED: project filter for the upcoming follow-ups table
    if (projectActive) { fuConds.push("l.project_name = ?"); fuParams.push(project); }
    const [followups] = await pool.query(
      `SELECT l.id, l.name, l.primary_phone, l.next_call_date, l.call_category, u.name AS caller_name
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
       WHERE ${fuConds.join(" AND ")}
       ORDER BY l.next_call_date ASC LIMIT 15`,
      fuParams
    );

    res.json({ totals: totals[0], performance, unassigned, walkins, followups });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ADDED: GET /api/dashboard/projects - distinct project names used to populate
// the project filter dropdown on the dashboards. A telecaller only sees the
// projects among their own assigned leads; an admin sees all. Admin may also
// pass ?assigned=<userId> to scope the list to one telecaller (used by the
// telecaller detail page). Only names that actually appear on leads are
// returned, so every option in the dropdown filters to at least one lead.
router.get("/projects", async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";
    const conds = ["project_name IS NOT NULL AND project_name <> ''"];
    const params = [];
    if (!isAdmin) {
      conds.push("assigned_to = ?");
      params.push(req.user.id);
    } else if (req.query.assigned) {
      conds.push("assigned_to = ?");
      params.push(req.query.assigned);
    }
    const [rows] = await pool.query(
      `SELECT project_name FROM leads WHERE ${conds.join(" AND ")}
       GROUP BY project_name ORDER BY project_name ASC`,
      params
    );
    res.json({ projects: rows.map((r) => r.project_name) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
