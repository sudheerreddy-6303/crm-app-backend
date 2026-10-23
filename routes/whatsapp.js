// ADDED: WhatsApp requests - saved from the Meta WhatsApp / Bulk WhatsApp form.
//   POST /api/whatsapp            save one request
//   GET  /api/whatsapp?channel=   history (latest first)
// Rules:
//   - A telecaller can only save requests for themselves and only sees their own history.
//   - Admin can save for any telecaller and sees everyone's history
//     (optional ?telecaller=<id> filter).
const express = require("express");
const { pool } = require("../db");
const { auth } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

const CHANNELS = { meta: "meta", bulk: "bulk" };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayLocal() {
  // India time (UTC+05:30) so "today" matches what the user sees
  const d = new Date(Date.now() + 330 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ADDED: Meta WhatsApp read / delivered / failed numbers. Empty = not entered (NULL).
const statOrNull = (v) => {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/\D/g, ""));
  return Number.isFinite(n) ? n : null;
};

router.post("/", async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";
    const channel = CHANNELS[String(req.body.channel || "").toLowerCase()];
    if (!channel) return res.status(400).json({ error: "Invalid WhatsApp type" });

    const telecallerId = isAdmin ? Number(req.body.telecaller_id) : Number(req.user.id);
    if (!telecallerId) return res.status(400).json({ error: "Telecaller name is required" });

    const projects = Array.isArray(req.body.projects)
      ? [...new Set(req.body.projects.map((p) => String(p || "").trim()).filter(Boolean))]
      : [];
    if (projects.length === 0) return res.status(400).json({ error: "Select at least one project" });
    // ADDED: only ONE project per request
    if (projects.length > 1) return res.status(400).json({ error: "Select only one project" });

    const count = Number(req.body.count);
    if (!Number.isInteger(count) || count <= 0) return res.status(400).json({ error: "Count must be a number greater than 0" });

    const sendDate = String(req.body.send_date || "");
    if (!DATE_RE.test(sendDate) || Number.isNaN(Date.parse(sendDate))) return res.status(400).json({ error: "Sending date is required" });
    if (sendDate < todayLocal()) return res.status(400).json({ error: "Sending date cannot be a past date" });

    const [[tc]] = await pool.query("SELECT id, name FROM users WHERE id = ?", [telecallerId]);
    if (!tc) return res.status(400).json({ error: "Telecaller not found" });

    const [r] = await pool.query(
      `INSERT INTO whatsapp_requests
         (channel, telecaller_id, telecaller_name, projects, project_count, count, send_date, created_by, created_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [channel, tc.id, tc.name || "", JSON.stringify(projects), projects.length, count, sendDate, req.user.id, req.user.name || ""]
    );
    // ADDED: Meta WhatsApp only - read / delivered / failed (optional)
    if (channel === "meta") {
      await pool.query(
        "UPDATE whatsapp_requests SET read_count = ?, delivered_count = ?, failed_count = ? WHERE id = ?",
        [statOrNull(req.body.read_count), statOrNull(req.body.delivered_count), statOrNull(req.body.failed_count), r.insertId]
      );
    }
    res.json({ message: "WhatsApp request saved", id: r.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ADDED: GET /api/whatsapp/count?project=<name>&telecaller_id=<id>
// Fills the "Count" box automatically when a project is picked in the form.
//  - Project  -> UPDATED: total leads in the project = same number as the Projects cards
//    (PREVIOUS: the project's "How much data in CRM" number from Project Details).
//    (ORIGINAL: number of leads in that project - own leads for a telecaller,
//     the picked telecaller's leads for admin, all leads when nobody is picked.)
//  - Group (Interior Designers / Tele Callers / Sales Executive)
//      -> number of service calls in that category.
const WA_GROUP_CATEGORY = {
  "Interior Designers": "Interior Designer",
  "Tele Callers": "Tele Callers",
  "Sales Executive": "Sales Executive",
};
router.get("/count", async (req, res) => {
  try {
    const project = String(req.query.project || "").trim();
    if (!project) return res.status(400).json({ error: "Project is required" });

    const category = WA_GROUP_CATEGORY[project];
    if (category) {
      const [[r]] = await pool.query(
        `SELECT COUNT(*) AS c FROM service_calls
         WHERE LOWER(TRIM(category)) = LOWER(?) AND phone IS NOT NULL AND TRIM(phone) <> ''`,
        [category]
      );
      return res.json({ count: Number(r.c) || 0, source: "service_calls", label: `service calls in ${category}` });
    }

    // UPDATED: Count = the same number as the big number on the Projects cards
    // (GET /dashboard/project-summary "total_leads"): all leads with this project name;
    // a telecaller sees only their own leads (same as their Projects cards).
    const conds = ["project_name = ?"];
    const params = [project];
    if (req.user.role !== "admin") { conds.push("assigned_to = ?"); params.push(req.user.id); }
    const [[r]] = await pool.query(`SELECT COUNT(*) AS c FROM leads WHERE ${conds.join(" AND ")}`, params);
    return res.json({
      count: Number(r.c) || 0,
      source: "leads",
      label: req.user.role === "admin" ? "total data in this project" : "your data in this project",
    });

    // PREVIOUS (used the project's "How much data in CRM" field - replaced as asked):
    // // UPDATED: Count = the project's "How much data in CRM" number (Project Details page).
    // // Not filled (0 / no project row) -> count: null, the form shows a note and leaves Count empty.
    // const [pr] = await pool.query(
    // `SELECT MAX(crm_data_count) AS c FROM projects WHERE LOWER(TRIM(project_name)) = LOWER(TRIM(?))`,
    // [project]
    // );
    // const crm = pr.length ? Number(pr[0].c) || 0 : 0;
    // if (crm > 0) return res.json({ count: crm, source: "project", label: "How much data in CRM" });
    // return res.json({ count: null, source: "project", label: "\"How much data in CRM\" is not filled for this project (Project Details)" });

    // ORIGINAL (counted the telecaller's leads in the project - replaced as asked):
    // let tcId = null;
    // if (req.user.role !== "admin") {
    // tcId = req.user.id;
    // } else if (req.query.telecaller_id) {
    // const [u] = await pool.query("SELECT id, role FROM users WHERE id = ?", [Number(req.query.telecaller_id)]);
    // if (u.length && u[0].role === "telecaller") tcId = u[0].id; // admin picked -> all leads
    // }
    // const conds = ["project_name = ?", "primary_phone IS NOT NULL", "TRIM(primary_phone) <> ''"];
    // const params = [project];
    // if (tcId) { conds.push("assigned_to = ?"); params.push(tcId); }
    // const [[r]] = await pool.query(`SELECT COUNT(*) AS c FROM leads WHERE ${conds.join(" AND ")}`, params);
    // res.json({ count: Number(r.c) || 0, source: "leads", label: tcId ? "leads of this telecaller" : "leads in this project" });
  } catch (err) {
    console.error("WhatsApp count error:", err);
    res.status(500).json({ error: "Could not get the count" });
  }
});

router.get("/", async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";
    const conds = [];
    const params = [];
    const channel = CHANNELS[String(req.query.channel || "").toLowerCase()];
    if (channel) { conds.push("channel = ?"); params.push(channel); }
    if (!isAdmin) { conds.push("telecaller_id = ?"); params.push(req.user.id); }
    else if (req.query.telecaller) { conds.push("telecaller_id = ?"); params.push(Number(req.query.telecaller)); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT id, channel, telecaller_id, telecaller_name, projects, project_count, count,
              DATE_FORMAT(send_date, '%Y-%m-%d') AS send_date, created_by_name, created_at,
              -- ADDED: Meta WhatsApp read / delivered / failed
              read_count, delivered_count, failed_count,
              -- ADDED: exact saved moment as epoch seconds, so the page shows the correct
              -- India time whatever timezone MySQL / the server are set to
              UNIX_TIMESTAMP(created_at) AS created_ts
       FROM whatsapp_requests ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT 500`,
      params
    );
    res.json({
      requests: rows.map((r) => {
        let list = [];
        try { list = JSON.parse(r.projects || "[]"); } catch { list = []; }
        return { ...r, projects: Array.isArray(list) ? list : [] };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ADDED: PUT /api/whatsapp/:id/stats  - update read / delivered / failed later
// (these numbers usually come in after the messages are sent).
// Admin: any request. Telecaller: only their own requests.
router.put("/:id/stats", async (req, res) => {
  try {
    const [[row]] = await pool.query("SELECT id, telecaller_id, channel FROM whatsapp_requests WHERE id = ?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "Request not found" });
    if (req.user.role !== "admin" && Number(row.telecaller_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "You can update only your own requests" });
    }
    if (row.channel !== "meta") return res.status(400).json({ error: "Read / delivered numbers are only for Meta WhatsApp" });
    const read = statOrNull(req.body.read_count), delivered = statOrNull(req.body.delivered_count), failed = statOrNull(req.body.failed_count);
    await pool.query(
      "UPDATE whatsapp_requests SET read_count = ?, delivered_count = ?, failed_count = ? WHERE id = ?",
      [read, delivered, failed, req.params.id]
    );
    res.json({ message: "Message status updated", read_count: read, delivered_count: delivered, failed_count: failed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
