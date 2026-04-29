from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import requests
import pandas as pd
import numpy as np
import joblib
import os
from sklearn.cluster import DBSCAN
from sklearn.preprocessing import StandardScaler
import random
import socketio
import asyncio
import math
import io

try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '.env'))
    print("[Env] .env file loaded OK")
except ImportError:
    print("[Env] python-dotenv not installed - set vars manually")



app = FastAPI()
from customer_priority import router as priority_router
app.include_router(priority_router)

from twilio_whatsapp import router as twilio_router, set_socket_server
app.include_router(twilio_router)

from smart_routing import router as smart_routing_router
app.include_router(smart_routing_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)
set_socket_server(sio)   


from fastapi import Request, Form
from fastapi.responses import Response as FastResponse

@app.post("/")
async def root_webhook_redirect(
    request: Request,
    From: str = Form(default=""),
    Body: str = Form(default=""),
):
    """
    Twilio fallback — catches POST / and handles it as a webhook.
    Fix your Twilio Console URL to: https://<ngrok-url>/twilio/webhook
    This is a safety net only.
    """
    import re, asyncio
    from datetime import datetime
    print("[Webhook] WARNING: Twilio hit POST / - Fix Console Webhook URL to /twilio/webhook")
    EMPTY_TWIML = "<?xml version='1.0' encoding='UTF-8'?><Response></Response>"
    phone_digits = re.sub(r"\D", "", From.strip())
    phone_10 = phone_digits[-10:] if len(phone_digits) >= 10 else phone_digits
    reply       = Body.strip()
    reply_upper = reply.upper()
    YES_WORDS = {"YES","Y","YEP","YEAH","OK","OKAY","AVAILABLE","HOME","SURE","CONFIRM"}
    NO_WORDS  = {"NO","N","NOPE","NOT AVAILABLE","NOT HOME","UNAVAILABLE","BUSY","CANT","CAN'T"}
    if reply_upper in YES_WORDS or reply_upper.startswith("YES"):
        reply_type, rescheduled_time = "yes", None
    elif reply_upper in NO_WORDS or reply_upper.startswith("NO"):
        reply_type, rescheduled_time = "no", None
    else:
        time_match = re.search(r'(\d{1,2})\s*(am|pm|:00|:30)?|after\s+\d{1,2}|evening|morning|afternoon', reply, re.IGNORECASE)
        reply_type = "reschedule" if time_match else "unknown"
        rescheduled_time = reply if time_match else None
    if sio:
        asyncio.create_task(sio.emit("whatsapp_reply", {
            "phone_10": phone_10, "phone_digits": phone_digits,
            "reply": reply, "reply_type": reply_type,
            "rescheduled_time": rescheduled_time,
            "timestamp": datetime.now().isoformat(), "source": "whatsapp_reply",
        }))
        print(f"[Webhook] Emitted whatsapp_reply via root fallback — phone_10={phone_10}, type={reply_type}")
    return FastResponse(content=EMPTY_TWIML, media_type="text/xml")
# ─────────────────────────────────────────────────────────────────────────────


@sio.on('connect')
async def connect(sid, environ):
    print(f"Client connected: {sid}")

@sio.on('start_simulation')
async def start_simulation(sid, data):
    print(f"Starting simulation task for {sid}")
    asyncio.create_task(simulate_delivery(sid, data.get('path', [])))

@sio.on('gps_update')
async def on_gps_update(sid, data):
    """Relay real device GPS to ALL connected clients (web dashboard can watch live)."""
    await sio.emit('position_update', data)

async def simulate_delivery(sid, path_coords):
    current_progress = 0
    if not path_coords:
        return
        
    while current_progress < len(path_coords) - 1:
        idx = math.floor(current_progress)
        next_idx = min(idx + 1, len(path_coords) - 1)
        fraction = current_progress - idx
        
        lat1, lng1 = path_coords[idx][0], path_coords[idx][1]
        lat2, lng2 = path_coords[next_idx][0], path_coords[next_idx][1]
        
        cur_lat = lat1 + (lat2 - lat1) * fraction
        cur_lng = lng1 + (lng2 - lng1) * fraction
        
        # Calculate heading
        y = math.sin(math.radians(lng2 - lng1)) * math.cos(math.radians(lat2))
        x = math.cos(math.radians(lat1)) * math.sin(math.radians(lat2)) - \
            math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(math.radians(lng2 - lng1))
        heading = (math.degrees(math.atan2(y, x)) + 360) % 360
        
        await sio.emit('position_update', {
            'lat': cur_lat,
            'lng': cur_lng,
            'heading': heading
        }, to=sid)
        
        current_progress += 0.05
        await asyncio.sleep(0.05)
        
    await sio.emit('destination_reached', {}, to=sid)

