const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { initDb } = require("./db");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const leadRoutes = require("./routes/leads");
const dashboardRoutes = require("./routes/dashboard");

const app = express();
// ORIGINAL: app.use(cors());  (allowed every origin)
// ADDED: if FRONTEND_URL is set in .env, only allow that origin plus localhost
// dev origins. If FRONTEND_URL is not set, behavior is unchanged (all origins allowed).
// UPDATED: normalize the value (trim spaces/quotes/trailing slash) so a small
// formatting difference in the Railway variable doesn't silently block the frontend,
// and log the allowed origins at startup so deploy logs show the CORS config.
if (process.env.FRONTEND_URL) {
  const normalize = (u) => String(u).trim().replace(/^['"]|['"]$/g, "").replace(/\/+$/, "");
  const allowedOrigins = [
    normalize(process.env.FRONTEND_URL),
    "http://localhost:5173",
    "http://localhost:3000",
    "https://crm-app-production-3be3.up.railway.app"
  ];
  console.log("CORS restricted to:", allowedOrigins.join(", "));
  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no Origin header (curl, server-to-server, health checks)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(normalize(origin))) return callback(null, true);
      console.log("CORS blocked origin:", origin);
      return callback(null, false);
    },
  }));
} else {
  console.log("CORS: FRONTEND_URL not set - allowing all origins");
  app.use(cors());
}
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/dashboard", dashboardRoutes);

const PORT = process.env.PORT || 5000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`TeleCRM backend running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to initialise database:", err.message);
    process.exit(1);
  });
