// ADDED: live "Data in CRM (count)" for Project Details = number of leads in the
// CRM for that project. Uses the SAME name matching as the Projects summary
// cards (routes/dashboard.js /project-summary), so both show the same number:
//   - names compared ignoring capitals, spaces, dots, dashes ("ABSL LOFT" = "absl-loft")
//   - small spelling differences still match (80% same, or one name starts with /
//     contains the other, names of 5+ letters)
//   - when two Project Details records have the same name, the most recently
//     updated one gets the count (same as the summary cards)
const { pool } = require("../db");

const nameKey = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
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
const similarity = (k, key) => {
  const shorter = Math.min(k.length, key.length);
  if (shorter < 5) return k === key ? 1 : 0;
  if (k.startsWith(key) || key.startsWith(k)) return 0.95;
  if (k.includes(key) || key.includes(k)) return 0.9;
  return 1 - editDistance(k, key) / Math.max(k.length, key.length);
};

async function leadGroups() {
  const [rows] = await pool.query(
    `SELECT project_name, COUNT(*) AS c FROM leads
     WHERE project_name IS NOT NULL AND project_name <> '' GROUP BY project_name`
  );
  return rows.map((r) => ({ key: nameKey(r.project_name), c: Number(r.c) || 0 })).filter((g) => g.key);
}

// { projectId: leadsCount } for every project in the table
async function countsByProjectId() {
  const [pj] = await pool.query(
    `SELECT id, project_name FROM projects WHERE project_name IS NOT NULL AND project_name <> ''
     ORDER BY updated_at DESC, id DESC`
  );
  const byKey = {};
  pj.forEach((p) => { const k = nameKey(p.project_name); if (k && !byKey[k]) byKey[k] = p.id; });
  const keys = Object.keys(byKey);
  const out = {};
  (await leadGroups()).forEach((g) => {
    let id = byKey[g.key];
    if (!id) {
      let best = null; let bestScore = 0;
      keys.forEach((k) => { const s = similarity(k, g.key); if (s > bestScore) { bestScore = s; best = byKey[k]; } });
      if (bestScore >= 0.8) id = best;
    }
    if (id) out[id] = (out[id] || 0) + g.c;
  });
  return out;
}

// adds crm_leads_count to each project row
async function attachLeadCounts(rows) {
  if (!rows || !rows.length) return rows;
  const counts = await countsByProjectId();
  rows.forEach((r) => { r.crm_leads_count = counts[r.id] || 0; });
  return rows;
}

// count for a project name typed in the form (project may not be saved yet)
async function countForName(name) {
  const key = nameKey(name);
  if (!key) return 0;
  let total = 0;
  (await leadGroups()).forEach((g) => { if (g.key === key || similarity(key, g.key) >= 0.8) total += g.c; });
  return total;
}

module.exports = { attachLeadCounts, countForName };
