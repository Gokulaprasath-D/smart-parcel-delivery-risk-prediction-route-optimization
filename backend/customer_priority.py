"""
Customer Risk & Priority Prediction Module
==========================================
A completely standalone add-on to the Smart Parcel Delivery System.
Reads from its own in-memory store (no DB required).
All routes are prefixed with /priority/ to avoid any collision.
"""

from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel
from typing import Optional
import pandas as pd
import io
from datetime import datetime

router = APIRouter(prefix="/priority", tags=["Customer Priority"])

# ─────────────────────────────────────────────
# In-memory stores (reset on server restart)
# ─────────────────────────────────────────────
customer_profiles:  dict = {}      # customer_id → profile dict
delivery_history:   list = []      # list of past feedback records
todays_deliveries:  list = []      # list of today's deliveries (raw)
priority_results:   list = []      # computed priority-sorted list
availability_store: dict = {}      # customer_id → availability record (shared with twilio_whatsapp)

# ─────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────
class FeedbackPayload(BaseModel):
    delivery_id: str
    customer_id: str
    agent_id: str
    outcome: str           # success | failed_not_home | failed_contact | failed_refused | rescheduled
    contact_reached: bool
    failure_reason: Optional[str] = ""
    agent_note: Optional[str] = ""

class PreferencePayload(BaseModel):
    customer_id: str
    preferred_slot: str    # morning | afternoon | evening | any
    available_from: Optional[str] = "00:00"
    available_to: Optional[str]   = "23:59"

# ─────────────────────────────────────────────
# Core scoring engine
# ─────────────────────────────────────────────
SLOT_HOURS = {
    "morning":   (6,  12),
    "afternoon": (12, 17),
    "evening":   (17, 22),
    "any":       (0,  24),
}

def _build_profile(customer_id: str) -> dict:
    """Return profile for a customer, creating a blank one if absent."""
    if customer_id not in customer_profiles:
        customer_profiles[customer_id] = {
            "customer_id": customer_id,
            "failed_attempts": 0,
            "contact_fail_count": 0,
            "contact_reliable": True,
            "preferred_slot": "any",
            "available_from": "00:00",
            "available_to": "23:59",
        }
    return customer_profiles[customer_id]


def _failed_score(failed: int) -> float:
    if failed == 0: return 0.0
    if failed == 1: return 0.3
    if failed == 2: return 0.6
    return 1.0


def _contact_score(reliable: bool, fail_count: int) -> float:
    if reliable:    return 0.0
    if fail_count == 1: return 0.4
    return 1.0


def _time_mismatch_score(scheduled_time_str: str, preferred_slot: str) -> float:
    """Compare scheduled HH:MM to preferred slot."""
    if preferred_slot == "any":
        return 0.0
    try:
        hour = int(scheduled_time_str.split(":")[0])
    except Exception:
        return 0.0
    low, high = SLOT_HOURS.get(preferred_slot, (0, 24))
    if low <= hour < high:
        return 0.0
    diff = min(abs(hour - low), abs(hour - high))
    if diff <= 1: return 0.2
    if diff <= 2: return 0.4
    if diff <= 3: return 0.7
    return 1.0


def _availability_score(profile: dict) -> float:
    """Historical: was customer ever recorded as 'not home'?"""
    fail = profile.get("failed_attempts", 0)
    if fail == 0: return 0.0
    if fail == 1: return 0.3
    if fail >= 3: return 1.0
    return 0.6


def compute_priority(delivery: dict, profile: dict) -> dict:
    sched = delivery.get("scheduled_time", "10:00")
    preferred = profile.get("preferred_slot", "any")

    f_score  = _failed_score(profile.get("failed_attempts", 0))      * 0.35
    a_score  = _availability_score(profile)                            * 0.25
    tm_score = _time_mismatch_score(sched, preferred)                  * 0.25
    c_score  = _contact_score(
                   profile.get("contact_reliable", True),
                   profile.get("contact_fail_count", 0)
               )                                                        * 0.15

    risk = round(f_score + a_score + tm_score + c_score, 4)
    priority = round(1.0 - risk, 4)

    tier = "low"
    if risk >= 0.60: tier = "high"
    elif risk >= 0.30: tier = "medium"

    return {
        **delivery,
        "risk_score": risk,
        "priority_score": priority,
        "risk_tier": tier,
        "factors": {
            "failed_attempts": profile.get("failed_attempts", 0),
            "preferred_slot": preferred,
            "scheduled_time": sched,
            "contact_reliable": profile.get("contact_reliable", True),
        },
        "recommendation": _recommendation(tier, preferred, sched),
    }


def _recommendation(tier: str, preferred: str, sched: str) -> str:
    if tier == "low":
        return "Proceed with delivery."
    if tier == "medium":
        return f"Call customer before visiting."
    return f"High risk — reschedule to {preferred} slot or call ahead."


# ─────────────────────────────────────────────
# API Routes
# ─────────────────────────────────────────────

@router.post("/upload-customer-profiles")
async def upload_customer_profiles(file: UploadFile = File(...)):
    """Upload customer_profiles.csv to register customer preferences."""
    try:
        content = await file.read()
        df = pd.read_csv(io.StringIO(content.decode("utf-8")))
        required = ["customer_id", "preferred_slot"]
        missing = [c for c in required if c not in df.columns]
        if missing:
            raise HTTPException(400, f"Missing columns: {missing}")

        count = 0
        for _, row in df.iterrows():
            cid = str(row["customer_id"])
            profile = _build_profile(cid)
            profile["preferred_slot"]  = str(row.get("preferred_slot", "any")).lower()
            profile["available_from"]  = str(row.get("available_from", "00:00"))
            profile["available_to"]    = str(row.get("available_to",   "23:59"))
            # copy name/phone if present
            for field in ["customer_name", "phone", "email", "address", "area", "city"]:
                if field in df.columns:
                    profile[field] = str(row.get(field, ""))
            count += 1

        return {"message": f"{count} customer profiles loaded.", "total": count}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/upload-delivery-history")
