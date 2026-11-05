// ADDED: Store Promotions (sidebar: Suchitra / Nanakramguda).
// Each store keeps its own list of phone numbers for promotions.
//   GET    /api/store-promotions/:store/numbers          list (search + paging)
//   POST   /api/store-promotions/:store/numbers          add many numbers at once
//   DELETE /api/store-promotions/:store/numbers/:id      remove one number (admin only)
// Rules: only valid Indian mobile numbers (10 digits starting 6-9; +91 / 91 / 0
// in front is removed), and a number is saved only once per store
// (UNIQUE store + phone in the database).
const express = require("express");
const { pool } = require("../db");
const { auth, adminOnly } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

const STORES = { suchitra: "Suchitra", nanakramguda: "Nanakramguda" };
const MAX_PER_ADD = 5000;

// "+91 98490-12345" -> "9849012345"; returns "" when not a valid mobile number
function cleanPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}

const storeOf = (req, res) => {
  const s = String(req.params.store || "").toLowerCase();
  if (!STORES[s]) { res.status(404).json({ error: "Unknown store" }); return null; }
  return s;
};

router.get("/:store/numbers", async (req, res) => {
  try {
    const store = storeOf(req, res); if (!store) return;
    const search = String(req.query.search || "").replace(/\D/g, "");
    const lim = Math.min(Number(req.query.limit) || 50, 1000);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const where = ["n.store = ?"]; const params = [store];
    if (search) { where.push("n.phone LIKE ?"); params.push(`%${search}%`); }
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM store_promo_numbers n WHERE ${where.join(" AND ")}`, params);
    const [rows] = await pool.query(
      `SELECT n.id, n.phone, n.created_at, UNIX_TIMESTAMP(n.created_at) AS created_ts, u.name AS added_by
       FROM store_promo_numbers n LEFT JOIN users u ON u.id = n.created_by
       WHERE ${where.join(" AND ")} ORDER BY n.id DESC LIMIT ? OFFSET ?`,
      [...params, lim, (page - 1) * lim]
    );
    res.json({ store: STORES[store], total, page, limit: lim, numbers: rows });
  } catch (err) {
    console.error("Store promo list error:", err);
    res.status(500).json({ error: "Failed to load numbers" });
  }
});

router.post("/:store/numbers", async (req, res) => {
  try {
    const store = storeOf(req, res); if (!store) return;
    // accepts { numbers: [...] } or { text: "98490..., 9000..." }
    // text: one entry per line / comma / semicolon; an entry that is not one valid number is split on spaces
    const splitText = (t) => String(t || "").split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)
      .flatMap((e) => (cleanPhone(e) ? [e] : e.split(/\s+/)));
    let list = Array.isArray(req.body.numbers) ? req.body.numbers : splitText(req.body.text);
    list = list.map((x) => String(x || "").trim()).filter(Boolean);
    if (!list.length) return res.status(400).json({ error: "Please enter at least one phone number" });
    if (list.length > MAX_PER_ADD) return res.status(400).json({ error: `Too many numbers at once - maximum ${MAX_PER_ADD}` });

    const invalid = []; const repeated = []; const seen = new Set(); const valid = [];
    list.forEach((raw) => {
      const p = cleanPhone(raw);
      if (!p) { invalid.push(raw); return; }
      if (seen.has(p)) { repeated.push(p); return; }
      seen.add(p); valid.push(p);
    });
    let already = [];
    if (valid.length) {
      const [ex] = await pool.query("SELECT phone FROM store_promo_numbers WHERE store = ? AND phone IN (?)", [store, valid]);
      const exSet = new Set(ex.map((r) => r.phone));
      already = valid.filter((p) => exSet.has(p));
      const fresh = valid.filter((p) => !exSet.has(p));
      if (fresh.length) {
        // INSERT IGNORE: even if two people add the same number at the same moment, it is saved once
        const [r] = await pool.query(
          "INSERT IGNORE INTO store_promo_numbers (store, phone, created_by) VALUES ?",
          [fresh.map((p) => [store, p, req.user.id])]
        );
        const added = r.affectedRows;
        return res.status(201).json({
          message: `${added} number${added === 1 ? "" : "s"} added to ${STORES[store]}` +
            (already.length ? ` · ${already.length} already in the list` : "") +
            (repeated.length ? ` · ${repeated.length} repeated` : "") +
            (invalid.length ? ` · ${invalid.length} invalid` : ""),
          added, already: already.length, repeated: repeated.length, invalid, already_numbers: already,
        });
      }
    }
    // nothing new to add
    return res.status(400).json({
      error: valid.length
        ? `No new numbers - ${already.length} already in the ${STORES[store]} list` + (invalid.length ? `, ${invalid.length} invalid` : "")
        : `No valid phone numbers. A valid number has 10 digits and starts with 6, 7, 8 or 9.`,
      added: 0, already: already.length, repeated: repeated.length, invalid,
    });
  } catch (err) {
    console.error("Store promo add error:", err);
    res.status(500).json({ error: "Failed to add numbers" });
  }
});

router.delete("/:store/numbers/:id", adminOnly, async (req, res) => {
  try {
    const store = storeOf(req, res); if (!store) return;
    const [r] = await pool.query("DELETE FROM store_promo_numbers WHERE id = ? AND store = ?", [req.params.id, store]);
    if (r.affectedRows === 0) return res.status(404).json({ error: "Number not found" });
    res.json({ message: "Number removed" });
  } catch (err) {
    console.error("Store promo delete error:", err);
    res.status(500).json({ error: "Failed to remove number" });
  }
});

module.exports = router;
module.exports.cleanPhone = cleanPhone;
