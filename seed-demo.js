// Demo data for testing.
//
//   cd backend
//   npm run seed-demo
//
// Creates (only if they don't already exist):
//   - 2 telecallers: sakshi@deeraj.com / Sakshi@123 and priya@deeraj.com / Priya@123
//   - 18 leads (from the Excel sheet) assigned between them + 2 unassigned
//   - Call logs spread over the last 7 days so "Calls per day" has data
//
// Safe to run more than once - it skips anything that already exists.

const bcrypt = require("bcryptjs");
const { pool, initDb } = require("./db");
require("dotenv").config();

const TELECALLERS = [
  { name: "Sakshi", email: "sakshi@deeraj.com", password: "Sakshi@123", phone: "9000000001" },
  { name: "Priya", email: "priya@deeraj.com", password: "Priya@123", phone: "9000000002" },
];

// Leads taken from the CRM sheet
const LEADS = [
  { name: "Mahesh",             phone: "9963462553", cat: "NOT INTERESTED", remark: "no not required",                      quote: "No",  order: "No",  wa: "DECOR", priority: "cold" },
  { name: "Anil Kumar",         phone: "9390778917", cat: "FOLLOW UP",      remark: "if required he will call us",          quote: "No",  order: "No",  wa: "DECOR", priority: "warm" },
  { name: "Venkat",             phone: "8886102345", cat: "NOT INTERESTED", remark: "no thank you",                         quote: "No",  order: "No",  wa: "DECOR", priority: "cold" },
  { name: "Saikiran",           phone: "7799588333", cat: "NOT INTERESTED", remark: "noo",                                  quote: "No",  order: "No",  wa: "DECOR", priority: "cold" },
  { name: "Sravan Mukka",       phone: "7498574166", cat: "NOT INTERESTED", remark: "no not intrested",                     quote: "No",  order: "No",  wa: "DECOR", priority: "cold" },
  { name: "Durga Sameera Puli", phone: "9573205311", cat: "INTERESTED",     remark: "she wants designs (guntur 4bhk) (sent)", quote: "Yes", order: "No", wa: "DECOR", priority: "hot" },
  { name: "Sri Kumar",          phone: "9676931544", cat: "NOT INTERESTED", remark: "no not required",                      quote: "No",  order: "No",  wa: "DECOR", priority: "cold" },
  { name: "Goutham Sreevani",   phone: "9502238371", cat: "NOT ANSWERED",   remark: "",                                     quote: "",    order: "",    wa: "DECOR", priority: "warm" },
  { name: "Shivani Reddy",      phone: "9108279165", cat: "NOT ANSWERED",   remark: "",                                     quote: "",    order: "",    wa: "DECOR", priority: "warm" },
  { name: "Hanumanulu Tamlurka",phone: "7972258540", cat: "NOT INTERESTED", remark: "no not required",                      quote: "No",  order: "No",  wa: "DECOR", priority: "cold" },
  { name: "Prabhakar Reddy",    phone: "8008877676", cat: "NOT INTERESTED", remark: "not required",                         quote: "No",  order: "No",  wa: "DECOR", priority: "cold" },
  { name: "Ravi",               phone: "9402592291", cat: "NOT INTERESTED", remark: "noo",                                  quote: "No",  order: "No",  wa: "DECOR", priority: "cold" },
  { name: "Anjali Chandra Sekhar", phone: "9849343909", cat: "NOT INTERESTED", remark: "no thank you",                      quote: "No",  order: "No",  wa: "DECOR", priority: "cold" },
  { name: "Santosh Kumar",      phone: "9966746633", cat: "NOT INTERESTED", remark: "not required",                         quote: "No",  order: "No",  wa: "DECOR", priority: "cold" },
  { name: "Vijay Kumar",        phone: "9849322982", cat: "NOT INTERESTED", remark: "no requirements",                      quote: "No",  order: "No",  wa: "DECOR", priority: "cold" },
  { name: "Saritha",            phone: "9703761009", cat: "NOT INTERESTED", remark: "not intrested",                        quote: "No",  order: "No",  wa: "DECOR", priority: "cold" },
  { name: "Venkat Rao",         phone: "9700050678", cat: "FOLLOW UP",      remark: "if required they wil call us",         quote: "No",  order: "No",  wa: "DECOR", priority: "warm" },
  { name: "Lakshmi Devi",       phone: "9876543210", cat: "INTERESTED",     remark: "wants 3bhk interior quote, hyderabad", quote: "Yes", order: "Yes", wa: "DECOR", priority: "hot" },
  // 2 fresh unassigned leads
  { name: "Ramesh Goud",        phone: "9812345670", cat: "", remark: "", quote: "", order: "", wa: "", priority: "none", unassigned: true },
  { name: "Sunitha Rani",       phone: "9823456781", cat: "", remark: "", quote: "", order: "", wa: "", priority: "none", unassigned: true },
];

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

