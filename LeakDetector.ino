#include <Arduino.h>

// ── Pins ──────────────────────────────────────────────────────────────────────
constexpr uint8_t PIN_FLOW_1  = 4;
constexpr uint8_t PIN_FLOW_2  = 5;
constexpr uint8_t PIN_MOTOR   = 25;   // GPIO25 → base resistor → PNP base

// ── Motor PWM (ESP32 core 3.x API) ────────────────────────────────────────────
constexpr int MOTOR_FREQ = 1000;  // Hz — lower freq for cleaner PNP switching
constexpr int MOTOR_RES  = 8;     // bits → 0-255

// PNP transistor inverts logic: GPIO LOW = motor ON, GPIO HIGH = motor OFF.
// motorWrite(255) = full speed ON, motorWrite(0) = fully OFF.
void motorWrite(uint8_t speed) {
  ledcWrite(PIN_MOTOR, 255 - speed);
}
void motorOn()  { motorWrite(255); }
void motorOff() { motorWrite(0);   }

// ── Sensor calibration ────────────────────────────────────────────────────────
// GR-402B: F(Hz) = Q(L/min) * 38  →  Q(L/min) = pulses_per_second / 38
constexpr float HZ_TO_LPM = 1.0f / 38.0f;
constexpr float ALPHA      = 0.3f;   // EMA smoothing for flow readings

// ── Risk thresholds ───────────────────────────────────────────────────────────
constexpr float DIFF_WARN   = 0.1f;  // L/min diff → leak detected
constexpr float DIFF_ALERT  = 0.3f;  // L/min diff → burst detected
constexpr float DIFF_MAX    = 0.6f;  // score normaliser / graph ceiling
constexpr float FLOW_HIGH   = 5.0f;  // L/min absolute → contributes to risk score
constexpr float RISK_BOOST  = 2.0f;
constexpr float BURST_RATIO = 2.0f;
constexpr float AVG_ALPHA   = 0.1f;

// ── Valve timing ──────────────────────────────────────────────────────────────
// How long to run the motor to achieve ~180°.
// CALIBRATE THIS: run the debug sketch, time your motor for 180°, set here.
constexpr uint32_t VALVE_MS = 500;

// ── Risk struct ───────────────────────────────────────────────────────────────
struct Risk {
  float score;
  uint8_t leak;
  uint8_t burst;
  const char* label;
};

Risk assessRisk(float lpm1, float lpm2);  // forward declaration

// ── ISR pulse counters ────────────────────────────────────────────────────────
volatile uint32_t pulses1 = 0;
volatile uint32_t pulses2 = 0;

void IRAM_ATTR isr1() { pulses1++; }
void IRAM_ATTR isr2() { pulses2++; }

// ── State ─────────────────────────────────────────────────────────────────────
float ema1 = 0, ema2 = 0;
float total1 = 0, total2 = 0;
float avgLpm1 = -1, avgLpm2 = -1;
uint32_t lastMs = 0;
uint32_t n = 0;
bool motorRunning   = false;
bool valveTriggered = false;  // latches true on first leak; never resets until reboot

// ── Risk assessment ───────────────────────────────────────────────────────────
Risk assessRisk(float lpm1, float lpm2) {
  float diff = fabsf(lpm1 - lpm2);

  if (avgLpm1 < 0) { avgLpm1 = lpm1; avgLpm2 = lpm2; }
  else {
    avgLpm1 = AVG_ALPHA * lpm1 + (1 - AVG_ALPHA) * avgLpm1;
    avgLpm2 = AVG_ALPHA * lpm2 + (1 - AVG_ALPHA) * avgLpm2;
  }

  uint8_t leak = 0, burst = 0;
  float rawScore = 0;

  if (diff > DIFF_ALERT)     { leak = 2; rawScore = diff / DIFF_MAX; }
  else if (diff > DIFF_WARN) { leak = 1; rawScore = diff / DIFF_MAX; }

  // Also factor in absolute flow rate — high flow on either sensor adds to risk
  float flowScore = max(lpm1, lpm2) / FLOW_HIGH;
  rawScore = max(rawScore, min(0.5f, flowScore));  // flow alone caps at 50% risk

  bool spike1 = (avgLpm1 > 0.05f) && (lpm1 > avgLpm1 * BURST_RATIO);
  bool spike2 = (avgLpm2 > 0.05f) && (lpm2 > avgLpm2 * BURST_RATIO);
  if (spike1 || spike2) { burst = 1; rawScore = 1.0f; }

  float score = min(1.0f, rawScore * RISK_BOOST);

  const char* label = "NORMAL";
  if (burst)          label = "BURST_DETECTED";
  else if (leak == 2) label = "BURST_DETECTED";
  else if (leak == 1) label = "LEAK_DETECTED";

  Risk r;
  r.score = score;
  r.leak  = leak;
  r.burst = burst;
  r.label = label;
  return r;
}

