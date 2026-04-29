/**
 * SmartNavModule.jsx — AI-Optimized Turn-by-Turn Navigation Add-On
 * ================================================================
 * Non-intrusive: mounts alongside PriorityModule and TwilioNotifier.
 * Props: deliveries, speak, socket, backendUrl
 *
 * Features:
 *  • Auto-calls /api/smart-route on new deliveries → dispatches priority-reorder
 *  • Floating collapsible panel with turn-by-turn instructions
 *  • Voice guidance for each maneuver and status change
 *  • Re-optimizes silently when WA replies arrive via socket
 *  • Works without GPS — starts from Karur Hub depot
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';

// ── Maneuver type → emoji ─────────────────────────────────────────────────────
const MANEUVER_ICON = {
  depart:      '🚦',
  arrive:      '📍',
  turn:        (mod) => mod?.includes('left') ? '↰' : '↱',
  continue:    '↑',
  'new name':  '↑',
  merge:       '⤵',
  'on ramp':   '↗',
  'off ramp':  '↘',
  roundabout:  '🔄',
  rotary:      '🔄',
  fork:        (mod) => mod?.includes('left') ? '↖' : '↗',
  'end of road': (mod) => mod?.includes('left') ? '↰' : '↱',
};

function getIcon(maneuver, modifier) {
  const v = MANEUVER_ICON[maneuver];
  if (!v) return '↑';
  return typeof v === 'function' ? v(modifier) : v;
}

// ── Distance formatter ────────────────────────────────────────────────────────
function fmtDist(m) {
  if (!m) return '';
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}
function fmtMin(s) {
  if (!s) return '';
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m/60)}h ${m%60}m`;
}

// ── Colour palette (matches App.jsx) ─────────────────────────────────────────
const COLORS = {
  bg:      'rgba(15,23,42,0.97)',
  card:    'rgba(30,41,59,0.95)',
  border:  'rgba(255,255,255,0.08)',
  blue:    '#3b82f6',
  green:   '#22c55e',
  violet:  '#a855f7',
  amber:   '#f59e0b',
  red:     '#ef4444',
  textPri: '#f1f5f9',
  textSec: '#94a3b8',
};

export default function SmartNavModule({ deliveries, speak, socket, backendUrl }) {
  // ── State ─────────────────────────────────────────────────────────────────
  const [collapsed,    setCollapsed]    = useState(true);
  const [isActive,     setIsActive]     = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [routeInfo,    setRouteInfo]    = useState(null);   // {total_distance_km, estimated_minutes, depot}
  const [steps,        setSteps]        = useState([]);     // flat OSRM steps array
  const [stepIdx,      setStepIdx]      = useState(0);
  const [stopIdx,      setStopIdx]      = useState(0);      // which delivery stop we're on
  const [optimized,   setOptimized]    = useState([]);     // AI-sorted deliveries
  const [lastUpdate,   setLastUpdate]   = useState(null);   // timestamp of last re-optimize
  // ── Hybrid GPS State (add-on) ──────────────────────────────────────────────
  const [gpsState,     setGpsState]     = useState('idle'); // 'idle'|'requesting'|'granted'|'denied'
  const [gpsOrigin,    setGpsOrigin]    = useState(null);   // { lat, lng } from browser GPS
  const debounceRef    = useRef(null);
  const prevDelIds     = useRef('');    // detect meaningful changes
  const optimizedRef   = useRef([]);   // always-current reference for closures
  const stepIdxRef     = useRef(0);
  const stopIdxRef     = useRef(0);
  const watchIdRef     = useRef(null); // continuous GPS watch handle
  const liveGpsRef     = useRef(null); // latest live position { lat, lng }

  const base = backendUrl || 'http://localhost:8000';

  // ── Speak helper (safe) ───────────────────────────────────────────────────
  const say = useCallback((text) => {
    try { if (typeof speak === 'function') speak(text); } catch {}
  }, [speak]);

  // ── AI-optimize route ──────────────────────────────────────────────────────
  // depotOverride: { lat, lng } — if provided, uses it as origin (GPS mode)
  const optimize = useCallback(async (dels, silent = false, depotOverride = null) => {
    if (!dels || dels.length === 0) return;
    if (loading) return;
    setLoading(true);
    try {
      const body = {
        deliveries: dels.map(d => ({
          customer_id:       d.customer_id,
          lat:               d.lat,
          lng:               d.lng,
          combined_priority: d.combined_priority || d.priority_score || 0.5,
          wa_status:         d.wa_status || d.waStatus || '',
          waStatus:          d.waStatus  || d.wa_status || '',
          callStatus:        d.callStatus || '',
          scheduled_time:    d.scheduled_time || '',
          customer_name:     d.customer_name  || '',
          phone:             d.phone || d.customer_phone || '',
        })),
      };
      // ── Hybrid GPS: pass real-world origin to backend if available ─────────
      if (depotOverride) {
        body.depot_lat = depotOverride.lat;
        body.depot_lng = depotOverride.lng;
      }

      const { data } = await axios.post(`${base}/api/smart-route`, body);

      if (!data.optimized_order?.length) return;

      const sorted = data.optimized_order;
      optimizedRef.current = sorted;
      setOptimized(sorted);
      setRouteInfo({
        total_distance_km: data.total_distance_km,
        estimated_minutes: data.estimated_minutes,
        depot:             data.depot,
      });
      setLastUpdate(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));

      // Dispatch priority-reorder so App.jsx map updates
      window.dispatchEvent(new CustomEvent('priority-reorder', {
        detail: { sorted, triggeredBy: null },
      }));

      if (!silent) {
        say(
          `AI route optimized. ${sorted.length} stops. ` +
          `Total distance: ${data.total_distance_km} kilometers. ` +
          `Estimated time: ${data.estimated_minutes} minutes. ` +
          `Starting from ${data.depot?.name || 'depot'}.`
        );
        setCollapsed(false);
      }

      // Fetch turn-by-turn if navigation is active
      if (isActive) await fetchSteps(sorted, stopIdxRef.current);

      return { sorted, depot: data.depot };
    } catch (err) {
      console.error('[SmartNav] optimize error:', err.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [base, loading, isActive, say]);

  // ── Fetch OSRM steps from current stop to end ─────────────────────────────
  const fetchSteps = useCallback(async (stops, fromIdx = 0) => {
    const remaining = stops.slice(fromIdx);
    if (remaining.length < 2) return [];
    const coords = remaining.map(s => `${s.lng},${s.lat}`).join(';');
    try {
      const { data } = await axios.post(`${base}/api/route-directions`, { coords });
      if (data.code === 'Ok' && data.steps?.length) {
        setSteps(data.steps);
        setStepIdx(0);
        stepIdxRef.current = 0;
        return data.steps;  // return so startNav can forward to overlay
      }
    } catch (err) {
      console.error('[SmartNav] fetchSteps error:', err.message);
    }
    return [];
  }, [base]);

  // ── Auto-optimize when deliveries change ──────────────────────────────────
  useEffect(() => {
    if (!deliveries || deliveries.length === 0) {
      setOptimized([]);
      setRouteInfo(null);
      setSteps([]);
      setIsActive(false);
      prevDelIds.current = '';
      return;
    }
    // Detect if the delivery list meaningfully changed
    const ids = deliveries.map(d => d.customer_id).sort().join(',');
    if (ids === prevDelIds.current) return;
    prevDelIds.current = ids;

    // Debounce 600ms to batch rapid updates
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => optimize(deliveries, false), 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [deliveries]);

  // ── Re-optimize silently on WA reply (socket) ─────────────────────────────
  // Improvement #3: voice includes customer name and next stop name
  useEffect(() => {
    if (!socket) return;
    const onReply = (payload) => {
      const { reply_type, confidence = 1, phone_10 } = payload || {};
      if (!reply_type || reply_type === 'unknown' || confidence < 0.5) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        if (!deliveries?.length) return;
        const result = await optimize(deliveries, true);   // silent
        const sorted = result?.sorted || optimizedRef.current;

        // Resolve customer name from phone for richer voice
        const norm = (p) => String(p || '').replace(/\D/g, '').slice(-10);
        const matched = deliveries.find(d =>
          norm(d.phone) === norm(phone_10) || norm(d.customer_phone) === norm(phone_10)
        );
        const custName   = matched?.customer_name || 'customer';
        const nextStopName = sorted[stopIdxRef.current + 1]?.customer_name
          || sorted[stopIdxRef.current]?.customer_name
          || 'next stop';

        // Improvement #3: contextual, name-aware voice messages
        const voiceMap = {
          yes:        `Route updated. ${custName} is now available and moved to top. Heading to ${nextStopName}.`,
          no:         `${custName} is unavailable. Rerouting — next stop is ${nextStopName}.`,
          reschedule: `${custName} has rescheduled. Route adjusted. Next stop: ${nextStopName}.`,
        };
        if (voiceMap[reply_type]) say(voiceMap[reply_type]);

        // Notify overlay of background update (smooth, no full redraw)
        if (result?.sorted?.length) {
          window.dispatchEvent(new CustomEvent('hybrid-nav-update', {
            detail: { stops: result.sorted, currentIdx: stopIdxRef.current },
          }));
        }
      }, 800);
    };
    socket.on('whatsapp_reply', onReply);
    return () => socket.off('whatsapp_reply', onReply);
  }, [socket, deliveries, optimize, say]);

  // ── Re-optimize on priority-reorder (call outcomes from PriorityModule) ───
  useEffect(() => {
    const handler = (e) => {
      const sorted = e.detail?.sorted || e.detail;
      if (!Array.isArray(sorted) || sorted.length === 0) return;
      // Only re-optimize if triggered by a call outcome (has callStatus)
      const tb = e.detail?.triggeredBy;
      if (tb?.callStatus && sorted.length) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => optimize(sorted, true), 500);
      }
    };
    window.addEventListener('priority-reorder', handler);
    return () => window.removeEventListener('priority-reorder', handler);
  }, [optimize]);

  // ── Speak current step when it changes ────────────────────────────────────
  useEffect(() => {
    if (!isActive || !steps.length) return;
    const step = steps[stepIdx];
    if (!step) return;
    const dist = step.distance_m ? ` in ${fmtDist(step.distance_m)}` : '';
    say(`${step.instruction}${dist}`);
  }, [stepIdx, isActive]);

  // ── Hybrid Start Navigation: request GPS → re-optimize → start tracking ────
  const startNav = async () => {
    if (!optimized.length) return;
    setGpsState('requesting');
    setIsActive(true);
    setStopIdx(0);
    stopIdxRef.current = 0;
    setStepIdx(0);
    stepIdxRef.current = 0;
    setCollapsed(false);

    let depotOverride = null;
    let gpsGranted    = false;
    let gpsPos        = null;

    // ── Improvement #1 & #2: High-accuracy one-shot GPS fix ──────────────────
    if ('geolocation' in navigator) {
      try {
        gpsPos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }  // ✅ max accuracy
          );
        });
        gpsGranted    = true;
        depotOverride = gpsPos;
        liveGpsRef.current = gpsPos;
        setGpsOrigin(gpsPos);
        setGpsState('granted');
        console.log('[HybridNav] GPS granted — re-optimizing from real location', gpsPos);
      } catch (err) {
        setGpsState('denied');
        console.warn('[HybridNav] GPS denied/unavailable — using hub fallback:', err.message);
      }
    } else {
      setGpsState('denied');
    }

    // ── Re-optimize with real origin (or keep existing hub-based order) ──────
    let finalStops = optimized;
    let finalSteps = [];
    if (gpsGranted && depotOverride) {
      const result = await optimize(deliveries, true, depotOverride);
      if (result?.sorted?.length) finalStops = result.sorted;
    }
    const stepsData = await fetchSteps(finalStops, 0);
    finalSteps = stepsData || steps;

    // ── Announce start ────────────────────────────────────────────────────────
    const firstStop = finalStops[0]?.customer_name || 'first customer';
    const originMsg = gpsGranted
      ? 'Route recalculated from your GPS location.'
      : 'GPS unavailable. Using Karur Hub as start point.';
    say(`Navigation started. ${originMsg} First stop: ${firstStop}.`);

    // ── Dispatch event for HybridNavOverlay ──────────────────────────────────
    window.dispatchEvent(new CustomEvent('hybrid-nav-active', {
      detail: {
        stops:      finalStops,
        currentIdx: 0,
        steps:      finalSteps,
        gpsUsed:    gpsGranted,
        depotName:  gpsGranted ? 'GPS' : 'Karur Hub',
      },
    }));
    // ── Dispatch GPS origin to App.jsx for map pan ────────────────────────────
    if (gpsGranted && gpsPos) {
      window.dispatchEvent(new CustomEvent('hybrid-gps-origin', { detail: gpsPos }));
    }

    // ── Improvement #4: Start continuous GPS watch for live tracking ──────────
    if (gpsGranted && 'geolocation' in navigator) {
      // Clear any stale watch first
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const live = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          liveGpsRef.current = live;
          // Dispatch to App.jsx for map marker update (piggybacks existing handler)
          window.dispatchEvent(new CustomEvent('hybrid-gps-live', { detail: live }));
        },
        (err) => console.warn('[HybridNav] watchPosition error:', err.message),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
      console.log('[HybridNav] GPS watchPosition started, id=', watchIdRef.current);
    }
  };

  // ── Stop GPS watch when navigation ends ───────────────────────────────────
  useEffect(() => {
    if (!isActive && watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
      liveGpsRef.current = null;
      console.log('[HybridNav] GPS watchPosition cleared');
    }
  }, [isActive]);

  // ── Next turn step ─────────────────────────────────────────────────────────
  const nextStep = () => {
    if (stepIdx < steps.length - 1) {
      const next = stepIdx + 1;
      setStepIdx(next);
      stepIdxRef.current = next;
      // Notify overlay
      window.dispatchEvent(new CustomEvent('hybrid-nav-step', { detail: { stepIdx: next } }));
    }
  };

  // ── Advance to next delivery stop ─────────────────────────────────────────
  const nextStop = async () => {
    const next = stopIdx + 1;
    if (next >= optimized.length) {
      say('All deliveries completed. Great work!');
      setIsActive(false);
      window.dispatchEvent(new CustomEvent('hybrid-nav-end'));
      return;
    }
    setStopIdx(next);
    stopIdxRef.current = next;
    setStepIdx(0);
    stepIdxRef.current = 0;
    await fetchSteps(optimized, next);
    say(`Proceeding to stop ${next + 1}: ${optimized[next]?.customer_name || 'next customer'}.`);
    // Notify overlay
    window.dispatchEvent(new CustomEvent('hybrid-nav-stop', { detail: { stopIdx: next } }));
  };

  // ── Skip current stop ──────────────────────────────────────────────────────
  const skipStop = async () => {
    say(`Skipping stop ${stopIdx + 1}. Moving to next.`);
    await nextStop();
  };

  // ── Current step data ─────────────────────────────────────────────────────
  const currentStep  = steps[stepIdx] || null;
  const currentStop  = optimized[stopIdx] || null;
  const progressPct  = optimized.length ? Math.round((stopIdx / optimized.length) * 100) : 0;

  // ── Don't render if no data ───────────────────────────────────────────────
  if (!deliveries || deliveries.length === 0) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 16,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 9500,
      width: collapsed ? 'auto' : 'min(420px, 96vw)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>

      {/* ── Collapsed pill ──────────────────────────────────────────────── */}
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          style={{
            background: isActive
              ? 'linear-gradient(135deg,#1d4ed8,#7c3aed)'
              : 'linear-gradient(135deg,#0f172a,#1e293b)',
            border: `1px solid ${isActive ? '#3b82f6' : COLORS.border}`,
            borderRadius: 50,
            padding: '10px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            cursor: 'pointer',
            color: '#fff',
            boxShadow: isActive
              ? '0 0 24px #3b82f688, 0 4px 16px rgba(0,0,0,0.4)'
              : '0 4px 16px rgba(0,0,0,0.4)',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ fontSize: 16 }}>{isActive ? '🧭' : '🤖'}</span>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5 }}>
            {isActive
              ? `Navigating · Stop ${stopIdx + 1}/${optimized.length}`
              : loading
              ? 'AI Optimizing…'
              : routeInfo
              ? `AI Route · ${routeInfo.total_distance_km} km · ${routeInfo.estimated_minutes} min`
              : 'AI Route'}
          </span>
          {loading && (
            <span style={{ width: 14, height: 14, border: '2px solid #fff3', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite', display: 'inline-block' }} />
          )}
          <span style={{ fontSize: 10, color: '#94a3b8' }}>▲</span>
        </button>
      )}

      {/* ── Expanded panel ──────────────────────────────────────────────── */}
      {!collapsed && (
        <div style={{
          background: COLORS.bg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 20,
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)',
        }}>
          {/* Header */}
          <div style={{
            background: isActive
              ? 'linear-gradient(135deg,#1e3a8a,#4c1d95)'
              : 'linear-gradient(135deg,#0f172a,#1e293b)',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: `1px solid ${COLORS.border}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 20 }}>{isActive ? '🧭' : '🤖'}</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, color: '#f1f5f9', letterSpacing: 0.5 }}>
                  {isActive ? 'Live Navigation' : 'AI Route Optimizer'}
                </div>
                <div style={{ fontSize: 10, color: COLORS.textSec, marginTop: 1 }}>
                  {routeInfo
                    ? `${routeInfo.total_distance_km} km · ${routeInfo.estimated_minutes} min · ${optimized.length} stops · from ${routeInfo.depot?.name}`
                    : loading ? 'Calculating optimal route…' : 'Upload CSV to begin'}
                </div>
                {/* GPS status badge */}
                {gpsState !== 'idle' && (
                  <div style={{
                    marginTop: 3, display: 'inline-flex', alignItems: 'center', gap: 4,
                    background: gpsState === 'granted' ? 'rgba(34,197,94,0.15)'
                              : gpsState === 'denied'  ? 'rgba(245,158,11,0.15)'
                              : 'rgba(59,130,246,0.15)',
                    border: `1px solid ${gpsState === 'granted' ? '#22c55e44' : gpsState === 'denied' ? '#f59e0b44' : '#3b82f644'}`,
                    borderRadius: 6, padding: '2px 6px', fontSize: 9, fontWeight: 700,
                    color: gpsState === 'granted' ? '#22c55e' : gpsState === 'denied' ? '#f59e0b' : '#3b82f6',
                  }}>
                    {gpsState === 'requesting' ? '⏳ GPS…'
                    : gpsState === 'granted'   ? '📍 GPS Origin'
                    : '🏭 Hub Fallback'}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {lastUpdate && (
                <span style={{ fontSize: 9, color: COLORS.textSec }}>Updated {lastUpdate}</span>
              )}
              {loading && (
                <div style={{ width: 14, height: 14, border: '2px solid #334155', borderTopColor: COLORS.blue, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              )}
              <button
                onClick={() => setCollapsed(true)}
                style={{ background: 'none', border: 'none', color: COLORS.textSec, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }}
              >▾</button>
            </div>
          </div>

          {/* Progress bar */}
          {optimized.length > 0 && (
            <div style={{ height: 3, background: '#1e293b' }}>
              <div style={{ height: '100%', width: `${progressPct}%`, background: 'linear-gradient(90deg,#3b82f6,#8b5cf6)', transition: 'width 0.5s ease' }} />
            </div>
          )}

          {/* Current stop card */}
          {currentStop && (
            <div style={{ padding: '12px 16px 0', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {/* Stop badge */}
              <div style={{
                minWidth: 36, height: 36, borderRadius: '50%',
                background: isActive ? COLORS.blue : '#334155',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 900, fontSize: 14, color: '#fff',
                boxShadow: isActive ? `0 0 16px ${COLORS.blue}88` : 'none',
                animation: isActive ? 'glow 2s ease-in-out infinite' : 'none',
                flexShrink: 0,
              }}>
                {stopIdx + 1}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: COLORS.textPri }}>
                  {currentStop.customer_name || `Customer ${stopIdx + 1}`}
                </div>
                <div style={{ fontSize: 10, color: COLORS.textSec, marginTop: 2 }}>
                  {currentStop.scheduled_time && `🕐 ${currentStop.scheduled_time} · `}
                  {currentStop._dist_from_prev_km && `📍 ${currentStop._dist_from_prev_km} km from prev`}
                </div>
              </div>
              {/* Remaining stops count */}
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 10, color: COLORS.textSec }}>Remaining</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: COLORS.amber }}>
                  {optimized.length - stopIdx}
                </div>
              </div>
            </div>
          )}

          {/* Turn instruction card */}
          {isActive && currentStep && (
            <div style={{
              margin: '10px 16px 0',
              background: COLORS.card,
              borderRadius: 12,
              padding: '10px 14px',
              border: `1px solid ${COLORS.border}`,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <div style={{
                fontSize: 28, lineHeight: 1, minWidth: 36, textAlign: 'center',
              }}>
                {getIcon(currentStep.maneuver, currentStep.modifier)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPri }}>
                  {currentStep.instruction}
                </div>
                <div style={{ fontSize: 10, color: COLORS.textSec, marginTop: 2 }}>
                  {currentStep.distance_m > 0 && fmtDist(currentStep.distance_m)}
                  {currentStep.distance_m > 0 && currentStep.duration_s > 0 && ' · '}
                  {currentStep.duration_s > 0 && fmtMin(currentStep.duration_s)}
                </div>
              </div>
              {/* Step counter */}
              <div style={{ fontSize: 9, color: COLORS.textSec, textAlign: 'right', flexShrink: 0 }}>
                Step {stepIdx + 1}/{steps.length}
              </div>
            </div>
          )}

          {/* Upcoming stops mini-list */}
          {optimized.length > 0 && !isActive && (
            <div style={{ padding: '10px 16px 0', display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
              {optimized.slice(0, 6).map((stop, i) => (
                <div key={stop.customer_id || i} style={{
                  flexShrink: 0,
                  background: COLORS.card,
                  border: `1px solid ${i === 0 ? COLORS.blue : COLORS.border}`,
                  borderRadius: 10,
                  padding: '6px 10px',
                  textAlign: 'center',
                  minWidth: 64,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: i === 0 ? COLORS.blue : COLORS.textSec }}>
                    {i + 1}
                  </div>
                  <div style={{ fontSize: 9, color: COLORS.textSec, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {stop.customer_name?.split(' ')[0] || `C${i+1}`}
                  </div>
                </div>
              ))}
              {optimized.length > 6 && (
                <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', fontSize: 10, color: COLORS.textSec, padding: '0 4px' }}>
                  +{optimized.length - 6} more
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ padding: '12px 16px 14px', display: 'flex', gap: 8 }}>
            {!isActive ? (
              <>
                <button
                  onClick={startNav}
                  disabled={loading || !optimized.length}
                  style={{
                    flex: 1,
                    background: optimized.length
                      ? 'linear-gradient(135deg,#1d4ed8,#7c3aed)'
                      : '#334155',
                    border: 'none',
                    borderRadius: 10,
                    padding: '10px 0',
                    color: '#fff',
                    fontWeight: 800,
                    fontSize: 12,
                    cursor: optimized.length ? 'pointer' : 'not-allowed',
                    letterSpacing: 0.3,
                    boxShadow: optimized.length ? '0 4px 16px rgba(59,130,246,0.35)' : 'none',
                  }}
                >
                  🧭 Start Navigation
                </button>
                <button
                  onClick={() => optimize(deliveries, false)}
                  disabled={loading}
                  style={{
                    background: COLORS.card,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 10,
                    padding: '10px 14px',
                    color: COLORS.textSec,
                    fontWeight: 700,
                    fontSize: 11,
                    cursor: loading ? 'not-allowed' : 'pointer',
                  }}
                >
                  {loading ? '⏳' : '🔄'} Re-optimize
                </button>
              </>
            ) : (
              <>
                {/* Previous turn */}
                <button
                  onClick={() => setStepIdx(s => Math.max(0, s - 1))}
                  disabled={stepIdx === 0}
                  style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '10px 12px', color: COLORS.textSec, fontSize: 14, cursor: stepIdx === 0 ? 'not-allowed' : 'pointer', opacity: stepIdx === 0 ? 0.4 : 1 }}
                >◀</button>

                {/* Next turn step */}
                <button
                  onClick={nextStep}
                  disabled={stepIdx >= steps.length - 1}
                  style={{ flex: 1, background: COLORS.card, border: `1px solid ${COLORS.blue}`, borderRadius: 10, padding: '10px 0', color: COLORS.blue, fontWeight: 800, fontSize: 11, cursor: 'pointer' }}
                >
                  ↑ Next Turn
                </button>

                {/* Delivered */}
                <button
                  onClick={nextStop}
                  style={{
                    flex: 2,
                    background: 'linear-gradient(135deg,#15803d,#059669)',
                    border: 'none',
                    borderRadius: 10,
                    padding: '10px 0',
                    color: '#fff',
                    fontWeight: 800,
                    fontSize: 11,
                    cursor: 'pointer',
                    boxShadow: '0 4px 12px rgba(21,128,61,0.35)',
                  }}
                >
                  ✅ Delivered · Next Stop
                </button>

                {/* Skip */}
                <button
                  onClick={skipStop}
                  style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '10px 10px', color: COLORS.amber, fontWeight: 700, fontSize: 11, cursor: 'pointer' }}
                >
                  ⏭ Skip
                </button>
              </>
            )}
          </div>

          {/* Footer status */}
          <div style={{ borderTop: `1px solid ${COLORS.border}`, padding: '6px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 9, color: COLORS.textSec }}>
              🤖 AI: Priority-Weighted Nearest-Neighbour · OSRM Navigation
            </span>
            {isActive && (
              <button
                onClick={() => { setIsActive(false); say('Navigation stopped.'); }}
                style={{ background: 'none', border: 'none', color: COLORS.red, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
              >
                ■ Stop Nav
              </button>
            )}
          </div>
        </div>
      )}

      {/* Spin keyframe (injected once) */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes glow {
          0%,100% { box-shadow: 0 0 8px #3b82f688; }
          50%      { box-shadow: 0 0 22px #3b82f6cc; }
        }
      `}</style>
    </div>
  );
}
