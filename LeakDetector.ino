#include <Arduino.h>
#include <ESP32Servo.h>

// ── Pins ──────────────────────────────────────────────────────────────────────
constexpr uint8_t PIN_FLOW_1  = 4;
constexpr uint8_t PIN_FLOW_2  = 5;
constexpr uint8_t PIN_SERVO   = 18;

// ── Sensor calibration ────────────────────────────────────────────────────────
constexpr float HZ_TO_LPM = 1.0f / 38.0f;
constexpr float ALPHA      = 0.3f;

// ── Risk thresholds ───────────────────────────────────────────────────────────
constexpr float DIFF_WARN   = 0.3f;
constexpr float DIFF_ALERT  = 0.5f;
constexpr float DIFF_MAX    = 1.0f;
constexpr float RISK_BOOST  = 2.0f;
constexpr float BURST_RATIO = 2.0f;
constexpr float AVG_ALPHA   = 0.1f;

// ── Risk struct (must be declared before use) ─────────────────────────────────
struct Risk {
  float score;
  uint8_t leak;
  uint8_t burst;
  const char* label;
};

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
int currentAngle = 0;

Servo valveServo;

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

  bool spike1 = (avgLpm1 > 0.05f) && (lpm1 > avgLpm1 * BURST_RATIO);
  bool spike2 = (avgLpm2 > 0.05f) && (lpm2 > avgLpm2 * BURST_RATIO);
  if (spike1 || spike2) { burst = 1; rawScore = 1.0f; }

  float score = min(1.0f, rawScore * RISK_BOOST);

  const char* label = "NORMAL";
  if (burst)          label = "BURST_DETECTED";
  else if (leak == 2) label = "LEAK_ALERT";
  else if (leak == 1) label = "LEAK_WARNING";

  Risk r;
  r.score = score;
  r.leak  = leak;
  r.burst = burst;
  r.label = label;
  return r;
}

// ── Valve control ─────────────────────────────────────────────────────────────
void setValve(int angle) {
  if (angle == currentAngle) return;
  valveServo.write(angle);
  currentAngle = angle;
  Serial.printf("{\"event\":\"motor\",\"angle\":%d}\n", angle);
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  pinMode(PIN_FLOW_1, INPUT);
  pinMode(PIN_FLOW_2, INPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_FLOW_1), isr1, RISING);
  attachInterrupt(digitalPinToInterrupt(PIN_FLOW_2), isr2, RISING);

  valveServo.attach(PIN_SERVO);
  valveServo.write(0);

  lastMs = millis();
  Serial.println("{\"event\":\"boot\",\"msg\":\"LeakDetector ready\"}");
}

// ── Main loop ─────────────────────────────────────────────────────────────────
void loop() {
  // Handle motor commands from serial bridge
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.startsWith("MOTOR:")) {
      int angle = cmd.substring(6).toInt();
      setValve(angle);
    }
  }

  // Read sensors every 1 second
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

  // Auto valve control (backup safety even without dashboard)
  if (risk.leak > 0 || risk.burst > 0) setValve(180);
  else                                  setValve(0);

  // JSON output
  Serial.printf(
    "{\"t\":%lu,\"lpm1\":%.4f,\"lpm2\":%.4f,\"diff\":%.4f,"
    "\"totL1\":%.3f,\"totL2\":%.3f,"
    "\"risk\":{\"score\":%.3f,\"leak\":%u,\"burst\":%u,\"label\":\"%s\"},"
    "\"motor\":%d}\n",
    now / 1000, ema1, ema2, fabsf(ema1 - ema2),
    total1, total2,
    risk.score, risk.leak, risk.burst, risk.label,
    currentAngle
  );
}