@app.get("/health")
def read_root():
    return {"status": "Navigation Backend Online"}


@app.get("/api/route")
def get_route(start_lat: float, start_lng: float, end_lat: float, end_lng: float):
    # OSRM expects coordinates as lon,lat
    url = f"http://router.project-osrm.org/route/v1/driving/{start_lng},{start_lat};{end_lng},{end_lat}?overview=full&geometries=geojson&steps=true"
    
    try:
        headers = {'User-Agent': 'SmartParcelDelivery/1.0'}
        response = requests.get(url, headers=headers, timeout=10)
        data = response.json()
        
        if data.get("code") != "Ok":
            raise HTTPException(status_code=400, detail="Could not find a route")
            
        route = data["routes"][0]
        
        # Geojson coordinates are [lon, lat], we need [lat, lon] for Leaflet
        decoded_geometry = [[coord[1], coord[0]] for coord in route["geometry"]["coordinates"]]
        
        # Extract steps
        steps = []
        for leg in route["legs"]:
            for step in leg["steps"]:
                maneuver = step['maneuver']
                m_type = maneuver['type']
                m_mod = maneuver.get('modifier', '')
                m_name = step.get('name', '')
                
                # Make instruction readable for TTS
                if m_type == "turn":
                    readable = f"Turn {m_mod}"
                elif m_type == "new name":
                    readable = f"Continue straight"
                elif m_type == "depart":
                    readable = "Head start"
                elif m_type == "arrive":
                    readable = "You will arrive at your destination"
                elif m_type == "roundabout":
                    readable = "Enter the roundabout"
                else:
                    readable = m_type.capitalize()
                    if m_mod:
                        readable += f" {m_mod}"

                if m_name:
                    readable += f" onto {m_name}"
                
                if step['distance'] > 0:
                    readable += f". Continue for {int(step['distance'])} meters."

                steps.append({
                    "instruction": readable,
                    "distance": step['distance'],
                    "duration": step['duration'],
                    "location": [maneuver['location'][1], maneuver['location'][0]] # lat, lng
                })
                
        return {
            "distance": route["distance"],
            "duration": route["duration"],
            "geometry": decoded_geometry,
            "steps": steps
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class RouteRequest(BaseModel):
    coords: str

@app.post("/api/route_batch")
def get_route_batch(req: RouteRequest):
    url = f"http://router.project-osrm.org/route/v1/driving/{req.coords}?overview=full&geometries=geojson&steps=true"
    headers = {'User-Agent': 'SmartParcelDelivery/1.0'}
    try:
        response = requests.get(url, headers=headers, timeout=15)
        return response.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/predict_risk")
def predict_risk(data: dict):
    try:
        # Load models
        rf_model = joblib.load("backend/ml_models/rf_risk_model.joblib")
        lr_model = joblib.load("backend/ml_models/lr_risk_model.joblib")
        scaler = joblib.load("backend/ml_models/scaler.joblib")
        
        # Prepare input
        features = ["distance", "traffic_level", "delivery_time", "weather_condition", 
                    "delivery_day", "distance_deviation", "order_deviation"]
        input_data = pd.DataFrame([data])[features]
        
        # For now, assume delivery_day=0, distance_deviation=0, order_deviation=0 if not provided
        if 'delivery_day' not in data:
            input_data['delivery_day'] = 0
        if 'distance_deviation' not in data:
            input_data['distance_deviation'] = 0
        if 'order_deviation' not in data:
            input_data['order_deviation'] = 0
            
        # Scale for LR
        input_scaled = scaler.transform(input_data)
        
        # Predictions
        rf_pred = rf_model.predict(input_data)[0]
        lr_pred = lr_model.predict(input_scaled)[0]
        
        return {
            "rf_prediction": rf_pred,
            "lr_prediction": lr_pred,
            "consensus": rf_pred if rf_pred == lr_pred else "Mixed"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/upload_csv")
def upload_csv(file: UploadFile = File(...)):
    try:
        # Read CSV
        df = pd.read_csv(file.file)
        
        # Validate required columns
        required_cols = ["distance", "traffic_level", "delivery_time", "weather_condition", "lat", "lng"]
        if not all(col in df.columns for col in required_cols):
            return {"error": f"Missing required columns. Required: {required_cols}"}
        
        # Add ID if not present
        if 'id' not in df.columns:
            df['id'] = range(1, len(df) + 1)
        
        # Add engineered features
        mean_distance = df['distance'].mean()
        df['delivery_day'] = np.random.randint(0, 7, len(df))  # Random for demo
        df['distance_deviation'] = np.abs(df['distance'] - mean_distance)
        df['order_deviation'] = np.random.uniform(0, 10, len(df))
        
        # Load models for risk prediction
        base_dir = os.path.dirname(os.path.abspath(__file__))
        rf_model = joblib.load(os.path.join(base_dir, "ml_models", "rf_risk_model.joblib"))
        scaler = joblib.load(os.path.join(base_dir, "ml_models", "scaler.joblib"))
        
        features = ["distance", "traffic_level", "delivery_time", "weather_condition", 
                    "delivery_day", "distance_deviation", "order_deviation"]
        X = df[features]
        X_scaled = scaler.transform(X)
        
        df['risk_level'] = rf_model.predict(X)
        
        # Clustering
        coords = df[['lat', 'lng']].values
        scaler_coords = StandardScaler()
        coords_scaled = scaler_coords.fit_transform(coords)
        
        dbscan = DBSCAN(eps=0.3, min_samples=2)
        df['cluster'] = dbscan.fit_predict(coords_scaled)
        
        # Simple route optimization (sort by cluster and distance)
        clusters = []
        optimized_route = []
        
        for cluster_id in df['cluster'].unique():
            if cluster_id == -1:  # Noise points
                cluster_deliveries = df[df['cluster'] == cluster_id]
            else:
                cluster_deliveries = df[df['cluster'] == cluster_id].copy()
                # Sort by distance (simple optimization)
                cluster_deliveries = cluster_deliveries.sort_values('distance')
            
            clusters.append({
                "id": int(cluster_id),
                "deliveries": cluster_deliveries.to_dict('records'),
                "center": [cluster_deliveries['lat'].mean(), cluster_deliveries['lng'].mean()]
            })
            
            optimized_route.extend(cluster_deliveries.to_dict('records'))
        
        return {
            "deliveries": df.to_dict('records'),
            "optimized_route": optimized_route,
            "total_deliveries": len(df),
            "clusters": clusters
        }
        
    except Exception as e:
        return {"error": str(e)}


@app.post("/smart_upload")
async def smart_upload_combined(file: UploadFile = File(...)):
    """
    Combined Smart Upload — joins road risk (ML) + customer risk (priority formula).
    One CSV, one upload, unified priority-sorted output for map + priority panel.
    """
    import customer_priority as cp
    try:
        content = await file.read()
        df = pd.read_csv(io.BytesIO(content))

        ml_required = ["distance", "traffic_level", "delivery_time", "weather_condition", "lat", "lng"]
        missing = [c for c in ml_required if c not in df.columns]
        if missing:
            return {"error": f"Missing required columns: {missing}. Smart CSV needs: distance, traffic_level, delivery_time, weather_condition, lat, lng, scheduled_time, preferred_slot, failed_attempts, contact_reliable"}

        if 'id' not in df.columns:
            df['id'] = range(1, len(df) + 1)

        # ── ROAD RISK via ML model ────────────────────────────────────────
        mean_dist = df['distance'].mean()
        df['delivery_day']       = np.random.randint(0, 7, len(df))
        df['distance_deviation'] = np.abs(df['distance'] - mean_dist)
        df['order_deviation']    = np.random.uniform(0, 10, len(df))

        base_dir = os.path.dirname(os.path.abspath(__file__))
        rf_model = joblib.load(os.path.join(base_dir, "ml_models", "rf_risk_model.joblib"))
        scaler   = joblib.load(os.path.join(base_dir, "ml_models", "scaler.joblib"))

        ml_features = ["distance", "traffic_level", "delivery_time", "weather_condition",
                       "delivery_day", "distance_deviation", "order_deviation"]
        X = df[ml_features]
        df['road_risk_level'] = rf_model.predict(X)
        road_map = {'Low': 0.1, 'Medium': 0.5, 'High': 0.9}
        df['road_risk_score'] = df['road_risk_level'].map(road_map).fillna(0.1)

        # ── CUSTOMER RISK via priority formula ────────────────────────────
        def get_customer_risk(row):
            cid = str(row.get('customer_id', f"CUST_{int(row['id'])}"))
            profile = cp._build_profile(cid)
            if 'preferred_slot' in df.columns:
                profile['preferred_slot'] = str(row.get('preferred_slot', 'any')).lower()
            if 'failed_attempts' in df.columns:
                try:    profile['failed_attempts'] = int(float(row.get('failed_attempts', 0)))
                except: profile['failed_attempts'] = 0
            if 'contact_reliable' in df.columns:
                profile['contact_reliable'] = str(row.get('contact_reliable', 'true')).lower() == 'true'
            if 'customer_name' in df.columns:
                profile['customer_name'] = str(row.get('customer_name', ''))
            sched  = str(row.get('scheduled_time', '10:00'))
            scored = cp.compute_priority({'scheduled_time': sched, **row.to_dict()}, profile)
            return scored['risk_score'], scored['priority_score'], scored['risk_tier'], scored.get('recommendation', '')

        results = df.apply(get_customer_risk, axis=1)
        df['customer_risk_score'] = [r[0] for r in results]
        df['customer_priority']   = [r[1] for r in results]
        df['recommendation']      = [r[3] for r in results]

        # ── COMBINED SCORE (40% road + 60% customer) ──────────────────────
        df['combined_risk']     = (df['road_risk_score'] * 0.40) + (df['customer_risk_score'] * 0.60)
        df['combined_priority'] = 1.0 - df['combined_risk']
        df['risk_probability']  = df['combined_risk']

        def tier(s):
            if s >= 0.60: return 'High'
            if s >= 0.30: return 'Medium'
            return 'Low'
        df['risk_level'] = df['combined_risk'].apply(tier)

        # Display-friendly aliases for existing frontend
        if 'street' not in df.columns:
            df['street'] = df.get('address', df.get('area', 'Unknown'))
        df['traffic'] = df['traffic_level']
        df['weather'] = df['weather_condition']

        # ── CLUSTERING ────────────────────────────────────────────────────
        coords = df[['lat', 'lng']].values
        sc = StandardScaler()
        db = DBSCAN(eps=0.3, min_samples=2)
        df['cluster'] = db.fit_predict(sc.fit_transform(coords))

        # ── PRIORITY SORT (best first) ─────────────────────────────────────
        df_sorted = df.sort_values('combined_priority', ascending=False).reset_index(drop=True)

        # ── SYNC TO PRIORITY MODULE ─────────────────────────────────────────
        cp.priority_results.clear()
        cp.todays_deliveries.clear()
        for _, row in df_sorted.iterrows():
            entry = {
                'delivery_id':   str(row.get('delivery_id', row['id'])),
                'customer_id':   str(row.get('customer_id', '')),
                'customer_name': str(row.get('customer_name', row.get('street', ''))),
                'phone':         str(row.get('phone', '')),
                'address':       str(row.get('address', row.get('street', ''))),
                'scheduled_time':str(row.get('scheduled_time', '')),
                'agent_id':      str(row.get('agent_id', '')),
                'lat':           float(row.get('lat', 0)),
                'lng':           float(row.get('lng', 0)),
                'cluster':       int(row.get('cluster', -1)),
                'priority_score':float(row['combined_priority']),
                'risk_score':    float(row['combined_risk']),
                'risk_tier':     row['risk_level'].lower(),
                'risk_level':    row['risk_level'],
                'factors': {
                    'failed_attempts': int(float(row.get('failed_attempts', 0))),
                    'preferred_slot':  str(row.get('preferred_slot', 'any')),
                    'scheduled_time':  str(row.get('scheduled_time', '')),
                    'contact_reliable':str(row.get('contact_reliable', 'true')).lower() == 'true',
                    'traffic_level':   int(float(row.get('traffic_level', 1))),
                    'road_risk':       str(row.get('road_risk_level', 'Low')),
                },
                'recommendation': str(row.get('recommendation', '')),
            }

            cp.priority_results.append(entry)
            cp.todays_deliveries.append(entry)

        clusters = []
        for cid in df['cluster'].unique():
            cdf = df[df['cluster'] == cid]
            clusters.append({
                "id": int(cid),
                "deliveries": cdf.to_dict('records'),
                "center": [float(cdf['lat'].mean()), float(cdf['lng'].mean())]
            })

        summary = {
            'low':    int((df['risk_level'] == 'Low').sum()),
            'medium': int((df['risk_level'] == 'Medium').sum()),
            'high':   int((df['risk_level'] == 'High').sum()),
        }

        return {
            "deliveries":       df.to_dict('records'),
            "optimized_route":  df_sorted.to_dict('records'),
            "total_deliveries": len(df),
            "clusters":         clusters,
            "priority_summary": summary,
            "mode":             "smart",
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()}


# ============================================================================
#  CUSTOMER AVAILABILITY MODULE
#  Routes: GET /availability/{id}  |  POST /availability/confirm
#          GET /availability/status-all
# ============================================================================
from datetime import datetime as _dt
availability_store: dict = {}   # customer_id → availability info

@app.get("/availability/{customer_id}")
async def get_customer_availability_info(customer_id: str):
    """
    Called by the Customer Availability page on load.
    Returns customer's scheduled delivery info from priority_results.
    """
    import customer_priority as cp
    # Find customer in today's priority results
    match = next((d for d in cp.priority_results if d.get('customer_id') == customer_id), None)
    if not match:
        # Fallback: return minimal info so page still works
        return {
            "customer_id":   customer_id,
            "customer_name": customer_id,
            "scheduled_time":"Today",
            "address":       "",
            "area":          "",
            "agent_id":      "",
            "current_availability": availability_store.get(customer_id, {"status": "unknown"}),
        }
    return {
        "customer_id":   match.get("customer_id"),
        "customer_name": match.get("customer_name"),
        "scheduled_time":match.get("scheduled_time", "Today"),
        "address":       match.get("address", ""),
        "area":          match.get("address", "").split(",")[0] if match.get("address") else "",
        "agent_id":      match.get("agent_id", ""),
        "current_availability": availability_store.get(customer_id, {"status": "unknown"}),
    }


class AvailabilityConfirm(BaseModel):
    customer_id:    str
    customer_name:  str = ""
    status:         str           # confirmed | not_available | set_slot
    slot:           str = "any"
    available_from: str = "08:00"
    available_to:   str = "21:00"

@app.post("/availability/confirm")
async def confirm_customer_availability(data: AvailabilityConfirm):
    """
    Customer submits their availability.
    Updates in-memory store + emits Socket.IO event → agent sees it instantly.
    Also adjusts priority score in priority_results.
    """
    import customer_priority as cp

    entry = {
        "customer_id":    data.customer_id,
        "customer_name":  data.customer_name,
        "status":         data.status,          # confirmed | not_available | set_slot
        "slot":           data.slot,
        "available_from": data.available_from,
        "available_to":   data.available_to,
        "confirmed_at":   _dt.now().strftime("%H:%M:%S"),
    }
    availability_store[data.customer_id] = entry

    # ── Adjust priority score based on availability ───────────────────────
    for item in cp.priority_results:
        if item.get("customer_id") == data.customer_id:
            if data.status == "confirmed" or data.status == "set_slot":
                # Customer confirmed home → big risk reduction
                item["priority_score"] = min(1.0, item["priority_score"] * 1.6 + 0.2)
                item["risk_score"]     = max(0.0, item["risk_score"]     * 0.35)
                item["risk_tier"]      = "low" if item["risk_score"] < 0.3 else "medium"
                item["recommendation"] = f"Customer confirmed available {data.available_from}–{data.available_to}"
            elif data.status == "not_available":
                # Customer said not home → mark high risk
                item["priority_score"] = 0.0
                item["risk_score"]     = 1.0
                item["risk_tier"]      = "high"
                item["recommendation"] = "Customer not available today — reschedule"
            item["availability"] = entry
            break

    # ── Real-time Socket.IO push to agent ────────────────────────────────
    await sio.emit("availability_update", {
        "customer_id":    data.customer_id,
        "customer_name":  data.customer_name,
        "status":         data.status,
        "slot":           data.slot,
        "available_from": data.available_from,
        "available_to":   data.available_to,
        "confirmed_at":   entry["confirmed_at"],
    })

    return {"message": "Availability confirmed and agent notified", "entry": entry}


@app.get("/availability/status-all")
async def get_all_availability():
    """Returns current availability status of all customers — polled by agent panel."""
    return {"statuses": availability_store, "total": len(availability_store)}



_dist = os.path.join(os.path.dirname(__file__), '..', 'client', 'dist')
if os.path.isdir(_dist):
    # Mount assets folder for JS/CSS
    app.mount('/assets', StaticFiles(directory=os.path.join(_dist, 'assets')), name='assets')

    @app.get('/{full_path:path}', include_in_schema=False)
    async def serve_spa(full_path: str):
        """Catch-all: serve React index.html for any non-API path (SPA routing)."""
        index = os.path.join(_dist, 'index.html')
        return FileResponse(index)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(socket_app, host="0.0.0.0", port=8000)
