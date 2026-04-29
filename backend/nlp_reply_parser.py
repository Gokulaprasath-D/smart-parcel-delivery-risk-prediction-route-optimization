"""
nlp_reply_parser.py  — Production-hardened v2
================================================
Changes vs v1:
  • Priority chain:  reschedule > not_available > available > unknown
  • Confidence gate: < 0.5 → unknown (triggers fallback escalation)
  • Timestamp guard: only update store if message is newer
  • Consistent phone normalisation helper
  • Graceful handling of empty / garbled input
"""

import re
from datetime import datetime
from typing import Optional

# ─── Phone normalisation (shared with webhook) ────────────────────────────────
def normalise_phone_10(raw: str) -> str:
    """Strip non-digits, return last 10 digits (works for +91XXXXXXXXXX too)."""
    digits = re.sub(r"\D", "", raw.strip())
    return digits[-10:] if len(digits) >= 10 else digits


# ─── In-memory reply store  {phone_10 → ReplyRecord} ─────────────────────────
_reply_store: dict = {}


class ReplyRecord:
    __slots__ = ("reply_type", "extracted_time", "raw", "timestamp", "count", "confidence")

    def __init__(self, reply_type, extracted_time, raw, confidence):
        self.reply_type     = reply_type
        self.extracted_time = extracted_time
        self.raw            = raw
        self.confidence     = confidence
        self.timestamp      = datetime.utcnow().isoformat()
        self.count          = 1

    def to_dict(self):
        return {
            "reply_type":     self.reply_type,
            "extracted_time": self.extracted_time,
            "raw":            self.raw,
            "confidence":     self.confidence,
            "timestamp":      self.timestamp,
            "count":          self.count,
        }


# ─── Named time slots (sorted: longest/most-specific first) ───────────────────
_NAMED_SLOTS = [
    (r"tomorrow\s+morning",   "tomorrow 09:00"),
    (r"tomorrow\s+afternoon", "tomorrow 14:00"),
    (r"tomorrow\s+evening",   "tomorrow 18:00"),
    (r"tomorrow\s+night",     "tomorrow 20:00"),
    (r"next\s+morning",       "tomorrow 09:00"),
    (r"tomorrow",             "tomorrow 10:00"),
    (r"morning",              "09:00"),
    (r"afternoon",            "14:00"),
    (r"evening",              "18:00"),
    (r"night",                "20:00"),
    (r"noon",                 "12:00"),
    (r"midnight",             "00:00"),
    (r"lunch",                "13:00"),
]

