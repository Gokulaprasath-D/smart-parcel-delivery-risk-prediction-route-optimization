/**
 * RouteController.jsx  —  Background routing controller (NO UI rendered)
 * =========================================================================
 * Merges GuidedDestinationMode + SingleActiveRouteMode into one headless
 * controller.  Renders null — zero visual output.
 *
 * Auto-starts as soon as GPS + deliveries are both available.
 * No start/stop buttons. No floating panels. No overlays.
 *
 * Emits (window CustomEvents — App.jsx listens):
 *   'rc-active'   { active, activeStop, agentPos, polyline, distM }
 *
 * Listens:
 *   'priority-reorder' → updated stop list
 *   'rc-delivered'     → mark current stop done, pick next
 *   socket 'whatsapp_reply' → update future stop availability
 *
 * Props: deliveries, socket, backendUrl, speak
 */
import { useEffect, useRef, useCallback } from 'react';
import axios from 'axios';

// ── Haversine (metres) ────────────────────────────────────────────────────────
function hav(la1, lo1, la2, lo2) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2
    + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}

// ── Scoring ───────────────────────────────────────────────────────────────────
const SKIP_WA = new Set(['replied_no', 'answered_unavailable', 'not_answered']);
function pickBest(stops, lat, lng, done) {
  const cands = stops.filter(s =>
    !done.has(s.customer_id) && !SKIP_WA.has(s.waStatus || s.wa_status || '')
  );
  if (!cands.length) return null;
  let best = null, bestScore = -Infinity;
  for (const s of cands) {
    const dist  = hav(lat, lng, s.lat, s.lng);
    const prox  = 1 / (dist / 1000 + 0.3);
    const prio  = s.combined_priority ?? s.priority_score ?? 0.5;
    const waY   = (s.waStatus === 'replied_yes' || s.wa_status === 'replied_yes') ? 0.2 : 0;
    const score = prox * 0.5 + prio * 0.35 + waY * 0.15;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

export default function RouteController({ deliveries, socket, backendUrl, speak }) {
  // All state kept in refs — no re-renders, zero UI
  const stopsRef    = useRef([]);
  const doneRef     = useRef(new Set());
  const agentRef    = useRef(null);
  const activeRef   = useRef(null);
  const watchRef    = useRef(null);
  const debounceRef = useRef(null);
  const backendRef  = useRef(backendUrl);
  const activeFlag  = useRef(false);

  useEffect(() => { backendRef.current = backendUrl; }, [backendUrl]);

  const say = useCallback((t) => {
    try { if (typeof speak === 'function') speak(t); } catch {}
  }, [speak]);

  // ── Emit consolidated event to App.jsx ────────────────────────────────────
  const emit = useCallback((polyline, stop, agent, distM) => {
    window.dispatchEvent(new CustomEvent('rc-active', {
      detail: {
        active:     activeFlag.current,
        activeStop: stop  || null,
        agentPos:   agent || null,
        polyline:   polyline || null,
        distM:      distM ?? null,
      },
    }));
  }, []);

  // ── Fetch OSRM road-aligned single route (debounced 1.5 s) ───────────────
  const fetchRoute = useCallback((agent, stop) => {
    if (!agent || !stop) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const coords = `${agent.lng},${agent.lat};${stop.lng},${stop.lat}`;
        const res    = await axios.post(`${backendRef.current}/api/route_batch`, { coords });
        if (res.data?.code === 'Ok') {
          const poly = res.data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
          const dist = hav(agent.lat, agent.lng, stop.lat, stop.lng);
          emit(poly, stop, agent, dist);
        }
      } catch {
        // Fallback: straight line
        const dist = hav(agent.lat, agent.lng, stop.lat, stop.lng);
        emit([[agent.lat, agent.lng], [stop.lat, stop.lng]], stop, agent, dist);
      }
    }, 1500);
  }, [emit]);

  // ── Pick next best → fetch route ─────────────────────────────────────────
  const pickNext = useCallback(() => {
    const agent = agentRef.current;
    if (!agent || !stopsRef.current.length) return;
    const best = pickBest(stopsRef.current, agent.lat, agent.lng, doneRef.current);
    activeRef.current = best;
    if (best) {
      fetchRoute(agent, best);
      say(`Heading to ${best.customer_name || 'next customer'}.`);
    } else {
      activeFlag.current = false;
      emit(null, null, agent, null);
      say('All deliveries completed.');
    }
  }, [fetchRoute, emit, say]);

  // ── GPS watchPosition — starts on mount ───────────────────────────────────
  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        agentRef.current = p;

        // Piggyback existing map-marker handler
        window.dispatchEvent(new CustomEvent('hybrid-gps-live', { detail: p }));

        // If active: update distance + re-fetch route
        if (activeFlag.current && activeRef.current) {
          const dist = hav(p.lat, p.lng, activeRef.current.lat, activeRef.current.lng);
          fetchRoute(p, activeRef.current);
          // Auto-trigger if somehow no route yet
          if (dist < 0) return;
        } else if (!activeFlag.current && stopsRef.current.length) {
          // Auto-start once GPS arrives
          activeFlag.current = true;
          pickNext();
        }
      },
      (err) => console.warn('[RC] GPS denied:', err.message),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
    return () => {
      if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
    };
  }, [fetchRoute, pickNext]);

  // ── Sync deliveries from prop ─────────────────────────────────────────────
  useEffect(() => {
    if (!deliveries?.length) return;
    stopsRef.current = deliveries;
    // Auto-start if GPS already available and not yet active
    if (agentRef.current && !activeFlag.current) {
      activeFlag.current = true;
      pickNext();
    }
  }, [deliveries, pickNext]);

  // ── Listen to priority-reorder (CSV upload + AI sort) ────────────────────
  useEffect(() => {
    const h = (e) => {
      const sorted = e.detail?.sorted || (Array.isArray(e.detail) ? e.detail : null);
      if (!sorted?.length) return;
      stopsRef.current = sorted;
      // Auto-start or re-pick if active
      if (agentRef.current && !activeFlag.current) {
        activeFlag.current = true;
        pickNext();
      } else if (activeFlag.current && !activeRef.current) {
        pickNext();
      }
    };
    window.addEventListener('priority-reorder', h);
    return () => window.removeEventListener('priority-reorder', h);
  }, [pickNext]);

  // ── Listen to WhatsApp replies — skip if active replies NO, re-pick for future ──
  useEffect(() => {
    if (!socket) return;
    const onReply = (payload) => {
      const { phone_10, reply_type } = payload || {};
      if (!phone_10 || !reply_type || reply_type === 'unknown') return;
      const norm = (x) => String(x || '').replace(/\D/g, '').slice(-10);
      const n10  = norm(phone_10);
      const newStatus = reply_type === 'yes' ? 'replied_yes'
        : reply_type === 'no' ? 'replied_no' : 'rescheduled';

      const isActiveStop = activeRef.current &&
        (norm(activeRef.current.phone) === n10 ||
         norm(activeRef.current.customer_phone) === n10);

      if (isActiveStop && reply_type === 'no') {
        // ── Customer currently being delivered to replied NO → skip to next ──
        const id = activeRef.current.customer_id;
        doneRef.current = new Set([...doneRef.current, id]);
        activeRef.current = null;
        say('Customer unavailable. Finding next best stop.');
        setTimeout(() => pickNext(), 150);
        // Notify App.jsx map marker update
        window.dispatchEvent(new CustomEvent('rc-active', {
          detail: { active: true, activeStop: null, agentPos: agentRef.current, polyline: null, distM: null },
        }));
        return;
      }

      // ── Future stop: update its waStatus in the internal list ─────────────
      let changed = false;
      stopsRef.current = stopsRef.current.map(s => {
        if (s.customer_id === activeRef.current?.customer_id) return s; // never touch active
        const match = norm(s.phone) === n10 || norm(s.customer_phone) === n10;
        if (!match) return s;
        changed = true;
        return { ...s, waStatus: newStatus };
      });

      // ── If current active stop is null and we now have a new status → re-pick
      if (changed && activeFlag.current && !activeRef.current) {
        setTimeout(() => pickNext(), 150);
      }

      // ── For "no" reply on future stop: dispatch priority-reorder so
      //    App.jsx sidebar list re-sorts and excludes unavailable customer ─────
      if (changed && reply_type === 'no' && stopsRef.current.length) {
        const available = stopsRef.current.filter(s => !SKIP_WA.has(s.waStatus || ''));
        window.dispatchEvent(new CustomEvent('priority-reorder', {
          detail: { sorted: stopsRef.current, triggeredBy: null },
        }));
        console.log('[RC] WA no-reply: re-dispatched priority-reorder,', available.length, 'available stops');
      }
    };
    socket.on('whatsapp_reply', onReply);
    return () => socket.off('whatsapp_reply', onReply);
  }, [socket, pickNext, say]);


  // ── Listen for delivery-complete trigger from App.jsx ─────────────────────
  useEffect(() => {
    const onDelivered = () => {
      if (!activeRef.current) return;
      const id = activeRef.current.customer_id;
      doneRef.current = new Set([...doneRef.current, id]);
      activeRef.current = null;
      const remaining = stopsRef.current.filter(s =>
        !doneRef.current.has(s.customer_id) && !SKIP_WA.has(s.waStatus || '')
      );
      if (!remaining.length) {
        activeFlag.current = false;
        emit(null, null, agentRef.current, null);
        say('All deliveries completed. Great work!');
      } else {
        setTimeout(() => pickNext(), 100);
      }
    };
    window.addEventListener('rc-delivered', onDelivered);
    return () => window.removeEventListener('rc-delivered', onDelivered);
  }, [emit, pickNext, say]);

  return null; // ← no UI whatsoever
}
