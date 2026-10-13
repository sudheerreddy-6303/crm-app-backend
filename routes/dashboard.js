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
    // ORIGINAL: const isAdmin = req.user.role === "admin";
    // UPDATED: admin may pass ?as_user=<telecallerId> to get exactly the
    // dashboard that telecaller sees (their own leads only). Used by the
    // telecaller detail page. Ignored for non-admins, so a telecaller can
    // never see anyone else's data. Without as_user nothing changes.
    let isAdmin = req.user.role === "admin";
    let scopeUserId = req.user.id;
    const asUser = isAdmin && /^\d+$/.test(String(req.query.as_user || "")) ? Number(req.query.as_user) : null;
    if (asUser) { isAdmin = false; scopeUserId = asUser; }

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
    // ORIGINAL: params.push(req.user.id) - UPDATED: scopeUserId (same value unless as_user)
    if (!isAdmin) { conds.push("l.assigned_to = ?"); params.push(scopeUserId); }
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
         SUM(next_call_date = CURDATE()) AS due_today,
         -- ADDED: "Leads" card - a record counts as a lead when the telecaller
         -- marked priority warm/cold OR category INTERESTED OR quotation sent Yes
         -- UPDATED: also counts leads marked Walk-in = Yes
         SUM(priority IN ('warm','cold') OR call_category = 'INTERESTED' OR quote_sent = 'Yes' OR walkin = 'Yes') AS leads,
         -- ADDED: leads marked Walk-in = Yes (shown as the "Walk-ins" card on
         -- a telecaller's dashboard - scoped to their own leads like the rest)
         SUM(walkin = 'Yes') AS walkin_leads
       FROM leads l ${scope}`,
      params
    );

    let performance = [];
    let unassigned = 0;
    // ADDED: total walk-ins (admin only). When a date range is active it counts
    // walk-ins whose visit_date falls in the range; otherwise it counts all.
    let walkins = 0;
    // ADDED: total number of projects in the database (admin only). This is a
    // straight count of the projects table, independent of the lead date/project
    // filters, so it always shows how many projects exist overall.
    let projectsCount = 0;
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

      // ADDED: every walk-in also counts as a lead on the green "Leads" card.
      // Read-only: walk-ins are NOT copied or changed - only counted here.
      // leads_from_calls keeps the original number for reference.
      totals[0].leads_from_calls = Number(totals[0].leads || 0);
      totals[0].leads_from_walkins = Number(walkins || 0);
      totals[0].leads = totals[0].leads_from_calls + totals[0].leads_from_walkins;

      // ADDED: count of projects (admin only). Counts the distinct project
      // names that appear on leads - the same set shown in the Project filter
      // dropdown (GET /dashboard/projects) - so the card matches that list.
      const [[pj]] = await pool.query(
        `SELECT COUNT(DISTINCT project_name) AS c FROM leads
         WHERE project_name IS NOT NULL AND project_name <> ''`
      );
      projectsCount = pj.c;
    }

    // Follow-ups: ORIGINAL always showed the next 3 days. With a range selected,
    // shows follow-ups whose next call date falls inside the range instead.
    const fuConds = [];
    const fuParams = [];
    // ORIGINAL: fuParams.push(req.user.id) - UPDATED: scopeUserId (same value unless as_user)
    if (!isAdmin) { fuConds.push("l.assigned_to = ?"); fuParams.push(scopeUserId); }
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

    res.json({ totals: totals[0], performance, unassigned, walkins, projects_count: projectsCount, followups });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ADDED: GET /api/dashboard/walkin-leads - read-only list of walk-ins shown
// under the leads when the dashboard "Leads" card is opened (admin only, same
// as the Walk-ins card). Optional ?project= matches the project-filtered card.
// This only READS the walkins table; nothing in walk-ins is changed.
router.get("/walkin-leads", async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.json({ walkins: [] });
    const project = String(req.query.project || "").trim();
    const where = project ? "WHERE w.project_name = ?" : "";
    // UPDATED: returns the same fields as the Walk-ins page (w.* + added by)
    // so the list under "Leads" displays exactly like the Walk-ins page
    const [rows] = await pool.query(
      `SELECT w.*, u.name AS created_by_name
       FROM walkins w LEFT JOIN users u ON u.id = w.created_by
       ${where}
       ORDER BY w.created_at DESC`,
      project ? [project] : []
    );
    res.json({ walkins: rows });
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

// ADDED: GET /api/dashboard/project-summary - one row per project name that
// appears on leads, with that project's lead counts. Powers the project cards
// grid (clicking the dashboard "Total projects" card). Admin sees every
// project; a telecaller sees only projects among their own assigned leads, so
// the number of rows here matches the "Total projects" card for that user.
router.get("/project-summary", async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";
    const conds = ["project_name IS NOT NULL AND project_name <> ''"];
    const params = [];
    if (!isAdmin) { conds.push("assigned_to = ?"); params.push(req.user.id); }
    const [rows] = await pool.query(
      `SELECT project_name AS name,
         COUNT(*) AS total_leads,
         SUM(call_category = 'INTERESTED') AS interested,
         SUM(call_category = 'FOLLOW UP') AS follow_up,
         SUM(quote_sent = 'Yes') AS quotes_sent,
         SUM(order_booked = 'Yes') AS orders_booked,
         -- ADDED: "Leads" per project - same rule as the dashboard "Leads" card
         SUM(priority IN ('warm','cold') OR call_category = 'INTERESTED' OR quote_sent = 'Yes' OR walkin = 'Yes') AS leads
       FROM leads
       WHERE ${conds.join(" AND ")}
       GROUP BY project_name
       ORDER BY total_leads DESC, project_name ASC`,
      params
    );

    // ADDED: walk-ins count per project for the project cards. Walk-ins are
    // stored in the walkins table with their own project_name, so they are
    // counted here (read-only) and attached to each project row by name.
    // Quotations use the existing quotes_sent count above (quote_sent = 'Yes').
    const [wkRows] = await pool.query(
      `SELECT project_name, COUNT(*) AS c FROM walkins
       WHERE project_name IS NOT NULL AND project_name <> ''
       GROUP BY project_name`
    );
    const wkMap = {};
    wkRows.forEach((w) => {
      const key = String(w.project_name).trim().toLowerCase();
      wkMap[key] = (wkMap[key] || 0) + Number(w.c || 0);
    });
    rows.forEach((r) => {
      r.walkins = wkMap[String(r.name).trim().toLowerCase()] || 0;
      // ADDED: like the dashboard "Leads" card, the admin's count also includes
      // that project's walk-ins (so it matches the dashboard filtered by project)
      r.leads = Number(r.leads || 0) + (isAdmin ? Number(r.walkins || 0) : 0);
    });

    // ADDED: project type and location for each card, read from the Project
    // Details records (projects table), matched by project name (ignoring
    // capital letters / extra spaces). Read-only. Empty when the project has
    // no Project Details record yet.
    const [pjRows] = await pool.query(
      // UPDATED: address added (used when Location is empty)
      // ORIGINAL: SELECT project_name, type, location FROM projects
      `SELECT project_name, type, location, address FROM projects
       WHERE project_name IS NOT NULL AND project_name <> ''
       ORDER BY updated_at DESC`
    );
    // UPDATED: names are matched ignoring capitals, spaces, dots, dashes etc.
    // ("ABSL LOFT" = "absl-loft" = "Absl Loft.") so small spelling differences
    // between the leads and Project Details still match.
    // ORIGINAL key: String(name).trim().toLowerCase()
    const nameKey = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const pjMap = {};
    pjRows.forEach((pj) => {
      const key = nameKey(pj.project_name);
      if (key && !pjMap[key]) pjMap[key] = pj; // most recently updated record wins
    });

    // ADDED: fallback type from the leads themselves - the most common
    // "Project type" (2BHK / 3BHK / Villa ...) entered on that project's leads.
    // Used only when the project has no type in Project Details.
    const [ltRows] = await pool.query(
      `SELECT project_name, project_type, COUNT(*) AS c FROM leads
       WHERE ${conds.join(" AND ")} AND project_type IS NOT NULL AND project_type <> ''
       GROUP BY project_name, project_type`,
      params
    );
    const leadTypeMap = {};
    ltRows.forEach((t) => {
      const key = nameKey(t.project_name);
      if (!leadTypeMap[key] || Number(t.c) > leadTypeMap[key].c) leadTypeMap[key] = { type: t.project_type, c: Number(t.c) };
    });

    // ADDED: close-name matching for names spelled slightly differently in
    // Project Details and on the leads, e.g. "Aparna Zenon" vs "Aparna xenon"
    // (1 letter different) or "Oorjitha projects (vedant)" vs "Oorjitha".
    // Exact matches always win; otherwise the closest name is used if it is
    // at least 80% the same (or one name fully contains the other).
    const editDistance = (a, b) => {
      const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
      for (let j = 1; j <= b.length; j++) d[0][j] = j;
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
      }
      return d[a.length][b.length];
    };
    const pjKeys = Object.keys(pjMap);
    const findProject = (key) => {
      if (!key) return null;
      if (pjMap[key]) return pjMap[key];
      let best = null; let bestScore = 0;
      pjKeys.forEach((k) => {
        let score = 0;
        const shorter = Math.min(k.length, key.length);
        if (shorter >= 5 && (k.startsWith(key) || key.startsWith(k))) score = 0.95;
        else if (shorter >= 5 && (k.includes(key) || key.includes(k))) score = 0.9;
        else if (shorter >= 5) score = 1 - editDistance(k, key) / Math.max(k.length, key.length);
        if (score > bestScore) { bestScore = score; best = pjMap[k]; }
      });
      return bestScore >= 0.8 ? best : null;
    };
    // ADDED: short area from the address when Location is empty - the part
    // just before the city (e.g. "..., Tellapur, Telangana 500019" -> "Tellapur")
    const areaFromAddress = (addr) => {
      const parts = String(addr || "").split(",").map((x) => x.trim()).filter(Boolean)
        .filter((x) => !/^(hyderabad|secunderabad|telangana|india|ts|tg)\b/i.test(x) && !/\d{6}/.test(x));
      return parts.length ? parts[parts.length - 1] : "";
    };

    rows.forEach((r) => {
      const key = nameKey(r.name);
      // ORIGINAL: const pj = pjMap[key];
      const pj = findProject(key);
      r.type = (pj && pj.type) || (leadTypeMap[key] ? leadTypeMap[key].type : "");
      // ADDED: where the type came from - "project" (Project Details) or "leads"
      r.type_source = pj && pj.type ? "project" : (leadTypeMap[key] ? "leads" : "");
      // ORIGINAL: r.location = pj ? pj.location || "" : "";
      // UPDATED: Location, or the area from the Address when Location is empty
      r.location = pj ? (pj.location || areaFromAddress(pj.address)) : "";
      // ADDED: the Project Details name it was matched to (for checking)
      r.matched_project = pj ? pj.project_name : "";
    });

    res.json({ projects: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
