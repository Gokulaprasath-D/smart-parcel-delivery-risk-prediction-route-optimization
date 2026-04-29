/**
 * PriorityModule.jsx
 * ==================
 * Customer Risk & Priority Prediction — standalone add-on panel.
 * Now includes real-time customer availability via Socket.IO.
 */

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import axios from 'axios';
import { io as SocketIO } from 'socket.io-client';

const Icon = ({ d, size = 16, color = 'currentColor', ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...rest}>
    <path d={d} />
  </svg>
);
const IcoClose    = (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />;
const IcoStar     = (p) => <Icon {...p} d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />;
const IcoFeedback = (p) => <Icon {...p} d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />;
const IcoPref     = (p) => <Icon {...p} d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />;
const IcoAdmin    = (p) => <Icon {...p} d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />;

const TIER_STYLES = {
  low:    { bg: '#dcfce7', text: '#166534', border: '#bbf7d0', dot: '#22c55e', label: '🟢 LOW RISK'    },
  medium: { bg: '#fef9c3', text: '#854d0e', border: '#fde68a', dot: '#f59e0b', label: '🟡 MEDIUM RISK' },
  high:   { bg: '#fee2e2', text: '#991b1b', border: '#fecaca', dot: '#ef4444', label: '🔴 HIGH RISK'   },
};

const TierBadge = ({ tier }) => {
  const s = TIER_STYLES[tier] || TIER_STYLES.low;
  return (
    <span style={{
      background: s.bg, color: s.text, border: `1px solid ${s.border}`,
      borderRadius: 999, fontSize: 10, fontWeight: 700,
      padding: '3px 10px', textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>{tier}</span>
  );
};

export default function PriorityModule({ backendUrl, speak: appSpeak, socket: appSocket, deliveries: appDeliveries }) {
  const base = backendUrl || 'http://localhost:8000';

  // ── Use App's Capacitor-aware speak (works on mobile + web) ───────────────
  const speak = (text) => {
    if (!text) return;
    if (typeof appSpeak === 'function') {
      appSpeak(text);  // Capacitor TTS on mobile, speechSynthesis on web
    } else if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95; u.lang = 'en-IN';
      window.speechSynthesis.speak(u);
    }
  };
  const queueVoice = speak; // alias

  const [open,        setOpen]        = useState(false);
  const [tab,         setTab]         = useState('priority');
  const [loading,     setLoading]     = useState(false);
  const [toast,       setToast]       = useState('');
  const [results,     setResults]     = useState(null);
  const [adminData,   setAdminData]   = useState(null);

  /**
   * customerStates: { [customer_id]: {
   *   waStatus:    'pending'|'replied_yes'|'replied_no'|'rescheduled'|'call_needed'|'call_missed'
   *   callStatus:  null|'answered_available'|'not_answered'|'answered_unavailable'|'rescheduled'
   *   reschedTime: string|null
   *   phone10:     string   (10-digit, for matching webhook)
   *   sentAt:      ISO string
   *   repliedAt:   ISO string|null
   * }}
   *
   * This dict IS the single source of truth for availability across the whole UI.
   * Backend is stateless — the frontend keeps session state.
   */
  const [customerStates, setCustomerStates] = useState({});   // 🔑 single source of truth

  // Feedback form
  const [fbDeliveryId, setFbDeliveryId] = useState('');
  const [fbCustomerId, setFbCustomerId] = useState('');
  const [fbAgentId,    setFbAgentId]    = useState('');
  const [fbOutcome,    setFbOutcome]    = useState('success');
  const [fbContact,    setFbContact]    = useState(true);
  const [fbNote,       setFbNote]       = useState('');

  // Preference form
  const [prefCid,  setPrefCid]  = useState('');
  const [prefSlot, setPrefSlot] = useState('any');
  const [prefFrom, setPrefFrom] = useState('09:00');
  const [prefTo,   setPrefTo]   = useState('17:00');

  const socketRef = useRef(null);
  const [waPanel,   setWaPanel]   = useState(false);
  const [waSent,    setWaSent]    = useState(0);     // count of WA messages sent
  const [waSending, setWaSending] = useState(false);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 4000); };

  // ── Listen for wa-sent CustomEvent dispatched by TwilioNotifier ───────────
  useEffect(() => {
    const handler = (e) => {
      const results = e.detail || [];
      setWaSent(results.length);
      setWaSending(false);
      // Store phone10 + sentAt per customer for webhook reply matching
      setCustomerStates(prev => {
        const next = { ...prev };
        results.forEach(r => {
          const cid = String(r.customer_id);
          if (cid) {
            next[cid] = {
              ...(next[cid] || {}),
              waStatus: 'pending',
              phone10:  String(r.phone_digits || '').slice(-10),
              name:     r.customer_name,
              sentAt:   r.sent_at || new Date().toISOString(),
            };
          }
        });
        return next;
      });
      showToast(`✅ WhatsApp sent to ${results.length} customers. Waiting for replies...`);
    };
    const sendingHandler = () => setWaSending(true);
    window.addEventListener('wa-sent',    handler);
    window.addEventListener('wa-sending', sendingHandler);
    return () => {
      window.removeEventListener('wa-sent',    handler);
      window.removeEventListener('wa-sending', sendingHandler);
    };
  }, []);

  // ── fetchPriority defined BEFORE useEffect to avoid stale closure ──────────
  const fetchPriorityRef = useRef(null);

  const fetchPriority = async () => {
    setLoading(true);
    try {
      const res = await axios.get(`${base}/priority/priority-order`);
      setResults(res.data);
      // ✅ FIX: seed customerStates with phone10 so webhook events can match replies
      if (res.data?.priority_order) {
        setCustomerStates(prev => {
          const next = { ...prev };
          res.data.priority_order.forEach(d => {
            if (!next[d.customer_id]) {
              const phone = String(d.phone || '').replace(/\D/g, '');
              next[d.customer_id] = {
                waStatus: 'pending',
                phone10:  phone.slice(-10),
                name:     d.customer_name || d.customer_id,
                sentAt:   null,
              };
            }
          });
          return next;
        });
      }
    } catch { showToast('Could not load priority order.'); }
    finally { setLoading(false); }
  };
  fetchPriorityRef.current = fetchPriority;  // always up-to-date ref

  // ── Seed customerStates from App's deliveries prop (immediate, no fetch needed) ─
  useEffect(() => {
    if (!appDeliveries || appDeliveries.length === 0) return;
    setCustomerStates(prev => {
      const next = { ...prev };
      appDeliveries.forEach(d => {
        const cid = String(d.customer_id || d.id || '');
        if (cid && !next[cid]) {
          const phone = String(d.phone || '').replace(/\D/g, '');
          next[cid] = {
            waStatus: 'pending',
            phone10:  phone.slice(-10),
            name:     d.customer_name || cid,
            sentAt:   null,
          };
        }
      });
      return next;
    });
  }, [appDeliveries]);

  // ── Core state updater + priority re-sort (pure frontend) ────────────────
  const updateCustomerState = (customerId, patch) => {
    setCustomerStates(prev => {
      const next = { ...prev, [customerId]: { ...(prev[customerId] || {}), ...patch } };
      const updatedCs = next[customerId]; // full state after patch
      setResults(prevR => {
        if (!prevR) return prevR;
        const arr = Array.isArray(prevR) ? prevR : (prevR.priority_order || prevR.deliveries || []);
        const sorted = [...arr].sort((a, b) => {
          const sa = next[a.customer_id] || {};
          const sb = next[b.customer_id] || {};
          const score = s => {
            if (s.waStatus === 'replied_yes'  || s.callStatus === 'answered_available')   return 100;
            if (s.waStatus === 'rescheduled'  || s.callStatus === 'rescheduled')           return  50;
            if (!s.waStatus || s.waStatus === 'pending')                                   return  30;
            if (s.waStatus === 'call_needed')                                               return  20;
            if (s.waStatus === 'replied_no'   || s.callStatus === 'answered_unavailable')  return   5;
            if (s.callStatus === 'not_answered')                                            return   2;
            return 15;
          };
          return (score(sb) + (b.priority_score||0.5)*40) - (score(sa) + (a.priority_score||0.5)*40);
        });
        const newR = Array.isArray(prevR) ? sorted : { ...prevR, priority_order: sorted, deliveries: sorted };
        // Notify App.jsx with sorted list + triggeredBy metadata for smart routing
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('priority-reorder', {
            detail: {
              sorted,
              triggeredBy: {
                customer_id: customerId,
                name:        updatedCs.name,
                waStatus:    updatedCs.waStatus,
                callStatus:  updatedCs.callStatus,
                reschedTime: updatedCs.reschedTime,
              },
            },
          }));
        }, 0);
        return newR;
      });
      return next;
    });
  };






  // ── Mark availability (frontend-first; also posts to /availability/confirm) ─
  const markAvailability = (delivery, status) => {
    updateCustomerState(delivery.customer_id, {
      waStatus:  status === 'confirmed' ? 'replied_yes' : 'replied_no',
      repliedAt: new Date().toISOString(),
    });
    const name = delivery.customer_name || delivery.customer_id;
    if (status === 'confirmed') {
      showToast(`✅ ${name} — Available. Route updated.`);
      speak(`${name} confirmed availability. Moved to top priority. Proceeding to their location.`);
    } else {
      showToast(`❌ ${name} — Not Home. Priority lowered. Route updated.`);
      speak(`${name} is not available today. Priority lowered. Route updated. Moving to next stop.`);
    }
    // Non-blocking backend post (keeps /availability/status-all in sync)
    axios.post(`${base}/availability/confirm`, {
      customer_id:    delivery.customer_id,
      customer_name:  delivery.customer_name,
      status, slot: 'any', available_from: '08:00', available_to: '21:00',
    }).catch(() => {});
  };


  // ── Log call outcome (pure frontend + voice) ──────────────────────────────
  const logCallOutcome = (delivery, outcome, reschedTime = null) => {
    const waStatus = outcome === 'answered_available'   ? 'replied_yes'
                   : outcome === 'answered_unavailable' ? 'replied_no'
                   : outcome === 'not_answered'         ? 'call_missed'
                   : 'rescheduled';
    updateCustomerState(delivery.customer_id, {
      callStatus: outcome, waStatus, reschedTime,
      repliedAt:  new Date().toISOString(),
    });
    const voiceMap = {
      answered_available:   `${delivery.customer_name} confirmed availability. Moved to top priority. Route updated.`,
      not_answered:         `No answer from ${delivery.customer_name}. Moved to lower priority. Moving to next.`,
      answered_unavailable: `${delivery.customer_name} not available today. Delivery deprioritised. Route updated.`,
      rescheduled:          `${delivery.customer_name} rescheduled to ${reschedTime || 'a new time'}. Priority adjusted.`,
    };
    // ✅ FIX 3: use voiceQueue (bypasses gesture restriction)
    queueVoice(voiceMap[outcome] || `${delivery.customer_name} call outcome recorded.`);
    showToast({
      answered_available:   `✅ ${delivery.customer_name} — Available. Priority boosted!`,
      not_answered:         `🔴 ${delivery.customer_name} — No answer. Moved to bottom.`,
      answered_unavailable: `❌ ${delivery.customer_name} — Not home. Deprioritised.`,
      rescheduled:          `🕐 ${delivery.customer_name} — Rescheduled to ${reschedTime}.`,
    }[outcome] || 'Call outcome recorded.');
    // ✅ FIX 1: removed fetchPriorityRef.current?.() — backend fetch overwrites frontend sort
  };

  // ── Call-needed timer: pending → call_needed after 5 min ─────────────────
  // Race guard: only escalate if STILL pending (no WA reply arrived meanwhile)
  const CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
  const RESOLVED_STATUSES = new Set([
    'replied_yes', 'replied_no', 'rescheduled', 'call_needed',
    'answered_available', 'answered_unavailable', 'delivered',
  ]);
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setCustomerStates(prev => {
        let changed = false;
        const next = { ...prev };
        const newlyNeeded = [];
        Object.entries(next).forEach(([cid, cs]) => {
          // Skip: already resolved, already escalated, or no sentAt timestamp
          if (RESOLVED_STATUSES.has(cs.waStatus)) return;
          if (cs.waStatus !== 'pending' || !cs.sentAt) return;
          if (now - new Date(cs.sentAt).getTime() >= CALL_TIMEOUT_MS) {
            next[cid] = { ...cs, waStatus: 'call_needed' };
            changed = true;
            newlyNeeded.push(cs.name || cid);
          }
        });
        if (newlyNeeded.length > 0) {
          speak(`Attention. ${newlyNeeded[0]} has not replied on WhatsApp. Please call them now.`);
          showToast(`📞 ${newlyNeeded.join(', ')} did not reply — Call required!`);
        }
        return changed ? next : prev;
      });
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // ── Socket.IO — use App's shared socket to avoid duplicate connections ────
  useEffect(() => {
    const socket = appSocket || SocketIO(base, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    // WhatsApp reply (NLP-enhanced from backend)
    socket.on('whatsapp_reply', (payload) => {
      const {
        phone_10, reply_type, rescheduled_time, reply,
        confidence = 1.0, extracted_time,
      } = payload || {};

      if (!phone_10 || !reply_type) return; // malformed payload guard

      // Low-confidence unknown — show toast but don't change state
      if (reply_type === 'unknown' || confidence < 0.5) {
        showToast(`📱 Unclear reply received (${confidence ? Math.round(confidence * 100) : '?'}% confidence). Please call customer.`);
        return;
      }

      setCustomerStates(prev => {
        // Normalise comparison: both to last 10 digits
        const normalise = (p) => String(p || '').replace(/\D/g, '').slice(-10);
        const norm10 = normalise(phone_10);

        const entry = Object.entries(prev).find(([, cs]) =>
          normalise(cs.phone10) === norm10
        );

        if (!entry) {
          showToast(`📱 Reply from unrecognised number: ${phone_10}`);
          return prev;
        }

        const [cid, cs] = entry;

        // Skip if customer is already delivered
        if (cs.waStatus === 'delivered') return prev;

        // Skip if same status already set (no-op dedup)
        const newStatus = reply_type === 'yes'        ? 'replied_yes'
                        : reply_type === 'no'         ? 'replied_no'
                        : reply_type === 'reschedule' ? 'rescheduled'
                        : cs.waStatus; // unknown — keep current
        if (newStatus === cs.waStatus && cs.waStatus !== 'pending') return prev;

        const name = cs.name || cid;
        const resolvedTime = extracted_time || rescheduled_time;

        const phrases = {
          yes:        `${name} confirmed availability. Moving to top priority. Route updated.`,
          no:         `${name} is not available today. Moved to bottom. Route updated.`,
          reschedule: `${name} rescheduled to ${resolvedTime || 'a new time'}. Priority adjusted.`,
        };
        if (phrases[reply_type]) speak(phrases[reply_type]);

        showToast({
          yes:        `✅ ${name} confirmed — Available! Route updated.`,
          no:         `❌ ${name} — Not available. Route updated.`,
          reschedule: `🕐 ${name} rescheduled: ${resolvedTime || reply}`,
        }[reply_type] || `📱 ${name}: ${reply}`);

        setTimeout(() => updateCustomerState(cid, {
          waStatus:   newStatus,
          reschedTime: resolvedTime,
          repliedAt:  new Date().toISOString(),
        }), 0);
        return prev;
      });
    });


    // Legacy event (backward compat)
    socket.on('availability_update', (data) => {
      if (data.customer_id) {
        const waStatus = data.status === 'confirmed' ? 'replied_yes' : data.status === 'not_available' ? 'replied_no' : data.status;
        updateCustomerState(data.customer_id, { waStatus });
      }
      showToast(`${data.customer_name || 'Customer'} - ${data.status}`);
      // ✅ FIX 1: no fetchPriorityRef call here
    });

    // Lightweight poll: sync with backend /availability endpoints (for route APIs)
    const pollAvail = async () => {
      try {
        const res = await axios.get(`${base}/availability/status-all`);
        if (res.data?.statuses) {
          Object.entries(res.data.statuses).forEach(([cid, av]) => {
            if (['confirmed', 'not_available'].includes(av.status)) {
              setCustomerStates(prev => ({
                ...prev,
                [cid]: { ...(prev[cid] || {}), waStatus: av.status === 'confirmed' ? 'replied_yes' : 'replied_no' },
              }));
            }
          });
        }
      } catch { /* silent */ }
    };
    pollAvail();
    const timer = setInterval(pollAvail, 60000);
    // Only disconnect if we created our own socket (don't kill App's socket)
    return () => { if (!appSocket) socket.disconnect(); clearInterval(timer); };
  }, [base]);



  // ── Handlers ─────────────────────────────────────────────────────────────

  const submitFeedback = async () => {
    if (!fbDeliveryId || !fbCustomerId || !fbAgentId) {
      showToast('Fill Delivery ID, Customer ID & Agent ID.'); return;
    }
    setLoading(true);
    try {
      await axios.post(`${base}/priority/submit-feedback`, {
        delivery_id: fbDeliveryId, customer_id: fbCustomerId,
        agent_id: fbAgentId, outcome: fbOutcome,
        contact_reached: fbContact, agent_note: fbNote,
      });
      showToast('Feedback submitted! Customer profile updated.');
      setFbDeliveryId(''); setFbCustomerId(''); setFbAgentId(''); setFbNote('');
    } catch (e) {
      showToast('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setLoading(false); }
  };

  const savePreference = async () => {
    if (!prefCid) { showToast('Enter Customer ID.'); return; }
    setLoading(true);
    try {
      await axios.post(`${base}/priority/set-preference`, {
        customer_id: prefCid, preferred_slot: prefSlot,
        available_from: prefFrom, available_to: prefTo,
      });
      showToast('Preference saved!');
      setPrefCid('');
    } catch (e) {
      showToast('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setLoading(false); }
  };

  const fetchAdmin = async () => {
    setLoading(true);
    try {
      const res = await axios.get(`${base}/priority/admin-overview`);
      setAdminData(res.data);
    } catch { showToast('Could not load admin data.'); }
    finally { setLoading(false); }
  };

  // ── Styles ────────────────────────────────────────────────────────────────
  const S = {
    overlay: {
      position: 'fixed', inset: 0, zIndex: 8000,
      background: 'rgba(15,23,42,0.45)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    },
    panel: {
      background: 'linear-gradient(145deg,#ffffff,#f8fafc)',
      borderRadius: 24, boxShadow: '0 32px 80px rgba(0,0,0,0.18)',
      width: '100%', maxWidth: 560, maxHeight: '90vh',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden', border: '1px solid #e2e8f0',
    },
    header: {
      padding: '20px 24px 0', borderBottom: '1px solid #e2e8f0',
      background: 'linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%)',
    },
    tabs: {
      display: 'flex', gap: 4, padding: '0 24px',
      background: 'linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%)',
    },
    body:  { flex: 1, overflowY: 'auto', padding: 24 },
    input: {
      width: '100%', border: '1px solid #e2e8f0', borderRadius: 10,
      padding: '10px 14px', fontSize: 13, color: '#0f172a',
      background: '#f8fafc', outline: 'none', boxSizing: 'border-box',
    },
    btn: (color = '#6366f1', text = 'white') => ({
      background: color, color: text, border: 'none', borderRadius: 12,
      padding: '11px 20px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
      transition: 'opacity 0.2s', width: '100%',
    }),
    card: {
      background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14,
      padding: 16, marginBottom: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
    },
    label: { fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4, display: 'block' },
    section: { marginBottom: 20 },
  };

  const tabBtn = (id, label, icon) => {
    const active = tab === id;
    return (
      <button key={id} onClick={() => { setTab(id); if (id === 'priority') fetchPriority(); if (id === 'admin') fetchAdmin(); }}
        style={{
          border: 'none', background: active ? 'rgba(255,255,255,0.25)' : 'transparent',
          color: active ? '#fff' : 'rgba(255,255,255,0.65)',
          padding: '10px 14px', borderRadius: '10px 10px 0 0',
          fontWeight: 700, fontSize: 11, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 5,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>{icon}{label}</button>
    );
  };

  const prioritySummary = results?.summary || {};

  // ── Live-sorted deliveries: customerStates scores applied in real-time ─────
  const scoreCs = (cs) => {
    if (!cs) return 30;
    if (cs.waStatus === 'replied_yes'  || cs.callStatus === 'answered_available')  return 100;
    if (cs.waStatus === 'rescheduled'  || cs.callStatus === 'rescheduled')          return  50;
    if (!cs.waStatus || cs.waStatus === 'pending')                                  return  30;
    if (cs.waStatus === 'call_needed')                                              return  20;
    if (cs.waStatus === 'replied_no'   || cs.callStatus === 'answered_unavailable') return   5;
    if (cs.callStatus === 'not_answered')                                           return   2;
    return 15;
  };
  const deliveries = [...(results?.priority_order || [])].sort((a, b) =>
    (scoreCs(customerStates[b.customer_id]) + (b.priority_score || 0.5) * 40) -
    (scoreCs(customerStates[a.customer_id]) + (a.priority_score || 0.5) * 40)
  );

  const confirmedCount = Object.values(customerStates).filter(
    cs => cs.waStatus === 'replied_yes' || cs.callStatus === 'answered_available'
  ).length;
  const callNeededCount = Object.values(customerStates).filter(
    cs => cs.waStatus === 'call_needed' || cs.callStatus === 'not_answered'
  ).length;


  return (
    <>
      {/* ── Floating Button ── */}
      <button
        id="priority-module-btn"
        onClick={() => { setOpen(true); fetchPriority(); }}
        title="Smart Priority Module"
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 7999,
          background: callNeededCount > 0
            ? 'linear-gradient(135deg,#ea580c,#dc2626)'
            : 'linear-gradient(135deg,#6366f1,#8b5cf6)',
          border: 'none', borderRadius: '50%', width: 56, height: 56,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: callNeededCount > 0
            ? '0 8px 24px rgba(234,88,12,0.55)'
            : '0 8px 24px rgba(99,102,241,0.45)',
          cursor: 'pointer', transition: 'all 0.3s',
        }}
        onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.1)'}
        onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
      >
        <IcoStar size={24} color="white" />
        {/* Green badge: confirmed customers */}
        {confirmedCount > 0 && (
          <span style={{
            position: 'absolute', top: -4, right: -4, background: '#22c55e',
            color: '#fff', borderRadius: '50%', width: 20, height: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 800, border: '2px solid #fff',
          }}>{confirmedCount}</span>
        )}
        {/* Orange badge: call-needed customers (overrides green position) */}
        {callNeededCount > 0 && (
          <span style={{
            position: 'absolute', top: -4, left: -4, background: '#f97316',
            color: '#fff', borderRadius: '50%', width: 20, height: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 800, border: '2px solid #fff',
            animation: 'pulse 1s infinite',
          }}>{callNeededCount}</span>
        )}
      </button>


      {/* ── Toast ── */}
      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            style={{
              position: 'fixed', bottom: 90, right: 24, zIndex: 9000,
              background: '#0f172a', color: '#fff', borderRadius: 12,
              padding: '12px 20px', fontSize: 13, fontWeight: 600,
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)', maxWidth: 320,
            }}>{toast}</motion.div>
        )}
      </AnimatePresence>

      {/* ── Panel ── */}
      <AnimatePresence>
        {open && (
          <div style={S.overlay} onClick={e => e.target === e.currentTarget && setOpen(false)}>
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 30 }} animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 30 }} transition={{ type: 'spring', damping: 22, stiffness: 260 }}
              style={S.panel}
            >
              {/* Header */}
              <div style={S.header}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 16 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ background: 'rgba(255,255,255,0.2)', borderRadius: 10, padding: 8 }}>
                        <IcoStar size={20} color="white" />
                      </div>
                      <span style={{ color: '#fff', fontWeight: 800, fontSize: 18 }}>Smart Priority</span>
                    </div>
                    <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 4, fontWeight: 600 }}>
                      SMART RISK INTELLIGENCE — ROAD + CUSTOMER + LIVE AVAILABILITY
                    </p>
                  </div>
                  <button onClick={() => setOpen(false)} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, cursor: 'pointer', padding: 7 }}>
                    <IcoClose size={16} color="white" />
                  </button>
                </div>

                {/* Stats strip */}
                {results && (
                  <div style={{ display: 'flex', gap: 8, paddingBottom: 12 }}>
                    {[
                      { label: 'Low Risk',  val: prioritySummary.low    ?? 0, color: '#22c55e' },
                      { label: 'Med Risk',  val: prioritySummary.medium  ?? 0, color: '#f59e0b' },
                      { label: 'High Risk', val: prioritySummary.high   ?? 0, color: '#ef4444' },
                      { label: 'Confirmed', val: confirmedCount,              color: '#a5b4fc' },
                    ].map(s => (
                      <div key={s.label} style={{ flex: 1, background: 'rgba(255,255,255,0.15)', borderRadius: 10, padding: '8px 4px', textAlign: 'center' }}>
                        <div style={{ color: s.color, fontWeight: 800, fontSize: 18 }}>{s.val}</div>
                        <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase' }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* ✅ WhatsApp Status Bar — visible on both web + mobile */}
                <div style={{
                  background: waSending ? 'rgba(245,158,11,0.2)'
                            : waSent > 0 ? 'rgba(37,211,102,0.15)'
                            : 'rgba(255,255,255,0.1)',
                  border: `1px solid ${waSending ? 'rgba(245,158,11,0.5)' : waSent > 0 ? 'rgba(37,211,102,0.4)' : 'rgba(255,255,255,0.15)'}`,
                  borderRadius: 10, padding: '8px 12px', marginBottom: 12,
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  {/* WA icon */}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="#25D366">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                    <path d="M12 0C5.373 0 0 5.373 0 12c0 2.126.554 4.122 1.524 5.852L.057 23.998l6.304-1.652A11.954 11.954 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.882a9.88 9.88 0 01-5.032-1.376l-.36-.214-3.742.981.998-3.648-.235-.374A9.867 9.867 0 012.118 12C2.118 6.534 6.534 2.118 12 2.118c5.465 0 9.882 4.416 9.882 9.882 0 5.465-4.417 9.882-9.882 9.882z"/>
                  </svg>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#fff', fontWeight: 700, fontSize: 12 }}>
                      {waSending ? '⏳ Sending WhatsApp messages...'
                       : waSent > 0 ? `✅ WA Sent (${waSent}) — ${confirmedCount} replied`
                       : '💬 WhatsApp Auto-Notify'}
                    </div>
                    <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10, marginTop: 1 }}>
                      {waSending ? 'Please wait'
                       : waSent > 0 ? 'Replies update cards automatically'
                       : 'Upload CSV to auto-send'}
                    </div>
                  </div>
                  {/* Reply count badges */}
                  {waSent > 0 && (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <span style={{ background: '#22c55e', color: '#fff', borderRadius: 6, padding: '2px 6px', fontSize: 9, fontWeight: 800 }}>
                        {Object.values(customerStates).filter(cs => cs.waStatus === 'replied_yes').length} ✔
                      </span>
                      <span style={{ background: '#ef4444', color: '#fff', borderRadius: 6, padding: '2px 6px', fontSize: 9, fontWeight: 800 }}>
                        {Object.values(customerStates).filter(cs => cs.waStatus === 'replied_no').length} ✘
                      </span>
                      <span style={{ background: '#f59e0b', color: '#fff', borderRadius: 6, padding: '2px 6px', fontSize: 9, fontWeight: 800 }}>
                        {Object.values(customerStates).filter(cs => cs.waStatus === 'call_needed').length} 📞
                      </span>
                    </div>
                  )}
                </div>

                {/* Tabs */}
                <div style={S.tabs}>
                  {tabBtn('priority',   'Priority',   <IcoStar     size={12} color="currentColor" />)}
                  {tabBtn('feedback',   'Feedback',   <IcoFeedback size={12} color="currentColor" />)}
                  {tabBtn('preference', 'Preference', <IcoPref     size={12} color="currentColor" />)}
                  {tabBtn('admin',      'Admin',      <IcoAdmin    size={12} color="currentColor" />)}
                </div>
              </div>

              {/* Body */}
              <div style={S.body}>
                {loading && (
                  <div style={{ textAlign: 'center', padding: 20, color: '#6366f1', fontWeight: 700, fontSize: 13 }}>
                    ⏳ Loading...
                  </div>
                )}

                {/* ── PRIORITY TAB ── */}
                {tab === 'priority' && !loading && (
                  <>
                    {deliveries.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
                        <IcoStar size={40} color="#c7d2fe" />
                        <p style={{ marginTop: 12, fontWeight: 700 }}>No deliveries loaded yet.</p>
                        <p style={{ fontSize: 12, marginTop: 4 }}>Upload Smart CSV via left sidebar to begin.</p>
                      </div>
                    ) : (
                      <div style={S.section}>
                        {deliveries.map((d, idx) => {
                          const cs            = customerStates[d.customer_id] || {};
                          const isConfirmed   = cs.waStatus === 'replied_yes'  || cs.callStatus === 'answered_available';
                          const isNotHome     = cs.waStatus === 'replied_no'   || cs.callStatus === 'answered_unavailable';
                          const isCallNeeded  = cs.waStatus === 'call_needed';
                          const isCallMissed  = cs.callStatus === 'not_answered';
                          const isRescheduled = cs.waStatus === 'rescheduled'  || cs.callStatus === 'rescheduled';
                          const tier          = d.risk_tier || 'low';
                          const ts            = TIER_STYLES[tier] || TIER_STYLES.low;

                          // Card border colour by live status
                          const borderColor = isConfirmed   ? '#22c55e'
                                            : isCallNeeded || isCallMissed ? '#f97316'
                                            : isNotHome     ? '#ef4444'
                                            : isRescheduled ? '#a855f7'
                                            : ts.dot;

                          return (
                            <div key={d.customer_id || idx} style={{ ...S.card, borderLeft: `4px solid ${borderColor}`, marginBottom: 10 }}>
                              {/* Rank + Name + Tier */}
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span style={{ background: borderColor, color: '#fff', borderRadius: '50%', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 900, flexShrink: 0 }}>{idx + 1}</span>
                                  <div>
                                    <div style={{ fontWeight: 800, fontSize: 14, color: '#0f172a' }}>{d.customer_name || d.customer_id}</div>
                                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>{d.address}</div>
                                  </div>
                                </div>
                                <TierBadge tier={tier} />
                              </div>

                              {/* Live Status Banner */}
                              {isConfirmed ? (
                                <div style={{ marginBottom: 8 }}>
                                  <div style={{ background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 8, padding: '6px 10px', fontSize: 11, color: '#166534', fontWeight: 700, marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span>✅</span>
                                    <span>{cs.callStatus === 'answered_available' ? 'Confirmed by Call' : 'Replied YES — Available'}</span>
                                    <span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 10 }}>
                                      {cs.repliedAt ? new Date(cs.repliedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''}
                                    </span>
                                  </div>
                                  {d.phone && (
                                    <a href={`tel:${d.phone}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: '#3b82f6', color: '#fff', borderRadius: 8, padding: '7px 10px', fontSize: 12, fontWeight: 800, textDecoration: 'none' }}>
                                      📞 Call {d.customer_name?.split(' ')[0]}
                                    </a>
                                  )}
                                </div>
                              ) : isRescheduled ? (
                                <div style={{ background: '#f3e8ff', border: '1px solid #d8b4fe', borderRadius: 8, padding: '6px 10px', fontSize: 11, color: '#6b21a8', fontWeight: 700, marginBottom: 8 }}>
                                  🕐 Rescheduled to {cs.reschedTime || 'new time'} — Priority adjusted
                                </div>
                              ) : isNotHome ? (
                                <div style={{ marginBottom: 8 }}>
                                  <div style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, padding: '6px 10px', fontSize: 11, color: '#991b1b', fontWeight: 700, marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span>❌</span>
                                    <span>{cs.callStatus === 'answered_unavailable' ? 'Not Home (Call logged)' : 'Replied NO — Not available'}</span>
                                    <span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 10 }}>
                                      {cs.repliedAt ? new Date(cs.repliedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''}
                                    </span>
                                  </div>
                                  {d.phone && (
                                    <a href={`tel:${d.phone}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: '#ef4444', color: '#fff', borderRadius: 8, padding: '7px 10px', fontSize: 12, fontWeight: 800, textDecoration: 'none' }}>
                                      📞 Call to Reschedule
                                    </a>
                                  )}
                                </div>
                              ) : isCallNeeded || isCallMissed ? (
                                <div style={{ marginBottom: 8 }}>
                                  <div style={{ background: '#fff7ed', border: '2px solid #fb923c', borderRadius: 10, padding: '8px 12px', marginBottom: 7 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                      <span style={{ fontSize: 16 }}>📞</span>
                                      <span style={{ color: '#9a3412', fontWeight: 800, fontSize: 12 }}>
                                        {isCallMissed ? 'No answer — Call again or skip' : 'No WhatsApp reply — Call now!'}
                                      </span>
                                    </div>
                                    {d.phone && (
                                      <a href={`tel:${d.phone}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: '#ea580c', color: '#fff', borderRadius: 8, padding: '8px 10px', fontSize: 12, fontWeight: 800, textDecoration: 'none', marginBottom: 7 }}>
                                        📞 Call {d.customer_name?.split(' ')[0]} — {d.phone}
                                      </a>
                                    )}
                                    <div style={{ fontSize: 10, color: '#7c3aed', fontWeight: 700, marginBottom: 5 }}>LOG CALL OUTCOME:</div>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                                      <button onClick={() => logCallOutcome(d, 'answered_available')}
                                        style={{ background: '#dcfce7', color: '#166534', border: '1.5px solid #86efac', borderRadius: 8, padding: '8px 4px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                                        ✅ Answered — Home
                                      </button>
                                      <button onClick={() => logCallOutcome(d, 'not_answered')}
                                        style={{ background: '#fef3c7', color: '#92400e', border: '1.5px solid #fcd34d', borderRadius: 8, padding: '8px 4px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                                        🔇 No Answer
                                      </button>
                                      <button onClick={() => logCallOutcome(d, 'answered_unavailable')}
                                        style={{ background: '#fee2e2', color: '#991b1b', border: '1.5px solid #fca5a5', borderRadius: 8, padding: '8px 4px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                                        ❌ Not Home Today
                                      </button>
                                      <button onClick={() => { const t = prompt(`Reschedule time for ${d.customer_name}:`, '5 PM'); if (t) logCallOutcome(d, 'rescheduled', t); }}
                                        style={{ background: '#ede9fe', color: '#6d28d9', border: '1.5px solid #c4b5fd', borderRadius: 8, padding: '8px 4px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                                        🕐 Reschedule
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 10px', fontSize: 11, color: '#94a3b8', fontWeight: 600, marginBottom: 6 }}>
                                    ⏳ Awaiting reply — message sent. Tap WhatsApp or Call below.
                                  </div>
                                  {(() => {
                                    const phone    = d.phone ? `91${String(d.phone).replace(/\D/g, '')}` : '';
                                    const firstName = (d.customer_name || '').split(' ')[0];
                                    const waText   = encodeURIComponent(`Hi ${firstName}! Your SmartParcel parcel arrives today. Reply YES if you're home or NO if not. — SmartParcel`);
                                    const waHref   = phone ? `https://wa.me/${phone}?text=${waText}` : `https://wa.me/?text=${waText}`;
                                    return (
                                      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                                        <a href={waHref} target="_blank" rel="noreferrer"
                                          style={{ flex: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: '#25D366', color: '#fff', borderRadius: 8, padding: '9px 10px', fontSize: 12, fontWeight: 800, textDecoration: 'none' }}>
                                          💬 WhatsApp
                                        </a>
                                        <a href={`tel:${d.phone || ''}`}
                                          style={{ flex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: '#3b82f6', color: '#fff', borderRadius: 8, padding: '9px 8px', fontSize: 12, fontWeight: 800, textDecoration: 'none' }}>
                                          📞 Call
                                        </a>
                                      </div>
                                    );
                                  })()}
                                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                                    <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600, display: 'flex', alignItems: 'center', marginRight: 4, whiteSpace: 'nowrap' }}>Got reply?</div>
                                    <button onClick={() => markAvailability(d, 'confirmed')}
                                      style={{ flex: 1, background: '#dcfce7', color: '#166534', border: '1.5px solid #86efac', borderRadius: 8, padding: '7px 6px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                                      ✅ YES — Home
                                    </button>
                                    <button onClick={() => markAvailability(d, 'not_available')}
                                      style={{ flex: 1, background: '#fee2e2', color: '#991b1b', border: '1.5px solid #fca5a5', borderRadius: 8, padding: '7px 6px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                                      ❌ NO — Not Home
                                    </button>
                                  </div>
                                </>
                              )}

                              {/* Stats + Recommendation */}
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                                {[
                                  { l: 'Scheduled', v: d.scheduled_time },
                                  { l: 'Failed x',  v: d.factors?.failed_attempts ?? 0 },
                                  { l: 'Score',     v: (d.priority_score * 100).toFixed(0) + '%' },
                                ].map(f => (
                                  <div key={f.l} style={{ background: '#f8fafc', borderRadius: 8, padding: '6px 8px', textAlign: 'center' }}>
                                    <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase' }}>{f.l}</div>
                                    <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a' }}>{f.v}</div>
                                  </div>
                                ))}
                              </div>
                              <div style={{ background: '#fefce8', border: '1px solid #fde68a', borderRadius: 8, padding: '7px 12px', fontSize: 11, color: '#78350f', fontWeight: 600 }}>
                                💡 {isNotHome ? 'Reschedule — customer not home' : d.recommendation || 'Proceed to this stop'}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}

                {/* ── FEEDBACK TAB ── */}
                {tab === 'feedback' && !loading && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <p style={{ fontSize: 13, color: '#64748b', fontWeight: 600, marginBottom: 4 }}>
                      Submit delivery outcome — updates customer risk profile.
                    </p>
                    {[
                      { label: 'Delivery ID',  val: fbDeliveryId, set: setFbDeliveryId, ph: 'DEL101' },
                      { label: 'Customer ID',  val: fbCustomerId, set: setFbCustomerId, ph: 'KARUR001' },
                      { label: 'Agent ID',     val: fbAgentId,    set: setFbAgentId,    ph: 'KAGT01' },
                    ].map(f => (
                      <div key={f.label}>
                        <label style={S.label}>{f.label}</label>
                        <input style={S.input} placeholder={f.ph} value={f.val} onChange={e => f.set(e.target.value)} />
                      </div>
                    ))}
                    <div>
                      <label style={S.label}>Outcome</label>
                      <select style={S.input} value={fbOutcome} onChange={e => setFbOutcome(e.target.value)}>
                        <option value="success">✅ Delivered Successfully</option>
                        <option value="failed_not_home">❌ Customer Not Home</option>
                        <option value="failed_contact">📞 Contact Unreachable</option>
                        <option value="failed_refused">🚫 Customer Refused</option>
                        <option value="rescheduled">🔄 Rescheduled</option>
                      </select>
                    </div>
                    <div>
                      <label style={S.label}>Contact Reached?</label>
                      <div style={{ display: 'flex', gap: 12 }}>
                        {[true, false].map(v => (
                          <button key={String(v)} onClick={() => setFbContact(v)}
                            style={{
                              flex: 1, padding: '10px 0', borderRadius: 10, fontWeight: 700, fontSize: 13,
                              border: `2px solid ${fbContact === v ? '#6366f1' : '#e2e8f0'}`,
                              background: fbContact === v ? '#eef2ff' : '#fff',
                              color: fbContact === v ? '#4338ca' : '#64748b', cursor: 'pointer',
                            }}>
                            {v ? '✅ Yes' : '❌ No'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label style={S.label}>Note (optional)</label>
                      <input style={S.input} placeholder="Any agent note…" value={fbNote} onChange={e => setFbNote(e.target.value)} />
                    </div>
                    <button style={S.btn()} onClick={submitFeedback}>Submit Feedback</button>
                  </div>
                )}

                {/* ── PREFERENCE TAB ── */}
                {tab === 'preference' && !loading && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <p style={{ fontSize: 13, color: '#64748b', fontWeight: 600, marginBottom: 4 }}>
                      Set or update a customer's preferred delivery time slot.
                    </p>
                    <div>
                      <label style={S.label}>Customer ID</label>
                      <input style={S.input} placeholder="KARUR001" value={prefCid} onChange={e => setPrefCid(e.target.value)} />
                    </div>
                    <div>
                      <label style={S.label}>Preferred Slot</label>
                      {['morning', 'afternoon', 'evening', 'any'].map(slot => (
                        <button key={slot} onClick={() => setPrefSlot(slot)}
                          style={{
                            display: 'block', width: '100%', marginBottom: 8,
                            padding: '11px 16px', textAlign: 'left', borderRadius: 10,
                            border: `2px solid ${prefSlot === slot ? '#6366f1' : '#e2e8f0'}`,
                            background: prefSlot === slot ? '#eef2ff' : '#fff',
                            color: prefSlot === slot ? '#4338ca' : '#64748b',
                            fontWeight: 700, fontSize: 13, cursor: 'pointer',
                          }}>
                          {{ morning: '🌅 Morning (6–12)', afternoon: '☀️ Afternoon (12–17)', evening: '🌆 Evening (17–22)', any: '🕐 Any Time' }[slot]}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 12 }}>
                      <div style={{ flex: 1 }}>
                        <label style={S.label}>Available From</label>
                        <input type="time" style={S.input} value={prefFrom} onChange={e => setPrefFrom(e.target.value)} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={S.label}>Available To</label>
                        <input type="time" style={S.input} value={prefTo} onChange={e => setPrefTo(e.target.value)} />
                      </div>
                    </div>
                    <button style={S.btn()} onClick={savePreference}>Save Preference</button>
                  </div>
                )}

                {/* ── ADMIN TAB ── */}
                {tab === 'admin' && !loading && (
                  <>
                    {/* ── Twilio Webhook Setup + Voice Test ── */}
                    <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: 14, marginBottom: 16 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#166534', marginBottom: 8 }}>
                        📡 Twilio Webhook URL
                      </div>
                      <div style={{
                        background: '#dcfce7', borderRadius: 8, padding: '8px 12px',
                        fontFamily: 'monospace', fontSize: 11, color: '#15803d',
                        wordBreak: 'break-all', marginBottom: 8,
                      }}>
                        {window.location.origin}/twilio/webhook
                      </div>
                      <div style={{ fontSize: 11, color: '#166534', marginBottom: 10 }}>
                        Paste this URL in → Twilio Console → Messaging → WhatsApp Sandbox → "When a message comes in"
                      </div>
                      <button
                        style={{ ...S.btn(), background: '#16a34a', fontSize: 12, padding: '8px 16px' }}
                        onClick={() => {
                          navigator.clipboard?.writeText(`${window.location.origin}/twilio/webhook`);
                          speak('Voice navigation is working. Route updates automatically when customers reply.');
                          showToast('Webhook URL copied! Voice test played.');
                        }}
                      >
                        📋 Copy URL + Test Voice
                      </button>
                    </div>

                    {!adminData ? (
                      <div style={{ textAlign: 'center', padding: 40 }}>
                        <button style={S.btn()} onClick={fetchAdmin}>Load Admin Overview</button>
                      </div>

                    ) : (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 20 }}>
                          {[
                            { label: 'Customers',    val: adminData.total_customers },
                            { label: 'History Recs', val: adminData.total_history_records },
                            { label: "Today's",      val: adminData.todays_deliveries },
                          ].map(s => (
                            <div key={s.label} style={{ background: '#eef2ff', borderRadius: 12, padding: 14, textAlign: 'center' }}>
                              <div style={{ fontSize: 22, fontWeight: 800, color: '#4338ca' }}>{s.val}</div>
                              <div style={{ fontSize: 10, color: '#6366f1', fontWeight: 700, textTransform: 'uppercase' }}>{s.label}</div>
                            </div>
                          ))}
                        </div>

                        {/* Live Availability Status — from frontend customerStates */}
                        {Object.keys(customerStates).length > 0 && (
                          <div style={{ marginBottom: 20 }}>
                            <label style={S.label}>🟢 Live Availability Status</label>
                            {Object.entries(customerStates).filter(([,cs]) => cs.waStatus).map(([cid, cs]) => (
                              <div key={cid} style={{ ...S.card, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                  <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{cs.name || cid}</div>
                                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                                    {cs.waStatus} · {cs.repliedAt ? new Date(cs.repliedAt).toLocaleTimeString('en-IN', {hour:'2-digit',minute:'2-digit'}) : 'pending'}
                                    {cs.reschedTime ? ` · 🕐 ${cs.reschedTime}` : ''}
                                  </div>
                                </div>
                                <div style={{
                                  background: cs.waStatus === 'replied_yes' ? '#dcfce7'
                                            : cs.waStatus === 'replied_no'  ? '#fee2e2'
                                            : cs.waStatus === 'call_needed' ? '#fff7ed'
                                            : '#f1f5f9',
                                  color: cs.waStatus === 'replied_yes' ? '#166534'
                                       : cs.waStatus === 'replied_no'  ? '#991b1b'
                                       : cs.waStatus === 'call_needed' ? '#9a3412'
                                       : '#64748b',
                                  borderRadius: 999, padding: '4px 10px', fontSize: 10, fontWeight: 800,
                                }}>
                                  {cs.waStatus === 'replied_yes'  ? '✅ Available'
                                 : cs.waStatus === 'replied_no'  ? '❌ Not Home'
                                 : cs.waStatus === 'call_needed' ? '📞 Call Now'
                                 : cs.waStatus === 'rescheduled' ? `🕐 ${cs.reschedTime || 'Rescheduled'}`
                                 : cs.waStatus === 'call_missed' ? '🔴 No Answer'
                                 : '⏳ Pending'}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        <label style={S.label}>Customer Profiles</label>
                        {adminData.profiles.length === 0 ? (
                          <p style={{ color: '#94a3b8', fontSize: 13 }}>No profiles yet. Upload Smart CSV via sidebar.</p>
                        ) : adminData.profiles.map((p, i) => (
                          <div key={i} style={{ ...S.card, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{p.customer_name || p.customer_id}</div>
                              <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                                Slot: <b>{p.preferred_slot}</b> · Failed: <b>{p.failed_attempts}</b> · Contact: <b>{p.contact_reliable ? '✅' : '❌'}</b>
                              </div>
                            </div>
                            <div style={{
                              background: p.failed_attempts >= 3 ? '#fee2e2' : p.failed_attempts >= 1 ? '#fef9c3' : '#dcfce7',
                              color: p.failed_attempts >= 3 ? '#991b1b' : p.failed_attempts >= 1 ? '#854d0e' : '#166534',
                              borderRadius: 999, padding: '4px 10px', fontSize: 10, fontWeight: 800,
                            }}>
                              {p.failed_attempts >= 3 ? '🔴 HIGH' : p.failed_attempts >= 1 ? '🟡 MED' : '🟢 LOW'}
                            </div>
                          </div>
                        ))}
                        <button style={{ ...S.btn('#f1f5f9', '#475569'), marginTop: 12 }} onClick={fetchAdmin}>🔄 Refresh</button>
                      </>
                    )}
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