// ── Valve control ─────────────────────────────────────────────────────────────
// One-shot: runs motor for VALVE_MS ms (~180°) on first leak, then stops forever.
// Can be reset via VALVE:UNLOCK serial command from dashboard.
void triggerValve() {
  if (valveTriggered) return;
  valveTriggered = true;
  motorRunning   = true;
  Serial.println("{\"event\":\"valve\",\"action\":\"closing\"}");
  motorOn();
  delay(VALVE_MS);
  motorOff();
  motorRunning = false;
  Serial.println("{\"event\":\"valve\",\"action\":\"closed\"}");
}

void unlockValve() {
  valveTriggered = false;
  motorOff();
  motorRunning = false;
  Serial.println("{\"event\":\"valve\",\"action\":\"unlocked\"}");
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  pinMode(PIN_FLOW_1, INPUT);
  pinMode(PIN_FLOW_2, INPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_FLOW_1), isr1, RISING);
  attachInterrupt(digitalPinToInterrupt(PIN_FLOW_2), isr2, RISING);

  ledcAttach(PIN_MOTOR, MOTOR_FREQ, MOTOR_RES);
  motorOff();  // safe state on boot

  lastMs = millis();
  Serial.println("{\"event\":\"boot\",\"msg\":\"LeakDetector ready\"}");
}

// ── Main loop ─────────────────────────────────────────────────────────────────
void loop() {
  // Handle commands from dashboard via serial bridge
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "VALVE:UNLOCK") {
      unlockValve();
    }
  }

  uint32_t now = millis();
  if (now - lastMs < 1000) return;
  uint32_t dt = now - lastMs;
  lastMs = now;
  n++;

  noInterrupts();
  uint32_t p1 = pulses1; pulses1 = 0;
  uint32_t p2 = pulses2; pulses2 = 0;
  interrupts();

  float hz1  = p1 * 1000.0f / dt;
  float hz2  = p2 * 1000.0f / dt;
  float lpm1 = hz1 * HZ_TO_LPM;
  float lpm2 = hz2 * HZ_TO_LPM;

  if (n == 1) { ema1 = lpm1; ema2 = lpm2; }
  else {
    ema1 = ALPHA * lpm1 + (1 - ALPHA) * ema1;
    ema2 = ALPHA * lpm2 + (1 - ALPHA) * ema2;
  }

  total1 += lpm1 / 60.0f;
  total2 += lpm2 / 60.0f;

  Risk risk = assessRisk(ema1, ema2);

  // Trigger valve on first leak detection — one-shot, never fires again
  if (risk.leak > 0 && !valveTriggered) {
    triggerValve();
  }

  // JSON output to serial bridge
  Serial.printf(
    "{\"t\":%lu,\"lpm1\":%.4f,\"lpm2\":%.4f,\"diff\":%.4f,"
    "\"totL1\":%.3f,\"totL2\":%.3f,"
    "\"risk\":{\"score\":%.3f,\"leak\":%u,\"burst\":%u,\"label\":\"%s\"},"
    "\"motor\":%s,\"valveClosed\":%s}\n",
    now / 1000, ema1, ema2, fabsf(ema1 - ema2),
    total1, total2,
    risk.score, risk.leak, risk.burst, risk.label,
    motorRunning   ? "true" : "false",
    valveTriggered ? "true" : "false"
  );
}