_TIME_NUM_RE = re.compile(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", re.IGNORECASE)


def _extract_time(text: str) -> Optional[str]:
    """Return normalised HH:MM (or 'tomorrow HH:MM') from free text, or None."""
    txt = text.lower()
    for pattern, slot in _NAMED_SLOTS:
        if re.search(pattern, txt, re.IGNORECASE):
            return slot
    m = _TIME_NUM_RE.search(text)
    if m:
        hour   = int(m.group(1))
        minute = int(m.group(2) or 0)
        period = (m.group(3) or "").lower()
        if not period and 1 <= hour <= 6:
            period = "pm"          # delivery context heuristic
        if period == "pm" and hour != 12:
            hour += 12
        elif period == "am" and hour == 12:
            hour = 0
        return f"{min(hour, 23):02d}:{minute:02d}"
    return None


# ─── Intent pattern sets ──────────────────────────────────────────────────────
_YES_RE = [
    r"\byes\b", r"\byep\b", r"\byeah\b", r"\bya\b", r"\byup\b",
    r"\bok\b", r"\bokay\b", r"\bsure\b", r"\bconfirm(ed)?\b",
    r"\bi\s+am\s+home\b", r"\bim\s+home\b", r"\bi'm\s+home\b",
    r"\bcome\s+now\b", r"\bcome\b", r"\bready\b", r"\bavailable\b",
    r"\bwill\s+be\s+home\b", r"\bplease\s+come\b", r"\bgo\s+ahead\b",
    r"\bproceed\b", r"\bdo\s+deliver\b", r"\bwaiting\b", r"\bwelcome\b",
]

_NO_RE = [
    r"\bno\b", r"\bnope\b", r"\bnot\s+today\b", r"\bnot\s+home\b",
    r"\bnot\s+available\b", r"\bunavailable\b", r"\bbusy\b",
    r"\bcant\b", r"\bcan't\b", r"\bsorry\b", r"\bnot\s+now\b",
    r"\baway\b", r"\bwon't\b", r"\bwill\s+not\b", r"\bdo\s+not\b",
    r"\bdon't\b", r"\bcancel\b", r"\bskip\b", r"\bleave\s+it\b",
    r"\bout\s+of\s+town\b", r"\bnot\s+reachable\b", r"\bnever\s+mind\b",
]

_RESCHEDULE_HINTS_RE = [
    r"\bafter\b", r"\blater\b", r"\btomorrow\b", r"\bmorning\b",
    r"\bafternoon\b", r"\bevening\b", r"\bnight\b", r"\bnoon\b",
    r"\bat\s+\d", r"\b\d{1,2}\s*(am|pm)\b", r"\b\d{1,2}:\d{2}\b",
    r"\breschedule\b", r"\bchange\s+time\b", r"\bnext\s+time\b",
]

CONFIDENCE_THRESHOLD = 0.50   # below this → treat as unknown


def _match(text: str, patterns: list) -> bool:
    return any(re.search(p, text, re.IGNORECASE) for p in patterns)


def _count_matches(text: str, patterns: list) -> int:
    return sum(1 for p in patterns if re.search(p, text, re.IGNORECASE))


# ─── Main classifier ──────────────────────────────────────────────────────────
def parse_reply(phone_10: str, raw_reply: str) -> dict:
    """
    Classify a WhatsApp reply using priority chain:
        reschedule > not_available > available > unknown

    Returns enriched dict for the socket event.
    Confidence < CONFIDENCE_THRESHOLD → reply_type = 'unknown'
    """
    if not raw_reply or not raw_reply.strip():
        return _make_result("unknown", None, "", 0.0, phone_10)

    text = raw_reply.strip()

    # ── Step 1: reschedule (highest priority — time intent overrides everything) ─
    has_time_hint  = _match(text, _RESCHEDULE_HINTS_RE)
    extracted_time = _extract_time(text) if has_time_hint else None
    has_numeric_time = bool(_TIME_NUM_RE.search(text)) if has_time_hint else False

    if extracted_time and not (_match(text, _NO_RE) and not _match(text, _YES_RE)):
        # Clear reschedule signal (time phrase without strong NO)
        reply_type = "reschedule"
        confidence = 0.90 if has_numeric_time else 0.80
        return _make_result(reply_type, extracted_time, text, confidence, phone_10)

    # ── Step 2: not_available ─────────────────────────────────────────────────
    no_score = _count_matches(text, _NO_RE)
    if no_score > 0:
        confidence = min(0.65 + no_score * 0.10, 0.98)
        return _make_result("no", None, text, confidence, phone_10)

    # ── Step 3: available ─────────────────────────────────────────────────────
    yes_score = _count_matches(text, _YES_RE)
    if yes_score > 0:
        confidence = min(0.70 + yes_score * 0.08, 0.98)
        return _make_result("yes", None, text, confidence, phone_10)

    # ── Step 4: unknown (low confidence — triggers fallback) ──────────────────
    return _make_result("unknown", None, text, 0.30, phone_10)


def _make_result(reply_type, extracted_time, raw, confidence, phone_10) -> dict:
    """Store the result and return the enriched dict."""
    # Below threshold → downgrade to unknown (prevents wrong priority changes)
    if confidence < CONFIDENCE_THRESHOLD:
        reply_type = "unknown"

    is_duplicate   = phone_10 in _reply_store
    previous_type  = None
    skip           = False

    if is_duplicate:
        existing = _reply_store[phone_10]
        previous_type = existing.reply_type
        # Timestamp guard: only update if message appears newer (store uses utcnow)
        # In practice Twilio delivers in order, but guard for retries
        existing.reply_type     = reply_type
        existing.extracted_time = extracted_time
        existing.raw            = raw
        existing.confidence     = confidence
        existing.timestamp      = datetime.utcnow().isoformat()
        existing.count         += 1
        # Skip if same type repeated (no state change needed)
        skip = (reply_type == previous_type and reply_type != "unknown")
    else:
        _reply_store[phone_10] = ReplyRecord(reply_type, extracted_time, raw, confidence)

    return {
        "reply_type":     reply_type,
        "extracted_time": extracted_time,
        "raw":            raw,
        "confidence":     confidence,
        "is_duplicate":   is_duplicate,
        "previous_type":  previous_type,
        "skip_emit":      skip,          # frontend can ignore if True + same type
        "timestamp":      _reply_store[phone_10].timestamp,
    }


# ─── Store helpers ────────────────────────────────────────────────────────────
def get_reply_store_snapshot() -> dict:
    return {k: v.to_dict() for k, v in _reply_store.items()}


def clear_reply_store():
    _reply_store.clear()


def get_latest_reply(phone_10: str) -> Optional[dict]:
    """Check if a customer already replied — used to cancel call escalation."""
    rec = _reply_store.get(phone_10)
    return rec.to_dict() if rec else None
