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
// HEALTH CHECK
// =========================

app.get("/", (req, res) => {
  res.send("SkillBid API Running ✅");
});

// =========================
// ROUTES
// =========================

// Public stats route for landing page (matches StatsService baseUrl)
app.use("/api/stats", require("./routes/stats")); // <-- use stats.js here [file:53]

app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/user"));
app.use("/api/tasks", require("./routes/tasks"));
app.use("/api/bids", require("./routes/bids"));
app.use("/api/payments", require("./routes/payments"));

// ✅ ADMIN ROUTES
app.use("/api/admin", require("./routes/admin"));

// =========================
// DATABASE
// =========================

connectDB();

// =========================
// SERVER
// =========================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
