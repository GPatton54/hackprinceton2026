import React from 'react';
import * as Recharts from 'recharts';

const { useState, useEffect } = React;
const { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } = Recharts;

const DIFF_WARN  = 0.2;
const DIFF_ALERT = 0.4;
const DIFF_MAX   = 0.8;

function assessRisk(lpm1, lpm2) {
  const diff = Math.abs(lpm1 - lpm2);
  let label = "NORMAL";
  if (diff > DIFF_ALERT)     label = "BURST_DETECTED";
  else if (diff > DIFF_WARN) label = "LEAK_DETECTED";
  return { diff, label };
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

export default function PipeHealthDashboard() {
  const [readings, setReadings]       = useState([]);
  const [alerts, setAlerts]           = useState([]);
  const [connected, setConnected]     = useState(false);
  const [valveClosed, setValveClosed] = useState(false);
  const wsRef = React.useRef(null);

  const closeValve = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send("VALVE:CLOSE");
    }
  };

  const unlockValve = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send("VALVE:UNLOCK");
    }
  };

  const lastAlertRef = React.useRef({ label: "NORMAL", time: 0 });

  useEffect(() => {
    let ws;
    function connect() {
      ws = new WebSocket("ws://localhost:8765");
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        console.log("Connected to ESP32 bridge");
      };

      ws.onmessage = (e) => {
        try {
          const r = JSON.parse(e.data);

          // Update valve state from ESP32 — source of truth
          if (r.valveClosed !== undefined) setValveClosed(r.valveClosed);
          if (r.event === "valve" && r.action === "unlocked") setValveClosed(false);
          if (r.event === "valve" && r.action === "closed")   setValveClosed(true);

          if (r.lpm1 === undefined) return;

          const risk = assessRisk(r.lpm1, r.lpm2);
          const reading = {
            lpm1:  r.lpm1,
            lpm2:  r.lpm2,
            diff:  risk.diff,
            label: risk.label,
          };

          setReadings(prev => [...prev.slice(-59), reading]);

          if (risk.label !== "NORMAL") {
            const now = Date.now();
            const last = lastAlertRef.current;
            if (risk.label !== last.label || now - last.time > 30000) {
              lastAlertRef.current = { label: risk.label, time: now };
              setAlerts(prev => [
                { id: now, time: new Date().toLocaleTimeString(), ...reading },
                ...prev.slice(0, 49)
              ]);
            }
          } else {
            lastAlertRef.current = { label: "NORMAL", time: 0 };
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
  const showBanner = latest.label && latest.label !== "NORMAL";

  return (
    <div style={{ fontFamily: "sans-serif", padding: "1rem", color: "#111", maxWidth: 900, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div>
          <p style={{ margin: 0, fontSize: 24, color: "#888", letterSpacing: "0.08em" }}>WaterShield Alerts</p>
          <p style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>Live sensor dashboard</p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{
            fontSize: 15, padding: "7px 16px", borderRadius: 20,
            background: valveClosed ? "rgba(226,75,74,0.10)" : "rgba(29,158,117,0.10)",
            color:      valveClosed ? "#e24b4a" : "#1d9e75",
            border:    `1px solid ${valveClosed ? "#e24b4a40" : "#1d9e7540"}`,
            fontWeight: 500,
          }}>
            {valveClosed ? "🔒 Valve closed" : "✅ Valve open"}
          </span>

          {valveClosed && (
            <button onClick={unlockValve} style={{
              fontSize: 15, padding: "7px 18px", borderRadius: 20, cursor: "pointer",
              background: "#fff", color: "#185fa5",
              border: "1px solid #185fa5", fontWeight: 500,
            }}>
              🔓 Unlock valve
            </button>
          )}

          {!valveClosed && (
            <button onClick={closeValve} style={{
              fontSize: 15, padding: "7px 18px", borderRadius: 20, cursor: "pointer",
              background: "#fff", color: "#e24b4a",
              border: "1px solid #e24b4a", fontWeight: 500,
            }}>
              🔒 Close valve
            </button>
          )}

          <span style={{
            fontSize: 15, padding: "7px 16px", borderRadius: 20,
            background: connected ? "rgba(29,158,117,0.10)" : "rgba(226,75,74,0.10)",
            color:      connected ? "#1d9e75" : "#e24b4a",
            border:    `1px solid ${connected ? "#1d9e7540" : "#e24b4a40"}`,
            fontWeight: 500,
          }}>
            {connected ? "● Connected" : "○ Waiting for ESP32..."}
          </span>
        </div>
      </div>

      {readings.length === 0 && (
        <div style={{ padding: 16, marginBottom: 16, borderRadius: 8, background: "rgba(239,159,39,0.10)", border: "1px solid #ef9f2740", fontSize: 13, color: "#ba7517" }}>
          Waiting for data from ESP32… Make sure serial_bridge.py is running and the board is connected.
        </div>
      )}

      {showBanner && (
        <div style={{ padding: "12px 16px", marginBottom: 14, borderRadius: 8, background: bg, border: `1px solid ${col}40`, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>{latest.label === "BURST_DETECTED" ? "💥" : "⚠️"}</span>
          <div>
            <p style={{ margin: 0, fontWeight: 600, color: col, fontSize: 14 }}>{riskLabel(latest.label)}</p>
            <p style={{ margin: 0, fontSize: 12, color: "#666" }}>Flow diff: {latest.diff?.toFixed(3)} L/min</p>
          </div>
        </div>
      )}

      {/* Metric cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginBottom: 16 }}>
        {[
          { label: "Status",    value: riskLabel(latest.label || "NORMAL"),                              color: col,    background: bg },
          { label: "Sensor 1",  value: latest.lpm1 != null ? `${latest.lpm1.toFixed(3)} L/min` : "–",  color: "#111", background: "#f5f5f5" },
          { label: "Sensor 2",  value: latest.lpm2 != null ? `${latest.lpm2.toFixed(3)} L/min` : "–",  color: "#111", background: "#f5f5f5" },
          { label: "Flow diff", value: latest.diff  != null ? `${latest.diff.toFixed(3)} L/min` : "–", color: col,    background: bg },
        ].map(({ label, value, color, background }) => (
          <div key={label} style={{ background, borderRadius: 8, padding: "10px 14px", border: "1px solid #e5e5e5" }}>
            <p style={{ margin: "0 0 4px", fontSize: 11, color: "#888", textTransform: "uppercase" }}>{label}</p>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 500, color }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Flow rates chart */}
      <div style={{ background: "#fff", border: "1px solid #e5e5e5", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
        <p style={{ margin: "0 0 12px", fontSize: 12, fontWeight: 500, color: "#555", textTransform: "uppercase" }}>Flow rates</p>
        {readings.length === 0 ? (
          <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: "#aaa", fontSize: 13 }}>No data yet — waiting for ESP32</div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={readings} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#eee" />
              <XAxis hide />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip formatter={v => `${Number(v).toFixed(3)} L/min`} labelFormatter={() => ""} />
              <Line type="monotone" dataKey="lpm1" stroke="#185fa5" dot={false} strokeWidth={1.5} name="Sensor 1" />
              <Line type="monotone" dataKey="lpm2" stroke="#0f6e56" dot={false} strokeWidth={1.5} name="Sensor 2" strokeDasharray="4 2" />
            </LineChart>
          </ResponsiveContainer>
        )}
        <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11, color: "#888" }}>
          <span style={{ color: "#185fa5" }}>— Sensor 1</span>
          <span style={{ color: "#0f6e56" }}>- - Sensor 2</span>
          <span style={{ marginLeft: "auto" }}>Last 60 seconds</span>
        </div>
      </div>

      {/* Flow difference chart */}
      <div style={{ background: "#fff", border: "1px solid #e5e5e5", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
        <p style={{ margin: "0 0 12px", fontSize: 12, fontWeight: 500, color: "#555", textTransform: "uppercase" }}>Flow difference</p>
        {readings.length === 0 ? (
          <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: "#aaa", fontSize: 13 }}>No data yet — waiting for ESP32</div>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={readings} margin={{ top: 4, right: 90, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#eee" />
              <XAxis hide />
              <YAxis domain={[0, DIFF_MAX]} tick={{ fontSize: 10 }} />
              <Tooltip formatter={v => `${Number(v).toFixed(3)} L/min`} labelFormatter={() => ""} />
              <ReferenceLine y={DIFF_WARN} stroke="#ef9f27" strokeDasharray="3 3"
                label={{ value: `leak ${DIFF_WARN} L/min`, position: "right", fontSize: 9, fill: "#ef9f27" }} />
              <ReferenceLine y={DIFF_ALERT} stroke="#e24b4a" strokeDasharray="3 3"
                label={{ value: `burst ${DIFF_ALERT} L/min`, position: "right", fontSize: 9, fill: "#e24b4a" }} />
              <Area type="monotone" dataKey="diff" stroke="#185fa5" fill="rgba(24,95,165,0.12)"
                dot={false} strokeWidth={1.5} name="Flow diff" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
        <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11, color: "#888" }}>
          <span style={{ color: "#185fa5" }}>— Flow difference</span>
          <span style={{ color: "#ef9f27" }}>— Leak threshold ({DIFF_WARN} L/min)</span>
          <span style={{ color: "#e24b4a" }}>— Burst threshold ({DIFF_ALERT} L/min)</span>
          <span style={{ marginLeft: "auto" }}>Last 60 seconds</span>
        </div>
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
              <span style={{ color: "#888", marginLeft: "auto" }}>ΔQ: {a.diff.toFixed(3)} L/min</span>
            </div>
          ))
        }
      </div>

      <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "#f9f9f9", border: "1px solid #e5e5e5", fontSize: 11, color: "#888" }}>
        Thresholds — leak: ΔQ &gt; {DIFF_WARN} L/min &nbsp;·&nbsp; burst: ΔQ &gt; {DIFF_ALERT} L/min
      </div>
    </div>
  );
}