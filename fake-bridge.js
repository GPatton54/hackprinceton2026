// fake-bridge.js
//
// Pretends to be serial_bridge.py for testing leak-alerts.js without the ESP32.
// Usage: node fake-bridge.js [normal|leak|burst]

import { WebSocketServer } from "ws";

const scenario = (process.argv[2] || "normal").toLowerCase();
const validScenarios = ["normal", "leak", "burst"];

if (!validScenarios.includes(scenario)) {
  console.error(`Unknown scenario "${scenario}". Use: ${validScenarios.join(", ")}`);
  process.exit(1);
}

const wss = new WebSocketServer({ port: 8765 });

console.log(`Fake bridge running on ws://localhost:8765 (scenario: ${scenario})`);
console.log("Now run `npm start` in another terminal.\n");

wss.on("connection", (ws) => {
  console.log("Client connected");

  let tick = 0;
  const interval = setInterval(() => {
    tick++;

    // Baseline flow with small jitter
    let lpm1 = 1.0 + (Math.random() - 0.5) * 0.05;
    let lpm2 = 1.0 + (Math.random() - 0.5) * 0.05;

    if (scenario === "leak" && tick > 3) {
      // Steady leak: the two sensors now disagree by ~0.45 L/min
      lpm2 = lpm1 - 0.45;
    } else if (scenario === "burst" && tick === 5) {
      // One-off sharp spike on sensor 1
      lpm1 = 3.0;
    }

    const payload = { lpm1, lpm2, temp: 22 };
    ws.send(JSON.stringify(payload));
    console.log(
      `tick=${tick}  lpm1=${lpm1.toFixed(2)}  lpm2=${lpm2.toFixed(2)}  ` +
      `diff=${Math.abs(lpm1 - lpm2).toFixed(2)}`
    );
  }, 1000);

  ws.on("close", () => {
    clearInterval(interval);
    console.log("Client disconnected");
  });
});
