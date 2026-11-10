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
    // UPDATED: not marked "opened" when the Deeraj team views the answers (?view=1)
    // ORIGINAL: if (b.status === "sent") await pool.query("UPDATE client_briefs SET status = 'opened', opened_at = NOW() WHERE id = ?", [b.id]);
    if (b.status === "sent" && !req.query.view) await pool.query("UPDATE client_briefs SET status = 'opened', opened_at = NOW() WHERE id = ?", [b.id]);
    let raw = null;
    try { raw = b.raw_json ? JSON.parse(b.raw_json) : null; } catch { raw = null; }
    const [photos] = await pool.query("SELECT slot FROM client_brief_photos WHERE brief_id = ?", [b.id]);
    // ADDED: floor plan files already attached
    const [files] = await pool.query(
      "SELECT id, file_name AS name, mime_type AS mime, size_bytes AS size FROM client_brief_files WHERE brief_id = ? ORDER BY id", [b.id]
    );
    res.json({
      brief_no: briefNo(b.id), client_name: b.client_name, phone: b.phone,
      submitted: b.status === "submitted", raw, photos: photos.map((p) => p.slot),
      files, // ADDED
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

// ADDED: "Attach floor plan" (Section 2) - the file is sent as it is (not JSON),
// with its name in the X-File-Name header. PDF or photo, 10 MB each, 5 files per brief.
const FP_MAX = 10 * 1024 * 1024;
const FP_TYPES = /^(application\/pdf|image\/(jpeg|png|webp|gif|heic|heif))$/i;
router.post("/:token/files", express.raw({ type: () => true, limit: "11mb" }), async (req, res) => {
  try {
    const b = await byToken(req.params.token);
    if (!b) return res.status(404).json({ error: "This link is not valid. Please ask Deeraj Interiors for a new link." });
    const data = req.body;
    if (!Buffer.isBuffer(data) || !data.length) return res.status(400).json({ error: "The file is empty. Please choose the floor plan again." });
    if (data.length > FP_MAX) return res.status(400).json({ error: "This file is bigger than 10 MB. Please choose a smaller file." });
    const mime = String(req.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (!FP_TYPES.test(mime)) return res.status(400).json({ error: "Please attach the floor plan as a PDF or a photo (JPG / PNG)." });
    let name = "floor-plan";
    try { name = decodeURIComponent(req.get("X-File-Name") || name); } catch { /* keep default */ }
    name = name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 200) || "floor-plan";
    const [[cnt]] = await pool.query("SELECT COUNT(*) AS c FROM client_brief_files WHERE brief_id = ?", [b.id]);
    if (Number(cnt.c) >= 5) return res.status(400).json({ error: "You can attach up to 5 floor plan files. Remove one to add another." });
    const [r] = await pool.query(
      "INSERT INTO client_brief_files (brief_id, kind, file_name, mime_type, size_bytes, data) VALUES (?, 'floor_plan', ?, ?, ?, ?)",
      [b.id, name, mime, data.length, data]
    );
    res.json({ message: "Floor plan attached", file: { id: r.insertId, name, mime, size: data.length } });
  } catch (err) {
    console.error("Public brief file upload error:", err);
    res.status(500).json({ error: "The floor plan could not be attached. Please try again." });
  }
});

router.get("/:token/files/:fid", async (req, res) => {
  try {
    const b = await byToken(req.params.token);
    if (!b) return res.status(404).end();
    const [[f]] = await pool.query("SELECT file_name, mime_type, data FROM client_brief_files WHERE id = ? AND brief_id = ?", [req.params.fid, b.id]);
    if (!f) return res.status(404).end();
    res.set("Content-Type", f.mime_type);
    res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
    res.send(f.data);
  } catch (err) {
    console.error("Public brief file error:", err);
    res.status(500).end();
  }
});

router.delete("/:token/files/:fid", async (req, res) => {
  try {
    const b = await byToken(req.params.token);
    if (!b) return res.status(404).json({ error: "This link is not valid." });
    const [r] = await pool.query("DELETE FROM client_brief_files WHERE id = ? AND brief_id = ?", [req.params.fid, b.id]);
    if (!r.affectedRows) return res.status(404).json({ error: "File not found" });
    res.json({ message: "Floor plan removed" });
  } catch (err) {
    console.error("Public brief file delete error:", err);
    res.status(500).json({ error: "Could not remove the file. Please try again." });
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
    // ADDED: State / City / Location (Section 2) in their own columns - separate
    // UPDATE so the statement above stays as it was
    await pool.query("UPDATE client_briefs SET state = ?, city = ?, location = ? WHERE id = ?",
      [cut(key.state, 50), cut(key.city, 100), cut(key.location, 200), b.id]);
    res.json({ message: "Thank you! Your brief has been sent to Deeraj Interiors.", brief_no: briefNo(b.id), again: b.submit_count > 0 });
  } catch (err) {
    console.error("Public brief submit error:", err);
    res.status(500).json({ error: "Your brief could not be sent. Please check your internet and try again." });
  }
});

module.exports = router;
