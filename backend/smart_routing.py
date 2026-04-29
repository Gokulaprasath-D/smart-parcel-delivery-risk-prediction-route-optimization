"""
smart_routing.py  —  AI-Optimized Routing Add-On
==================================================
Non-intrusive add-on: registers its own /api/smart-route and
/api/route-directions endpoints.  Zero changes to existing logic.

Algorithm:
  Priority-Weighted Nearest-Neighbour TSP
  score = priority*0.55 + proximity*0.35 + status_boost*0.10
  Depot fallback: Karur Distribution Hub (10.9601 N, 78.0766 E)
"""

import math
import requests
from fastapi import APIRouter
from pydantic import BaseModel
from typing import List, Optional

router = APIRouter(prefix="/api", tags=["AI Smart Routing"])

# ── Default depot: Karur Distribution Hub ────────────────────────────────────
DEPOT = {"lat": 10.9601, "lng": 78.0766, "name": "Karur Hub"}

# ── Status priority boosts ────────────────────────────────────────────────────
STATUS_BOOST = {
    "replied_yes":           +0.35,
    "answered_available":    +0.35,
    "rescheduled":           +0.05,
    "pending":                0.00,
    "call_needed":           -0.05,
    "replied_no":            -0.40,
    "answered_unavailable":  -0.40,
    "not_answered":          -0.20,
}


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Return great-circle distance in km between two GPS points."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2))
         * math.sin(dlng / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(max(0, min(1, a))))


# ── Pydantic models ───────────────────────────────────────────────────────────
class DeliveryStop(BaseModel):
    customer_id:        str
    lat:                float
    lng:                float
    combined_priority:  Optional[float] = 0.5
    priority_score:     Optional[float] = 0.5
    wa_status:          Optional[str]   = ""
    waStatus:           Optional[str]   = ""      # frontend camelCase alias
    callStatus:         Optional[str]   = ""
    scheduled_time:     Optional[str]   = ""
    customer_name:      Optional[str]   = ""
    phone:              Optional[str]   = ""
    customer_phone:     Optional[str]   = ""
    risk_level:         Optional[str]   = ""
    road_risk_level:    Optional[str]   = ""


class SmartRouteRequest(BaseModel):
    deliveries:  List[DeliveryStop]
    depot_lat:   Optional[float] = None
    depot_lng:   Optional[float] = None


class DirectionsRequest(BaseModel):
    coords: str   # "lng1,lat1;lng2,lat2;..." same format as route_batch


# ── AI Optimization Endpoint ─────────────────────────────────────────────────
@router.post("/smart-route")
def smart_route(req: SmartRouteRequest):
    """
    Priority-weighted nearest-neighbour TSP.
    Returns: optimized_order (list of delivery dicts with _stop_num, _dist_km),
             total_distance_km, estimated_minutes, depot.
    """
    deliveries = req.deliveries
    if not deliveries:
        return {
            "optimized_order": [],
            "total_distance_km": 0,
            "estimated_minutes": 0,
            "depot": DEPOT,
            "status": "ok",
        }

    start_lat = req.depot_lat if req.depot_lat is not None else DEPOT["lat"]
    start_lng = req.depot_lng if req.depot_lng is not None else DEPOT["lng"]

    unvisited = [d.dict() for d in deliveries]
    route: List[dict] = []
    cur_lat, cur_lng = start_lat, start_lng
    total_dist = 0.0

    while unvisited:
        best      = None
        best_score = float("-inf")

        for d in unvisited:
            dist = haversine_km(cur_lat, cur_lng, d["lat"], d["lng"])
            # Proximity score — normalised for city-scale (<50 km typical)
            prox     = 1.0 / (dist + 0.5)
            priority = d.get("combined_priority") or d.get("priority_score") or 0.5
            # Resolve status — accept both snake_case and camelCase
            wa_st    = d.get("waStatus") or d.get("wa_status") or ""
            call_st  = d.get("callStatus") or ""
            s_boost  = max(
                STATUS_BOOST.get(wa_st,   0.0),
                STATUS_BOOST.get(call_st, 0.0),
            )
            score = priority * 0.55 + prox * 0.35 + s_boost * 0.10

            if best is None or score > best_score:
                best       = d
                best_score = score

        d2b = haversine_km(cur_lat, cur_lng, best["lat"], best["lng"])
        total_dist += d2b
        best["_stop_num"]    = len(route) + 1
        best["_dist_from_prev_km"] = round(d2b, 2)
        route.append(best)
        cur_lat, cur_lng = best["lat"], best["lng"]
        unvisited.remove(best)

    # City avg speed 25 km/h + 4 min per delivery stop
    est_minutes = int((total_dist / 25.0) * 60) + len(route) * 4

    return {
        "optimized_order":   route,
        "total_distance_km": round(total_dist, 2),
        "estimated_minutes": est_minutes,
        "depot":             {"lat": start_lat, "lng": start_lng, "name": DEPOT["name"]},
        "status":            "ok",
    }


