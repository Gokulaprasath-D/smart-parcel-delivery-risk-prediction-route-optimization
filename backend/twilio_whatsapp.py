"""
Twilio WhatsApp Module — NLP-Enhanced
======================================
Backend responsibility:
  1. POST /twilio/send-all  → send WhatsApp messages via Twilio API
  2. POST /twilio/webhook   → receive customer reply → NLP parse → emit Socket.IO event
  3. GET  /twilio/reply-store → debug: view parsed replies in memory
  4. POST /twilio/clear-store → reset reply memory for new session

NLP parser understands natural language:
  "yes", "I am home", "come now"       → yes
  "no", "busy", "not now"              → no
  "after 2 pm", "evening", "tomorrow" → reschedule  (+ extracted HH:MM)
"""

from fastapi import APIRouter, Form, Request
from fastapi.responses import Response
from pydantic import BaseModel
from typing import List, Optional
import os, re, asyncio
from datetime import datetime
from nlp_reply_parser import (
    parse_reply, clear_reply_store, get_reply_store_snapshot,
    get_latest_reply, normalise_phone_10,
)


router = APIRouter(prefix="/twilio", tags=["Twilio WhatsApp"])

# ─── Socket.IO reference (injected from main.py) ─────────────────────────────
_sio = None

def set_socket_server(sio_instance):
    """Called once from main.py after sio is created."""
    global _sio
    _sio = sio_instance
# ─────────────────────────────────────────────────────────────────────────────


# ─── Pydantic models ──────────────────────────────────────────────────────────
class DeliveryNotif(BaseModel):
    customer_id:    str
    customer_name:  str
    phone:          str
    delivery_id:    str
    scheduled_time: str

class SendAllPayload(BaseModel):
    deliveries: List[DeliveryNotif]
    backend_url: Optional[str] = ""
# ─────────────────────────────────────────────────────────────────────────────


# ─── WhatsApp sender (stateless) ─────────────────────────────────────────────
def _send_whatsapp(to_phone: str, body: str) -> dict:
    """
    Send a WhatsApp message via Twilio.
    MOCK mode if credentials are not set (safe for demos).
    """
    sid   = os.environ.get("TWILIO_ACCOUNT_SID", "")
    token = os.environ.get("TWILIO_AUTH_TOKEN", "")
    from_ = os.environ.get("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886")

    phone_digits = re.sub(r"\D", "", to_phone)
    if len(phone_digits) == 10:
        phone_digits = "91" + phone_digits
    to_wa = f"whatsapp:+{phone_digits}"

    if not sid or not token:
        print(f"[Twilio MOCK] -> {to_wa}: {body[:80]}...")
        return {"status": "mock", "to": to_wa, "phone_digits": phone_digits}

    try:
        from twilio.rest import Client
        client = Client(sid, token)
        msg = client.messages.create(body=body, from_=from_, to=to_wa)
        print(f"[Twilio] Sent to {to_wa} — SID: {msg.sid}")
        return {"status": "sent", "sid": msg.sid, "to": to_wa, "phone_digits": phone_digits}
    except Exception as e:
        error_str = str(e)
        if "63038" in error_str or "daily messages limit" in error_str.lower():
            print("[Twilio LIMIT] Daily 50-message cap reached.")
            return {"status": "limit_exceeded", "error": "Daily limit (50/day trial)", "to": to_wa, "phone_digits": phone_digits}
        print(f"[Twilio ERROR] {e}")
        return {"status": "error", "error": error_str, "to": to_wa, "phone_digits": phone_digits}
# ─────────────────────────────────────────────────────────────────────────────


# ─── POST /twilio/send-all ────────────────────────────────────────────────────
@router.post("/send-all")
async def send_to_all_customers(payload: SendAllPayload):
    """
    Called by frontend after CSV upload.
    Sends WhatsApp to every customer. Also clears the NLP reply store
    so this new session starts fresh.
    """
    clear_reply_store()   # fresh NLP store for new delivery batch
    results   = []
    limit_hit = False

    for d in payload.deliveries:
        phone        = str(d.phone).strip()
        phone_digits = re.sub(r"\D", "", phone)

        if limit_hit:
            results.append({
                "customer_id":    d.customer_id,
                "customer_name":  d.customer_name,
                "phone":          phone,
                "phone_digits":   phone_digits,
                "delivery_id":    d.delivery_id,
                "scheduled_time": d.scheduled_time,
                "wa_status":      "skipped",
                "sent_at":        datetime.now().isoformat(),
            })
            continue

        message = (
            f"Hi {d.customer_name}! Your SmartParcel (ID: *{d.delivery_id}*) "
            f"will arrive around *{d.scheduled_time}*.\n"
            f"Are you available? Reply:\n"
            f"  YES - I'm home\n"
            f"  NO - Not available\n"
            f"  Or share your preferred time (e.g., 'after 3 pm' or 'evening')\n"
            f"- SmartParcel Delivery"
        )

        result = _send_whatsapp(phone, message)

        if result["status"] == "limit_exceeded":
            limit_hit = True
            print("[Twilio LIMIT] Stopping — daily cap reached.")

        results.append({
            "customer_id":    d.customer_id,
            "customer_name":  d.customer_name,
            "phone":          phone,
            "phone_digits":   result.get("phone_digits", phone_digits),
            "delivery_id":    d.delivery_id,
            "scheduled_time": d.scheduled_time,
            "wa_status":      result["status"],
            "sent_at":        datetime.now().isoformat(),
        })

    sent_count    = sum(1 for r in results if r["wa_status"] == "sent")
    skipped_count = sum(1 for r in results if r["wa_status"] in ("skipped", "limit_exceeded"))
    print(f"[Twilio] send-all: {len(results)} entries ({sent_count} sent, {skipped_count} skipped)")
    return {
        "sent":      sent_count,
        "results":   results,
        "limit_hit": limit_hit,
        "message":   (
            f"Daily limit reached — {sent_count}/{len(results)} sent."
            if limit_hit else
            f"WhatsApp sent to {sent_count} customers."
        ),
    }
