/**
 * TwilioNotifier.jsx — WhatsApp Auto-Send (Stateless)
 * - Triggers send-all when CSV is uploaded
 * - Dispatches CustomEvents so PriorityModule updates its own state
 * - Renders nothing (WA status is embedded inside PriorityModule panel)
 */
import { useEffect, useRef } from 'react';
import axios from 'axios';

export default function TwilioNotifier({ deliveries, backendUrl, speak }) {
  const sentRef = useRef(false);

  useEffect(() => {
    if (!deliveries || deliveries.length === 0) {
      sentRef.current = false;
      return;
    }
    if (sentRef.current) return;
    sentRef.current = true;

    const sendAll = async () => {
      window.dispatchEvent(new CustomEvent('wa-sending'));

      const notifs = deliveries
        .filter(d => d.phone || d.customer_id)
        .map(d => ({
          customer_id:    String(d.customer_id   || d.id || ''),
          customer_name:  String(d.customer_name || 'Customer'),
          phone:          String(d.phone         || '').replace(/\D/g, ''),
          delivery_id:    String(d.id            || d.delivery_id || ''),
          scheduled_time: String(d.scheduled_time || d.delivery_time || '10:00'),
        }))
        .filter(n => n.phone.length >= 10);

      if (notifs.length === 0) {
        console.warn('[TwilioNotifier] No valid phone numbers — skipping.');
        window.dispatchEvent(new CustomEvent('wa-sent', { detail: [] }));
        return;
      }

      try {
        const res = await axios.post(`${backendUrl}/twilio/send-all`, {
          deliveries: notifs,
          backend_url: backendUrl,
        });
        const results = res.data.results || [];
        // ➡ PriorityModule listens for this to init customerStates
        window.dispatchEvent(new CustomEvent('wa-sent', { detail: results }));
        if (speak) speak(`WhatsApp sent to ${results.length} customers. Waiting for replies.`);
        console.log('[TwilioNotifier] send-all OK:', res.data);
      } catch (err) {
        console.error('[TwilioNotifier] send-all failed:', err.message);
        window.dispatchEvent(new CustomEvent('wa-sent', { detail: [] }));
      }
    };

    sendAll();
  }, [deliveries]);

  // All UI is inside PriorityModule panel — this renders nothing
  return null;
}
