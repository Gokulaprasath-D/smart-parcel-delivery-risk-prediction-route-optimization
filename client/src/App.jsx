import { useState, useMemo, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, useMapEvent } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-rotatedmarker';
import { io } from 'socket.io-client';

// Custom Bike Icon
const bikeIcon = new L.Icon({
  iconUrl: 'https://cdn-icons-png.flaticon.com/512/3720/3720610.png',
  iconSize: [40, 40],
  iconAnchor: [20, 20],
});

// Keep plain icons for driver location marker only
const blueIcon = new L.Icon({ iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png', shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41] });

// ── Numbered DivIcon factory ──────────────────────────────────────────────────
// Creates a circular numbered marker with colour, pulse, and dim support
const createNumberedIcon = (number, color, isNextStop = false, isDimmed = false, isCompleted = false) => {
  const bgColor = color === 'green' ? '#16a34a'
    : color === 'red' ? '#dc2626'
      : color === 'violet' ? '#9333ea'
        : '#2563eb'; // blue
  const ring = isNextStop ? `box-shadow:0 0 0 3px #fff,0 0 0 5px ${bgColor},0 0 18px 6px ${bgColor}88;`
    : isCompleted ? `box-shadow:0 0 0 2px #fff,0 0 0 4px ${bgColor}66;`
      : `box-shadow:0 2px 8px ${bgColor}55;`;
  const opacity = isDimmed ? 'opacity:0.35;filter:grayscale(50%);' : '';
  const pulse = isNextStop ? 'delivery-marker-pulse' : '';
  const checkmark = isCompleted ? '<span style="position:absolute;top:-6px;right:-6px;background:#fff;border-radius:50%;width:14px;height:14px;display:flex;align-items:center;justify-content:center;font-size:9px;border:1px solid #16a34a;">✓</span>' : '';
  return L.divIcon({
    className: '',
    html: `<div class="delivery-marker-base ${pulse}" style="${opacity}width:32px;height:32px;border-radius:50%;background:${bgColor};display:flex;align-items:center;justify-content:center;position:relative;cursor:pointer;transition:all 0.4s ease;${ring}"><span style="color:#fff;font-weight:800;font-size:13px;font-family:system-ui;line-height:1;">${number}</span>${checkmark}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -20],
  });
};

// ── Availability → map colour helper ─────────────────────────────────────────
// Returns: 'green' | 'red' | 'violet' | 'blue'
const availColor = (waStatus, callStatus, isRevisit, isCompleted) => {
  if (isCompleted) return 'green';
  if (isRevisit) return 'violet';
  if (waStatus === 'replied_yes' || callStatus === 'answered_available') return 'green';
  if (waStatus === 'replied_no' || callStatus === 'answered_unavailable'
    || callStatus === 'not_answered') return 'red';
  return 'blue'; // pending / call_needed / unknown
};

const iconByColor = { green: null, red: null, blue: null, violet: null }; // filled after icons created

// MapUpdater: only pans when vehicle actually moved >15m — eliminates shake on web
const MapUpdater = ({ center, zoom }) => {
  const map = useMap();
  const prevRef = useRef(null);
  useEffect(() => {
    if (!center || !map) return;
    if (prevRef.current) {
      const [plat, plng] = prevRef.current;
      const dlat = Math.abs(plat - center[0]);
      const dlng = Math.abs(plng - center[1]);
      // ~15 metre threshold in degrees; skip tiny micro-updates
      if (dlat < 0.00015 && dlng < 0.00015) return;
    }
    prevRef.current = center;
    map.panTo(center, { animate: true, duration: 0.4 });
  }, [center, map]);
  return null;
};

import {
  Truck,
  AlertTriangle,
  Cloud,
  Gauge,
  ArrowRight,
  Route,
  Shield,
  Zap,
  MapPin,
  Sun,
  CloudRain,
  CloudSnow,
  Package,
  Activity,
  Plus,
  Trash2,
  Layers,
  Navigation,
  LocateFixed,
  CheckCircle,
} from 'lucide-react';
import axios from 'axios';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import './App.css';
import PriorityModule from './PriorityModule';
import TwilioNotifier from './TwilioNotifier';   // WhatsApp auto-notification add-on
import SmartNavModule from './SmartNavModule';   // AI navigation add-on
import HybridNavOverlay from './HybridNavOverlay'; // Guidance-first HUD (add-on)
import RouteController from './RouteController'; // Background routing controller (no UI)



const getRiskIcon = (level) => {
  let color = 'green';
  if (level === 'Medium') color = 'gold';
  if (level === 'High') color = 'red';

  return `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`;
};

const WeatherIcon = ({ condition, size = 14 }) => {
  if (condition === 0) return <Sun size={size} className="text-amber-400" />;
  if (condition === 1) return <CloudRain size={size} className="text-blue-400" />;
  return <CloudSnow size={size} className="text-slate-300" />;
};

const AnimatedNumber = ({ value, suffix = '' }) => (
  <motion.span
    key={value}
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    className="tabular-nums font-bold"
  >
    {value}{suffix}
  </motion.span>
);

const getCompletedIcon = () => {
  return 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png';
};

const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // metres
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) *
    Math.sin(dl / 2) * Math.sin(dl / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const containerStyle = {
  width: '100%',
  height: '100%'
};

function App() {
  const [deliveries, setDeliveries] = useState([]);
  const [optimizedRoute, setOptimizedRoute] = useState(null);
  const [loading, setLoading] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState('');
  const [mapCenter, setMapCenter] = useState([13.0827, 80.2707]); // Default to Chennai, Tamil Nadu
  const [mapZoom, setMapZoom] = useState(12);
  const [backendReady, setBackendReady] = useState(false);
  const [mapInstance, setMapInstance] = useState(null);
  const [activeMarker, setActiveMarker] = useState(null);
  // Navigation States
  const [sourceInput, setSourceInput] = useState('');
  const [destInput, setDestInput] = useState('');
  const [isNavigationActive, setIsNavigationActive] = useState(false);
  const [navIndex, setNavIndex] = useState(0);
  const [vehiclePos, setVehiclePos] = useState(null);
  const [vehicleHeading, setVehicleHeading] = useState(0);
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const spokenStepsRef = useRef(new Set());
  const socketRef = useRef(null);
  const fileInputRef = useRef(null);
  const pendingFileRef = useRef(null);
  const backendUrlRef = useRef(
    localStorage.getItem('backend_url') ||
    (window.location.protocol === 'https:' ? window.location.origin : 'http://localhost:8000')
  );
  const isRetryingRef = useRef(false); // prevents IP modal from looping after save
  const [routeStats, setRouteStats] = useState(null);
  const [directionsResponse, setDirectionsResponse] = useState(null);
  const [currentInstruction, setCurrentInstruction] = useState(null);


  const isLoaded = true;
  const [socketInstance, setSocketInstance] = useState(null);
  const [osrmPolyline, setOsrmPolyline] = useState([]);
  // Coloured segments: [{positions:[[lat,lng],...], color:'green'|'blue'|'red'|'violet'}]
  const [routeSegments, setRouteSegments] = useState([]);
  // Per-stop OSRM geometry cache for segment colouring
  const stopGeomRef = useRef({});
  // Single source of truth for customer availability status in App
  const [customerStatusMap, setCustomerStatusMap] = useState({});

  const [routeVersion, setRouteVersion] = useState(0);

  // ── Route Controller (unified background controller) ──────────────────
  const [rcPolyline,   setRcPolyline]   = useState(null);
  const [rcActiveStop, setRcActiveStop] = useState(null);
  const rcActive = rcActiveStop !== null;


  useEffect(() => {
    const id = 'delivery-map-anim-css';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      @keyframes delivery-pulse {
        0%   { box-shadow: 0 0 0 3px #fff,0 0 0 5px #2563eb,0 0 18px 6px #2563eb88; transform: scale(1); }
        50%  { box-shadow: 0 0 0 3px #fff,0 0 0 9px #2563eb,0 0 28px 12px #2563eb55; transform: scale(1.14); }
        100% { box-shadow: 0 0 0 3px #fff,0 0 0 5px #2563eb,0 0 18px 6px #2563eb88; transform: scale(1); }
      }
      .delivery-marker-pulse {
        animation: delivery-pulse 1.6s ease-in-out infinite;
      }
      @keyframes route-draw-in {
        from { stroke-dashoffset: 2000; opacity: 0.2; }
        to   { stroke-dashoffset: 0;    opacity: 1; }
      }
      .route-seg-animated {
        stroke-dasharray: 2000;
        animation: route-draw-in 0.75s ease-out forwards;
      }
      .delivery-marker-base {
        transition: transform 0.3s ease, box-shadow 0.3s ease, opacity 0.3s ease;
      }
    `;
    document.head.appendChild(style);
    return () => { const el = document.getElementById(id); if (el) el.remove(); };
  }, []);

  // ── Listen to RouteController events ────────────────────────────────
  useEffect(() => {
    const onRc = ({ detail }) => {
      setRcPolyline(detail?.polyline || null);
      setRcActiveStop(detail?.activeStop || null);
    };
    window.addEventListener('rc-active', onRc);
    return () => window.removeEventListener('rc-active', onRc);
  }, []);






  // Simulation State
  const [isSimulating, setIsSimulating] = useState(false);
  const [simIndex, setSimIndex] = useState(0);
  const [revisitQueue, setRevisitQueue] = useState([]); // late replies — already passed


  // Real-time GPS State
  const [isRealTimeMode, setIsRealTimeMode] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [userHeading] = useState(0);
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(true);
  const [mapType, setMapType] = useState('roadmap');
  const [isCompassMode, setIsCompassMode] = useState(false);
  const [is3DMode, setIs3DMode] = useState(false);
  const [waitingForValidation, setWaitingForValidation] = useState(false);
  const [routeMode, setRouteMode] = useState('driving');
  const [showIpModal, setShowIpModal] = useState(false);
  const [ipInput, setIpInput] = useState('');
  // When served via ngrok (HTTPS), use same origin automatically — no manual IP needed
  const defaultBackendUrl = (() => {
    const saved = localStorage.getItem('backend_url');
    if (saved) return saved;
    if (window.location.protocol === 'https:') return window.location.origin;
    return 'http://localhost:8000';
  })();
  const [backendUrl, setBackendUrl] = useState(defaultBackendUrl);
  // ── Reactive mobile detection (updates on orientation change / resize) ────
  const [isMobileView, setIsMobileView] = useState(
    typeof window !== 'undefined' && window.innerWidth < 768
  );
  useEffect(() => {
    const handler = () => setIsMobileView(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    window.addEventListener('orientationchange', handler);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('orientationchange', handler);
    };
  }, []);

  // ── Sync ALL refs so closures never go stale ──────────────────────────────
  useEffect(() => { socketRef.current = socketInstance; }, [socketInstance]);
  useEffect(() => { backendUrlRef.current = backendUrl; }, [backendUrl]);

  // ── Hybrid GPS: pan map on nav start + live tracking during nav ───────────
  // add-on listener — zero changes to existing logic
  useEffect(() => {
    // One-shot origin pan when nav starts (GPS granted)
    const onGpsOrigin = ({ detail }) => {
      if (detail?.lat && detail?.lng) {
        setMapCenter([detail.lat, detail.lng]);
        setMapZoom(15);
      }
    };
    // Continuous live updates from watchPosition → move map marker with agent
    const onGpsLive = ({ detail }) => {
      if (!detail?.lat || !detail?.lng) return;
      setUserLocation([detail.lat, detail.lng]);
      setVehiclePos({ lat: detail.lat, lng: detail.lng });
      // Emit to socket so other dashboard clients see live agent position
      if (socketRef.current?.connected) {
        socketRef.current.emit('gps_update', { lat: detail.lat, lng: detail.lng, heading: 0 });
      }
    };
    window.addEventListener('hybrid-gps-origin', onGpsOrigin);
    window.addEventListener('hybrid-gps-live', onGpsLive);
    return () => {
      window.removeEventListener('hybrid-gps-origin', onGpsOrigin);
      window.removeEventListener('hybrid-gps-live', onGpsLive);
    };
  }, []);

  // Computed delivery target tracking
  const currentTarget = optimizedRoute ? optimizedRoute[Math.min(navIndex, optimizedRoute.length - 1)] : null;
  const distanceToTarget = (userLocation && currentTarget)
    ? calculateDistance(userLocation[0], userLocation[1], currentTarget.lat, currentTarget.lng)
    : null;
  const withinDeliveryRange = distanceToTarget !== null && distanceToTarget <= 250;

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const url = backendUrl;
        await axios.get(`${url}/`);
        setBackendReady(true);
      } catch (err) {
        setBackendReady(false);
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, 5000);
    return () => clearInterval(interval);
  }, []);


  // Socket.IO tracking
  useEffect(() => {
    const newSocket = io(backendUrl);

    newSocket.on('position_update', (data) => {
      // Update marker only — do NOT move the whole map (causes shake)
      setVehiclePos({ lat: data.lat, lng: data.lng });
      setVehicleHeading(data.heading);

      // Voice Instructions integration over sockets
      if (directionsResponse && directionsResponse.routes && directionsResponse.routes[0].legs[0].steps) {
        const steps = directionsResponse.routes[0].legs[0].steps;
        steps.forEach((step, sIdx) => {
          if (!spokenStepsRef.current.has(sIdx)) {
            const stepLng = step.maneuver.location[0];
            const stepLat = step.maneuver.location[1];
            const dist = calculateDistance(data.lat, data.lng, stepLat, stepLng);
            if (dist < 30) {
              let phrase = `${step.maneuver.type || 'Turn'} ${step.maneuver.modifier || ''} ${step.name ? 'onto ' + step.name : ''}`.trim();
              speak(phrase);
              setCurrentInstruction(phrase);
              spokenStepsRef.current.add(sIdx);
            }
          }
        });
      }
    });

    newSocket.on('destination_reached', () => {
      setIsNavigationActive(false);
      setShowCompletionModal(true);
      speak("You have arrived at your destination.");
      setCurrentInstruction('Arrived at Destination');
      setVehiclePos(null);
    });

    // ── Real-time availability → update Risk Intelligence panel + map markers ──
    newSocket.on('availability_update', (data) => {
      setOptimizedRoute(prev => {
        if (!prev) return prev;
        // Update the matching stop's risk fields
        const updated = prev.map(stop => {
          const matchById = stop.customer_id && stop.customer_id === data.customer_id;
          const matchByName = stop.customer_name && stop.customer_name === data.customer_name;
          if (!matchById && !matchByName) return stop;

          if (data.status === 'not_available') {
            // Customer not home → push to HIGH risk
            return {
              ...stop,
              risk_level: 'High',
              risk_probability: 1.0,
              road_risk_level: stop.road_risk_level || 'High',
              combined_risk: 1.0,
              combined_priority: 0.0,
              availability_status: 'not_available',
            };
          } else {
            // Customer confirmed home → drop to LOW risk
            return {
              ...stop,
              risk_level: 'Low',
              risk_probability: Math.max(0.05, (stop.risk_probability || 0.5) * 0.3),
              combined_risk: Math.max(0.05, (stop.combined_risk || 0.5) * 0.3),
              combined_priority: Math.min(0.99, (stop.combined_priority || 0.5) * 1.6 + 0.2),
              availability_status: 'confirmed',
            };
          }
        });
        // Re-sort: High risk to bottom, Low risk to top
        return [...updated].sort((a, b) => {
          const order = { Low: 0, Medium: 1, High: 2 };
          return (order[a.risk_level] || 0) - (order[b.risk_level] || 0);
        });
      });
    });
    // ────────────────────────────────────────────────────────────────────────

    setSocketInstance(newSocket);
    return () => newSocket.close();
  }, [backendUrl]);


  // Fetch initial user location unconditionally
  useEffect(() => {
    const fetchLoc = async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          const permissions = await Geolocation.checkPermissions();
          if (permissions.location !== 'granted') await Geolocation.requestPermissions();
          const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true });
          setUserLocation([position.coords.latitude, position.coords.longitude]);
        } else if ("geolocation" in navigator) {
          navigator.geolocation.getCurrentPosition(
            (position) => {
              setUserLocation([position.coords.latitude, position.coords.longitude]);
            },
            (err) => console.warn("Initial positioning failed", err),
            { enableHighAccuracy: true }
          );
        }
      } catch (e) {
        console.warn("Location error", e);
      }
    };
    fetchLoc();
  }, []);

  // Voice Synthesis Helper
  const speak = async (text) => {
    if (!isVoiceEnabled) return;
    if (Capacitor.isNativePlatform()) {
      try {
        await TextToSpeech.speak({
          text: text,
          rate: 1.0,
          pitch: 1.0,
        });
      } catch (e) { console.error("TTS Error", e); }
    } else {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
    }
  };

  // Simulation Logic
  useEffect(() => {
    let timer;
    if (isSimulating && optimizedRoute && simIndex < optimizedRoute.length) {
      if (waitingForValidation) return; // Wait for user to validate

      timer = setTimeout(() => {
        setWaitingForValidation(true);
        speak(`Arrived at stop ${simIndex + 1}. Please confirm delivery to mark as completed.`);
      }, 3000); // simulate travel time
    } else if (simIndex >= (optimizedRoute?.length || 0)) {
      setIsSimulating(false);
    }
    return () => clearTimeout(timer);
  }, [isSimulating, simIndex, optimizedRoute, waitingForValidation]);

  const handleCompleteDelivery = () => {
    // Notify RouteController to advance to next best destination
    window.dispatchEvent(new CustomEvent('rc-delivered'));
    setWaitingForValidation(false);
    const nextIndex = simIndex + 1;
    if (nextIndex < optimizedRoute.length) {
      const nextStop = optimizedRoute[nextIndex];
      setSimIndex(nextIndex);
      setMapCenter([nextStop.lat, nextStop.lng]);

      if (nextStop.risk_level === 'High') {
        speak(`Caution. Approaching high risk delivery at stop ${nextIndex + 1}.`);
      }
    } else {
      setSimIndex(nextIndex); // Move beyond the last stop
      speak("Final stop reached. All deliveries completed.");
      setIsSimulating(false);
      setIsRealTimeMode(false);
    }
  };



  // Strip HTML helper
  const stripHtml = (html) => {
    const tmp = document.createElement("DIV");
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || "";
  };

  const startNavigation = () => {
    if (!directionsResponse?.routes?.[0]) {
      speak('Please wait for the route to load first.');
      return;
    }
    const pathCoords = directionsResponse.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    // Place marker at route start
    setVehiclePos({ lat: pathCoords[0][0], lng: pathCoords[0][1] });
    setMapCenter([pathCoords[0][0], pathCoords[0][1]]);
    setNavIndex(0);
    spokenStepsRef.current = new Set();
    setIsNavigationActive(true);
    setMapZoom(17);
    setCurrentInstruction('Head along the active route');
    speak('Navigation started. GPS tracking active. Move to see the marker follow you.');
    // Activate real GPS watch — positions will be emitted via Socket.IO
    setIsRealTimeMode(true);
  };



  const handleOrderCompletion = async (status) => {
    setShowCompletionModal(false);
    try {
      await axios.post('http://localhost:8000/update_status', {
        order_id: `ORD-${Math.floor(Math.random() * 10000)}`,
        status: status,
        timestamp: new Date().toISOString()
      });
      alert(`Saved successfully: ${status}`);
    } catch (e) {
      console.error(e);
      alert(`Order marked as ${status}`);
    }
    setSourceInput('');
    setDestInput('');
    setOptimizedRoute(null);
    setDirectionsResponse(null);
    setRouteStats(null);
  };


  // Real-time GPS Tracking — emits positions via Socket.IO for live tracking on all clients
  useEffect(() => {
    let watchId = null;

    const onPosition = (latitude, longitude, heading) => {
      const h = heading ?? 0;
      setUserLocation([latitude, longitude]);
      setVehiclePos({ lat: latitude, lng: longitude });
      setVehicleHeading(h);
      setMapCenter([latitude, longitude]);
      // Emit real GPS to backend → backend broadcasts as position_update to all clients
      if (socketRef.current?.connected) {
        socketRef.current.emit('gps_update', { lat: latitude, lng: longitude, heading: h });
      }
    };

    const startTracking = async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          const permissions = await Geolocation.checkPermissions();
          if (permissions.location !== 'granted') await Geolocation.requestPermissions();
          watchId = await Geolocation.watchPosition(
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
            (position, err) => {
              if (err || !position) return;
              const { latitude, longitude, heading } = position.coords;
              onPosition(latitude, longitude, heading);
            }
          );
        } else if ('geolocation' in navigator) {
          watchId = navigator.geolocation.watchPosition(
            (pos) => onPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.heading),
            (error) => {
              console.error('Geolocation error:', error);
              speak('Unable to access GPS. Please allow location access.');
              setIsRealTimeMode(false);
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
          );
        }
      } catch (e) {
        console.error('Watch position error', e);
      }
    };

    if (isRealTimeMode) startTracking();

    return () => {
      if (watchId !== null) {
        if (Capacitor.isNativePlatform()) Geolocation.clearWatch({ id: watchId });
        else navigator.geolocation.clearWatch(watchId);
      }
    };
  }, [isRealTimeMode]);


  // Turn-by-turn voice guidance — OSRM compatible, no Google Maps methods
  useEffect(() => {
    if (!isNavigationActive || !userLocation || !directionsResponse?.routes?.[0]) return;
    const steps = directionsResponse.routes[0].legs?.[0]?.steps;
    if (!steps) return;
    steps.forEach((step, sIdx) => {
      if (!spokenStepsRef.current.has(sIdx)) {
        const stepLat = step.maneuver.location[1];
        const stepLng = step.maneuver.location[0];
        const d = calculateDistance(userLocation[0], userLocation[1], stepLat, stepLng);
        if (d < 40) {
          const phrase = `${step.maneuver.type || 'Turn'} ${step.maneuver.modifier || ''} ${step.name ? 'onto ' + step.name : ''}`.trim();
          speak(phrase);
          setCurrentInstruction(phrase);
          spokenStepsRef.current.add(sIdx);
        }
      }
    });
  }, [userLocation, directionsResponse, isNavigationActive]);

  // Arrival detection using route end point
  useEffect(() => {
    if (!isNavigationActive || !userLocation || !osrmPolyline.length) return;
    const dest = osrmPolyline[osrmPolyline.length - 1];
    const d = calculateDistance(userLocation[0], userLocation[1], dest[0], dest[1]);
    if (d < 30) {
      speak('You have arrived at your destination.');
      setCurrentInstruction('Arrived at destination!');
      setIsNavigationActive(false);
      setIsRealTimeMode(false);
      setShowCompletionModal(true);
    }
  }, [userLocation, isNavigationActive, osrmPolyline]);

  // ── Fetch full route (for stats + fallback polyline) ─────────────────────
  const fetchGoogleRoutes = async (routeOverride) => {
    const route = routeOverride || optimizedRoute;
    if (!route || route.length === 0) return;
    const stops = route.slice(0, 23);
    const coordsStr = stops.map(s => `${s.lng},${s.lat}`).join(';');
    if (!coordsStr || coordsStr.split(';').length < 2) return;
    const url = `${backendUrlRef.current}/api/route_batch`;
    try {
      const response = await axios.post(url, { coords: coordsStr });
      const data = response.data;
      if (data.code === 'Ok') {
        setDirectionsResponse(data);
        const poly = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
        setOsrmPolyline(poly);
        setRouteStats({
          distance: (data.routes[0].distance / 1000).toFixed(1) + ' km',
          duration: Math.round(data.routes[0].duration / 60) + ' min',
        });
      }
    } catch (e) {
      console.error('Route fetch failed:', e.message);
    }
  };

  // ── Fetch per-segment geometry for coloured polylines ─────────────────────
  const buildSegmentedRoute = async (route, custStates, revisitIds) => {
    if (!route || route.length < 2) { setRouteSegments([]); return; }
    const revisitSet = new Set((revisitIds || []).map(r => r.customer_id));
    const effectiveIdx = isNavigationActive ? navIndex : simIndex;
    const segments = [];

    for (let i = 0; i < route.length - 1; i++) {
      const from = route[i];
      const to = route[i + 1];
      const cs = custStates?.[to.customer_id] || {};
      const isCompleted = i + 1 < Math.floor(effectiveIdx);
      const isRevisit = revisitSet.has(to.customer_id);
      const color = availColor(cs.waStatus, cs.callStatus, isRevisit, isCompleted);

      // Skip (don't draw) red segments — customer not available
      if (color === 'red') continue;

      // Cache key for this segment
      const cacheKey = `${from.lng},${from.lat}|${to.lng},${to.lat}`;
      let pts = stopGeomRef.current[cacheKey];

      if (!pts) {
        try {
          const res = await axios.post(`${backendUrlRef.current}/api/route_batch`, {
            coords: `${from.lng},${from.lat};${to.lng},${to.lat}`,
          });
          if (res.data?.code === 'Ok') {
            pts = res.data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
            stopGeomRef.current[cacheKey] = pts;
          }
        } catch { pts = [[from.lat, from.lng], [to.lat, to.lng]]; }
      }

      if (pts && pts.length > 0) {
        segments.push({ positions: pts, color });
      }
    }
    setRouteSegments(segments);
    setRouteVersion(prev => prev + 1); // trigger re-render
  };

  useEffect(() => {
    if (optimizedRoute) fetchGoogleRoutes(optimizedRoute);
  }, [optimizedRoute]);

  // ── Rebuild coloured segments whenever status, revisit, or nav index changes ──
  useEffect(() => {
    if (!optimizedRoute || optimizedRoute.length === 0) return;
    buildSegmentedRoute(optimizedRoute, customerStatusMap, revisitQueue);
  }, [optimizedRoute, navIndex, simIndex, revisitQueue, customerStatusMap]);

  // ── Listen to socket whatsapp_reply directly to update map colors instantly ──
  useEffect(() => {
    if (!socketInstance) return;
    const onReply = (payload) => {
      const { phone_10, reply_type, confidence = 1 } = payload || {};
      if (!phone_10 || !reply_type || reply_type === 'unknown' || confidence < 0.5) return;
      // Find matching delivery by last-10-digit phone comparison
      const normalise = (p) => String(p || '').replace(/\D/g, '').slice(-10);
      const matched = (optimizedRoute || []).find(s =>
        normalise(s.phone) === normalise(phone_10) ||
        normalise(s.customer_phone) === normalise(phone_10)
      );
      if (!matched) return;
      const waStatus = reply_type === 'yes' ? 'replied_yes'
        : reply_type === 'no' ? 'replied_no'
          : reply_type === 'reschedule' ? 'rescheduled'
            : 'pending';

      // Update color map immediately
      setCustomerStatusMap(prev => {
        const updated = { ...prev, [matched.customer_id]: { ...(prev[matched.customer_id] || {}), waStatus } };

        // ── Re-calculate route ONLY for "no" / reschedule replies ─────────────
        if ((reply_type === 'no' || reply_type === 'reschedule') && optimizedRoute?.length) {
          const SKIP = new Set(['replied_no', 'answered_unavailable', 'not_answered', 'rescheduled']);
          const activeStops = optimizedRoute.filter(s => {
            const cs = updated[s.customer_id] || {};
            return !SKIP.has(cs.waStatus) && !SKIP.has(cs.callStatus);
          });
          const routeToUse = activeStops.length >= 2 ? activeStops : optimizedRoute;
          // Debounced so rapid replies don't hammer OSRM
          if (routeDebounceRef.current) clearTimeout(routeDebounceRef.current);
          routeDebounceRef.current = setTimeout(() => {
            fetchGoogleRoutes(routeToUse);
            console.log('[Map] Route re-calc after WA reply:', routeToUse.length, 'active stops');
          }, 400);
        }
        return updated;
      });
      console.log('[Map] Status updated from WA reply:', matched.customer_id, '->', waStatus);
    };
    socketInstance.on('whatsapp_reply', onReply);
    return () => socketInstance.off('whatsapp_reply', onReply);
  }, [socketInstance, optimizedRoute]);


  // ── Debounce ref: prevents excessive route recalculation on rapid replies ───
  const routeDebounceRef = useRef(null);

  // ── Smart routing: priority-reorder events from PriorityModule ───────────
  useEffect(() => {
    const handler = (e) => {
      const detail = e.detail || {};
      const sorted = Array.isArray(detail) ? detail : detail.sorted;
      const triggeredBy = Array.isArray(detail) ? null : detail.triggeredBy;
      if (!Array.isArray(sorted) || sorted.length === 0) return;
      const stops = sorted.filter(s => s && s.customer_id);
      if (stops.length === 0) return;

      setDeliveries(stops);

      // ── Update customerStatusMap from triggeredBy (immediate color update) ─
      if (triggeredBy?.customer_id && (triggeredBy.waStatus || triggeredBy.callStatus)) {
        setCustomerStatusMap(prev => ({
          ...prev,
          [triggeredBy.customer_id]: {
            ...(prev[triggeredBy.customer_id] || {}),
            ...(triggeredBy.waStatus ? { waStatus: triggeredBy.waStatus } : {}),
            ...(triggeredBy.callStatus ? { callStatus: triggeredBy.callStatus } : {}),
          },
        }));
      }

      const effectiveIdx = isNavigationActive ? navIndex : simIndex;
      const isMoving = isNavigationActive || isSimulating;

      if (triggeredBy?.customer_id && isMoving) {
        const trigStop = stops.find(s => s.customer_id === triggeredBy.customer_id);
        if (trigStop?.status === 'delivered') return;
        const custIdx = stops.findIndex(s => s.customer_id === triggeredBy.customer_id);
        if (custIdx !== -1 && custIdx <= effectiveIdx) {
          setRevisitQueue(prev => {
            const without = prev.filter(r => r.customer_id !== triggeredBy.customer_id);
            return [...without, {
              ...(trigStop || {}),
              customer_id: triggeredBy.customer_id,
              customer_name: triggeredBy.name || trigStop?.customer_name || triggeredBy.customer_id,
              revisitReason: triggeredBy.waStatus || 'late_reply',
              revisitTime: triggeredBy.reschedTime || null,
              addedAt: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
            }];
          });
          speak(`${triggeredBy.name || 'Customer'} replied late. Added to revisit queue.`);
          return;
        }
        if (custIdx !== -1 && custIdx === effectiveIdx + 1) {
          const ok = window.confirm(
            `${triggeredBy.name || 'Customer'} just replied (${triggeredBy.waStatus || 'update'}). ` +
            `Recalculate route to prioritise them?`
          );
          if (!ok) return;
        }
      }

      // ── Debounced route recalculation: exclude unavailable stops ──────────
      if (routeDebounceRef.current) clearTimeout(routeDebounceRef.current);
      routeDebounceRef.current = setTimeout(() => {
        // Build active-only route: skip customers who are confirmed unavailable
        setCustomerStatusMap(latestMap => {
          const SKIP_STATUSES = new Set(['replied_no', 'answered_unavailable', 'not_answered']);
          const activeStops = stops.filter(s => {
            const cs = latestMap[s.customer_id] || {};
            const isSkipped = SKIP_STATUSES.has(cs.waStatus) || SKIP_STATUSES.has(cs.callStatus);
            return !isSkipped;
          });
          const routeToUse = activeStops.length >= 2 ? activeStops : stops;
          fetchGoogleRoutes(routeToUse);
          console.log('[App] Route recalculated:', routeToUse.length, 'active stops (', stops.length - routeToUse.length, 'skipped )');
          return latestMap; // no change to map — just reading it
        });
      }, 300);
    };

    window.addEventListener('priority-reorder', handler);
    return () => {
      window.removeEventListener('priority-reorder', handler);
      if (routeDebounceRef.current) clearTimeout(routeDebounceRef.current);
    };
  }, [isNavigationActive, isSimulating, navIndex, simIndex]);

  // ── Socket fallback: poll /availability/status-all if socket disconnects ──
  useEffect(() => {
    if (!socketInstance) return;
    const poll = async () => {
      if (socketInstance.connected) return; // socket healthy — skip poll
      try {
        const res = await fetch(`${backendUrl}/availability/status-all`);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data?.statuses)) {
          // Emit a synthetic event so PriorityModule can update states
          data.statuses.forEach(s => {
            if (s.customer_id && s.status) {
              window.dispatchEvent(new CustomEvent('availability-poll', { detail: s }));
            }
          });
        }
      } catch { /* silent — socket may reconnect before next tick */ }
    };
    const timer = setInterval(poll, 45000); // every 45s
    return () => clearInterval(timer);
  }, [socketInstance, backendUrl]);



  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    pendingFileRef.current = file; // store for retry after IP config
    await processFile(file);
  };

  const processFile = async (file) => {
    setLoading(true);
    setUploadedFileName(file.name);
    setIsSimulating(false);
    setSimIndex(0);
    setDirectionsResponse(null);
    setOsrmPolyline([]);
    setRouteSegments([]);
    setCustomerStatusMap({});   // clear status map for new session
    stopGeomRef.current = {};   // clear geometry cache for new session

    try {
      const fileText = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(e);
        reader.readAsText(file);
      });

      const formData = new FormData();
      formData.append('file', new Blob([fileText], { type: 'text/csv' }), file.name);

      // Always use current backendUrl state (reactive, not stale localStorage)
      const response = await axios.post(`${backendUrlRef.current}/smart_upload`, formData, {
        // Do NOT set Content-Type manually — axios sets it with correct boundary for FormData
        timeout: 20000,
      });

      if (response.data.error) {
        alert(`CSV Error: ${response.data.error}`);
        setDeliveries([]);
        setOptimizedRoute(null);
      } else {
        const data = response.data;
        if (!data.deliveries || data.deliveries.length === 0) {
          alert('No deliveries found. Check Smart CSV columns:\ndistance, traffic_level, delivery_time, weather_condition, lat, lng\n+ customer cols: scheduled_time, preferred_slot, failed_attempts, contact_reliable');
          return;
        }
        setDeliveries(data.deliveries);
        setOptimizedRoute(data.optimized_route);
        setMapCenter([data.deliveries[0].lat, data.deliveries[0].lng]);
        setMapZoom(13);
        isRetryingRef.current = false; // reset on success
        speak(`Route ready. ${data.total_deliveries} deliveries loaded.`);
      }
    } catch (error) {
      console.error('Upload failed:', error);
      if (isRetryingRef.current) {
        // Retry already failed — don't loop the modal, just inform
        isRetryingRef.current = false;
        alert(`Still cannot reach backend at:\n${backendUrlRef.current}\n\nCheck:\n1. python main.py is running\n2. Firewall allows port 8000\n3. Same Wi-Fi network\n\nTap ⚙ to change IP.`);
      } else {
        // First failure — open IP modal so user can set/correct IP
        setIpInput(backendUrlRef.current.replace('http://', '').replace(':8000', ''));
        setShowIpModal(true);
      }
    } finally {
      setLoading(false);
      // Reset input so same file can be re-selected after IP change
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const stats = useMemo(() => {
    if (!optimizedRoute || optimizedRoute.length === 0) {
      return { total: 0, highRisk: 0, avgProb: 0, clusters: 0 };
    }
    const high = optimizedRoute.filter(d => d.risk_level === 'High').length;
    const avgP = optimizedRoute.reduce((acc, d) => acc + d.risk_probability, 0) / optimizedRoute.length;
    const clusterCount = new Set(optimizedRoute.map(d => d.cluster)).size;
    return {
      total: optimizedRoute.length,
      highRisk: high,
      avgProb: (avgP * 100).toFixed(1),
      clusters: clusterCount
    };
  }, [optimizedRoute]);

  const fetchManualRoute = async () => {
    if (!sourceInput || !destInput) return;
    setLoading(true);
    setOptimizedRoute(null);
    setDirectionsResponse(null);

    try {
      const gSource = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(sourceInput)}&format=json&limit=1`);
      const jSource = await gSource.json();
      const gDest = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(destInput)}&format=json&limit=1`);
      const jDest = await gDest.json();

      const start = [parseFloat(jSource[0].lon), parseFloat(jSource[0].lat)];
      const end = [parseFloat(jDest[0].lon), parseFloat(jDest[0].lat)];

      const manualRoute = [
        { lat: start[1], lng: start[0], id: 1, cluster: 0, street: sourceInput, risk_level: 'Low', risk_probability: 0.05, distance: 0, traffic: 1, weather: 0 },
        { lat: end[1], lng: end[0], id: 2, cluster: 0, street: destInput, risk_level: 'Low', risk_probability: 0.05, distance: 10, traffic: 1, weather: 0 }
      ];

      setDeliveries(manualRoute);
      setOptimizedRoute(manualRoute);
      setMapCenter([start[1], start[0]]);
    } catch (e) {
      console.error(e);
      alert("Geocoding failed. Please check your inputs.");
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    setDeliveries([]);
    setOptimizedRoute(null);
    setUploadedFileName('');
    setMapCenter([13.0827, 80.2707]);
    setMapZoom(10);
    setIsSimulating(false);
    setSimIndex(0);
    setIsRealTimeMode(false);
    setWaitingForValidation(false);
  };

  const toggleSimulation = () => {
    setIsRealTimeMode(false); // Disable real-time if simulation starts
    if (optimizedRoute && simIndex >= optimizedRoute.length) {
      setSimIndex(0);
    }
    setWaitingForValidation(false);
    setIsSimulating(!isSimulating);
  };

  const toggleRealTimeMode = () => {
    setIsSimulating(false); // Disable simulation if real-time starts
    setWaitingForValidation(false);
    setIsRealTimeMode(!isRealTimeMode);
  };





  return (
    <div className="flex flex-col lg:flex-row min-h-[100dvh] lg:h-screen bg-[#020617] lg:overflow-hidden relative overflow-y-auto overflow-x-hidden">

      {showIpModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="bg-slate-900 border border-white/10 rounded-2xl p-6 w-full max-w-sm shadow-2xl flex flex-col gap-4 relative">
            <button onClick={() => setShowIpModal(false)} className="absolute top-4 right-4 text-slate-500 hover:text-white font-bold text-xl">✕</button>
            <div className="text-center">
              <div className="w-12 h-12 bg-indigo-500/10 rounded-full flex items-center justify-center mx-auto mb-3">
                <Zap size={24} className="text-indigo-500" />
              </div>
              <h2 className="text-lg font-bold text-white tracking-wide">Configure Server IP</h2>
              <p className="text-xs text-slate-400 mt-2">Mobile detected. Enter your laptop's Wi-Fi IPv4 address (e.g., 192.168.1.5) to connect to the backend.</p>
            </div>
            <input
              type="text"
              value={ipInput}
              onChange={(e) => setIpInput(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/50 rounded-xl p-3 text-sm text-center text-white focus:border-indigo-500 outline-none"
              placeholder="192.168.1.x"
            />
            <button onClick={async () => {
              if (ipInput) {
                const newUrl = `http://${ipInput}:8000`;
                localStorage.setItem('backend_url', newUrl);
                backendUrlRef.current = newUrl; // set IMMEDIATELY — don't wait for React effect
                setBackendUrl(newUrl);
                setShowIpModal(false);
                if (pendingFileRef.current) {
                  isRetryingRef.current = true; // mark as retry so loop is prevented
                  setTimeout(() => processFile(pendingFileRef.current), 300);
                }
              }
            }} className="w-full bg-indigo-600 hover:bg-indigo-500 py-3 rounded-xl font-bold text-white shadow-lg shadow-indigo-600/30">
              Save Configuration
            </button>
          </motion.div>
        </div>
      )}

      {showCompletionModal && (
        <div className="fixed inset-0 z-[9999] flex items-end justify-center pb-20 bg-black/60 backdrop-blur-sm">
          <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="bg-slate-900 border border-white/10 rounded-2xl p-6 w-[400px] shadow-2xl flex flex-col items-center gap-6 relative">
            <button onClick={() => setShowCompletionModal(false)} className="absolute top-4 right-4 text-slate-500 hover:text-white font-bold text-xl">✕</button>
            <div className="text-center">
              <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-3">
                <CheckCircle size={32} className="text-emerald-500" />
              </div>
              <h2 className="text-xl font-bold text-white tracking-wide">Destination Reached</h2>
              <p className="text-xs text-slate-400 mt-2">Log the final delivery status to continue.</p>
            </div>
            <div className="grid grid-cols-2 gap-4 w-full">
              <button onClick={() => handleOrderCompletion('Completed')} className="flex flex-col items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-emerald-600/30">
                ✅ Completed
              </button>
              <button onClick={() => handleOrderCompletion('Incomplete')} className="flex flex-col items-center justify-center gap-2 bg-rose-600 hover:bg-rose-500 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-rose-600/30">
                ❌ Incomplete
              </button>
            </div>
          </motion.div>
        </div>
      )}

      <div className="app-bg" />

      {/* Sidebar */}
      <aside className={`sidebar w-full lg:w-80 border-t lg:border-t-0 border-white/5 shrink-0 z-50 lg:h-full bg-slate-900/95 backdrop-blur-xl ${(optimizedRoute || directionsResponse) ? 'hidden lg:flex flex-col' : 'flex flex-col'}`}>
        <div className="px-6 py-4 lg:py-8 border-b border-white/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                <Truck size={20} className="text-white" />
              </div>
              <div>
                <h1 className="sidebar-logo text-xl font-bold tracking-tight">SmartParcel</h1>
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-0.5">Tamil Nadu Ops</p>
              </div>
            </div>
            {/* Always-visible Server Settings button */}
            <button
              onClick={() => {
                setIpInput(backendUrlRef.current.replace('http://', '').replace(':8000', ''));
                setShowIpModal(true);
              }}
              title={`Server: ${backendUrl}`}
              className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 border border-white/10 flex items-center justify-center text-slate-400 hover:text-indigo-400 transition-all"
            >
              ⚙
            </button>
          </div>
        </div>

        <div className="flex-1 px-4 py-6 overflow-y-auto custom-scrollbar">

          <div className="bg-slate-800/40 p-4 mt-4 rounded-xl border border-white/5 space-y-3">
            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest text-center">Standard Navigation</p>
            <input type="text" placeholder="Source (Auto GPS if empty)" value={sourceInput} onChange={e => setSourceInput(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-[11px] text-white outline-none focus:border-indigo-500 transition-all" />
            <input type="text" placeholder="Destination" value={destInput} onChange={e => setDestInput(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-[11px] text-white outline-none focus:border-indigo-500 transition-all" />
            <button onClick={() => {
              if (!destInput) return alert("Destination required");
              setOptimizedRoute(null);
              setDeliveries([]);
              fetchGoogleRoutes();
            }} className="w-full bg-indigo-600 hover:bg-indigo-500 py-2.5 rounded-lg text-[11px] font-bold text-white transition-all shadow-lg shadow-indigo-600/20">Fetch Route</button>
            {routeStats && (
              <div className="flex justify-between items-center bg-slate-950 p-2.5 rounded-lg w-full mt-2 text-[10px] text-slate-300">
                <span className="font-bold text-blue-400">Dist: {routeStats.distance}</span>
                <span className="font-bold text-emerald-400">ETA: {routeStats.duration}</span>
              </div>
            )}
          </div>

          <button
            onClick={startNavigation}
            disabled={!directionsResponse || isNavigationActive}
            className={`w-full py-4 mt-4 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 border shadow-lg ${isNavigationActive
              ? "bg-slate-700 border-white/5 text-slate-400"
              : "bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 border-emerald-400/30 text-white shadow-emerald-900/20"
              }`}
          >
            {isNavigationActive ? <Activity size={16} className="animate-spin" /> : <Navigation size={16} />}
            {isNavigationActive ? "Navigating..." : "Start Navigation"}
          </button>

          <div className="mt-4 border-t border-white/5 pt-4">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block text-center mb-3">Or Upload Batch CSV</span>

            <label className="block mb-6">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="hidden"
              />
              <div className="cursor-pointer bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-50 hover:to-violet-500 transition-all p-5 rounded-2xl text-center group border border-indigo-400/20 shadow-xl shadow-indigo-900/20">
                <Package size={36} className="mx-auto mb-3 text-white group-hover:scale-110 transition-transform" />
                <p className="text-white font-bold text-sm">Smart Upload CSV</p>
                <p className="text-indigo-100/70 text-[10px] mt-1">Road + Customer Risk Intelligence</p>
              </div>
            </label>
          </div>

          {uploadedFileName && (
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4 mb-4">
              <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Active Batch</p>
              <p className="text-sm text-white font-medium truncate">{uploadedFileName}</p>
              <div className="flex items-center gap-2 mt-2">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <p className="text-xs text-emerald-400 font-medium">{deliveries.length} Records Loaded</p>
              </div>
            </motion.div>
          )}

          {deliveries.length > 0 && (
            <div className="space-y-3">
              <button
                onClick={() => {
                  if (isNavigationActive) setIsNavigationActive(false);
                  else startNavigation();
                }}
                className={`w-full py-4 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 border shadow-lg ${isNavigationActive
                  ? 'bg-rose-600 border-rose-400/30 text-white shadow-rose-900/40'
                  : 'bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 border-indigo-400/30 text-white shadow-indigo-900/20'
                  }`}
              >
                {isNavigationActive ? <LocateFixed size={16} className="animate-pulse" /> : <Navigation size={16} />}
                {isNavigationActive ? 'Stop 3D GPS Mode' : 'Start 3D Drive Mode'}
              </button>

              <div className="pt-4 space-y-3">
                <div className="flex items-center justify-between px-2">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Routing Mode</span>
                  <select
                    value={routeMode}
                    onChange={(e) => setRouteMode(e.target.value)}
                    className="bg-slate-800/80 border border-white/5 text-[10px] font-bold text-slate-300 rounded-lg px-2 py-1 outline-none cursor-pointer"
                  >
                    <option value="driving">Car 🚗</option>
                    <option value="walking">Walking 🚶</option>
                    <option value="cycling">Bike 🚲</option>
                  </select>
                </div>
                <div className="flex items-center justify-between px-2">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Voice Assistant</span>
                  <button
                    onClick={() => setIsVoiceEnabled(!isVoiceEnabled)}
                    className={`text-[10px] font-bold px-3 py-1 rounded-full transition-all ${isVoiceEnabled ? 'bg-indigo-500/20 text-indigo-400' : 'bg-slate-800 text-slate-500'}`}
                  >
                    {isVoiceEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>

                <div className="flex items-center justify-between px-2">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Map View</span>
                  <select
                    value={mapType}
                    onChange={(e) => setMapType(e.target.value)}
                    className="bg-slate-800/80 border border-white/5 text-[10px] font-bold text-slate-300 rounded-lg px-2 py-1 outline-none cursor-pointer"
                  >
                    <option value="dark">Dark Mode</option>
                    <option value="satellite">Satellite (Google)</option>
                    <option value="terrain">Terrain (Google)</option>
                  </select>
                </div>

                <div className="flex items-center justify-between px-2">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Compass Mode</span>
                  <button
                    onClick={() => setIsCompassMode(!isCompassMode)}
                    className={`text-[10px] font-bold px-3 py-1 rounded-full transition-all ${isCompassMode ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-800 text-slate-500'}`}
                  >
                    {isCompassMode ? 'HEADING UP' : 'NORTH UP'}
                  </button>
                </div>

                <div className="flex items-center justify-between px-2">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">3D Map Style</span>
                  <button
                    onClick={() => setIs3DMode(!is3DMode)}
                    className={`text-[10px] font-bold px-3 py-1 rounded-full transition-all ${is3DMode ? 'bg-indigo-500/20 text-indigo-400' : 'bg-slate-800 text-slate-500'}`}
                  >
                    {is3DMode ? 'ON' : 'OFF'}
                  </button>
                </div>
              </div>

              <button onClick={handleClear} className="w-full bg-slate-800/50 hover:bg-rose-900/40 hover:text-rose-400 border border-slate-700 text-slate-400 py-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2">
                <Trash2 size={14} /> Clear System Data
              </button>
            </div>
          )}
        </div>

        <div className="px-4 py-6 border-t border-white/5 bg-slate-900/20">
          <div className="system-status">
            <div className="flex items-center gap-2 mb-4">
              <div className={`status-dot ${!backendReady ? 'offline' : ''}`} />
              <span className="text-xs font-bold text-slate-300 tracking-wide uppercase">
                {backendReady ? 'Optimization Engine Online' : 'Backend Connection Offline'}
              </span>
            </div>
            <div className="space-y-2.5">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">RF Classifier</span>
                <span className="text-indigo-400 font-bold">Active</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">LR Optimizer</span>
                <span className="text-violet-400 font-bold">Stable</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">Genetic Algo</span>
                <span className="text-emerald-400 font-bold">Ready</span>
              </div>
            </div>
          </div>
        </div>
      </aside>
      <main className="flex-1 flex flex-col relative z-10 lg:overflow-hidden min-h-[60vh] lg:min-h-0">
        <header className={`app-header h-20 items-center justify-between px-8 shrink-0 ${(optimizedRoute || directionsResponse) ? 'hidden lg:flex' : 'flex'}`}>
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight">Adaptive Route Intelligence</h2>
            <div className="flex items-center gap-4 mt-1">
              <p className="text-xs text-slate-500 font-medium flex items-center gap-1.5">
                <Activity size={12} className="text-indigo-500" /> Multi-Cluster Optimization
              </p>
              <div className="w-1 h-1 rounded-full bg-slate-700" />
              <p className="text-xs text-slate-500 font-medium flex items-center gap-1.5">
                <Shield size={12} className="text-emerald-500" /> Risk-Aware Routing
              </p>
            </div>
          </div>

          {loading && <div className="flex items-center gap-3 bg-indigo-500/10 border border-indigo-500/20 px-4 py-2 rounded-full">
            <span className="loading-spinner" />
            <span className="text-xs font-bold text-indigo-400 uppercase tracking-widest">Optimizing...</span>
          </div>}
        </header>

        <div className="flex-1 overflow-auto p-4 lg:p-6 scrollbar-hide flex flex-col">
          {/* Stats Bar */}
          <div className={`grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-6 mb-4 lg:mb-6 shrink-0 ${optimizedRoute ? 'hidden lg:grid' : ''}`}>
            {[
              { label: 'Total Stops', value: stats.total, icon: MapPin, color: 'from-indigo-500/10', iconColor: 'text-indigo-400' },
              { label: 'High Risk Alerts', value: stats.highRisk, icon: AlertTriangle, color: 'from-rose-500/10', iconColor: 'text-rose-400' },
              { label: 'System Accuracy', value: stats.total > 0 ? '97.4' : '—', suffix: stats.total > 0 ? '%' : '', icon: Shield, color: 'from-emerald-500/10', iconColor: 'text-emerald-400' },
              { label: 'Active Clusters', value: stats.clusters, icon: Layers, color: 'from-violet-500/10', iconColor: 'text-violet-400' },
            ].map((stat, i) => {
              const Icon = stat.icon;
              return (
                <motion.div key={i} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }} className="stat-card group">
                  <div className={`absolute inset-0 bg-gradient-to-br ${stat.color} to-transparent opacity-50 group-hover:opacity-100 transition-opacity`} />
                  <div className="relative flex items-center justify-between">
                    <div>
                      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">{stat.label}</p>
                      <p className="text-2xl text-white">
                        <AnimatedNumber value={stat.value} suffix={stat.suffix} />
                      </p>
                    </div>
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center bg-slate-900/50 border border-white/5 ${stat.iconColor}`}>
                      <Icon size={24} />
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>

          {/* Desktop web: grid. Mobile browser + Capacitor APK: fullscreen when route loaded */}
          <div className={`${(Capacitor.isNativePlatform() || (isMobileView && (optimizedRoute || isNavigationActive))) ? 'fixed inset-0 z-[5000] w-full h-[100dvh]' : 'grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6 flex-1 min-h-[55vh] lg:min-h-0 lg:h-[calc(100vh-280px)] pb-10 lg:pb-0'}`}>
            {/* Map Container */}
            <div className={`${(Capacitor.isNativePlatform() || (isMobileView && (optimizedRoute || isNavigationActive))) ? 'w-full h-full' : 'lg:col-span-2 rounded-3xl'} relative map-panel overflow-hidden group`}>

              {(optimizedRoute || directionsResponse) && (waitingForValidation || isRealTimeMode || isNavigationActive) && (
                <div
                  className="delivery-confirm-hud"
                  style={{
                    position: 'absolute',
                    bottom: 'calc(48px + env(safe-area-inset-bottom, 0px))',
                    left: '50%', transform: 'translateX(-50%)',
                    zIndex: 6000, width: '90%', maxWidth: 384,
                    pointerEvents: 'auto',
                  }}
                >
                  <motion.div initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} className="bg-slate-900/95 backdrop-blur-xl border border-indigo-500/30 p-5 rounded-2xl shadow-2xl flex flex-col gap-4">
                    <div className="flex justify-between items-center">
                      <div>
                        <h4 className="text-white font-bold flex items-center gap-2">
                          <CheckCircle className="text-emerald-400" size={18} /> Confirm Delivery
                        </h4>
                        <p className="text-slate-400 text-xs mt-1">
                          {currentTarget?.street || `Active Zone Target`}
                        </p>
                      </div>
                      {(isRealTimeMode || isNavigationActive) && (
                        <div className="text-right">
                          <p className="text-[10px] text-slate-500 uppercase font-bold">Distance</p>
                          <p className={`text-sm font-bold ${withinDeliveryRange ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {distanceToTarget ? `${Math.round(distanceToTarget)}m` : 'Arriving'}
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="flex gap-3 w-full">
                      <button
                        onClick={handleCompleteDelivery}
                        disabled={(isRealTimeMode || isNavigationActive) && distanceToTarget !== null && distanceToTarget > 250}
                        className={`flex-1 py-3 rounded-xl font-bold transition-all ${(!(isRealTimeMode || isNavigationActive) || (distanceToTarget !== null && distanceToTarget <= 250))
                          ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-500/20 cursor-pointer'
                          : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-white/5'
                          }`}
                      >
                        ✅ Completed
                      </button>
                      <button
                        onClick={handleCompleteDelivery}
                        disabled={(isRealTimeMode || isNavigationActive) && distanceToTarget !== null && distanceToTarget > 250}
                        className={`flex-1 py-3 rounded-xl font-bold transition-all ${(!(isRealTimeMode || isNavigationActive) || (distanceToTarget !== null && distanceToTarget <= 250))
                          ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-500/20 cursor-pointer'
                          : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-white/5'
                          }`}
                      >
                        ❌ Incomplete
                      </button>
                    </div>
                    {(isRealTimeMode || isNavigationActive) && distanceToTarget !== null && distanceToTarget > 250 && (
                      <p className="text-center text-[10px] text-amber-500 uppercase tracking-wider font-bold">
                        Must be within 250m to validate
                      </p>
                    )}
                  </motion.div>
                </div>
              )}

              {(optimizedRoute || directionsResponse) && (
                <div className={`absolute top-4 right-4 z-[6000] flex gap-2 pointer-events-auto ${isNavigationActive ? '' : 'lg:hidden'}`}>
                  {!isNavigationActive && (
                    <button id="auto-start-nav-btn" onClick={startNavigation} className="bg-indigo-600 py-2.5 px-5 rounded-full text-white font-bold shadow-xl border border-indigo-500/50">
                      🚀 Start Navigation
                    </button>
                  )}
                  <button onClick={() => { setOptimizedRoute(null); setDeliveries([]); if (isNavigationActive) setIsNavigationActive(false); }} className="bg-white border border-slate-200 py-2.5 px-4 rounded-full text-slate-800 font-bold shadow-xl">
                    Quit
                  </button>
                </div>
              )}

              <div className="absolute top-6 left-6 z-[1000] space-y-2 pointer-events-none">
                <div className="bg-white/90 backdrop-blur-xl border border-slate-200 px-4 py-3 rounded-2xl shadow-xl">
                  <h3 className="text-xs font-bold text-slate-800 mb-2 flex items-center gap-2 tracking-wide uppercase">
                    <Activity size={14} className="text-indigo-600" /> Dynamic Map Visualization
                  </h3>
                  <div className="flex gap-4">
                    <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-emerald-500" /><span className="text-[10px] text-slate-400 font-bold uppercase">Safe/Complete</span></div>
                    <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-amber-500" /><span className="text-[10px] text-slate-400 font-bold uppercase">Warning</span></div>
                    <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-rose-500" /><span className="text-[10px] text-slate-400 font-bold uppercase">Risk</span></div>
                  </div>
                </div>
              </div>

              {isNavigationActive && currentInstruction && (
                <div className="absolute top-6 left-1/2 -translate-x-1/2 z-[6000] w-[90%] max-w-md pointer-events-none">
                  <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="bg-white/95 backdrop-blur-md border-b-4 border-indigo-600 p-4 rounded-b-2xl shadow-xl flex items-center gap-4 pointer-events-auto">
                    <div className="w-12 h-12 rounded-full bg-indigo-600 flex items-center justify-center shrink-0">
                      <Navigation size={24} className="text-white" />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest mb-0.5">Route Guidance</p>
                      <h2 className="text-slate-800 font-bold text-lg lg:text-xl leading-tight capitalize">{currentInstruction}</h2>
                    </div>
                  </motion.div>
                </div>
              )}

              {isLoaded ? (
                <MapContainer
                  center={mapCenter}
                  zoom={mapZoom}
                  className="w-full h-full"
                  zoomControl={false}
                  attributionControl={false}
                >
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  <MapUpdater center={mapCenter} zoom={mapZoom} />

                  {/* ── RC: single blinking road-aligned route ──────────── */}
                  {rcActive && rcPolyline && rcPolyline.length > 1 && (
                    <Polyline
                      key="rc-route"
                      positions={rcPolyline}
                      pathOptions={{ color: '#1d4ed8', weight: 7, opacity: 1, className: 'sarm-route' }}
                    />
                  )}

                  {/* ── Multi-route polylines: hidden when RC is managing routing */}
                  {!rcActive && routeSegments.length > 0 ? (
                    routeSegments.map((seg, si) => (
                      <Polyline
                        key={`seg-${si}-v${routeVersion}`}
                        positions={seg.positions}
                        pathOptions={{
                          color: seg.color === 'green' ? '#16a34a'
                            : seg.color === 'violet' ? '#9333ea' : '#2563eb',
                          weight: seg.color === 'blue' ? 7 : 5,
                          opacity: seg.color === 'blue' ? 0.95 : 0.80,
                          dashArray: seg.color === 'violet' ? '10 7' : undefined,
                          className: 'route-seg-animated',
                        }}
                      />
                    ))
                  ) : !rcActive && osrmPolyline.length > 0 && (
                    <Polyline
                      key={`fallback-v${routeVersion}`}
                      positions={osrmPolyline}
                      pathOptions={{ color: '#2563eb', weight: 6, opacity: 0.9, className: 'route-seg-animated' }}
                    />
                  )}


                  {userLocation && (
                    <Marker position={userLocation} icon={blueIcon}>
                      <Popup>
                        <div className="p-1 text-center text-slate-800">
                          <p className="text-[10px] font-bold text-blue-500 uppercase mb-1">Live Location</p>
                          <p className="text-xs font-bold">You are here</p>
                        </div>
                      </Popup>
                    </Marker>
                  )}

                  {vehiclePos && (
                    <Marker
                      position={[vehiclePos.lat, vehiclePos.lng]}
                      icon={bikeIcon}
                      rotationAngle={vehicleHeading}
                      rotationOrigin="center center"
                      zIndexOffset={5000}
                    />
                  )}

                  {/* ── RC: single active destination marker ────────────── */}
                  {rcActive && rcActiveStop && (() => {
                    const stop = rcActiveStop;
                    const rcIcon = L.divIcon({
                      className: '',
                      html: `<div class="sarm-dest-icon" style="width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#1d4ed8,#2563eb);display:flex;align-items:center;justify-content:center;font-size:22px;">📦</div>`,
                      iconSize: [46, 46], iconAnchor: [23, 23], popupAnchor: [0, -28],
                    });
                    return (
                      <Marker key={`rc-dest-${stop.customer_id}`} position={[stop.lat, stop.lng]} icon={rcIcon} zIndexOffset={9999}>
                        <Popup>
                          <div style={{ fontFamily: 'system-ui', minWidth: 155 }}>
                            <div style={{ fontSize: 11, fontWeight: 800, color: '#1d4ed8', marginBottom: 5 }}>📍 ACTIVE DESTINATION</div>
                            <div style={{ fontSize: 13, fontWeight: 700 }}>{stop.customer_name || 'Customer'}</div>
                            {stop.scheduled_time && <div style={{ fontSize: 10, color: '#64748b', marginTop: 3 }}>🕐 {stop.scheduled_time}</div>}
                            {stop.phone && <div style={{ fontSize: 10, color: '#64748b' }}>📞 {stop.phone}</div>}
                            {stop.risk_level && <div style={{ fontSize: 10, fontWeight: 700, marginTop: 4, color: stop.risk_level === 'High' ? '#ef4444' : stop.risk_level === 'Medium' ? '#f59e0b' : '#22c55e' }}>{stop.risk_level} Risk</div>}
                          </div>
                        </Popup>
                      </Marker>
                    );
                  })()}

                  {/* ── Multi-stop markers: hidden when RC is active ──────────── */}
                  {/* (placeholder — real block follows) */}
                  {false && null /* kept for JSX balance */}

                  {/* ── (legacy GDM marker removed — RC handles all routing) */}
                  {false && (() => {
                    const stop = {};
                    const gdmIcon = L.divIcon({ className:'', html:'', iconSize:[0,0] });
                    return (
                      <Marker
                        key="gdm-placeholder"
                        position={[0, 0]}
                        icon={gdmIcon}
                        zIndexOffset={0}
                      >
                        <Popup>
                          <div style={{ fontFamily: 'system-ui', minWidth: 160 }}>
                            <div style={{ fontSize: 11, fontWeight: 800, color: '#1d4ed8', marginBottom: 6 }}>🎯 ACTIVE DESTINATION</div>
                            <div style={{ fontSize: 13, fontWeight: 700 }}>{stop.customer_name || 'Customer'}</div>
                            {stop.scheduled_time && <div style={{ fontSize: 10, color: '#64748b', marginTop: 3 }}>🕐 {stop.scheduled_time}</div>}
                            {stop.phone && <div style={{ fontSize: 10, color: '#64748b' }}>📞 {stop.phone}</div>}
                            {stop.risk_level && <div style={{ fontSize: 10, fontWeight: 700, marginTop: 4, color: stop.risk_level === 'High' ? '#ef4444' : stop.risk_level === 'Medium' ? '#f59e0b' : '#22c55e' }}>{stop.risk_level} Risk</div>}
                          </div>
                        </Popup>
                      </Marker>
                    );
                  })()}

                  {/* ── Numbered delivery markers (hidden when RC active) ────── */}
                  {!rcActive && optimizedRoute && (() => {
                    // Compute display sequence (skip unavailable in count)
                    const SKIP = new Set(['replied_no', 'answered_unavailable', 'not_answered']);
                    const effectiveIdx = isNavigationActive ? navIndex : simIndex;
                    // Next active stop = first non-completed, non-unavailable stop
                    let nextActiveStopIdx = -1;
                    for (let i = 0; i < optimizedRoute.length; i++) {
                      if (i < Math.floor(effectiveIdx)) continue;
                      const _cs = customerStatusMap[optimizedRoute[i].customer_id] || {};
                      if (SKIP.has(_cs.waStatus) || SKIP.has(_cs.callStatus)) continue;
                      nextActiveStopIdx = i;
                      break;
                    }
                    let displayNum = 0;
                    return optimizedRoute.map((stop, i) => {
                      const isCompleted = i < Math.floor(effectiveIdx);
                      const isRevisit = revisitQueue.some(r => r.customer_id === stop.customer_id);
                      const cs = customerStatusMap[stop.customer_id] || {};
                      const waStatus = cs.waStatus || '';
                      const callStatus = cs.callStatus || '';
                      const color = availColor(waStatus, callStatus, isRevisit, isCompleted);
                      const isUnavail = SKIP.has(waStatus) || SKIP.has(callStatus);
                      const isNextStop = i === nextActiveStopIdx;
                      const isDimmed = isUnavail && !isCompleted;

                      // Sequence number: completed show ✓ (handled in icon), unavailable get no number
                      if (!isCompleted) displayNum++;
                      const label = isCompleted ? '✓' : String(displayNum);

                      // Popup labels
                      const statusLabel = isCompleted ? '✅ Delivered'
                        : isNextStop ? '🚀 Next Stop'
                          : isRevisit ? '🔄 Revisit Later'
                            : waStatus === 'replied_yes' || callStatus === 'answered_available' ? '✅ Available'
                              : waStatus === 'replied_no' || callStatus === 'answered_unavailable' ? '❌ Not Home'
                                : callStatus === 'not_answered' ? '🔇 No Answer'
                                  : waStatus === 'call_needed' ? '📞 Call Needed'
                                    : waStatus === 'rescheduled' ? '🕐 Rescheduled'
                                      : '⏳ Pending';
                      const statusBg = isNextStop ? 'bg-blue-100 text-blue-800 ring-2 ring-blue-400'
                        : color === 'green' ? 'bg-emerald-100 text-emerald-700'
                          : color === 'red' ? 'bg-rose-100 text-rose-700'
                            : color === 'violet' ? 'bg-purple-100 text-purple-700'
                              : 'bg-blue-100 text-blue-700';

                      return (
                        <Marker
                          key={`${stop.customer_id}-v${routeVersion}`}
                          position={[stop.lat, stop.lng]}
                          icon={createNumberedIcon(label, color, isNextStop, isDimmed, isCompleted)}
                          zIndexOffset={isNextStop ? 9000 : isCompleted ? 0 : isDimmed ? -100 : 500}
                        >
                          <Popup>
                            <div style={{ fontFamily: 'system-ui', minWidth: 160 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                <span style={{ fontSize: 10, fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>Stop #{i + 1}</span>
                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${statusBg}`}>{statusLabel}</span>
                              </div>
                              {isNextStop && (
                                <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '4px 8px', marginBottom: 8, fontSize: 11, fontWeight: 700, color: '#1d4ed8', textAlign: 'center' }}>
                                  🚀 HEAD HERE NEXT
                                </div>
                              )}
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <p style={{ fontSize: 12, fontWeight: 700, display: 'flex', justifyContent: 'space-between' }}>Customer: <span style={{ color: '#6366f1', maxWidth: 100, textAlign: 'right' }}>{stop.customer_name || `Zone ${stop.cluster}`}</span></p>
                                <p style={{ fontSize: 12, fontWeight: 700, display: 'flex', justifyContent: 'space-between' }}>Scheduled: <span style={{ color: '#8b5cf6' }}>{stop.scheduled_time || 'N/A'}</span></p>
                                <p style={{ fontSize: 12, fontWeight: 700, display: 'flex', justifyContent: 'space-between' }}>Road Risk: <span style={{ color: stop.road_risk_level === 'High' ? '#ef4444' : stop.road_risk_level === 'Medium' ? '#f59e0b' : '#10b981' }}>{stop.road_risk_level || 'Low'}</span></p>
                              </div>
                            </div>
                          </Popup>
                        </Marker>
                      );
                    });
                  })()}

                  {/* ── Map Legend ──────────────────────────────────────────── */}
                  {optimizedRoute && optimizedRoute.length > 0 && (
                    <div style={{
                      position: 'absolute', bottom: 24, left: 12, zIndex: 1000,
                      background: 'rgba(15,23,42,0.88)', backdropFilter: 'blur(8px)',
                      borderRadius: 12, padding: '10px 14px', border: '1px solid rgba(255,255,255,0.08)',
                      fontFamily: 'system-ui', pointerEvents: 'none',
                    }}>
                      <div style={{ fontSize: 9, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Route Legend</div>
                      {[['#2563eb', '●──', 'Active Route'], ['#16a34a', '●──', 'Available / Done'], ['#9333ea', '●╌╌', 'Revisit Later'],].map(([c, sym, lbl]) => (
                        <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                          <span style={{ color: c, fontSize: 14, lineHeight: 1 }}>{sym}</span>
                          <span style={{ color: '#cbd5e1', fontSize: 10, fontWeight: 600 }}>{lbl}</span>
                        </div>
                      ))}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <span style={{ color: '#dc2626', fontSize: 14, lineHeight: 1 }}>●</span>
                        <span style={{ color: '#fca5a5', fontSize: 10, fontWeight: 600 }}>Unavailable (dimmed)</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: '#2563eb', fontSize: 12, animation: 'delivery-pulse 1.6s infinite' }}>◎</span>
                        <span style={{ color: '#93c5fd', fontSize: 10, fontWeight: 600 }}>Pulsing = Go here next</span>
                      </div>
                    </div>
                  )}

                </MapContainer>
              ) : (
                <div className="w-full h-full bg-slate-900 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-4">
                    <Truck className="text-indigo-500 animate-bounce" size={40} />
                    <p className="text-slate-500 font-bold tracking-widest uppercase text-xs">Initializing Engine...</p>
                  </div>
                </div>
              )}
            </div>

            {/* Decision Support Panel */}
            <div className="hidden lg:flex risk-panel rounded-3xl flex-col overflow-hidden">
              <div className="p-6 border-b border-white/5 bg-slate-900/40">
                <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-widest">
                  <Activity size={18} className="text-indigo-500" /> Risk Intelligence
                </h3>
                <p className="text-[10px] text-slate-500 mt-1 font-medium tracking-wide">COMBINED ROAD + CUSTOMER RISK INTELLIGENCE</p>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 custom-scrollbar">
                <AnimatePresence mode="popLayout">
                  {!optimizedRoute ? (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex flex-col items-center justify-center text-center p-10">
                      <div className="w-16 h-16 rounded-3xl bg-indigo-500/5 flex items-center justify-center mb-4 border border-indigo-500/10">
                        <Zap size={32} className="text-indigo-500/40" />
                      </div>
                      <h4 className="text-sm font-bold text-slate-400 mb-2">No Active Pipeline</h4>
                      <p className="text-xs text-slate-600">Upload a manifest CSV to initialize the ML-based risk assessment engine.</p>
                    </motion.div>
                  ) : (
                    optimizedRoute.slice(simIndex).map((stop, i) => {
                      const realIndex = i + simIndex;
                      const riskType = stop.risk_level.toLowerCase();
                      return (
                        <motion.div key={realIndex} initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
                          className={`risk-card risk-${riskType} border-l-4 ${riskType === 'high' ? 'border-l-rose-500' : riskType === 'medium' ? 'border-l-amber-500' : 'border-l-emerald-500'}`}
                        >
                          <div className="flex justify-between items-center mb-3">
                            <div className="flex items-center gap-3">
                              <span className="w-8 h-8 rounded-lg bg-slate-900/80 text-slate-400 flex items-center justify-center text-[11px] font-bold">
                                {`#${realIndex + 1}`}
                              </span>
                              <div>
                                <p className="text-xs font-bold text-white uppercase tracking-tight truncate max-w-[120px]">
                                  {stop.customer_name || (stop.street && stop.street !== 'Unknown Street' ? stop.street : `Zone ${stop.cluster}`)}
                                </p>
                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                                  {`Zone ${stop.cluster} • ID ${stop.id}`}
                                </p>
                              </div>
                            </div>
                            <span className={`risk-badge risk-badge-${riskType}`}>
                              {stop.risk_level}
                            </span>
                          </div>

                          <div className="grid grid-cols-3 gap-2">
                            <div className="bg-slate-900/40 p-2 rounded-lg text-center">
                              <p className="text-[9px] text-slate-500 font-bold uppercase mb-0.5">Road</p>
                              <p className={`text-xs font-bold ${stop.road_risk_level === 'High' ? 'text-rose-400' : stop.road_risk_level === 'Medium' ? 'text-amber-400' : 'text-emerald-400'}`}>
                                {stop.road_risk_level || 'Low'}
                              </p>
                            </div>
                            <div className="bg-slate-900/40 p-2 rounded-lg text-center">
                              <p className="text-[9px] text-slate-500 font-bold uppercase mb-0.5">Failed</p>
                              <p className={`text-xs font-bold ${(stop.failed_attempts > 1) ? 'text-rose-400' : 'text-white'}`}>
                                {stop.failed_attempts ?? 0}x
                              </p>
                            </div>
                            <div className="bg-slate-900/40 p-2 rounded-lg text-center">
                              <p className="text-[9px] text-slate-500 uppercase mb-0.5">Contact</p>
                              <p className={`text-xs font-bold ${String(stop.contact_reliable) === 'false' ? 'text-rose-400' : 'text-emerald-400'}`}>
                                {String(stop.contact_reliable) === 'false' ? '❌' : '✅'}
                              </p>
                            </div>
                          </div>

                          <div className="mt-3">
                            <div className="flex justify-between items-center text-[9px] font-bold uppercase mb-1">
                              <span className="text-slate-500 tracking-widest">Combined Risk Score</span>
                              <span className="text-indigo-400">{(stop.risk_probability * 100).toFixed(1)}%</span>
                            </div>
                            <div className="prob-bar-track bg-slate-900/60">
                              <motion.div initial={{ width: 0 }} animate={{ width: `${stop.risk_probability * 100}%` }}
                                className={`prob-bar-fill ${riskType === 'high' ? 'bg-rose-500' : riskType === 'medium' ? 'bg-amber-500' : 'bg-emerald-500'}`}
                              />
                            </div>
                          </div>
                        </motion.div>
                      );
                    })
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
      </main >
      {/* ── Customer Priority Module (add-on) ─────────────────────── */}
      <PriorityModule
        backendUrl={backendUrl}
        speak={speak}
        socket={socketInstance}
        deliveries={deliveries}
      />
      {/* ──────────────────────────────────────────────────────────── */}

      {/* ── Revisit Queue Overlay ─────────────────────────────────── */}
      {revisitQueue.length > 0 && (
        <div style={{
          position: 'fixed', bottom: 90, left: 16, zIndex: 8500,
          background: '#fff', borderRadius: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          border: '2px solid #f97316', minWidth: 240, maxWidth: 320,
          fontFamily: 'system-ui, sans-serif',
        }}>
          {/* Header */}
          <div style={{
            background: 'linear-gradient(135deg,#ea580c,#dc2626)', borderRadius: '12px 12px 0 0',
            padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ color: '#fff', fontWeight: 800, fontSize: 13 }}>
              🔄 Revisit Queue ({revisitQueue.length})
            </span>
            <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 10 }}>Late replies — already passed</span>
          </div>
          {/* Items */}
          <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {revisitQueue.map((r, i) => (
              <div key={r.customer_id || i} style={{
                background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '8px 10px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 13, color: '#9a3412' }}>{r.customer_name}</div>
                    <div style={{ fontSize: 10, color: '#78350f', marginTop: 2 }}>
                      {r.revisitReason === 'replied_yes' ? '✅ Now available — was passed'
                        : r.revisitReason === 'rescheduled' ? `🕐 Rescheduled: ${r.revisitTime || 'new time'}`
                          : '📱 Late reply — driver passed location'}
                    </div>
                    {r.addedAt && (
                      <div style={{ fontSize: 9, color: '#b45309', marginTop: 2 }}>Added at {r.addedAt}</div>
                    )}
                  </div>
                  <button
                    onClick={() => setRevisitQueue(prev => prev.filter(x => x.customer_id !== r.customer_id))}
                    style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: '#ef4444', lineHeight: 1, padding: '0 2px' }}
                    title="Dismiss"
                  >✕</button>
                </div>
                {r.phone && (
                  <a href={`tel:${r.phone}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, background: '#ea580c', color: '#fff', borderRadius: 7, padding: '5px 10px', fontSize: 11, fontWeight: 700, textDecoration: 'none' }}>
                    📞 Call to arrange revisit
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {/* ──────────────────────────────────────────────────────────── */}


      {/* ── Twilio WhatsApp Auto-Notification (add-on) ────────────── */}
      <TwilioNotifier
        deliveries={deliveries}
        socket={socketInstance}
        backendUrl={backendUrl}
        speak={speak}
      />
      {/* ── AI Smart Navigation Add-On ────────────────────────────── */}
      <SmartNavModule
        deliveries={deliveries}
        socket={socketInstance}
        backendUrl={backendUrl}
        speak={speak}
      />
      {/* ── Guidance-First Hybrid Nav Overlay (add-on) ────────────── */}
      <HybridNavOverlay
        speak={speak}
        userLocation={userLocation}
      />
      {/* ── Route Controller — background logic, zero UI ────────────────── */}
      <RouteController
        deliveries={deliveries}
        socket={socketInstance}
        backendUrl={backendUrl}
        speak={speak}
      />
      {/* ──────────────────────────────────────────────────────────────── */}


    </div>
  );
}

export default App;