# ─────────────────────────────────────────────────────────────────────────────


# ─── POST /twilio/webhook ─────────────────────────────────────────────────────
@router.post("/webhook")
async def twilio_webhook(
    request: Request,
    From: str = Form(default=""),
    Body: str = Form(default=""),
):
    """
    Twilio webhook: receive customer WhatsApp reply.
    • Consistent phone normalisation via normalise_phone_10()
    • Full try/except for malformed payloads
    • skip_emit: skips socket for same-type duplicate (no state change)
    • Low-confidence unknowns are logged for parser improvement
    """
    EMPTY_TWIML = "<?xml version='1.0' encoding='UTF-8'?><Response></Response>"

    try:
        # ── Normalise phone (consistent with frontend lookup) ─────────────
        phone_10  = normalise_phone_10(From)
        raw_reply = (Body or "").strip()

        if not phone_10:
            print(f"[Webhook] Received message with no parseable phone: From={From!r}")
            return Response(content=EMPTY_TWIML, media_type="text/xml")

        if not raw_reply:
            return Response(content=EMPTY_TWIML, media_type="text/xml")

        # ── NLP Classification ────────────────────────────────────────────
        parsed = parse_reply(phone_10, raw_reply)

        conf_pct = f"{parsed['confidence']:.0%}"
        print(
            f"[Webhook NLP] {phone_10} | '{raw_reply[:60]}' "
            f"-> {parsed['reply_type']} "
            f"(conf={conf_pct}, time={parsed['extracted_time']}, "
            f"dup={parsed['is_duplicate']}, skip={parsed['skip_emit']})"
        )

        # Low-confidence unknown — log for parser tuning
        if parsed["reply_type"] == "unknown":
            print(f"[NLP FALLBACK] '{raw_reply}' not classified. "
                  f"conf={conf_pct}. Frontend will trigger call escalation.")

        # ── Skip emit for same-type duplicates (no new info) ─────────────
        if parsed.get("skip_emit"):
            print(f"[Webhook] Skipping emit — same type duplicate from {phone_10}")
            return Response(content=EMPTY_TWIML, media_type="text/xml")

        # ── Emit enriched Socket.IO event ─────────────────────────────────
        if _sio:
            phone_digits = re.sub(r"\D", "", From.strip())
            event_payload = {
                "phone_10":         phone_10,
                "phone_digits":     phone_digits,
                "reply":            raw_reply,
                "reply_type":       parsed["reply_type"],
                "rescheduled_time": parsed["extracted_time"],
                "extracted_time":   parsed["extracted_time"],
                "confidence":       parsed["confidence"],
                "is_duplicate":     parsed["is_duplicate"],
                "previous_type":    parsed["previous_type"],
                "timestamp":        parsed["timestamp"],
                "source":           "whatsapp_nlp",
            }
            asyncio.create_task(_sio.emit("whatsapp_reply", event_payload))
            print(f"[Socket.IO] whatsapp_reply -> {phone_10} | {parsed['reply_type']}")

    except Exception as exc:
        # Never let a malformed payload crash the webhook
        print(f"[Webhook ERROR] {exc} | From={From!r} Body={Body!r}")

    return Response(content=EMPTY_TWIML, media_type="text/xml")



# ─── GET /twilio/reply-store (debug) ─────────────────────────────────────────
@router.get("/reply-store")
async def get_reply_store_endpoint():
    """View all NLP-parsed replies in memory for this session."""
    return get_reply_store_snapshot()


# ─── POST /twilio/clear-store ─────────────────────────────────────────────────
@router.post("/clear-store")
async def clear_store_endpoint():
    """Reset reply memory — call at start of a new delivery day."""
    clear_reply_store()
    return {"status": "cleared", "message": "Reply store cleared for new session"}