(async () => {
  await initDb();

  // 1. Telecallers
  const tcIds = [];
  for (const t of TELECALLERS) {
    const [rows] = await pool.query("SELECT id FROM users WHERE email = ?", [t.email]);
    if (rows.length > 0) {
      tcIds.push(rows[0].id);
      console.log(`Telecaller exists: ${t.name} (${t.email})`);
    } else {
      const hash = await bcrypt.hash(t.password, 10);
      const [r] = await pool.query(
        "INSERT INTO users (name, email, phone, password, role) VALUES (?, ?, ?, ?, 'telecaller')",
        [t.name, t.email, t.phone, hash]
      );
      tcIds.push(r.insertId);
      console.log(`Created telecaller: ${t.name} (${t.email} / ${t.password})`);
    }
  }

  // 2. Leads + call logs
  let created = 0, skipped = 0;
  for (let i = 0; i < LEADS.length; i++) {
    const L = LEADS[i];
    const [exists] = await pool.query("SELECT id FROM leads WHERE primary_phone = ?", [L.phone]);
    if (exists.length > 0) { skipped++; continue; }

    const assignedTo = L.unassigned ? null : tcIds[i % tcIds.length];
    const dayOffset = i % 7; // spread first-call dates over the last week
    const firstCall = L.cat ? daysAgo(dayOffset + 1) : null;
    const secondCall = L.cat === "FOLLOW UP" || L.cat === "INTERESTED" ? daysAgo(dayOffset) : null;
    const nextCall = L.cat === "FOLLOW UP" ? daysAgo(-2) : L.cat === "INTERESTED" ? daysAgo(-1) : null;

    const [r] = await pool.query(
      `INSERT INTO leads
       (name, primary_phone, assigned_to, first_calling_date, second_calling_date,
        call_category, quote_sent, order_booked, whatsapp_sent_date, whatsapp_category,
        calling_remark, next_call_date, priority, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Demo data')`,
      [
        L.name, L.phone, assignedTo, firstCall, secondCall,
        L.cat, L.quote, L.order,
        L.cat ? daysAgo(dayOffset) : null, L.wa,
        L.remark, nextCall, L.priority,
      ]
    );

    // Call log entries so "Calls per day" has history
    if (assignedTo && L.cat) {
      await pool.query(
        "INSERT INTO call_logs (lead_id, user_id, remark, category, log_date) VALUES (?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL ? DAY))",
        [r.insertId, assignedTo, L.remark || "called", L.cat, dayOffset + 1]
      );
      if (secondCall) {
        await pool.query(
          "INSERT INTO call_logs (lead_id, user_id, remark, category, log_date) VALUES (?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL ? DAY))",
          [r.insertId, assignedTo, `2nd call: ${L.remark || "followed up"}`, L.cat, dayOffset]
        );
      }
    }
    created++;
  }

  console.log(`\nDemo data ready: ${created} lead(s) created, ${skipped} already existed.`);
  console.log("Logins:");
  console.log(`  Admin:      ${process.env.ADMIN_EMAIL || "admin@telecrm.local"} / ${process.env.ADMIN_PASSWORD || "ChangeMe@123"}`);
  for (const t of TELECALLERS) console.log(`  Telecaller: ${t.email} / ${t.password}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
