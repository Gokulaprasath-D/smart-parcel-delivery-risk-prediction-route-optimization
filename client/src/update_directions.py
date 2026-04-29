import os
import re

file_path = r'd:\quiz\client\src\App.jsx'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Imports
content = re.sub(
    r"import { GoogleMap, useJsApiLoader, MarkerF, InfoWindowF, PolylineF, DirectionsRenderer } from '@react-google-maps/api';",
    "import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, useMapEvent } from 'react-leaflet';\nimport L from 'leaflet';\nimport 'leaflet/dist/leaflet.css';\nimport 'leaflet-rotatedmarker';\nimport { io } from 'socket.io-client';\n\n// Custom Bike Icon\nconst bikeIcon = new L.Icon({\n  iconUrl: 'https://cdn-icons-png.flaticon.com/512/3720/3720610.png',\n  iconSize: [40, 40],\n  iconAnchor: [20, 20],\n});\n\nconst blueIcon = new L.Icon({ iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png', shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41] });\n\nconst greenIcon = new L.Icon({ iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png', shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41] });\n\nconst redIcon = new L.Icon({ iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png', shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41] });\n\n// Component to handle map view updates dynamically\nconst MapUpdater = ({ center, zoom, vehicleHeading, isCompassMode }) => {\n  const map = useMap();\n  useEffect(() => {\n    if (center) {\n      if (isCompassMode) {\n        // Smoothly animate to center but we can't do native 3D tilt without plugins like mapbox. We fake it via CSS.\n        map.flyTo(center, 18, { animate: true, duration: 0.5 });\n        document.querySelector('.leaflet-container').style.transform = `rotateX(60deg) rotateZ(${-vehicleHeading}deg)`;\n      } else {\n        document.querySelector('.leaflet-container').style.transform = `none`;\n        map.flyTo(center, zoom, { animate: true });\n      }\n    }\n  }, [center, zoom, isCompassMode, vehicleHeading]);\n  return null;\n};\n",
    content
)

# 2. State & Variables
content = re.sub(r'const GOOGLE_MAPS_API_KEY = ".*"; // REPLACE WITH YOUR API KEY\n', '', content)
content = re.sub(
    r"  const { isLoaded } = useJsApiLoader\({[\s\S]*?}\);",
    "  const isLoaded = true;\n  const [socketInstance, setSocketInstance] = useState(null);\n  const [osrmPolyline, setOsrmPolyline] = useState([]);\n",
    content
)

# 3. Socket.io Effect (inject after checkStatus effect)
socket_effect = """
  // Socket.IO tracking
  useEffect(() => {
    const url = localStorage.getItem('backend_url') || 'http://localhost:8000';
    const newSocket = io(url);
    
    newSocket.on('position_update', (data) => {
        setVehiclePos({ lat: data.lat, lng: data.lng });
        setVehicleHeading(data.heading);
        setMapCenter([data.lat, data.lng]);
    });
    
    newSocket.on('destination_reached', () => {
        setIsNavigationActive(false);
        setShowCompletionModal(true);
        speak("You have arrived at your destination.");
        setVehiclePos(null);
    });
    
    setSocketInstance(newSocket);
    return () => newSocket.close();
  }, []);
"""
content = re.sub(
    r"  // Fetch initial user location unconditionally",
    socket_effect + "\n  // Fetch initial user location unconditionally",
    content
)

# 4. updatePosition / requestAnimationFrame -> replace with emit
content = re.sub(
    r"  const startNavigation = \(overrideDirections = null\) => {([\s\S]*?)speak\(\"Starting 3D GPS navigation. Following the optimized route.\"\);\n  };",
    """  const startNavigation = (overrideDirections = null) => {
    const currentRoute = overrideDirections || directionsResponse;
    if (!currentRoute || !currentRoute.routes[0]) {
      speak("Please wait or generate a route first.");
      return;
    }
    
    const pathCoords = currentRoute.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    
    setVehiclePos({lat: pathCoords[0][0], lng: pathCoords[0][1]});
    setNavIndex(0);
    spokenStepsRef.current = new Set();
    setIsNavigationActive(true);
    setIs3DMode(true);
    setIsCompassMode(true);
    setMapZoom(18);
    speak("Starting 3D GPS navigation. Following the optimized route.");
    
    // START SOCKET
    if (socketInstance) {
        socketInstance.emit('start_simulation', { path: pathCoords });
    }
  };""",
    content
)

