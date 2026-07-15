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
if (process.env.FRONTEND_URL) {
  app.use(cors({
    origin: [
      process.env.FRONTEND_URL,
      "http://localhost:5173",
      "http://localhost:3000",
    ],
  }));
} else {
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