# ── Turn-by-Turn Directions Proxy ─────────────────────────────────────────────
@router.post("/route-directions")
def route_directions(req: DirectionsRequest):
    """
    Proxies OSRM with steps=true and returns legs/steps for turn-by-turn.
    coords format: 'lng1,lat1;lng2,lat2;...'
    """
    url = (
        f"http://router.project-osrm.org/route/v1/driving/{req.coords}"
        "?overview=full&geometries=geojson&steps=true&annotations=false"
    )
    headers = {"User-Agent": "SmartParcelDelivery-NavModule/1.0"}
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        data = resp.json()
        if data.get("code") != "Ok":
            return {"code": "Error", "steps": [], "legs": []}

        # Flatten all steps across all legs for easy frontend consumption
        all_steps = []
        total_dist = 0.0
        total_dur  = 0.0
        for leg_idx, leg in enumerate(data["routes"][0]["legs"]):
            total_dist += leg["distance"]
            total_dur  += leg["duration"]
            for step in leg["steps"]:
                all_steps.append({
                    "leg_index":   leg_idx,
                    "instruction": _humanise(step),
                    "distance_m":  round(step.get("distance", 0)),
                    "duration_s":  round(step.get("duration", 0)),
                    "maneuver":    step.get("maneuver", {}).get("type", ""),
                    "name":        step.get("name", ""),
                    "modifier":    step.get("maneuver", {}).get("modifier", ""),
                })

        return {
            "code":             "Ok",
            "steps":            all_steps,
            "total_distance_m": round(total_dist),
            "total_duration_s": round(total_dur),
            "geometry":         data["routes"][0]["geometry"],
        }
    except Exception as exc:
        return {"code": "Error", "error": str(exc), "steps": []}


def _humanise(step: dict) -> str:
    """Convert an OSRM step to a simple human-readable instruction."""
    mtype    = step.get("maneuver", {}).get("type", "")
    modifier = step.get("maneuver", {}).get("modifier", "")
    name     = step.get("name", "")
    dist_m   = round(step.get("distance", 0))
    dist_str = (f"in {dist_m} m" if dist_m < 1000
                else f"in {dist_m/1000:.1f} km") if dist_m > 0 else ""

    road = f"onto {name}" if name else ""

    if mtype == "depart":
        return f"Head {modifier} {road}".strip()
    if mtype == "arrive":
        return "Arrived at destination"
    if mtype == "turn":
        return f"Turn {modifier} {dist_str} {road}".strip()
    if mtype in ("new name", "continue"):
        return f"Continue {dist_str} {road}".strip()
    if mtype in ("on ramp", "off ramp"):
        return f"Take the {modifier} ramp {road}".strip()
    if mtype in ("roundabout", "rotary"):
        exit_n = step.get("maneuver", {}).get("exit", "")
        return f"At the roundabout, take exit {exit_n} {road}".strip()
    if mtype == "merge":
        return f"Merge {modifier} {road}".strip()
    if mtype == "fork":
        return f"Keep {modifier} at the fork {road}".strip()
    if mtype == "end of road":
        return f"At end of road, turn {modifier} {road}".strip()
    return f"Continue {dist_str} {road}".strip()
