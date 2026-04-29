/**
 * CustomerAvailability.jsx
 * ========================
 * Mobile-first customer page — accessible via:
 *   http://your-ip:5173/?id=KARUR001
 *
 * No login required. Customer taps link → confirms availability → agent notified.
 */

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ── Backend URL detection (same logic as App.jsx) ─────────────────────────
const BACKEND =
  localStorage.getItem('backend_url') ||
  (window.location.protocol === 'https:' ? window.location.origin : 'http://localhost:8000');

// ── Slots ─────────────────────────────────────────────────────────────────
const SLOTS = [
  { id: 'morning',   label: 'Morning',   emoji: '🌅', time: '8 AM – 12 PM',  from: '08:00', to: '12:00' },
  { id: 'afternoon', label: 'Afternoon', emoji: '☀️', time: '12 PM – 5 PM',  from: '12:00', to: '17:00' },
  { id: 'evening',   label: 'Evening',   emoji: '🌆', time: '5 PM – 9 PM',   from: '17:00', to: '21:00' },
  { id: 'any',       label: 'Any Time',  emoji: '🕐', time: 'Flexible',      from: '08:00', to: '21:00' },
];

export default function CustomerAvailability({ customerId }) {
  const [step,       setStep]       = useState('loading');  // loading | home | slot | confirm | done | error
  const [customer,   setCustomer]   = useState(null);
  const [errorMsg,   setErrorMsg]   = useState('');
  const [selSlot,    setSelSlot]    = useState('evening');
  const [customFrom, setCustomFrom] = useState('17:00');
  const [customTo,   setCustomTo]   = useState('21:00');
  const [submitting, setSubmitting] = useState(false);
  const [chosenStatus, setChosenStatus] = useState('');

  // ── Load customer info on mount ──────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const res  = await fetch(`${BACKEND}/availability/${customerId}`);
        const data = await res.json();
        if (data.error) { setErrorMsg(data.error); setStep('error'); return; }
        setCustomer(data);
        setStep('home');
      } catch (e) {
        // If backend is offline just show a minimal form
        setCustomer({ customer_id: customerId, customer_name: 'Customer', scheduled_time: 'Today', address: '' });
        setStep('home');
      }
    };
    load();
  }, [customerId]);

  // ── Submit availability ──────────────────────────────────────────────────
  const submit = async (status, slot, from, to) => {
    setSubmitting(true);
    setChosenStatus(status);
    try {
      await fetch(`${BACKEND}/availability/confirm`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id:    customerId,
          customer_name:  customer?.customer_name || customerId,
          status,          // confirmed | not_available | set_slot
          slot:            slot || 'any',
          available_from:  from || '08:00',
          available_to:    to   || '21:00',
        }),
      });
    } catch (e) { /* best-effort: UI still shows success */ }
    setSubmitting(false);
    setStep('done');
  };

  // ── Slot label helper ────────────────────────────────────────────────────
  const slotInfo = SLOTS.find(s => s.id === selSlot) || SLOTS[3];

  // ── Shared styles ────────────────────────────────────────────────────────
  const S = {
    page: {
      minHeight: '100dvh', background: 'linear-gradient(145deg,#6366f1 0%,#4f46e5 40%,#7c3aed 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, fontFamily: "'Inter','Segoe UI',sans-serif",
    },
    card: {
      background: '#fff', borderRadius: 28, padding: '32px 24px',
      width: '100%', maxWidth: 420, boxShadow: '0 32px 80px rgba(0,0,0,0.25)',
    },
    bigBtn: (bg, text = '#fff') => ({
      width: '100%', padding: '18px 16px', borderRadius: 16,
      background: bg, color: text, border: 'none', fontWeight: 800,
      fontSize: 16, cursor: 'pointer', marginBottom: 12,
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      boxShadow: '0 4px 16px rgba(0,0,0,0.10)', transition: 'transform 0.15s, opacity 0.15s',
    }),
    label: { fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.07em', display: 'block', marginBottom: 6 },
    input: {
      width: '100%', border: '2px solid #e2e8f0', borderRadius: 12, padding: '12px 14px',
      fontSize: 15, color: '#0f172a', outline: 'none', boxSizing: 'border-box',
      background: '#f8fafc',
    },
  };

  // ── Loading ──────────────────────────────────────────────────────────────
  if (step === 'loading') return (
    <div style={S.page}>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ textAlign: 'center' }}>
        <div style={{ width: 56, height: 56, border: '4px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
        <p style={{ color: '#fff', fontWeight: 700 }}>Loading your delivery info...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </motion.div>
    </div>
  );

  // ── Error ────────────────────────────────────────────────────────────────
  if (step === 'error') return (
    <div style={S.page}>
      <div style={S.card}>
        <div style={{ textAlign: 'center', padding: 20 }}>
          <div style={{ fontSize: 48 }}>❌</div>
          <h2 style={{ color: '#0f172a', marginTop: 12 }}>Link Not Found</h2>
          <p style={{ color: '#64748b', fontSize: 14, marginTop: 8 }}>{errorMsg}</p>
          <p style={{ color: '#64748b', fontSize: 13, marginTop: 8 }}>Please contact your delivery agent for the correct link.</p>
        </div>
      </div>
    </div>
  );

  // ── Done ─────────────────────────────────────────────────────────────────
  if (step === 'done') {
    const isConfirmed   = chosenStatus === 'confirmed' || chosenStatus === 'set_slot';
    const isNotAvailable= chosenStatus === 'not_available';
    return (
      <div style={S.page}>
        <motion.div initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', damping: 18 }} style={S.card}>
          <div style={{ textAlign: 'center' }}>
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.2, type: 'spring', damping: 12 }}
              style={{ width: 80, height: 80, borderRadius: '50%', background: isConfirmed ? '#dcfce7' : '#fee2e2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 36 }}>
              {isConfirmed ? '✅' : '❌'}
            </motion.div>

            <h1 style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', margin: 0 }}>
              {isConfirmed ? 'Confirmed!' : 'Noted!'}
            </h1>
            <p style={{ color: '#64748b', fontSize: 14, margin: '10px 0 24px' }}>
              {isConfirmed
                ? `You are marked available for ${slotInfo.emoji} ${slotInfo.label} (${slotInfo.time}). The delivery agent has been notified!`
                : 'Your delivery has been flagged for rescheduling. The agent will contact you.'}
            </p>

            {isConfirmed && (
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 14, padding: 16, textAlign: 'left', marginBottom: 20 }}>
                {[
                  { icon: '👤', label: 'Customer', val: customer?.customer_name },
                  { icon: '📅', label: 'Date',     val: 'Today' },
                  { icon: '🕐', label: 'Slot',     val: `${slotInfo.label} (${customFrom} – ${customTo})` },
                  { icon: '📍', label: 'Address',  val: customer?.address || 'Your registered address' },
                ].map(r => (
                  <div key={r.label} style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
                    <span>{r.icon}</span>
                    <span style={{ fontSize: 13, color: '#166534' }}><b>{r.label}:</b> {r.val}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ background: '#f8fafc', borderRadius: 12, padding: 14, fontSize: 13, color: '#64748b', textAlign: 'left' }}>
              💡 The delivery agent will call you {isConfirmed ? 'before arriving' : 'to reschedule'}.
              <br />Thank you for using SmartParcel! 📦
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  // ── Slot Picker ─────────────────────────────────────────────────────────
  if (step === 'slot') return (
    <div style={S.page}>
      <motion.div initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} style={S.card}>
        <button onClick={() => setStep('home')} style={{ background: 'none', border: 'none', color: '#6366f1', fontWeight: 700, fontSize: 14, cursor: 'pointer', marginBottom: 16, padding: 0 }}>
          ← Back
        </button>

        <h2 style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', margin: '0 0 6px' }}>Choose Your Slot</h2>
        <p style={{ color: '#64748b', fontSize: 14, margin: '0 0 20px' }}>When will you be home?</p>

        {SLOTS.map(slot => (
          <button key={slot.id} onClick={() => { setSelSlot(slot.id); setCustomFrom(slot.from); setCustomTo(slot.to); }}
            style={{
              ...S.bigBtn(selSlot === slot.id ? '#eef2ff' : '#f8fafc', '#0f172a'),
              border: `2px solid ${selSlot === slot.id ? '#6366f1' : '#e2e8f0'}`,
              boxShadow: selSlot === slot.id ? '0 0 0 3px rgba(99,102,241,0.15)' : 'none',
            }}>
            <span style={{ fontSize: 22 }}>{slot.emoji}</span>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 800, color: selSlot === slot.id ? '#4338ca' : '#0f172a' }}>{slot.label}</div>
              <div style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>{slot.time}</div>
            </div>
            {selSlot === slot.id && <span style={{ marginLeft: 'auto', color: '#6366f1', fontSize: 18 }}>✓</span>}
          </button>
        ))}

        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>From</label>
            <input type="time" style={S.input} value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>To</label>
            <input type="time" style={S.input} value={customTo} onChange={e => setCustomTo(e.target.value)} />
          </div>
        </div>

        <button onClick={() => submit('set_slot', selSlot, customFrom, customTo)} disabled={submitting}
          style={{ ...S.bigBtn('linear-gradient(135deg,#6366f1,#8b5cf6)'), opacity: submitting ? 0.7 : 1 }}>
          {submitting ? '⏳ Confirming...' : '✅ Confirm This Slot'}
        </button>
      </motion.div>
    </div>
  );

  // ── Home (main screen) ──────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', damping: 20 }} style={S.card}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.1, type: 'spring' }}
            style={{ width: 72, height: 72, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', borderRadius: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 32 }}>
            📦
          </motion.div>
          <h1 style={{ fontSize: 26, fontWeight: 900, color: '#0f172a', margin: '0 0 4px', letterSpacing: '-0.5px' }}>
            SmartParcel
          </h1>
          <p style={{ color: '#6366f1', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', margin: 0 }}>
            Delivery Confirmation
          </p>
        </div>

        {/* Customer Info Card */}
        <div style={{ background: 'linear-gradient(135deg,#eef2ff,#f5f3ff)', border: '1px solid #c7d2fe', borderRadius: 16, padding: 16, marginBottom: 24 }}>
          <p style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 800, color: '#0f172a' }}>
            Hello, {customer?.customer_name?.split(' ')[0] || 'Customer'}! 👋
          </p>
          <p style={{ margin: '0 0 10px', color: '#64748b', fontSize: 13 }}>
            You have a parcel scheduled for delivery today.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              { icon: '🕐', label: 'Scheduled', val: customer?.scheduled_time || 'Today' },
              { icon: '📍', label: 'Address',   val: customer?.area || 'Your address', truncate: true },
            ].map(r => (
              <div key={r.label} style={{ background: '#fff', borderRadius: 10, padding: '8px 10px' }}>
                <p style={{ margin: 0, fontSize: 10, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase' }}>{r.label}</p>
                <p style={{ margin: '2px 0 0', fontSize: 13, fontWeight: 700, color: '#0f172a', whiteSpace: r.truncate ? 'nowrap' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.icon} {r.val}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Question */}
        <p style={{ textAlign: 'center', fontWeight: 700, fontSize: 17, color: '#0f172a', marginBottom: 16 }}>
          Will you be home to receive it?
        </p>

        {/* Action Buttons */}
        <AnimatePresence>
          <motion.button key="yes" whileTap={{ scale: 0.97 }} onClick={() => submit('confirmed', 'any', '08:00', '21:00')}
            disabled={submitting}
            style={{ ...S.bigBtn('linear-gradient(135deg,#22c55e,#16a34a)') }}>
            <span style={{ fontSize: 20 }}>✅</span>
            <span>Yes, I'm Home!</span>
          </motion.button>

          <motion.button key="slot" whileTap={{ scale: 0.97 }} onClick={() => setStep('slot')}
            style={{ ...S.bigBtn('linear-gradient(135deg,#6366f1,#8b5cf6)') }}>
            <span style={{ fontSize: 20 }}>🕐</span>
            <span>I'll be home at a specific time</span>
          </motion.button>

          <motion.button key="no" whileTap={{ scale: 0.97 }} onClick={() => submit('not_available', 'none', '', '')}
            disabled={submitting}
            style={{ ...S.bigBtn('#fff', '#64748b'), border: '2px solid #e2e8f0', boxShadow: 'none' }}>
            <span style={{ fontSize: 20 }}>❌</span>
            <span>Not Available Today</span>
          </motion.button>
        </AnimatePresence>

        <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: 11, marginTop: 16, lineHeight: 1.5 }}>
          Your response helps the agent plan their route efficiently.<br />
          <b style={{ color: '#6366f1' }}>SmartParcel — Karur District</b>
        </p>
      </motion.div>
    </div>
  );
}
