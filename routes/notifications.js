// ADDED: Notifications bell for telecallers. A notification = an admin reply
// (call_log_replies) to a call remark on a lead assigned to this telecaller.
// Read-only except for marking as read. A telecaller only ever sees replies
// on their OWN assigned leads. Admins have no notifications (they send them).
const express = require("express");
const { pool } = require("../db");
const { auth } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// GET /api/notifications  -> { unread, notifications: [...] } (latest 50)
router.get("/", async (req, res) => {
  try {
    if (req.user.role === "admin") return res.json({ unread: 0, notifications: [] });
    const [rows] = await pool.query(
      `SELECT rp.id, rp.reply, rp.created_at, rp.read_at, u.name AS from_name,
              c.id AS log_id, c.remark, c.category, c.log_date,
              l.id AS lead_id, l.name AS lead_name, l.project_name, l.primary_phone
       FROM call_log_replies rp
       JOIN call_logs c ON c.id = rp.log_id
       JOIN leads l ON l.id = c.lead_id
       LEFT JOIN users u ON u.id = rp.user_id
       WHERE l.assigned_to = ? AND (rp.user_id IS NULL OR rp.user_id <> ?)
       ORDER BY rp.created_at DESC, rp.id DESC
       LIMIT 50`,
      [req.user.id, req.user.id]
    );
    const [[cnt]] = await pool.query(
      `SELECT COUNT(*) AS c
       FROM call_log_replies rp
       JOIN call_logs c ON c.id = rp.log_id
       JOIN leads l ON l.id = c.lead_id
       WHERE l.assigned_to = ? AND (rp.user_id IS NULL OR rp.user_id <> ?) AND rp.read_at IS NULL`,
      [req.user.id, req.user.id]
    );
    res.json({ unread: Number(cnt.c || 0), notifications: rows.map((r) => ({ ...r, read: Boolean(r.read_at) })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/notifications/read-all  - mark all of MY notifications as read
router.post("/read-all", async (req, res) => {
  try {
    await pool.query(
      `UPDATE call_log_replies rp
       JOIN call_logs c ON c.id = rp.log_id
       JOIN leads l ON l.id = c.lead_id
       SET rp.read_at = NOW()
       WHERE l.assigned_to = ? AND rp.read_at IS NULL`,
      [req.user.id]
    );
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/notifications/:id/read  - mark ONE of my notifications as read
router.post("/:id/read", async (req, res) => {
  try {
    const [result] = await pool.query(
      `UPDATE call_log_replies rp
       JOIN call_logs c ON c.id = rp.log_id
       JOIN leads l ON l.id = c.lead_id
       SET rp.read_at = COALESCE(rp.read_at, NOW())
       WHERE rp.id = ? AND l.assigned_to = ?`,
      [req.params.id, req.user.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Notification not found" });
    res.json({ message: "Marked as read" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
