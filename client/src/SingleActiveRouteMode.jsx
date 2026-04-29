/**
 * SingleActiveRouteMode.jsx  —  v1
 * =================================
 * NON-INTRUSIVE add-on. Replaces ONLY the map rendering layer.
 * Backend, WhatsApp, priority, socket — all untouched.
 *
 * Emits (window CustomEvents — App.jsx listens):
 *   'sarm-mode-active'  { active: bool }
 *   'sarm-route-update' { polyline:[[lat,lng]], activeStop, agentPos, distM }
 *
 * Props: deliveries, socket, backendUrl, speak
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import axios from 'axios';

// ── Haversine (metres) ────────────────────────────────────────────────────────
function hav(la1, lo1, la2, lo2) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}

// ── Bearing → direction label ─────────────────────────────────────────────────
function bearingDeg(la1, lo1, la2, lo2) {
  const dLo = (lo2 - lo1) * Math.PI / 180;
  const y = Math.sin(dLo) * Math.cos(la2 * Math.PI / 180);
  const x = Math.cos(la1 * Math.PI / 180) * Math.sin(la2 * Math.PI / 180)
    - Math.sin(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.cos(dLo);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}
function dirHint(agentHdg, brg) {
  const r = ((brg - agentHdg) + 360) % 360;
  if (r < 25 || r >= 335) return { t: 'Go Straight', a: '↑' };
  if (r < 70)  return { t: 'Slight Right', a: '↗' };
  if (r < 120) return { t: 'Turn Right',   a: '→' };
  if (r < 175) return { t: 'Sharp Right',  a: '↘' };
  if (r < 205) return { t: 'U-Turn',       a: '↓' };
  if (r < 255) return { t: 'Sharp Left',   a: '↙' };
  if (r < 300) return { t: 'Turn Left',    a: '←' };
  return              { t: 'Slight Left',  a: '↖' };
}
function fmtD(m) {
  return m == null ? '—' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

// ── Pick best unvisited stop ──────────────────────────────────────────────────
const SKIP_WA = new Set(['replied_no', 'answered_unavailable', 'not_answered']);
function pickBest(stops, lat, lng, done) {
  const cands = stops.filter(s => !done.has(s.customer_id) && !SKIP_WA.has(s.waStatus || s.wa_status || ''));
  if (!cands.length) return null;
  let best = null, bestScore = -Infinity;
  for (const s of cands) {
    const dist  = hav(lat, lng, s.lat, s.lng);
    const prox  = 1 / (dist / 1000 + 0.3);
    const prio  = s.combined_priority ?? s.priority_score ?? 0.5;
    const boost = (s.waStatus === 'replied_yes' || s.wa_status === 'replied_yes') ? 0.2 : 0;
    const score = prox * 0.5 + prio * 0.35 + boost * 0.15;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

// CSS tokens
const T = { card: 'rgba(15,23,42,0.98)', bdr: 'rgba(255,255,255,0.08)', blue: '#3b82f6', green: '#22c55e', amber: '#f59e0b', red: '#ef4444', tp: '#f1f5f9', ts: '#64748b', tm: '#94a3b8' };

const SARM_CSS = `
@keyframes sarm-march { to { stroke-dashoffset: -28; } }
.sarm-route { stroke-dasharray: 18 9; animation: sarm-march 0.7s linear infinite; }
@keyframes sarm-dest-ring {
  0%,100%{ box-shadow:0 0 0 3px #fff,0 0 0 6px #3b82f6,0 0 20px 8px #3b82f688; }
  50%    { box-shadow:0 0 0 3px #fff,0 0 0 11px #3b82f6,0 0 36px 16px #3b82f655; }
}
@keyframes sarm-dest-pulse { 0%,100%{transform:scale(1);} 50%{transform:scale(1.10);} }
.sarm-dest-icon { animation: sarm-dest-ring 1.8s ease-in-out infinite, sarm-dest-pulse 1.8s ease-in-out infinite; }
`;

export default function SingleActiveRouteMode({ deliveries, socket, backendUrl, speak }) {
  const [active,     setActive]    = useState(false);
  const [agentPos,   setAgentPos]  = useState(null);
  const [heading,    setHeading]   = useState(0);
  const [stops,      setStops]     = useState([]);
  const [done,       setDone]      = useState(new Set());
  const [activeStop, setActiveStop]= useState(null);
  const [distM,      setDistM]     = useState(null);
  const [collapsed,  setCollapsed] = useState(false);
  const [gpsStatus,  setGpsStatus] = useState('idle');
  const [fetching,   setFetching]  = useState(false);

  const stopsRef    = useRef([]);
  const doneRef     = useRef(new Set());
  const agentRef    = useRef(null);
  const activeRef   = useRef(null);
  const watchRef    = useRef(null);
  const debounceRef = useRef(null);
  const backendRef  = useRef(backendUrl);

  useEffect(() => { stopsRef.current  = stops;      }, [stops]);
  useEffect(() => { doneRef.current   = done;        }, [done]);
  useEffect(() => { agentRef.current  = agentPos;    }, [agentPos]);
  useEffect(() => { activeRef.current = activeStop;  }, [activeStop]);
  useEffect(() => { backendRef.current = backendUrl; }, [backendUrl]);

  const say = useCallback((t) => { try { if (typeof speak === 'function') speak(t); } catch {} }, [speak]);

  // Inject CSS once
  useEffect(() => {
    const id = 'sarm-css';
    if (document.getElementById(id)) return;
    const el = document.createElement('style'); el.id = id; el.textContent = SARM_CSS;
    document.head.appendChild(el);
    return () => document.getElementById(id)?.remove();
  }, []);

  // GPS watchPosition on mount
  useEffect(() => {
    if (!('geolocation' in navigator)) { setGpsStatus('denied'); return; }
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setAgentPos(p);
        if (pos.coords.heading != null) setHeading(pos.coords.heading);
        setGpsStatus('ok');
        window.dispatchEvent(new CustomEvent('hybrid-gps-live', { detail: p }));
      },
      () => setGpsStatus('denied'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
    return () => { if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current); };
  }, []);

  // Sync stops from deliveries prop + priority-reorder event
  useEffect(() => { if (deliveries?.length) setStops(deliveries); }, [deliveries]);
  useEffect(() => {
    const h = (e) => {
      const s = e.detail?.sorted || (Array.isArray(e.detail) ? e.detail : null);
      if (s?.length) setStops(s);
    };
    window.addEventListener('priority-reorder', h);
    return () => window.removeEventListener('priority-reorder', h);
  }, []);

  // WA replies update future stops only (never active stop)
  useEffect(() => {
    if (!socket) return;
    const onReply = (p) => {
      const { phone_10, reply_type } = p || {};
      if (!phone_10 || !reply_type) return;
      const norm = (x) => String(x || '').replace(/\D/g, '').slice(-10);
      setStops(prev => prev.map(s => {
        if (s.customer_id === activeRef.current?.customer_id) return s; // never touch active
        const match = norm(s.phone) === norm(phone_10) || norm(s.customer_phone) === norm(phone_10);
        if (!match) return s;
        return { ...s, waStatus: reply_type === 'yes' ? 'replied_yes' : reply_type === 'no' ? 'replied_no' : 'rescheduled' };
      }));
    };
    socket.on('whatsapp_reply', onReply);
    return () => socket.off('whatsapp_reply', onReply);
  }, [socket]);

  // Emit mode-active when active changes
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('sarm-mode-active', { detail: { active } }));
    if (!active) window.dispatchEvent(new CustomEvent('sarm-route-update', { detail: { polyline: null, activeStop: null } }));
  }, [active]);

  // Fetch OSRM road-aligned route (debounced 1.5 s to avoid hammering on GPS ticks)
  const fetchRoute = useCallback(async (agent, stop) => {
    if (!agent || !stop) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setFetching(true);
      try {
        const coords = `${agent.lng},${agent.lat};${stop.lng},${stop.lat}`;
        const res = await axios.post(`${backendRef.current}/api/route_batch`, { coords });
        if (res.data?.code === 'Ok') {
          const poly = res.data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
          const d = hav(agent.lat, agent.lng, stop.lat, stop.lng);
          setDistM(d);
          window.dispatchEvent(new CustomEvent('sarm-route-update', {
            detail: { polyline: poly, activeStop: stop, agentPos: agent, distM: d },
          }));
        }
      } catch { /* silent — use straight-line distance fallback */ }
      finally { setFetching(false); }
    }, 1500);
  }, []);

  // Pick next best stop and trigger route fetch
  const pickNext = useCallback(() => {
    const pos = agentRef.current;
    if (!pos || !stopsRef.current.length) return;
    const best = pickBest(stopsRef.current, pos.lat, pos.lng, doneRef.current);
    setActiveStop(best);
    if (best) {
      setDistM(hav(pos.lat, pos.lng, best.lat, best.lng));
      fetchRoute(pos, best);
      say(`Heading to ${best.customer_name || 'next customer'}.`);
    } else {
      say('All deliveries completed!');
      setActive(false);
    }
  }, [fetchRoute, say]);

  // Re-fetch route when agentPos changes (GPS update) and mode is active
  useEffect(() => {
    if (!active || !agentPos || !activeStop) return;
    setDistM(hav(agentPos.lat, agentPos.lng, activeStop.lat, activeStop.lng));
    fetchRoute(agentPos, activeStop);
  }, [agentPos, active]);

  // Start mode
  const startMode = () => {
    if (!agentPos) { say('Waiting for GPS.'); return; }
    if (!stops.length) { say('Upload a CSV first.'); return; }
    setDone(new Set());
    setActive(true);
    setTimeout(() => pickNext(), 60);
    say(`Single route mode started. ${stops.length} deliveries loaded.`);
  };

  // Mark delivered
  const markDelivered = () => {
    if (!activeStop) return;
    const newDone = new Set([...doneRef.current, activeStop.customer_id]);
    setDone(newDone);
    say(`Delivered to ${activeStop.customer_name || 'customer'}.`);
    const remaining = stopsRef.current.filter(s => !newDone.has(s.customer_id) && !SKIP_WA.has(s.waStatus || ''));
    if (!remaining.length) {
      say('All deliveries complete!');
      setActive(false);
      setActiveStop(null);
      return;
    }
    setTimeout(() => pickNext(), 120);
  };

  // Skip
  const skipStop = () => {
    if (!activeStop) return;
    const newDone = new Set([...doneRef.current, activeStop.customer_id]);
    setDone(newDone);
    say(`Skipping ${activeStop.customer_name || 'stop'}.`);
    setTimeout(() => pickNext(), 120);
  };

  // Stop mode
  const stopMode = () => {
    setActive(false); setActiveStop(null);
    say('Single route mode stopped.');
  };

  const dir = agentPos && activeStop
    ? dirHint(heading, bearingDeg(agentPos.lat, agentPos.lng, activeStop.lat, activeStop.lng))
    : null;
  const remaining = stops.filter(s => !done.has(s.customer_id)).length;
  const close     = distM != null && distM < 300;
  const riskClr   = activeStop?.risk_level === 'High' ? T.red : activeStop?.risk_level === 'Medium' ? T.amber : T.green;

  // Collapsed pill
  if (active && collapsed) {
    return (
      <button id="sarm-pill" onClick={() => setCollapsed(false)} style={{
        position: 'fixed', bottom: 96, right: 16, zIndex: 9800,
        background: 'linear-gradient(135deg,#0f4c9e,#1d4ed8)',
        border: '1.5px solid #3b82f6', borderRadius: 50, padding: '8px 18px',
        color: '#fff', fontWeight: 800, fontSize: 11, cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 6,
        boxShadow: '0 4px 18px rgba(59,130,246,0.5)', fontFamily: 'system-ui',
      }}>
        🗺 {activeStop?.customer_name?.split(' ')[0] || 'Dest'} · {fmtD(distM)}
      </button>
    );
  }

  return (
    <div style={{
      position: 'fixed', bottom: 96, right: 16, zIndex: 9800,
      width: 'min(360px, calc(100vw - 28px))',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <AnimatePresence mode="wait">
        <motion.div key="sarm-panel"
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 14, scale: 0.96 }}
          transition={{ duration: 0.25 }}
          style={{ background: T.card, border: `1px solid ${T.bdr}`, borderRadius: 20, overflow: 'hidden', boxShadow: '0 28px 70px rgba(0,0,0,0.7)' }}
        >
          {/* Header */}
          <div style={{
            background: active ? 'linear-gradient(135deg,#0f2d6e,#1e3a8a)' : 'linear-gradient(135deg,#0f172a,#1e293b)',
            padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            borderBottom: `1px solid ${T.bdr}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>🗺</span>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, color: T.tp, letterSpacing: 0.5 }}>Single Route Mode</div>
                <div style={{ fontSize: 9, color: T.ts, marginTop: 1 }}>
                  {active ? `${remaining} left · ${done.size} done` : 'One route · One destination'}
                  {' · '}
                  <span style={{ color: gpsStatus === 'ok' ? T.green : gpsStatus === 'denied' ? T.red : T.amber }}>
                    {gpsStatus === 'ok' ? '📍 GPS Live' : gpsStatus === 'denied' ? '⚠ GPS off' : '⏳ GPS…'}
                  </span>
                  {fetching && <span style={{ color: T.blue }}> · routing…</span>}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {active && <button onClick={() => setCollapsed(true)} style={{ background: 'none', border: 'none', color: T.ts, cursor: 'pointer', fontSize: 16 }}>▾</button>}
              {active && <button onClick={stopMode} style={{ background: 'none', border: 'none', color: T.red, cursor: 'pointer', fontSize: 10, fontWeight: 700 }}>■ Stop</button>}
            </div>
          </div>

          {/* Progress */}
          {active && stops.length > 0 && (
            <div style={{ height: 3, background: '#0f172a' }}>
              <div style={{ height: '100%', width: `${Math.round((done.size / stops.length) * 100)}%`, background: 'linear-gradient(90deg,#22c55e,#3b82f6)', transition: 'width 0.6s ease' }} />
            </div>
          )}

          {/* Direction + distance */}
          {active && dir && activeStop && (
            <div style={{
              margin: '12px 14px 0',
              background: 'linear-gradient(135deg,rgba(59,130,246,0.1),rgba(29,78,216,0.06))',
              border: '1.5px solid rgba(59,130,246,0.3)', borderRadius: 14,
              padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{ fontSize: 40, lineHeight: 1, minWidth: 46, textAlign: 'center', color: T.blue, fontWeight: 900 }}>{dir.a}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 900, color: T.tp }}>{dir.t}</div>
                <div style={{ fontSize: 10, color: T.tm, marginTop: 2 }}>toward <strong style={{ color: T.tp }}>{activeStop.customer_name || 'Destination'}</strong></div>
              </div>
              <div style={{
                textAlign: 'right', flexShrink: 0,
                background: close ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.10)',
                border: `1px solid ${close ? '#22c55e44' : '#f59e0b44'}`,
                borderRadius: 10, padding: '6px 10px',
              }}>
                <div style={{ fontSize: 18, fontWeight: 900, color: close ? T.green : T.amber }}>{fmtD(distM)}</div>
                <div style={{ fontSize: 9, color: T.ts }}>away</div>
              </div>
            </div>
          )}

          {/* Active destination card */}
          {active && activeStop && (
            <div style={{ padding: '10px 14px 0' }}>
              <div style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${T.bdr}`, borderRadius: 12, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'linear-gradient(135deg,#1d4ed8,#2563eb)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0, boxShadow: '0 0 0 3px #fff,0 0 0 6px #3b82f6,0 0 18px 8px #3b82f655' }}>📦</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.tp, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeStop.customer_name || 'Active Destination'}</div>
                  <div style={{ fontSize: 10, color: T.tm, marginTop: 2 }}>
                    {activeStop.scheduled_time && `🕐 ${activeStop.scheduled_time}`}
                    {activeStop.phone && `  📞 ${activeStop.phone}`}
                  </div>
                  {activeStop.address && <div style={{ fontSize: 9, color: T.ts, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📍 {activeStop.address}</div>}
                </div>
                {activeStop.risk_level && (
                  <div style={{ flexShrink: 0, padding: '3px 8px', borderRadius: 8, fontSize: 9, fontWeight: 800, color: riskClr, background: riskClr + '22', border: `1px solid ${riskClr}44` }}>{activeStop.risk_level}</div>
                )}
              </div>
            </div>
          )}

          {/* Not active — start button */}
          {!active && (
            <div style={{ padding: '14px' }}>
              <div style={{ fontSize: 10, color: T.ts, textAlign: 'center', marginBottom: 10, lineHeight: 1.6 }}>
                One road-aligned route at a time.<br />
                All other markers &amp; routes are hidden.
              </div>
              <button id="sarm-start-btn" onClick={startMode}
                disabled={!stops.length || gpsStatus === 'denied'}
                style={{
                  width: '100%', border: 'none', borderRadius: 12, padding: '11px 0',
                  background: (stops.length && gpsStatus !== 'denied') ? 'linear-gradient(135deg,#1d4ed8,#2563eb)' : '#1e293b',
                  color: '#fff', fontWeight: 800, fontSize: 13, cursor: 'pointer',
                  opacity: (stops.length && gpsStatus !== 'denied') ? 1 : 0.5,
                  boxShadow: (stops.length && gpsStatus !== 'denied') ? '0 4px 18px rgba(37,99,235,0.5)' : 'none',
                  transition: 'all 0.25s',
                }}>
                🗺 Start Single Route Mode
              </button>
              {!stops.length && <div style={{ fontSize: 9, color: T.ts, textAlign: 'center', marginTop: 6 }}>⏳ Upload CSV first</div>}
            </div>
          )}

          {/* Action buttons */}
          {active && (
            <div style={{ padding: '10px 14px 12px', display: 'flex', gap: 8 }}>
              <button id="sarm-delivered-btn" onClick={markDelivered} disabled={!activeStop}
                style={{ flex: 3, border: 'none', borderRadius: 10, padding: '10px 0', color: '#fff', fontWeight: 800, fontSize: 12, cursor: activeStop ? 'pointer' : 'not-allowed', opacity: activeStop ? 1 : 0.5, background: activeStop ? 'linear-gradient(135deg,#15803d,#059669)' : '#1e293b', boxShadow: activeStop ? '0 4px 14px rgba(21,128,61,0.45)' : 'none' }}>
                ✅ Delivered · Next Route
              </button>
              <button id="sarm-skip-btn" onClick={skipStop} disabled={!activeStop}
                style={{ flex: 1, border: `1px solid ${T.bdr}`, borderRadius: 10, padding: '10px 0', background: 'rgba(255,255,255,0.04)', color: T.amber, fontWeight: 700, fontSize: 11, cursor: activeStop ? 'pointer' : 'not-allowed', opacity: activeStop ? 1 : 0.5 }}>
                ⏭ Skip
              </button>
            </div>
          )}

          {/* Footer */}
          <div style={{ borderTop: `1px solid ${T.bdr}`, padding: '6px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 9, color: T.ts }}>🗺 Road-Aligned · Proximity-First · Live GPS</span>
            {agentPos && <span style={{ fontSize: 9, color: T.ts }}>{agentPos.lat.toFixed(4)}, {agentPos.lng.toFixed(4)}</span>}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
