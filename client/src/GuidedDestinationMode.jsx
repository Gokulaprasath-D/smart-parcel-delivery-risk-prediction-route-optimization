/**
 * GuidedDestinationMode.jsx — v2 Full Guided Destination Mode
 * ============================================================
 * NON-INTRUSIVE add-on. Zero changes to backend, WhatsApp, or priority logic.
 *
 * Behaviour:
 *  • Starts GPS watchPosition immediately on mount
 *  • After CSV upload (priority-reorder event) picks ONE best stop via combined score
 *    (proximity × 0.5 + priority × 0.35 + WA-yes boost × 0.15)
 *  • Emits  'gdm-mode-active' {active: bool}  → App.jsx hides polylines & all other markers
 *  • Emits  'gdm-active-stop' {stop, agentPos} → App.jsx renders single glowing marker
 *  • WA replies update future stops only; current active stop never interrupted
 *  • "Delivered → Next" auto-selects next best stop
 *  • Voice: 500 m and 100 m approach alerts + directional hint on demand
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ── Haversine (metres) ────────────────────────────────────────────────────────
function hav(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}

// ── Bearing degrees (0 = N) ───────────────────────────────────────────────────
function bearing(lat1, lng1, lat2, lng2) {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180)
    - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// ── Direction label from relative bearing ─────────────────────────────────────
function dirLabel(agentHdg, targetBrg) {
  const rel = ((targetBrg - agentHdg) + 360) % 360;
  if (rel < 25 || rel >= 335) return { text: 'Go Straight',   arrow: '↑' };
  if (rel < 70)               return { text: 'Slight Right',  arrow: '↗' };
  if (rel < 120)              return { text: 'Turn Right',    arrow: '→' };
  if (rel < 175)              return { text: 'Sharp Right',   arrow: '↘' };
  if (rel < 205)              return { text: 'U-Turn',        arrow: '↓' };
  if (rel < 250)              return { text: 'Sharp Left',    arrow: '↙' };
  if (rel < 295)              return { text: 'Turn Left',     arrow: '←' };
  return                             { text: 'Slight Left',   arrow: '↖' };
}

function fmtDist(m) {
  if (m == null) return '—';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

// ── Combined score: proximity + priority + WA boost ───────────────────────────
function pickBest(stops, lat, lng, doneIds) {
  const WA_SKIP = new Set(['replied_no', 'answered_unavailable', 'not_answered']);
  const candidates = stops.filter(s => {
    if (doneIds.has(s.customer_id)) return false;
    const wa = s.waStatus || s.wa_status || '';
    return !WA_SKIP.has(wa);
  });
  if (!candidates.length) return null;
  let best = null, bestScore = -Infinity;
  for (const s of candidates) {
    const dist  = hav(lat, lng, s.lat, s.lng);
    const prox  = 1 / (dist / 1000 + 0.3);          // closer = higher
    const prio  = s.combined_priority ?? s.priority_score ?? 0.5;
    const waYes = (s.waStatus === 'replied_yes' || s.wa_status === 'replied_yes') ? 1 : 0;
    const score = prox * 0.5 + prio * 0.35 + waYes * 0.15;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const T = {
  card:  'rgba(15,23,42,0.98)',
  bdr:   'rgba(255,255,255,0.08)',
  blue:  '#3b82f6',
  green: '#22c55e',
  amber: '#f59e0b',
  red:   '#ef4444',
  tp:    '#f1f5f9',
  ts:    '#64748b',
  tm:    '#94a3b8',
};

const GDM_CSS = `
@keyframes gdm-pulse{0%,100%{box-shadow:0 0 0 0 rgba(59,130,246,0);transform:scale(1);}50%{box-shadow:0 0 0 14px rgba(59,130,246,.18);transform:scale(1.09);}}
@keyframes gdm-ring{0%,100%{box-shadow:0 0 0 3px #fff,0 0 0 6px #3b82f6,0 0 22px 8px #3b82f688;}50%{box-shadow:0 0 0 3px #fff,0 0 0 11px #3b82f6,0 0 36px 16px #3b82f655;}}
@keyframes gdm-spin{to{transform:rotate(360deg);}}
.gdm-badge{animation:gdm-pulse 1.8s ease-in-out infinite;}
.gdm-ring{animation:gdm-ring 1.8s ease-in-out infinite;}
.gdm-spin{animation:gdm-spin .9s linear infinite;}
`;

export default function GuidedDestinationMode({ deliveries, socket, speak, backendUrl }) {
  const [active,      setActive]    = useState(false);
  const [agentPos,    setAgentPos]  = useState(null);
  const [heading,     setHeading]   = useState(0);
  const [activeStop,  setActiveStop]= useState(null);
  const [dist,        setDist]      = useState(null);
  const [stops,       setStops]     = useState([]);
  const [done,        setDone]      = useState(new Set());
  const [collapsed,   setCollapsed] = useState(false);
  const [gpsStatus,   setGpsStatus] = useState('idle');   // idle|ok|denied
  const [v500, setV500] = useState(false);
  const [v100, setV100] = useState(false);

  // refs keep closure-free access in callbacks
  const stopsRef  = useRef([]);
  const doneRef   = useRef(new Set());
  const activeRef = useRef(null);
  const agentRef  = useRef(null);
  const watchRef  = useRef(null);

  useEffect(() => { stopsRef.current  = stops;      }, [stops]);
  useEffect(() => { doneRef.current   = done;        }, [done]);
  useEffect(() => { activeRef.current = activeStop;  }, [activeStop]);
  useEffect(() => { agentRef.current  = agentPos;    }, [agentPos]);

  const say = useCallback((t) => {
    try { if (typeof speak === 'function') speak(t); } catch {}
  }, [speak]);

  // Inject CSS once
  useEffect(() => {
    const id = 'gdm-v2-css';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id; el.textContent = GDM_CSS;
    document.head.appendChild(el);
    return () => document.getElementById(id)?.remove();
  }, []);

  // ── GPS watchPosition — starts immediately on mount ────────────────────────
  useEffect(() => {
    if (!('geolocation' in navigator)) { setGpsStatus('denied'); return; }
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setAgentPos(p);
        if (pos.coords.heading != null) setHeading(pos.coords.heading);
        setGpsStatus('ok');
        // Piggyback existing map-marker handler
        window.dispatchEvent(new CustomEvent('hybrid-gps-live', { detail: p }));
      },
      () => setGpsStatus('denied'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
    return () => {
      if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
    };
  }, []);

  // ── Real-time distance + voice thresholds ─────────────────────────────────
  useEffect(() => {
    if (!agentPos || !activeStop) return;
    const d = hav(agentPos.lat, agentPos.lng, activeStop.lat, activeStop.lng);
    setDist(d);
    if (d <= 500 && !v500) { setV500(true); say(`${activeStop.customer_name || 'Destination'} is ${Math.round(d)} metres away.`); }
    if (d <= 100 && !v100) { setV100(true); say(`Destination ahead. ${Math.round(d)} metres remaining.`); }
  }, [agentPos, activeStop]);

  // ── Listen for CSV upload (priority-reorder) ───────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      const sorted = e.detail?.sorted || (Array.isArray(e.detail) ? e.detail : null);
      if (!sorted?.length) return;
      setStops(sorted);
    };
    window.addEventListener('priority-reorder', handler);
    return () => window.removeEventListener('priority-reorder', handler);
  }, []);

  // Also sync from deliveries prop (initial load)
  useEffect(() => {
    if (deliveries?.length) setStops(deliveries);
  }, [deliveries]);

  // ── WhatsApp replies → update future stops only ────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const onReply = (payload) => {
      const { phone_10, reply_type } = payload || {};
      if (!phone_10 || !reply_type) return;
      const norm = (p) => String(p || '').replace(/\D/g, '').slice(-10);
      setStops(prev => prev.map(s => {
        const match = norm(s.phone) === norm(phone_10) || norm(s.customer_phone) === norm(phone_10);
        if (!match) return s;
        // Never touch the currently active stop
        if (activeRef.current?.customer_id === s.customer_id) return s;
        return {
          ...s,
          waStatus: reply_type === 'yes' ? 'replied_yes'
            : reply_type === 'no' ? 'replied_no' : 'rescheduled',
        };
      }));
    };
    socket.on('whatsapp_reply', onReply);
    return () => socket.off('whatsapp_reply', onReply);
  }, [socket]);

  // ── Emit map-suppression events whenever active state changes ─────────────
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('gdm-mode-active', { detail: { active } }));
    if (!active) {
      window.dispatchEvent(new CustomEvent('gdm-active-stop', { detail: { stop: null } }));
    }
  }, [active]);

  // ── Emit active stop to map whenever it changes ────────────────────────────
  useEffect(() => {
    if (!active) return;
    window.dispatchEvent(new CustomEvent('gdm-active-stop', {
      detail: { stop: activeStop, agentPos: agentRef.current },
    }));
  }, [activeStop, active]);

  // ── Pick best stop ────────────────────────────────────────────────────────
  const pickNext = useCallback(() => {
    const pos = agentRef.current;
    if (!pos || !stopsRef.current.length) return;
    const best = pickBest(stopsRef.current, pos.lat, pos.lng, doneRef.current);
    setActiveStop(best);
    setV500(false); setV100(false);
    if (best) {
      const d = hav(pos.lat, pos.lng, best.lat, best.lng);
      setDist(d);
      window.dispatchEvent(new CustomEvent('gdm-active-stop', {
        detail: { stop: best, agentPos: pos },
      }));
      say(`Heading to ${best.customer_name || 'next customer'}. ${fmtDist(d)} away.`);
    }
  }, []);

  // Re-pick when stops change (WA update) but only if active
  useEffect(() => {
    if (active && agentPos && stops.length && !activeStop) pickNext();
  }, [stops, active]);

  // ── Start guidance ────────────────────────────────────────────────────────
  const startGuidance = () => {
    if (!agentPos) { say('Waiting for GPS. Please allow location access.'); return; }
    if (!stops.length) { say('Please upload a delivery CSV first.'); return; }
    setDone(new Set());
    setCollapsed(false);
    setActive(true);
    setTimeout(() => pickNext(), 50);
    say(`Guided destination mode started. ${stops.length} deliveries loaded.`);
  };

  // ── Mark delivered ────────────────────────────────────────────────────────
  const markDelivered = () => {
    if (!activeStop) return;
    const id = activeStop.customer_id;
    const newDone = new Set([...doneRef.current, id]);
    setDone(newDone);
    say(`Delivery completed for ${activeStop.customer_name || 'customer'}.`);

    const remaining = stopsRef.current.filter(s => !newDone.has(s.customer_id));
    if (!remaining.length) {
      say('All deliveries completed! Great work.');
      setActive(false);
      setActiveStop(null);
      window.dispatchEvent(new CustomEvent('gdm-mode-active', { detail: { active: false } }));
      window.dispatchEvent(new CustomEvent('gdm-active-stop', { detail: { stop: null } }));
      return;
    }
    setTimeout(() => pickNext(), 120);
  };

  // ── Skip current stop ─────────────────────────────────────────────────────
  const skipStop = () => {
    if (!activeStop) return;
    say(`Skipping ${activeStop.customer_name || 'current stop'}.`);
    const newDone = new Set([...doneRef.current, activeStop.customer_id]);
    setDone(newDone);
    setTimeout(() => pickNext(), 120);
  };

  // ── Stop guidance ─────────────────────────────────────────────────────────
  const stopGuidance = () => {
    setActive(false);
    setActiveStop(null);
    say('Guided mode stopped.');
  };

  // Derived display values
  const dir = (agentPos && activeStop)
    ? dirLabel(heading, bearing(agentPos.lat, agentPos.lng, activeStop.lat, activeStop.lng))
    : null;
  const remaining  = stops.filter(s => !done.has(s.customer_id)).length;
  const riskColor  = activeStop?.risk_level === 'High' ? T.red
    : activeStop?.risk_level === 'Medium' ? T.amber : T.green;
  const distClose  = dist != null && dist < 300;

  // ── Collapsed pill ────────────────────────────────────────────────────────
  if (active && collapsed) {
    return (
      <button
        id="gdm-pill"
        onClick={() => setCollapsed(false)}
        style={{
          position: 'fixed', bottom: 164, left: '50%', transform: 'translateX(-50%)',
          zIndex: 9700, background: 'linear-gradient(135deg,#1d4ed8,#7c3aed)',
          border: '1px solid #3b82f6', borderRadius: 50, padding: '8px 20px',
          color: '#fff', fontWeight: 800, fontSize: 11, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
          boxShadow: '0 4px 18px rgba(59,130,246,0.5)', fontFamily: 'system-ui',
        }}
      >
        🎯 {activeStop?.customer_name?.split(' ')[0] || 'Destination'} · {fmtDist(dist)}
      </button>
    );
  }

  return (
    <div style={{
      position: 'fixed', bottom: 164, left: '50%', transform: 'translateX(-50%)',
      zIndex: 9700, width: 'min(408px, calc(100vw - 28px))',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <AnimatePresence mode="wait">
        <motion.div
          key="gdm-panel"
          initial={{ opacity: 0, y: 22, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 14, scale: 0.96 }}
          transition={{ duration: 0.26 }}
          style={{
            background: T.card,
            border: `1px solid ${T.bdr}`,
            borderRadius: 20, overflow: 'hidden',
            boxShadow: '0 28px 70px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04)',
          }}
        >
          {/* Header */}
          <div style={{
            background: active
              ? 'linear-gradient(135deg,#1e3a8a,#4c1d95)'
              : 'linear-gradient(135deg,#0f172a,#1e293b)',
            padding: '10px 14px', display: 'flex',
            alignItems: 'center', justifyContent: 'space-between',
            borderBottom: `1px solid ${T.bdr}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>🎯</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, color: T.tp, letterSpacing: 0.4 }}>
                  Guided Destination Mode
                </div>
                <div style={{ fontSize: 9, color: T.ts, marginTop: 1 }}>
                  {active
                    ? `${remaining} stop${remaining !== 1 ? 's' : ''} remaining · ${done.size} done`
                    : 'Single-destination focus navigation'}
                  {' · '}
                  <span style={{ color: gpsStatus === 'ok' ? T.green : gpsStatus === 'denied' ? T.red : T.amber }}>
                    {gpsStatus === 'ok' ? '📍 GPS Live' : gpsStatus === 'denied' ? '⚠ GPS off' : '⏳ GPS…'}
                  </span>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {active && (
                <button onClick={() => setCollapsed(true)}
                  style={{ background: 'none', border: 'none', color: T.ts, cursor: 'pointer', fontSize: 16 }}>▾</button>
              )}
              {active && (
                <button onClick={stopGuidance}
                  style={{ background: 'none', border: 'none', color: T.red, cursor: 'pointer', fontSize: 10, fontWeight: 700 }}>■ Stop</button>
              )}
            </div>
          </div>

          {/* Progress bar */}
          {active && stops.length > 0 && (
            <div style={{ height: 3, background: '#0f172a' }}>
              <div style={{
                height: '100%',
                width: `${Math.round((done.size / stops.length) * 100)}%`,
                background: 'linear-gradient(90deg,#22c55e,#3b82f6)',
                transition: 'width 0.6s ease',
              }} />
            </div>
          )}

          {/* Direction arrow */}
          {active && dir && activeStop && (
            <div style={{
              margin: '12px 14px 0',
              background: 'linear-gradient(135deg,rgba(59,130,246,0.1),rgba(139,92,246,0.07))',
              border: `1.5px solid rgba(59,130,246,0.3)`,
              borderRadius: 14, padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 14,
            }}>
              <div style={{
                fontSize: 42, lineHeight: 1, minWidth: 50, textAlign: 'center',
                color: T.blue, fontWeight: 900,
              }}>
                {dir.arrow}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 17, fontWeight: 900, color: T.tp }}>{dir.text}</div>
                <div style={{ fontSize: 11, color: T.tm, marginTop: 3 }}>
                  toward <strong style={{ color: T.tp }}>{activeStop.customer_name || 'Destination'}</strong>
                </div>
              </div>
              <div style={{
                textAlign: 'right', flexShrink: 0,
                background: distClose ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.10)',
                border: `1px solid ${distClose ? '#22c55e44' : '#f59e0b44'}`,
                borderRadius: 10, padding: '6px 10px',
              }}>
                <div style={{ fontSize: 19, fontWeight: 900, color: distClose ? T.green : T.amber }}>
                  {fmtDist(dist)}
                </div>
                <div style={{ fontSize: 9, color: T.ts }}>away</div>
              </div>
            </div>
          )}

          {/* Active destination card */}
          {active && activeStop && (
            <div style={{ padding: '12px 14px 0' }}>
              <div style={{
                background: 'rgba(255,255,255,0.03)',
                border: `1px solid ${T.bdr}`,
                borderRadius: 12, padding: '10px 12px',
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <div className="gdm-badge gdm-ring" style={{
                  width: 44, height: 44, borderRadius: '50%',
                  background: T.blue, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 18, fontWeight: 900,
                  color: '#fff', flexShrink: 0,
                }}>🎯</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.tp, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {activeStop.customer_name || 'Active Destination'}
                  </div>
                  <div style={{ fontSize: 10, color: T.tm, marginTop: 2 }}>
                    {activeStop.scheduled_time && `🕐 ${activeStop.scheduled_time}`}
                    {activeStop.phone && `  📞 ${activeStop.phone}`}
                  </div>
                  {activeStop.address && (
                    <div style={{ fontSize: 9, color: T.ts, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      📍 {activeStop.address}
                    </div>
                  )}
                </div>
                {activeStop.risk_level && (
                  <div style={{
                    flexShrink: 0, padding: '3px 8px', borderRadius: 8,
                    fontSize: 9, fontWeight: 800, color: riskColor,
                    background: riskColor + '22', border: `1px solid ${riskColor}44`,
                  }}>
                    {activeStop.risk_level}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Not-active: start button */}
          {!active && (
            <div style={{ padding: '14px' }}>
              <div style={{ fontSize: 10, color: T.ts, textAlign: 'center', marginBottom: 10, lineHeight: 1.6 }}>
                Upload a delivery CSV, then start guided mode.<br />
                The system focuses on <strong style={{ color: T.tp }}>one destination at a time</strong>.
              </div>
              <button
                id="gdm-start-btn"
                onClick={startGuidance}
                disabled={!stops.length || gpsStatus === 'denied'}
                style={{
                  width: '100%',
                  background: (stops.length && gpsStatus !== 'denied')
                    ? 'linear-gradient(135deg,#1d4ed8,#7c3aed)' : '#1e293b',
                  border: 'none', borderRadius: 12, padding: '11px 0',
                  color: '#fff', fontWeight: 800, fontSize: 13, cursor: 'pointer',
                  letterSpacing: 0.3, opacity: (stops.length && gpsStatus !== 'denied') ? 1 : 0.5,
                  boxShadow: (stops.length && gpsStatus !== 'denied') ? '0 4px 18px rgba(59,130,246,0.45)' : 'none',
                  transition: 'all 0.25s ease',
                }}
              >
                🎯 Start Guided Destination Mode
              </button>
              {!stops.length && (
                <div style={{ fontSize: 9, color: T.ts, textAlign: 'center', marginTop: 6 }}>
                  ⏳ Upload CSV first
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          {active && (
            <div style={{ padding: '10px 14px 12px', display: 'flex', gap: 8 }}>
              <button
                id="gdm-delivered-btn"
                onClick={markDelivered}
                disabled={!activeStop}
                style={{
                  flex: 3,
                  background: activeStop ? 'linear-gradient(135deg,#15803d,#059669)' : '#1e293b',
                  border: 'none', borderRadius: 10, padding: '10px 0',
                  color: '#fff', fontWeight: 800, fontSize: 12,
                  cursor: activeStop ? 'pointer' : 'not-allowed',
                  opacity: activeStop ? 1 : 0.5,
                  boxShadow: activeStop ? '0 4px 14px rgba(21,128,61,0.45)' : 'none',
                }}
              >
                ✅ Delivered · Next Stop
              </button>
              <button
                id="gdm-skip-btn"
                onClick={skipStop}
                disabled={!activeStop}
                style={{
                  flex: 1,
                  background: 'rgba(255,255,255,0.04)',
                  border: `1px solid ${T.bdr}`,
                  borderRadius: 10, padding: '10px 0',
                  color: T.amber, fontWeight: 700, fontSize: 11,
                  cursor: activeStop ? 'pointer' : 'not-allowed',
                  opacity: activeStop ? 1 : 0.5,
                }}
              >
                ⏭ Skip
              </button>
            </div>
          )}

          {/* Footer */}
          <div style={{
            borderTop: `1px solid ${T.bdr}`,
            padding: '6px 14px', display: 'flex',
            justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 9, color: T.ts }}>
              🎯 Single-focus · Proximity-First · WA-Aware
            </span>
            {agentPos && (
              <span style={{ fontSize: 9, color: T.ts }}>
                {agentPos.lat.toFixed(4)}, {agentPos.lng.toFixed(4)}
              </span>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
