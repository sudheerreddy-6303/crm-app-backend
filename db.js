const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
require("dotenv").config();

// Connection pool with keepAlive so idle connections don't drop overnight
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "telecrm",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

async function initDb() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(150) NOT NULL UNIQUE,
        phone VARCHAR(20) DEFAULT '',
        password VARCHAR(255) NOT NULL,
        role ENUM('admin','telecaller') NOT NULL DEFAULT 'telecaller',
        status ENUM('active','inactive') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        project_name VARCHAR(150) DEFAULT '',
        primary_phone VARCHAR(20) NOT NULL,
        assigned_to INT NULL,
        first_calling_date DATE NULL,
        second_calling_date DATE NULL,
        call_category ENUM('','NOT INTERESTED','FOLLOW UP','INTERESTED','NOT ANSWERED') DEFAULT '',
        quote_sent ENUM('','Yes','No') DEFAULT '',
        order_booked ENUM('','Yes','No') DEFAULT '',
        whatsapp_sent_date DATE NULL,
        whatsapp_category VARCHAR(100) DEFAULT '',
        calling_remark TEXT,
        next_call_date DATE NULL,
        priority ENUM('none','hot','warm','cold') DEFAULT 'none',
        source VARCHAR(100) DEFAULT '',
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS call_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lead_id INT NOT NULL,
        user_id INT NULL,
        remark TEXT,
        category VARCHAR(50) DEFAULT '',
        log_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // ADDED: migration for existing databases. CREATE TABLE IF NOT EXISTS above
    // only applies to fresh installs, so on an already-deployed database we add
    // the project_name column if it's missing. Safe to run on every startup.
    const [pnCol] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND COLUMN_NAME = 'project_name'`
    );
    if (pnCol[0].cnt === 0) {
      console.log("Migration: adding project_name column to leads table");
      await conn.query("ALTER TABLE leads ADD COLUMN project_name VARCHAR(150) DEFAULT '' AFTER name");
    }

    // ADDED: Service Calls table (name, phone, category dropdown, location, remarks)
    // category is VARCHAR (not ENUM) so new categories can be added later
    // without a database migration
    await conn.query(`
      CREATE TABLE IF NOT EXISTS service_calls (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        category VARCHAR(50) DEFAULT '',
        location VARCHAR(200) DEFAULT '',
        remarks TEXT,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // Seed admin from env variables (never hardcode credentials in code)
    const adminEmail = process.env.ADMIN_EMAIL || "admin@telecrm.local";
    const adminPassword = process.env.ADMIN_PASSWORD || "ChangeMe@123";
    // ORIGINAL CODE (bug: only seeded on very first run - if you changed
    // ADMIN_EMAIL/ADMIN_PASSWORD in .env later, the new admin was never created):
    // const [rows] = await conn.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
    // if (rows.length === 0) {
    // FIXED: check for the specific ADMIN_EMAIL account, so updating .env and
    // restarting always creates the admin you configured
    const [rows] = await conn.query("SELECT id FROM users WHERE email = ? LIMIT 1", [adminEmail]);
    if (rows.length === 0) {
      const hash = await bcrypt.hash(adminPassword, 10);
      await conn.query(
        "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'admin')",
        ["Admin", adminEmail, hash]
      );
      console.log(`Seeded admin account: ${adminEmail} (set ADMIN_EMAIL / ADMIN_PASSWORD in .env)`);
    }

    console.log("Database initialised");
  } finally {
    conn.release();
  }
}

module.exports = { pool, initDb };
