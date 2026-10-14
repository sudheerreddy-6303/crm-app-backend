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
    res.json({ message: "WhatsApp request saved", id: r.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
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

module.exports = router;
