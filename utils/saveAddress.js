// ADDED: saves State / City / Location chosen in the forms (State -> City -> Location
// dropdowns, Telangana / Andhra Pradesh). Runs as a separate small UPDATE after the
// normal save, so the original INSERT / UPDATE statements stay unchanged.
// Only the fields actually sent by the form are written.
const { pool } = require("../db");

const MAX = { state: 50, city: 100, location: 200, site_location: 200 };
const TABLES = {
  leads: ["state", "city", "location"],
  service_calls: ["state"],
  walkins: ["state"],
  projects: ["state", "city"],
  business_partners: ["state", "city"],
};

async function saveAddress(table, id, body) {
  const allowed = TABLES[table];
  if (!allowed || !id || !body) return;
  const cols = allowed.filter((c) => c in body);
  if (!cols.length) return;
  const vals = cols.map((c) => String(body[c] == null ? "" : body[c]).trim().slice(0, MAX[c] || 200));
  await pool.query(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...vals, id]);
}

module.exports = { saveAddress };
