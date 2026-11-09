// ADDED: Client Brief - PUBLIC side (no login). The client opens the link sent on
// WhatsApp (https://<backend>/brief/<token>) and the form talks to these:
//   GET  /api/public/briefs/:token               who it is for + earlier answers
//   GET  /api/public/briefs/:token/photos/:slot  a photo the client added earlier
//   POST /api/public/briefs/:token               submit (or update) the answers
// Only the secret token in the link gives access - one link = one brief.
const express = require("express");
const { pool } = require("../db");

const router = express.Router();
const SLOTS = ["Living", "Kitchen", "Bedroom"];
const MAX_PHOTO = 3 * 1024 * 1024; // 3 MB per photo (the form shrinks photos before sending)
const briefNo = (id) => `DI-CB-${String(id).padStart(4, "0")}`;
const cut = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

async function byToken(token) {
  if (!/^[a-f0-9]{20,64}$/i.test(String(token || ""))) return null;
  const [[row]] = await pool.query("SELECT * FROM client_briefs WHERE token = ?", [token]);
  return row || null;
}

router.get("/:token", async (req, res) => {
  try {
    const b = await byToken(req.params.token);
    if (!b) return res.status(404).json({ error: "This link is not valid. Please ask Deeraj Interiors for a new link." });
    if (b.status === "sent") await pool.query("UPDATE client_briefs SET status = 'opened', opened_at = NOW() WHERE id = ?", [b.id]);
    let raw = null;
    try { raw = b.raw_json ? JSON.parse(b.raw_json) : null; } catch { raw = null; }
    const [photos] = await pool.query("SELECT slot FROM client_brief_photos WHERE brief_id = ?", [b.id]);
    res.json({
      brief_no: briefNo(b.id), client_name: b.client_name, phone: b.phone,
      submitted: b.status === "submitted", raw, photos: photos.map((p) => p.slot),
    });
  } catch (err) {
    console.error("Public brief load error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

router.get("/:token/photos/:slot", async (req, res) => {
  try {
    const b = await byToken(req.params.token);
    if (!b) return res.status(404).end();
    const [[p]] = await pool.query("SELECT mime_type, data FROM client_brief_photos WHERE brief_id = ? AND slot = ?", [b.id, req.params.slot]);
    if (!p) return res.status(404).end();
    res.set("Content-Type", p.mime_type);
    res.send(p.data);
  } catch (err) {
    console.error("Public brief photo error:", err);
    res.status(500).end();
  }
});

router.post("/:token", async (req, res) => {
  try {
    const b = await byToken(req.params.token);
    if (!b) return res.status(404).json({ error: "This link is not valid. Please ask Deeraj Interiors for a new link." });
    const body = req.body || {};
    const key = body.key || {};
    const name = cut(key.name, 150);
    const phoneDigits = String(key.phone || "").replace(/\D/g, "");
    if (!name) return res.status(400).json({ error: "Please write your full name in Section 1 (About You)." });
    if (phoneDigits.length < 10) return res.status(400).json({ error: "Please write your phone / WhatsApp number in Section 1 (About You)." });
    const answers = Array.isArray(body.answers) ? body.answers : [];
    const raw = body.raw && typeof body.raw === "object" ? body.raw : {};

    // photos: { Living: "data:image/jpeg;base64,...", ... }; null = remove
    const photoRows = [];
    const remove = [];
    for (const slot of SLOTS) {
      const v = body.photos ? body.photos[slot] : undefined;
      if (v === null) { remove.push(slot); continue; }
      if (typeof v !== "string") continue;
      const m = v.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      if (!m) return res.status(400).json({ error: `The ${slot} photo could not be read. Please add it again.` });
      const data = Buffer.from(m[2], "base64");
      if (data.length > MAX_PHOTO) return res.status(400).json({ error: `The ${slot} photo is too big. Please choose a smaller photo.` });
      photoRows.push([slot, m[1], data]);
    }

    await pool.query(
      `UPDATE client_briefs SET status = 'submitted', submitted_at = NOW(), submit_count = submit_count + 1,
         filled_name = ?, filled_phone = ?, email = ?, city_area = ?, property_type = ?, configuration = ?, budget = ?,
         answers_json = ?, raw_json = ?, summary_text = ?, opened_at = COALESCE(opened_at, NOW())
       WHERE id = ?`,
      [name, cut(key.phone, 30), cut(key.email, 150), cut(key.city_area, 255), cut(key.property_type, 255),
       cut(key.configuration, 255), cut(key.budget, 255),
       JSON.stringify(answers), JSON.stringify(raw), cut(body.summary, 200000), b.id]
    );
    for (const [slot, mime, data] of photoRows) {
      await pool.query(
        `INSERT INTO client_brief_photos (brief_id, slot, mime_type, size_bytes, data) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE mime_type = VALUES(mime_type), size_bytes = VALUES(size_bytes), data = VALUES(data), uploaded_at = NOW()`,
        [b.id, slot, mime, data.length, data]
      );
    }
    if (remove.length) await pool.query("DELETE FROM client_brief_photos WHERE brief_id = ? AND slot IN (?)", [b.id, remove]);
    res.json({ message: "Thank you! Your brief has been sent to Deeraj Interiors.", brief_no: briefNo(b.id), again: b.submit_count > 0 });
  } catch (err) {
    console.error("Public brief submit error:", err);
    res.status(500).json({ error: "Your brief could not be sent. Please check your internet and try again." });
  }
});

module.exports = router;
