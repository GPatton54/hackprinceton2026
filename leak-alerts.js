// leak-alerts.js

import "dotenv/config";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import WebSocket from "ws";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BRIDGE_URL        = process.env.BRIDGE_URL        || "ws://localhost:8765";
const PHOTON_PROJECT_ID = process.env.PHOTON_PROJECT_ID;
const PHOTON_SECRET     = process.env.PHOTON_SECRET;
const COOLDOWN_SECONDS  = parseInt(process.env.COOLDOWN_SECONDS || "30", 10);

// ─── THRESHOLDS ──────────────────────────────────────────────────────────────
const DIFF_WARN  = 0.2;
const DIFF_ALERT = 0.4;

// ─── SEVERITY LOGIC ──────────────────────────────────────────────────────────
function assessRisk(lpm1, lpm2) {
  const diff = Math.abs(lpm1 - lpm2);
  let label = "NORMAL";
  if (diff > DIFF_ALERT)     label = "BURST_DETECTED";
  else if (diff > DIFF_WARN) label = "LEAK_DETECTED";
  return { diff, label };
}

function categorize(label) {
  if (label === "BURST_DETECTED") return "BURST";
  if (label === "LEAK_DETECTED")  return "LEAK";
  return "NORMAL";
}

function buildMessage(category, diff) {
  const d = diff.toFixed(2);
  switch (category) {
    case "BURST": return `🚨 BURST DETECTED\nΔQ ${d} L/min — major flow difference detected. The valve has been closed. Check piping immediately.`;
    case "LEAK":  return `⚠️ Leak detected\nΔQ ${d} L/min — flow difference above threshold. Go check piping for a leak.`;
    default: return null;
  }
}

// ─── COOLDOWN ────────────────────────────────────────────────────────────────
const lastSentAt = { BURST: 0, LEAK: 0 };
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

// ─── CAPTURE ALERT DESTINATION ───────────────────────────────────────────────
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
  }
})();

// ─── CONNECT TO SENSOR BRIDGE ────────────────────────────────────────────────
let warmedUp = false;
let burstAlertSent = false;

function connect() {
  const ws = new WebSocket(BRIDGE_URL);

  ws.on("open", () => {
    console.log(`✅ Connected to sensor bridge at ${BRIDGE_URL}`);
    warmedUp = false;
    burstAlertSent = false;
    setTimeout(() => {
      warmedUp = true;
      console.log("✅ Warmup done — monitoring active.");
    }, 5000);
  });

  ws.on("error", (err) => console.error(`Bridge error: ${err.message}`));

  ws.on("close", () => {
    console.log("Bridge disconnected. Retrying in 2s...");
    setTimeout(connect, 2000);
  });

  ws.on("message", async (raw) => {
    if (!warmedUp) return;

    let r;
    try { r = JSON.parse(raw.toString()); } catch { return; }

    // Listen for valve unlock — reset burst flag so alerts can fire again
    if (r.event === "valve" && r.action === "unlocked") {
      burstAlertSent = false;
      console.log("🔓 Valve unlocked — burst alert reset, monitoring resumed.");
      if (alertSpace) {
        try {
          await app.send(alertSpace, "🔓 Valve has been reopened. WaterShield is monitoring again.");
        } catch (err) {
          console.error("Failed to send unlock notification:", err.message);
        }
      }
      return;
    }

    // Block all messages after a burst until valve is reopened
    if (burstAlertSent) return;

    if (typeof r.lpm1 !== "number" || typeof r.lpm2 !== "number") return;

    const { diff, label } = assessRisk(r.lpm1, r.lpm2);
    const category = categorize(label);

    if (category === "NORMAL") return;
    if (!shouldSend(category)) return;

    if (!alertSpace) {
      console.log(`⏸  ${category} detected — text the agent first to arm alerts.`);
      return;
    }

    const text = buildMessage(category, diff);
    if (!text) return;

    try {
      await app.send(alertSpace, text);
      markSent(category);
      console.log(`[${new Date().toLocaleTimeString()}] ${category} → sent (ΔQ ${diff.toFixed(2)})`);

      if (category === "BURST") {
        burstAlertSent = true;
        console.log("🔒 Burst sent — all alerts paused until valve is unlocked.");
      }
    } catch (err) {
      console.error(`❌ Send failed:`, err.message);
    }
  });
}

connect();
console.log(`📡 Watching ${BRIDGE_URL} — Ctrl+C to stop.\n`);

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await app.stop();
  process.exit(0);
});