// leak-alerts.js
//
// Listens to the same WebSocket the dashboard uses, runs the severity
// detection from the dashboard, and sends iMessages via Photon Spectrum
// when a leak or burst is detected. Severity-aware messages with per-
// category cooldown to prevent spam.

import "dotenv/config";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import WebSocket from "ws";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BRIDGE_URL        = process.env.BRIDGE_URL        || "ws://localhost:8765";
const PHOTON_PROJECT_ID = process.env.PHOTON_PROJECT_ID;
const PHOTON_SECRET     = process.env.PHOTON_SECRET;
const COOLDOWN_SECONDS  = parseInt(process.env.COOLDOWN_SECONDS || "30", 10);

// ─── SEVERITY LOGIC (mirrors the dashboard's assessRisk) ────────────────────
const DIFF_WARN   = 0.3;    // L/min — enter LEAK state
const DIFF_ALERT  = 0.5;    // L/min — higher urgency leak
const DIFF_MAX    = 1.0;    // L/min — score saturation point
const RISK_BOOST  = 2.0;    // score multiplier
const BURST_RATIO = 2.0;    // sensor spike threshold (x rolling avg)
const AVG_ALPHA   = 0.1;    // EMA smoothing factor

let avgLpm1 = null, avgLpm2 = null;

function assessRisk(lpm1, lpm2) {
  const diff = Math.abs(lpm1 - lpm2);

  if (avgLpm1 === null) { avgLpm1 = lpm1; avgLpm2 = lpm2; }
  else {
    avgLpm1 = AVG_ALPHA * lpm1 + (1 - AVG_ALPHA) * avgLpm1;
    avgLpm2 = AVG_ALPHA * lpm2 + (1 - AVG_ALPHA) * avgLpm2;
  }

  let leak = 0, burst = 0, rawScore = 0;
  if (diff > DIFF_ALERT)     { leak = 2; rawScore = diff / DIFF_MAX; }
  else if (diff > DIFF_WARN) { leak = 1; rawScore = diff / DIFF_MAX; }

  const spike1 = avgLpm1 > 0.05 && lpm1 > avgLpm1 * BURST_RATIO;
  const spike2 = avgLpm2 > 0.05 && lpm2 > avgLpm2 * BURST_RATIO;
  if (spike1 || spike2) { burst = 1; rawScore = 1.0; }

  const score = Math.min(1.0, rawScore * RISK_BOOST);

  let label = "NORMAL";
  if (burst)          label = "BURST_DETECTED";
  else if (leak >= 1) label = "LEAK_DETECTED";

  return { score, label, diff };
}

// ─── THREE-TIER ALERT CATEGORY ───────────────────────────────────────────────
function categorize(label, score) {
  if (label === "BURST_DETECTED") return "BURST";
  if (label === "LEAK_DETECTED" && score >= 0.6) return "LEAK_HIGH";
  if (label === "LEAK_DETECTED") return "LEAK_LOW";
  return "NORMAL";
}

function buildMessage(category, diff, score) {
  const pct = Math.round(score * 100);
  const d = diff.toFixed(2);
  switch (category) {
    case "BURST":
      return `🚨 BURST DETECTED\nSensor flow spike (ΔQ ${d} L/min, risk ${pct}%). Valve closing — check immediately.`;
    case "LEAK_HIGH":
      return `⚠️ Leak confirmed\nΔQ ${d} L/min, risk ${pct}%. Recommend immediate inspection.`;
    case "LEAK_LOW":
      return `💧 Possible leak\nΔQ ${d} L/min, risk ${pct}%. Flow above baseline — monitoring.`;
    default:
      return null;
  }
}

// ─── COOLDOWN ────────────────────────────────────────────────────────────────
const lastSentAt = { BURST: 0, LEAK_HIGH: 0, LEAK_LOW: 0 };
const shouldSend = (c) => (Date.now() / 1000 - lastSentAt[c]) >= COOLDOWN_SECONDS;
const markSent   = (c) => { lastSentAt[c] = Date.now() / 1000; };

// ─── STARTUP VALIDATION ──────────────────────────────────────────────────────
if (!PHOTON_PROJECT_ID || !PHOTON_SECRET) {
  console.error("❌ Missing PHOTON_PROJECT_ID or PHOTON_SECRET.");
  console.error("   Create a .env file (see .env.example).");
  process.exit(1);
}

// ─── INIT SPECTRUM ───────────────────────────────────────────────────────────
console.log("Connecting to Spectrum...");
const app = await Spectrum({
  projectId: PHOTON_PROJECT_ID,
  projectSecret: PHOTON_SECRET,
  providers: [imessage.config()],
});
console.log("✅ Spectrum connected\n");

// ─── CAPTURE ALERT DESTINATION FROM INCOMING MESSAGE ─────────────────────────
// Spectrum can only send into spaces it knows about (i.e. someone messaged
// the agent first). We listen for the first incoming message and lock that
// space as our alert destination.
let alertSpace = null;

console.log("👋 Text your Photon agent from your iPhone now to arm alerts.");
console.log("   (Any message works — we just need a conversation to reply into.)\n");

(async () => {
  for await (const [space, message] of app.messages) {
    if (!alertSpace) {
      alertSpace = space;
      const senderId = message.sender?.id ?? "unknown";
      console.log(`✅ Alerts armed. Destination: ${senderId}\n`);
      try {
        await app.send(space, "🔒 WaterShield is armed. You'll get alerts here when leaks are detected.");
      } catch (err) {
        console.error("Failed to send acknowledgement:", err.message);
      }
    }
    // Ignore further incoming messages — this is a one-way alert system.
  }
})();

// ─── CONNECT TO SENSOR BRIDGE ────────────────────────────────────────────────
function connect() {
  const ws = new WebSocket(BRIDGE_URL);

  ws.on("open",  () => console.log(`✅ Connected to sensor bridge at ${BRIDGE_URL}`));
  ws.on("error", (err) => console.error(`Bridge error: ${err.message}`));
  ws.on("close", () => {
    console.log("Bridge disconnected. Retrying in 2s...");
    setTimeout(connect, 2000);
  });

  ws.on("message", async (raw) => {
    let r;
    try { r = JSON.parse(raw.toString()); } catch { return; }
    if (typeof r.lpm1 !== "number" || typeof r.lpm2 !== "number") return;

    const { score, label, diff } = assessRisk(r.lpm1, r.lpm2);
    const category = categorize(label, score);

    if (category === "NORMAL") return;
    if (!shouldSend(category)) return;

    if (!alertSpace) {
      console.log(`⏸  ${category} detected — text the agent first to arm alerts.`);
      return;
    }

    const text = buildMessage(category, diff, score);
    if (!text) return;

    try {
      await app.send(alertSpace, text);
      markSent(category);
      console.log(
        `[${new Date().toLocaleTimeString()}] ${category} → sent ` +
        `(ΔQ ${diff.toFixed(2)}, risk ${Math.round(score * 100)}%)`
      );
    } catch (err) {
      console.error(`❌ Send failed:`, err.message);
    }
  });
}

connect();
console.log(`📡 Watching ${BRIDGE_URL} — Ctrl+C to stop.\n`);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await app.stop();
  process.exit(0);
});
