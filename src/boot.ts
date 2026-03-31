// Boot wrapper — handles dotenv safely before loading the app
console.log(`[boot] ScoutAI worker starting — Node ${process.version} — PID ${process.pid}`);
console.log(`[boot] PORT=${process.env.PORT || "not set"}`);

try {
  require("dotenv/config");
  console.log("[boot] dotenv loaded");
} catch {
  console.log("[boot] dotenv skipped (no .env file — using Railway env vars)");
}

// Global error handlers
process.on("uncaughtException", (err) => { console.error("[CRASH] Uncaught:", err); process.exit(1); });
process.on("unhandledRejection", (err) => { console.error("[CRASH] Unhandled rejection:", err); });

// Now load the app
require("./index");
