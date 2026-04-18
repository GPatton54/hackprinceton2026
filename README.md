# WaterShield Alerts

> Real-time iMessage alerts for a dual-sensor water leak detection system, built on [Photon Spectrum](https://photon.codes/spectrum).

When the WaterShield hardware detects abnormal water flow, this service sends a severity-aware iMessage to your phone — so you know about a leak before it floods your basement.

## What it does

- Connects to the ESP32 sensor bridge over WebSocket (`ws://localhost:8765`)
- Runs a dual-sensor flow-difference anomaly detector (same logic as the live dashboard)
- Classifies events into three severities: `LEAK_LOW`, `LEAK_HIGH`, `BURST`
- Sends severity-specific iMessages via Photon Spectrum
- Per-severity cooldown (default 30s) to prevent spam

## Architecture

```
┌──────────┐   serial   ┌─────────────────┐   WebSocket   ┌──────────────┐   Spectrum   ┌───────┐
│  ESP32   │ ─────────► │ serial_bridge.py│ ────────────► │leak-alerts.js│ ───────────► │ Your  │
│ sensors  │    USB     │  (Python host)  │  localhost    │   (Node.js)  │   iMessage   │ phone │
└──────────┘            └─────────────────┘    :8765      └──────────────┘              └───────┘
```

The same WebSocket feeds the React dashboard, so the alerts service runs in parallel without touching the existing stack.

## Severity rules

| Category | Trigger | Example message |
|---|---|---|
| `LEAK_LOW` | Flow diff > 0.3 L/min, risk score < 60% | 💧 Possible leak — monitoring |
| `LEAK_HIGH` | Flow diff > 0.3 L/min, risk score ≥ 60% | ⚠️ Leak confirmed — recommend inspection |
| `BURST` | Sensor spike > 2× rolling average | 🚨 Burst detected — valve closing |

Thresholds are defined at the top of `leak-alerts.js` and match the dashboard's `assessRisk()` function.

## Setup

### Prerequisites

- Node.js 18+
- A [Photon](https://photon.codes) account with iMessage provider configured and an agent number
- Your ESP32 + `serial_bridge.py` running (or `fake-bridge.js` for testing)

### Install

```bash
git clone https://github.com/YOUR-USERNAME/watershield-alerts.git
cd watershield-alerts
npm install
```

### Configure

Copy the example env file and fill in your Photon credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```
PHOTON_PROJECT_ID=your-project-id
PHOTON_SECRET=sve_your_secret_here
```

> ⚠️ Never commit `.env` — it's already in `.gitignore`.

### Run

```bash
npm start
```

On first run, text your Photon iMessage agent from your phone. You'll get back `🔒 WaterShield is armed.` — now alerts are active.

## Testing without hardware

A fake bridge that simulates sensor data is included:

```bash
# Terminal 1 — simulate a steady leak
node fake-bridge.js leak

# Terminal 2 — run the alert service
npm start
```

Scenarios: `normal`, `leak`, `burst`.

## Configuration

Edit these constants at the top of `leak-alerts.js`:

| Constant | Default | Purpose |
|---|---|---|
| `BRIDGE_URL` | `ws://localhost:8765` | Where to find the sensor WebSocket |
| `COOLDOWN_SECONDS` | `30` | Min seconds between repeat alerts of same severity |
| `DIFF_WARN` | `0.3` | Flow diff (L/min) to enter LEAK state |
| `DIFF_ALERT` | `0.5` | Flow diff (L/min) for higher urgency |
| `BURST_RATIO` | `2.0` | Rolling-avg multiplier that counts as a burst |

## Platform swap

Spectrum supports Telegram, WhatsApp, Slack, Discord, and more. To swap iMessage for Telegram, change two lines:

```javascript
import { telegram } from "spectrum-ts/providers/telegram";
// ...
providers: [telegram.config()],
```

And enable Telegram in your Photon dashboard.

## File map

```
watershield-alerts/
├── leak-alerts.js       # Main service: WebSocket → severity check → Spectrum send
├── fake-bridge.js       # Simulator for testing without hardware
├── package.json
├── .env.example         # Template for your Photon credentials
├── .gitignore
└── README.md
```

## Troubleshooting

**"No alerts ever fire"** → You need to text your Photon agent first. The script only knows where to send once you've initiated a conversation.

**"Invalid credentials"** → Check your `PHOTON_SECRET` in `.env` — it should start with `sve_`. Rotate it on the Photon dashboard if unsure.

**"Bridge disconnected"** → `serial_bridge.py` isn't running, or nothing is on port 8765. For testing without hardware, run `fake-bridge.js` first.

**Messages arrive hours late** → Check your phone's iMessage settings; the message is sent instantly by Spectrum.

## License

MIT
