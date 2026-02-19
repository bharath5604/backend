const express = require("express");
const connectDB = require("./config/db");
const cors = require("cors");
require("dotenv").config();

const app = express();

// =========================
// MIDDLEWARE
// =========================

app.use(cors());

app.use(
  express.json({
    limit: "10mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
  })
);

// =========================
/* HEALTH CHECK */
// =========================

app.get("/", (req, res) => {
  res.send("SkillBid API Running ✅");
});

// =========================
// ROUTES
// =========================

// Public stats route for landing page (matches StatsService baseUrl)
app.use("/api/stats", require("./routes/stats"));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/user"));
app.use("/api/tasks", require("./routes/tasks"));
app.use("/api/bids", require("./routes/bids"));
app.use("/api/payments", require("./routes/payments"));

// ✅ ADMIN ROUTES
app.use("/api/admin", require("./routes/admin"));

// =========================
// GLOBAL ERROR HANDLER
// =========================

app.use((err, req, res, next) => {
  console.error("GLOBAL ERROR HANDLER:", err);
  if (res.headersSent) {
    return next(err);
  }
  res
    .status(500)
    .json({ message: "Server error", error: err.message || String(err) });
});

// =========================
// DATABASE
// =========================

connectDB();

// =========================
/* SERVER */
// =========================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
