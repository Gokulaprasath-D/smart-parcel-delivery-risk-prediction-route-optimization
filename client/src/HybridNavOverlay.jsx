/**
 * HybridNavOverlay.jsx  —  Guidance-First Navigation HUD
 * =======================================================
 * NON-INTRUSIVE ADD-ON: mounts alongside SmartNavModule without modifying
 * any existing logic. Listens to custom events dispatched by SmartNavModule.
 *
 * Events consumed (read-only):
 *   'hybrid-nav-active'   – { stops, currentIdx, steps, gpsUsed, depotName }
 *   'hybrid-nav-step'     – { stepIdx }
 *   'hybrid-nav-stop'     – { stopIdx }
 *   'hybrid-nav-end'      – {}
 *   'hybrid-nav-update'   – { stops, currentIdx }
 *
 * Props: speak (function), userLocation ([lat,lng]|null)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const COLORS = {
  bg:      'rgba(2,6,23,0.97)',
  card:    'rgba(15,23,42,0.98)',
  border:  'rgba(255,255,255,0.07)',
  blue:    '#3b82f6',
  green:   '#22c55e',
  amber:   '#f59e0b',
  red:     '#ef4444',
  textPri: '#f1f5f9',
  textSec: '#64748b',
  textMid: '#94a3b8',
};

const MANEUVER_ICON = {
  depart: '🚦', arrive: '📍',
  turn: (m) => m?.includes('left') ? '↰' : '↱',
  continue: '↑', 'new name': '↑', merge: '⤵',
  'on ramp': '↗', 'off ramp': '↘',
  roundabout: '🔄', rotary: '🔄',
  fork: (m) => m?.includes('left') ? '↖' : '↗',
  'end of road': (m) => m?.includes('left') ? '↰' : '↱',
};
const getManIcon = (type, mod) => {
  const v = MANEUVER_ICON[type];
  if (!v) return '↑';
  return typeof v === 'function' ? v(mod) : v;
};
const fmtDist = (m) => (!m ? '' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
const fmtMin  = (s) => {
  if (!s) return '';
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}

const OVERLAY_CSS = `
@keyframes hno-pulse {
  0%,100% { box-shadow:0 0 0 0 rgba(59,130,246,0); transform:scale(1); }
  50%      { box-shadow:0 0 0 14px rgba(59,130,246,0.18); transform:scale(1.07); }
}
@keyframes hno-glow {
  0%,100% { box-shadow:0 0 16px 4px rgba(59,130,246,0.35),0 0 0 3px #fff,0 0 0 5px #3b82f6; }
  50%      { box-shadow:0 0 32px 10px rgba(59,130,246,0.55),0 0 0 3px #fff,0 0 0 8px #3b82f6; }
}
.hno-badge { animation:hno-pulse 1.8s ease-in-out infinite; }
.hno-glow  { animation:hno-glow  1.8s ease-in-out infinite; }
`;

export default function HybridNavOverlay({ speak, userLocation }) {
  const [active,    setActive]    = useState(false);
  const [stops,     setStops]     = useState([]);
  const [stopIdx,   setStopIdx]   = useState(0);
  const [steps,     setSteps]     = useState([]);
  const [stepIdx,   setStepIdx]   = useState(0);
  const [gpsUsed,   setGpsUsed]   = useState(false);
  const [depotName, setDepotName] = useState('Karur Hub');
  const [dismissed, setDismissed] = useState(false);
  const [showAll,   setShowAll]   = useState(false);
  const prevStopRef   = useRef(-1);
  const distSpokenRef = useRef({ spoken500: false, spoken150: false }); // track voiced thresholds

  const say = useCallback((t) => {
    try { if (typeof speak === 'function') speak(t); } catch {}
  }, [speak]);

  // Inject CSS once
  useEffect(() => {
    const id = 'hno-css';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id; el.textContent = OVERLAY_CSS;
    document.head.appendChild(el);
    return () => { const e = document.getElementById(id); if (e) e.remove(); };
  }, []);

  // Listen to events
  useEffect(() => {
    const onActive = ({ detail: d = {} }) => {
      setStops(d.stops || []);
      setStopIdx(d.currentIdx || 0);
      setSteps(d.steps || []);
      setStepIdx(0);
      setGpsUsed(!!d.gpsUsed);
      setDepotName(d.depotName || 'Karur Hub');
      setActive(true);
      setDismissed(false);
      prevStopRef.current = d.currentIdx || 0;
    };
    const onStep   = ({ detail: d = {} }) => setStepIdx(d.stepIdx ?? 0);
    const onStop   = ({ detail: d = {} }) => {
      setStopIdx(d.stopIdx ?? 0);
      setStepIdx(0);
    };
    const onEnd    = () => { setActive(false); };
    const onUpdate = ({ detail: d = {} }) => {
      setStops(d.stops || []);
      if (d.currentIdx !== undefined) setStopIdx(d.currentIdx);
    };

    window.addEventListener('hybrid-nav-active',  onActive);
    window.addEventListener('hybrid-nav-step',    onStep);
    window.addEventListener('hybrid-nav-stop',    onStop);
    window.addEventListener('hybrid-nav-end',     onEnd);
    window.addEventListener('hybrid-nav-update',  onUpdate);
    return () => {
      window.removeEventListener('hybrid-nav-active',  onActive);
      window.removeEventListener('hybrid-nav-step',    onStep);
      window.removeEventListener('hybrid-nav-stop',    onStop);
      window.removeEventListener('hybrid-nav-end',     onEnd);
      window.removeEventListener('hybrid-nav-update',  onUpdate);
    };
  }, []);

  // Voice for step changes
  useEffect(() => {
    if (!active || !steps.length) return;
    const s = steps[stepIdx];
    if (s) say(`${s.instruction}${s.distance_m ? `. In ${fmtDist(s.distance_m)}` : ''}`);
  }, [stepIdx, active]);

  // Voice for stop advances
  useEffect(() => {
    if (!active || stops.length === 0) return;
    if (stopIdx === prevStopRef.current) return;
    prevStopRef.current = stopIdx;
    // Reset distance thresholds for new stop
    distSpokenRef.current = { spoken500: false, spoken150: false };
    const s = stops[stopIdx];
    if (s) say(`Proceeding to stop ${stopIdx + 1}: ${s.customer_name || 'next customer'}.`);
  }, [stopIdx, active, stops]);

  // ── Improvement #5: Distance-to-stop voice announcements ──────────────────────
  // Announces "X is 500 meters away" once, then "arriving" at 150m
  useEffect(() => {
    if (!active || !userLocation || !stops.length) return;
    const s = stops[stopIdx];
    if (!s) return;
    const dist = haversineM(userLocation[0], userLocation[1], s.lat, s.lng);
    const name = s.customer_name || `stop ${stopIdx + 1}`;

    if (!distSpokenRef.current.spoken500 && dist <= 500 && dist > 150) {
      distSpokenRef.current.spoken500 = true;
      say(`${name} is ${Math.round(dist)} meters away.`);
    } else if (!distSpokenRef.current.spoken150 && dist <= 150) {
      distSpokenRef.current.spoken150 = true;
      say(`Arriving at ${name}. ${Math.round(dist)} meters remaining.`);
    }
  }, [userLocation, active, stopIdx, stops]);

  if (!active || dismissed) {
    // Show a tiny restore pill when dismissed
    if (!active) return null;
    return (
      <button
        onClick={() => setDismissed(false)}
        style={{
          position: 'fixed',
          bottom: 'calc(80px + env(safe-area-inset-bottom, 0px))',
          right: 16, zIndex: 9800,
          background: 'linear-gradient(135deg,#1d4ed8,#7c3aed)',
          border: '1px solid #3b82f6', borderRadius: 50,
          padding: '8px 16px', color: '#fff', fontWeight: 800, fontSize: 11,
          cursor: 'pointer', boxShadow: '0 4px 16px rgba(59,130,246,0.4)',
          display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'system-ui',
          pointerEvents: 'auto', minHeight: 44,
        }}
      >
        🧭 Stop {stopIdx + 1}/{stops.length}
      </button>
    );
  }

  const currentStop = stops[stopIdx] || null;
  const nextStop    = stops[stopIdx + 1] || null;
  const currentStep = steps[stepIdx] || null;
  const remaining   = stops.length - stopIdx;
  const progress    = stops.length > 0 ? Math.round((stopIdx / stops.length) * 100) : 0;
  const distToStop  = (userLocation && currentStop)
    ? haversineM(userLocation[0], userLocation[1], currentStop.lat, currentStop.lng)
    : null;

  return (
    <div
      className="hno-panel"
      style={{
        position: 'fixed',
        bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
        right: 16, zIndex: 9800,
        width: 'min(360px, calc(100vw - 32px))',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        display: 'flex', flexDirection: 'column', gap: 8,
        pointerEvents: 'none',
      }}>

      {/* Turn instruction strip */}
      <AnimatePresence mode="wait">
        {currentStep && (
          <motion.div
            key={`step-${stepIdx}`}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            style={{
              background: 'rgba(59,130,246,0.12)', border: `1.5px solid rgba(59,130,246,0.35)`,
              borderRadius: 14, padding: '10px 14px',
              display: 'flex', alignItems: 'center', gap: 12,
              pointerEvents: 'auto', backdropFilter: 'blur(12px)',
            }}
          >
            <div style={{ fontSize: 26, lineHeight: 1, minWidth: 32, textAlign: 'center' }}>
              {getManIcon(currentStep.maneuver, currentStep.modifier)}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPri }}>
                {currentStep.instruction}
              </div>
              <div style={{ fontSize: 10, color: COLORS.textMid, marginTop: 2 }}>
                {currentStep.distance_m > 0 && fmtDist(currentStep.distance_m)}
                {currentStep.distance_m > 0 && currentStep.duration_s > 0 && ' · '}
                {currentStep.duration_s > 0 && fmtMin(currentStep.duration_s)}
              </div>
            </div>
            <div style={{ fontSize: 9, color: COLORS.textSec, flexShrink: 0 }}>
              {stepIdx + 1}/{steps.length}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main card */}
      <div style={{
        background: COLORS.card,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 20, overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.7),0 0 0 1px rgba(255,255,255,0.04)',
        pointerEvents: 'auto',
      }}>
        {/* Header */}
        <div style={{
          background: 'linear-gradient(135deg,#0f172a,#1e3a8a)',
          padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: `1px solid ${COLORS.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>🧭</span>
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: COLORS.textPri, letterSpacing: 0.4 }}>
                Live Navigation
              </div>
              <div style={{ fontSize: 9, color: COLORS.textSec, marginTop: 1 }}>
                {gpsUsed ? '📍 GPS origin' : `🏭 ${depotName}`}
                {' · '}Stop {stopIdx + 1}/{stops.length} · {remaining} left
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => setShowAll(v => !v)}
              style={{
                background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 8,
                padding: '4px 8px', color: COLORS.textMid, cursor: 'pointer', fontSize: 10, fontWeight: 700,
              }}
            >{showAll ? 'Focus' : 'All Stops'}</button>
            <button
              onClick={() => setDismissed(true)}
              style={{ background: 'none', border: 'none', color: COLORS.textSec, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}
            >▾</button>
          </div>
        </div>

        {/* Progress */}
        <div style={{ height: 3, background: '#0f172a' }}>
          <div style={{
            height: '100%', width: `${progress}%`,
            background: 'linear-gradient(90deg,#3b82f6,#8b5cf6)',
            transition: 'width 0.6s ease',
          }} />
        </div>

        {/* Primary stop */}
        {currentStop && (
          <div style={{ padding: '14px 14px 0' }}>
            <div style={{
              background: 'linear-gradient(135deg,rgba(59,130,246,0.12),rgba(139,92,246,0.07))',
              border: `1.5px solid rgba(59,130,246,0.35)`,
              borderRadius: 14, padding: '12px 14px',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              {/* Pulsing glowing badge */}
              <div className="hno-badge hno-glow" style={{
                width: 44, height: 44, borderRadius: '50%',
                background: COLORS.blue, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 16, fontWeight: 900,
                color: '#fff', flexShrink: 0,
              }}>
                {stopIdx + 1}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: COLORS.textPri, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {currentStop.customer_name || `Customer ${stopIdx + 1}`}
                </div>
                <div style={{ fontSize: 10, color: COLORS.textMid, marginTop: 3 }}>
                  {currentStop.scheduled_time && `🕐 ${currentStop.scheduled_time}`}
                  {currentStop._dist_from_prev_km && `  📍 ${currentStop._dist_from_prev_km} km`}
                </div>
                {distToStop !== null && (
                  <div style={{
                    marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4,
                    background: distToStop < 300 ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.12)',
                    border: `1px solid ${distToStop < 300 ? '#22c55e44' : '#f59e0b44'}`,
                    borderRadius: 6, padding: '2px 7px', fontSize: 10, fontWeight: 700,
                    color: distToStop < 300 ? COLORS.green : COLORS.amber,
                  }}>
                    {distToStop < 300 ? '✅ Nearby' : `${Math.round(distToStop)} m`}
                  </div>
                )}
              </div>
              {currentStop.risk_level && (
                <div style={{
                  flexShrink: 0, padding: '3px 8px', borderRadius: 8, fontSize: 9, fontWeight: 800,
                  background: currentStop.risk_level === 'High'   ? 'rgba(239,68,68,0.15)'
                             : currentStop.risk_level === 'Medium' ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.12)',
                  color: currentStop.risk_level === 'High' ? COLORS.red
                        : currentStop.risk_level === 'Medium' ? COLORS.amber : COLORS.green,
                }}>
                  {currentStop.risk_level}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Next stop preview (de-emphasised) */}
        {nextStop && !showAll && (
          <div style={{ padding: '8px 14px 0', opacity: 0.45, filter: 'grayscale(40%)' }}>
            <div style={{
              background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.border}`,
              borderRadius: 10, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{
                width: 26, height: 26, borderRadius: '50%', background: '#1e293b',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 800, color: COLORS.textSec, flexShrink: 0,
              }}>{stopIdx + 2}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.textMid, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {nextStop.customer_name || `Stop ${stopIdx + 2}`}
                </div>
                <div style={{ fontSize: 9, color: COLORS.textSec }}>Up next</div>
              </div>
            </div>
          </div>
        )}

        {/* All stops list (expanded) */}
        {showAll && (
          <div style={{ padding: '8px 14px 0', maxHeight: 190, overflowY: 'auto' }}>
            {stops.map((s, i) => {
              const isCurr = i === stopIdx;
              const isDone = i < stopIdx;
              return (
                <div key={s.customer_id || i} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '6px 0', borderBottom: `1px solid ${COLORS.border}`,
                  opacity: i > stopIdx ? 0.35 : isDone ? 0.55 : 1,
                  filter: i > stopIdx ? 'grayscale(70%)' : 'none',
                  // Improvement #2: smoother 450ms transition on route updates
                  transition: 'opacity 0.45s ease, filter 0.45s ease',
                }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                    background: isDone ? '#16a34a' : isCurr ? COLORS.blue : '#1e293b',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 9, fontWeight: 800, color: '#fff',
                    boxShadow: isCurr ? `0 0 8px ${COLORS.blue}88` : 'none',
                  }}>{isDone ? '✓' : i + 1}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: isCurr ? COLORS.textPri : COLORS.textMid, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.customer_name || `Stop ${i + 1}`}
                    </div>
                    <div style={{ fontSize: 9, color: COLORS.textSec }}>
                      {s.scheduled_time}{s._dist_from_prev_km ? `  · ${s._dist_from_prev_km} km` : ''}
                    </div>
                  </div>
                  {isCurr && <span style={{ fontSize: 9, color: COLORS.blue, fontWeight: 800, flexShrink: 0 }}>← NOW</span>}
                </div>
              );
            })}
          </div>
        )}

        {/* GPS source footer */}
        <div style={{
          padding: '8px 14px 10px', marginTop: 8,
          borderTop: `1px solid ${COLORS.border}`,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: gpsUsed ? COLORS.green : COLORS.amber,
            boxShadow: `0 0 6px ${gpsUsed ? COLORS.green : COLORS.amber}`,
            flexShrink: 0,
          }} />
          <span style={{ fontSize: 9, color: COLORS.textSec, fontWeight: 600 }}>
            {gpsUsed
              ? 'Route origin: your live GPS position'
              : `Route origin: ${depotName} (GPS denied / fallback)`}
          </span>
        </div>
      </div>
    </div>
  );
}
