import React from 'react';
import * as Recharts from 'recharts';

const { useState, useEffect } = React;
const { LineChart, Line, AreaChart, Area, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } = Recharts;

// ── Thresholds ────────────────────────────────────────────────────────────────
const DIFF_WARN   = 0.3;
const DIFF_ALERT  = 0.5;
const DIFF_MAX    = 1.0;
const RISK_BOOST  = 2.0;
const BURST_RATIO = 2.0;

let avgLpm1 = null, avgLpm2 = null;
const AVG_ALPHA = 0.1;

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
  if (burst)           label = "BURST_DETECTED";
  else if (leak === 2) label = "LEAK_DETECTED";
  else if (leak === 1) label = "LEAK_DETECTED";

  return { score, leak, burst, label, diff };
}

function statusColor(l) {
  if (l === "BURST_DETECTED") return "#e24b4a";
  if (l === "LEAK_DETECTED")  return "#ef9f27";
  return "#1d9e75";
}

function statusBg(l) {
  if (l === "BURST_DETECTED") return "rgba(226,75,74,0.10)";
  if (l === "LEAK_DETECTED")  return "rgba(239,159,39,0.12)";
  return "rgba(29,158,117,0.10)";
}

function riskLabel(l) {
  return { NORMAL: "Normal", LEAK_DETECTED: "Leak detected", BURST_DETECTED: "Burst detected" }[l] || l;
}

// Custom dot that only renders when score crosses a threshold
function AlertDot(props) {
  const { cx, cy, payload } = props;
  if (!payload || payload.score < 0.3) return null;
  const color = payload.score >= 0.6 ? "#e24b4a" : "#ef9f27";
  return <circle cx={cx} cy={cy} r={4} fill={color} stroke="#fff" strokeWidth={1.5} />;
}

