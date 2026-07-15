// Utility: force the admin account to match ADMIN_EMAIL / ADMIN_PASSWORD in .env
// Use this if you forgot the admin password or changed .env after first run.
//
//   cd backend
//   node reset-admin.js
//
const bcrypt = require("bcryptjs");
const { pool } = require("./db");
require("dotenv").config();

(async () => {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first.");
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  const [rows] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
  if (rows.length > 0) {
    await pool.query("UPDATE users SET password = ?, role = 'admin', status = 'active' WHERE email = ?", [hash, email]);
    console.log(`Password reset for admin: ${email}`);
  } else {
    await pool.query("INSERT INTO users (name, email, password, role) VALUES ('Admin', ?, ?, 'admin')", [email, hash]);
    console.log(`Created admin: ${email}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