content = re.sub(
    r"  useEffect\(\(\) => {\n    let animationFrameId;[\s\S]*?return \(\) => cancelAnimationFrame\(animationFrameId\);\n  }, \[isNavigationActive, directionsResponse\]\);",
    "", # Delete the requestAnimationFrame entirely!
    content
)

# 5. fetchGoogleRoutes -> fetchOSRMRoute
content = re.sub(
    r"  const fetchGoogleRoutes = async \(\) => {([\s\S]*?)  };\n\n  useEffect\(\(\) => {\n    if \(optimizedRoute\) fetchGoogleRoutes\(\);",
    """  const fetchGoogleRoutes = async () => {
    const directionsService = null;
    let points = optimizedRoute ? optimizedRoute.map(stop => ({ location: { lat: stop.lat, lng: stop.lng }, stopover: true })) : [];

    if (points.length > 20) {
      points = points.slice(0, 20);
    }
    
    let path = [];
    if (sourceInput) {
       // Just grab first loc
       path.push([80.2707, 13.0827]); 
    } else if (userLocation) {
       path.push([userLocation[1], userLocation[0]]);
    } else if (optimizedRoute && optimizedRoute[0]) {
       path.push([optimizedRoute[0].lng, optimizedRoute[0].lat]);
    }
    
    points.forEach(p => {
        path.push([p.location.lng, p.location.lat]);
    });
    
    const coordsStr = path.map(p => `${p[0]},${p[1]}`).join(';');
    const url = `http://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true`;
    
    try {
        const response = await axios.get(url);
        const data = response.data;
        if (data.code === 'Ok') {
             setDirectionsResponse(data);
             // generate polyline coords
             const poly = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
             setOsrmPolyline(poly);
             
             setRouteStats({
                distance: (data.routes[0].distance / 1000).toFixed(1) + ' km',
                duration: Math.round(data.routes[0].duration / 60) + ' min'
             });
             
             if (!isNavigationActive) {
                setTimeout(() => startNavigation(data), 500);
             }
        } else {
             alert('OSRM limits: ' + data.code);
        }
    } catch (e) {
        console.error(e);
        alert('Failed to connect to OSRM.');
    }
  };

  useEffect(() => {
    if (optimizedRoute) fetchGoogleRoutes();""",
    content
)

# 6. Replace <GoogleMap> with <MapContainer>
content = re.sub(
    r"<GoogleMap[\s\S]*?</GoogleMap>",
    """<MapContainer
                  center={mapCenter}
                  zoom={mapZoom}
                  className="w-full h-full"
                  zoomControl={false}
                  attributionControl={false}
                >
                  <TileLayer url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png" />
                  <MapUpdater center={mapCenter} zoom={mapZoom} vehicleHeading={vehicleHeading} isCompassMode={isCompassMode} />

                  {osrmPolyline.length > 0 && (
                    <Polyline positions={osrmPolyline} color="#6366f1" weight={6} opacity={0.9} />
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

                  {optimizedRoute && optimizedRoute.map((stop, i) => {
                    const isCompleted = i < Math.floor(navIndex);
                    return (
                      <Marker
                        key={i}
                        position={[stop.lat, stop.lng]}
                        icon={isCompleted ? greenIcon : (stop.risk_level === 'High' ? redIcon : blueIcon)}
                      >
                        <Popup>
                          <div className="p-1 min-w-[140px] text-slate-800">
                            <div className="flex justify-between items-start mb-2">
                              <span className="text-[10px] font-bold text-slate-500 uppercase">Stop #{i + 1}</span>
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${isCompleted ? 'bg-emerald-100 text-emerald-600' :
                                stop.risk_level === 'High' ? 'bg-rose-100 text-rose-600' :
                                  stop.risk_level === 'Medium' ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-600'
                                }`}>
                                {isCompleted ? 'Completed ✅' : stop.risk_level}
                              </span>
                            </div>
                            <div className="space-y-1.5">
                              <p className="text-xs font-bold flex justify-between">ID: <span className="text-slate-500">#00{stop.id}</span></p>
                              <p className="text-xs font-bold flex justify-between">Area: <span className="text-indigo-500 truncate ml-2">{stop.street && stop.street !== 'Unknown Street' ? stop.street : `Zone ${stop.cluster}`}</span></p>
                              <p className="text-xs font-bold flex justify-between">Cluster: <span className="text-violet-500">Area {stop.cluster}</span></p>
                            </div>
                          </div>
                        </Popup>
                      </Marker>
                    );
                  })}
                </MapContainer>""",
    content
)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Migration completed.")