export default function PipeHealthDashboard() {
  const [readings, setReadings]   = useState([]);
  const [alerts, setAlerts]       = useState([]);
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState("flow");

  useEffect(() => {
    let ws;
    function connect() {
      ws = new WebSocket("ws://localhost:8765");

      ws.onopen = () => {
        setConnected(true);
        console.log("Connected to ESP32 bridge");
      };

      ws.onmessage = (e) => {
        try {
          const r = JSON.parse(e.data);
          const risk = assessRisk(r.lpm1, r.lpm2);

          const reading = {
            lpm1:  r.lpm1,
            lpm2:  r.lpm2,
            diff:  risk.diff,
            score: risk.score,
            label: risk.label,
            temp:  r.temp ?? 0,
          };

          setReadings(prev => [...prev.slice(-29), reading]);

          if (reading.label !== "NORMAL") {
            setAlerts(prev => [
              { id: Date.now(), time: new Date().toLocaleTimeString(), ...reading },
              ...prev.slice(0, 49)
            ]);
          }
        } catch (err) {
          console.error("Bad JSON from bridge:", err);
        }
      };

      ws.onerror = () => {
        setConnected(false);
        console.error("WebSocket error — is serial_bridge.py running?");
      };

      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 2000);
      };
    }

    connect();
    return () => { if (ws) ws.close(); };
  }, []);

  const latest = readings[readings.length - 1] || {};
  const col = statusColor(latest.label || "NORMAL");
  const bg  = statusBg(latest.label  || "NORMAL");

  // ── Derived alert banner ──────────────────────────────────────────────────
  const showBanner = latest.label && latest.label !== "NORMAL";

  return (
    <div style={{ fontFamily: "sans-serif", padding: "1rem", color: "#111", maxWidth: 900, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div>
          <p style={{ margin: 0, fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em" }}>Pipe health monitor</p>
          <p style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>Live sensor dashboard</p>
        </div>
        <span style={{
          fontSize: 12, padding: "4px 12px", borderRadius: 20,
          background: connected ? "rgba(29,158,117,0.10)" : "rgba(226,75,74,0.10)",
          color:      connected ? "#1d9e75" : "#e24b4a",
          border:    `1px solid ${connected ? "#1d9e7540" : "#e24b4a40"}`
        }}>
          {connected ? "● Connected" : "○ Waiting for ESP32..."}
        </span>
      </div>

      {/* No data banner */}
      {readings.length === 0 && (
        <div style={{ padding: 16, marginBottom: 16, borderRadius: 8, background: "rgba(239,159,39,0.10)", border: "1px solid #ef9f2740", fontSize: 13, color: "#ba7517" }}>
          Waiting for data from ESP32… Make sure serial_bridge.py is running and the board is on COM8.
        </div>
      )}

      {/* Active alert banner */}
      {showBanner && (
        <div style={{ padding: "12px 16px", marginBottom: 14, borderRadius: 8, background: bg, border: `1px solid ${col}40`, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>{latest.label === "BURST_DETECTED" ? "💥" : "⚠️"}</span>
          <div>
            <p style={{ margin: 0, fontWeight: 600, color: col, fontSize: 14 }}>{riskLabel(latest.label)}</p>
            <p style={{ margin: 0, fontSize: 12, color: "#666" }}>
              Flow diff: {latest.diff?.toFixed(2)} L/min &nbsp;·&nbsp; Risk: {Math.round((latest.score ?? 0) * 100)}%
            </p>
          </div>
        </div>
      )}

      {/* Metric cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginBottom: 16 }}>
        {[
          { label: "Status",      value: riskLabel(latest.label || "NORMAL"),                                    color: col,    background: bg },
          { label: "Sensor 1",    value: latest.lpm1 != null ? `${latest.lpm1.toFixed(2)} L/min` : "–",         color: "#111", background: "#f5f5f5" },
          { label: "Sensor 2",    value: latest.lpm2 != null ? `${latest.lpm2.toFixed(2)} L/min` : "–",         color: "#111", background: "#f5f5f5" },
          { label: "Flow diff",   value: latest.diff  != null ? `${latest.diff.toFixed(2)} L/min` : "–",        color: "#111", background: "#f5f5f5" },
          { label: "Risk score",  value: latest.score != null ? `${Math.round(latest.score * 100)}%` : "–",     color: col,    background: "#f5f5f5" },
          { label: "Temperature", value: latest.temp  != null && latest.temp !== 0 ? `${latest.temp} °C` : "–", color: "#111", background: "#f5f5f5" },
        ].map(({ label, value, color, background }) => (
          <div key={label} style={{ background, borderRadius: 8, padding: "10px 14px", border: "1px solid #e5e5e5" }}>
            <p style={{ margin: "0 0 4px", fontSize: 11, color: "#888", textTransform: "uppercase" }}>{label}</p>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 500, color }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Chart tabs — now only Flow and combined Diff + Risk */}
      <div style={{ background: "#fff", border: "1px solid #e5e5e5", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {["flow", "alert"].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              fontSize: 12, padding: "4px 12px", borderRadius: 5,
              border: "1px solid #ccc",
              background: activeTab === tab ? "#eee" : "#fff",
              cursor: "pointer",
              fontWeight: activeTab === tab ? 500 : 400
            }}>
              {tab === "flow" ? "Flow rates" : "Diff & risk"}
            </button>
          ))}
        </div>

        {readings.length === 0 ? (
          <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: "#aaa", fontSize: 13 }}>
            No data yet — waiting for ESP32
          </div>
        ) : activeTab === "flow" ? (
          // ── Flow rates chart ────────────────────────────────────────────────
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={readings} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#eee" />
              <XAxis hide />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip formatter={v => `${v.toFixed(3)} L/min`} labelFormatter={() => ""} />
              <Line type="monotone" dataKey="lpm1" stroke="#185fa5" dot={false} strokeWidth={1.5} name="Sensor 1" />
              <Line type="monotone" dataKey="lpm2" stroke="#0f6e56" dot={false} strokeWidth={1.5} name="Sensor 2" strokeDasharray="4 2" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          // ── Combined diff + risk chart ──────────────────────────────────────
          // Two stacked panels sharing the same X axis
          <div>
            {/* Flow diff panel */}
            <p style={{ margin: "0 0 4px", fontSize: 11, color: "#888", textTransform: "uppercase" }}>Flow difference (L/min)</p>
            <ResponsiveContainer width="100%" height={100}>
              <AreaChart data={readings} margin={{ top: 2, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="#eee" />
                <XAxis hide />
                <YAxis domain={[0, Math.max(DIFF_ALERT * 1.5, 0.8)]} tick={{ fontSize: 10 }} />
                <Tooltip formatter={v => `${v.toFixed(3)} L/min`} labelFormatter={() => ""} />
                <ReferenceLine y={DIFF_WARN}  stroke="#ef9f27" strokeDasharray="3 3"
                  label={{ value: `warn ${DIFF_WARN}`, position: "right", fontSize: 9, fill: "#ef9f27" }} />
                <ReferenceLine y={DIFF_ALERT} stroke="#e24b4a" strokeDasharray="3 3"
                  label={{ value: `alert ${DIFF_ALERT}`, position: "right", fontSize: 9, fill: "#e24b4a" }} />
                <Area type="monotone" dataKey="diff" stroke="#185fa5" fill="rgba(24,95,165,0.12)"
                  dot={false} strokeWidth={1.5} name="Flow diff" />
              </AreaChart>
            </ResponsiveContainer>

            <div style={{ height: 10 }} />

            {/* Risk score panel */}
            <p style={{ margin: "0 0 4px", fontSize: 11, color: "#888", textTransform: "uppercase" }}>Risk score</p>
            <ResponsiveContainer width="100%" height={100}>
              <AreaChart data={readings} margin={{ top: 2, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="#eee" />
                <XAxis hide />
                <YAxis domain={[0, 1]} tickFormatter={v => `${Math.round(v * 100)}%`} tick={{ fontSize: 10 }} />
                <Tooltip formatter={v => `${(v * 100).toFixed(1)}%`} labelFormatter={() => ""} />
                <ReferenceLine y={0.3} stroke="#ef9f27" strokeDasharray="3 3"
                  label={{ value: "warn 30%",  position: "right", fontSize: 9, fill: "#ef9f27" }} />
                <ReferenceLine y={0.6} stroke="#e24b4a" strokeDasharray="3 3"
                  label={{ value: "alert 60%", position: "right", fontSize: 9, fill: "#e24b4a" }} />
                <Area type="monotone" dataKey="score" stroke="#e24b4a" fill="rgba(226,75,74,0.15)"
                  dot={<AlertDot />} strokeWidth={1.5} name="Risk" />
              </AreaChart>
            </ResponsiveContainer>

            {/* Shared legend */}
            <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11, color: "#888" }}>
              <span style={{ color: "#185fa5" }}>— Flow diff</span>
              <span style={{ color: "#e24b4a" }}>— Risk score</span>
              <span style={{ color: "#ef9f27" }}>● Leak detected</span>
              <span style={{ color: "#e24b4a" }}>● Burst detected</span>
              <span style={{ marginLeft: "auto" }}>Last 30 s</span>
            </div>
          </div>
        )}

        {activeTab === "flow" && (
          <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11, color: "#888" }}>
            <span>— Sensor 1</span><span>- - Sensor 2</span>
            <span style={{ marginLeft: "auto" }}>Last 30 seconds</span>
          </div>
        )}
      </div>

      {/* Event log */}
      <div style={{ background: "#fff", border: "1px solid #e5e5e5", borderRadius: 10, padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>Event log</p>
          <span style={{ fontSize: 11, color: "#888" }}>{alerts.length} events</span>
        </div>
        {alerts.length === 0
          ? <p style={{ margin: 0, fontSize: 12, color: "#888", fontStyle: "italic" }}>No anomalies detected.</p>
          : alerts.slice(0, 15).map(a => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: "#f9f9f9", borderRadius: 6, marginBottom: 5, fontSize: 12 }}>
              <span style={{ color: "#888", minWidth: 70 }}>{a.time}</span>
              <span style={{ background: statusBg(a.label), color: statusColor(a.label), padding: "2px 8px", borderRadius: 4, fontWeight: 500, fontSize: 11 }}>
                {riskLabel(a.label)}
              </span>
              <span style={{ color: "#888", marginLeft: "auto" }}>
                ΔQ: {a.diff.toFixed(2)} L/min · risk {Math.round(a.score * 100)}%
              </span>
            </div>
          ))
        }
      </div>

      {/* Threshold legend */}
      <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "#f9f9f9", border: "1px solid #e5e5e5", fontSize: 11, color: "#888" }}>
        Thresholds — leak detected: ΔQ &gt; {DIFF_WARN} L/min · burst detected: sensor spikes 2× rolling average · risk boost: ×{RISK_BOOST}
      </div>
    </div>
  );
}