async def upload_delivery_history(file: UploadFile = File(...)):
    """Upload delivery_history.csv to seed past outcomes."""
    try:
        content = await file.read()
        df = pd.read_csv(io.StringIO(content.decode("utf-8")))
        required = ["customer_id", "outcome", "contact_reached"]
        missing = [c for c in required if c not in df.columns]
        if missing:
            raise HTTPException(400, f"Missing columns: {missing}")

        for _, row in df.iterrows():
            cid = str(row["customer_id"])
            profile = _build_profile(cid)
            outcome = str(row.get("outcome", "success")).lower()
            reached = str(row.get("contact_reached", "true")).lower() == "true"

            if "failed" in outcome or outcome == "rescheduled":
                profile["failed_attempts"] += 1
            if not reached:
                profile["contact_fail_count"] += 1
                profile["contact_reliable"] = False

            delivery_history.append(row.to_dict())

        return {"message": f"{len(df)} history records processed."}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/upload-todays-deliveries")
async def upload_todays_deliveries(file: UploadFile = File(...)):
    """Upload deliveries_today.csv and compute priority order."""
    global todays_deliveries, priority_results
    try:
        content = await file.read()
        df = pd.read_csv(io.StringIO(content.decode("utf-8")))
        required = ["delivery_id", "customer_id", "customer_name",
                    "phone", "address", "scheduled_time", "agent_id"]
        missing = [c for c in required if c not in df.columns]
        if missing:
            raise HTTPException(400, f"Missing columns: {missing}")

        todays_deliveries = df.to_dict("records")

        # Compute priority for each delivery
        results = []
        for delivery in todays_deliveries:
            cid = str(delivery["customer_id"])
            profile = _build_profile(cid)
            scored = compute_priority(delivery, profile)
            results.append(scored)

        # Sort: highest priority first (lowest risk first)
        results.sort(key=lambda x: x["priority_score"], reverse=True)
        priority_results = results

        summary = {
            "low":    len([r for r in results if r["risk_tier"] == "low"]),
            "medium": len([r for r in results if r["risk_tier"] == "medium"]),
            "high":   len([r for r in results if r["risk_tier"] == "high"]),
        }

        return {
            "message": f"{len(results)} deliveries prioritized.",
            "summary": summary,
            "priority_order": results,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/priority-order")
def get_priority_order(agent_id: Optional[str] = None):
    """Return today's priority-sorted delivery list — always re-sorted."""
    if not priority_results:
        return {"message": "No deliveries loaded yet.", "priority_order": []}

    result = priority_results
    if agent_id:
        result = [r for r in result if str(r.get("agent_id", "")) == agent_id]

    # ✔️ BUG FIX: always re-sort so real-time score updates are reflected
    result_sorted = sorted(result, key=lambda x: x.get("priority_score", 0), reverse=True)

    # Also update risk_tier based on current risk_score
    for item in result_sorted:
        rs = item.get("risk_score", 0)
        item["risk_tier"] = "high" if rs >= 0.60 else "medium" if rs >= 0.30 else "low"

    return {
        "total": len(result_sorted),
        "priority_order": result_sorted,
        "summary": {
            "low":    len([r for r in result_sorted if r["risk_tier"] == "low"]),
            "medium": len([r for r in result_sorted if r["risk_tier"] == "medium"]),
            "high":   len([r for r in result_sorted if r["risk_tier"] == "high"]),
        }
    }



@router.get("/customer-risk/{customer_id}")
def get_customer_risk(customer_id: str):
    """Get risk profile for a specific customer."""
    profile = customer_profiles.get(customer_id)
    if not profile:
        return {"message": "Customer not found.", "profile": None}
    return {"customer_id": customer_id, "profile": profile}


@router.post("/submit-feedback")
def submit_feedback(payload: FeedbackPayload):
    """Agent submits delivery outcome after each delivery."""
    cid = payload.customer_id
    profile = _build_profile(cid)

    outcome = payload.outcome.lower()
    if "failed" in outcome or outcome == "rescheduled":
        profile["failed_attempts"] += 1

    if not payload.contact_reached:
        profile["contact_fail_count"] += 1
        if profile["contact_fail_count"] >= 2:
            profile["contact_reliable"] = False

    delivery_history.append({
        "delivery_id": payload.delivery_id,
        "customer_id": cid,
        "agent_id": payload.agent_id,
        "outcome": outcome,
        "contact_reached": payload.contact_reached,
        "failure_reason": payload.failure_reason,
        "agent_note": payload.agent_note,
        "timestamp": datetime.now().isoformat(),
    })

    return {
        "message": "Feedback recorded.",
        "updated_profile": profile,
    }


@router.post("/set-preference")
def set_preference(payload: PreferencePayload):
    """Customer sets their preferred delivery time slot."""
    cid = payload.customer_id
    profile = _build_profile(cid)
    profile["preferred_slot"]  = payload.preferred_slot.lower()
    profile["available_from"]  = payload.available_from or "00:00"
    profile["available_to"]    = payload.available_to   or "23:59"

    return {"message": "Preference saved.", "profile": profile}


@router.get("/admin-overview")
def admin_overview():
    """Admin view: all customer profiles + risk summary."""
    profiles_list = list(customer_profiles.values())
    return {
        "total_customers": len(profiles_list),
        "total_history_records": len(delivery_history),
        "todays_deliveries": len(todays_deliveries),
        "profiles": profiles_list,
    }
