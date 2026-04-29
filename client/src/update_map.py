import re

with open('App.jsx', 'r', encoding='utf-8') as f:
    code = f.read()

# 1. Imports
code = code.replace(
    "import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';",
    "import { GoogleMap, useJsApiLoader, MarkerF, InfoWindowF, PolylineF, DirectionsRenderer } from '@react-google-maps/api';\nconst GOOGLE_MAPS_API_KEY = \"YOUR_GOOGLE_MAPS_API_KEY\"; // REPLACE WITH YOUR API KEY"
)
code = code.replace("import 'leaflet/dist/leaflet.css';\n", "")

# 2. L and Icons
code = re.sub(
    r"import L from 'leaflet';\nimport '\./App\.css';(.+?)const getRiskIcon = \(level\) => {",
    "import './App.css';\n\nconst getRiskIcon = (level) => {",
    code,
    flags=re.DOTALL
)

code = re.sub(
    r"return new L\.Icon\(\{(.+?)iconUrl:\s*`(.+?)`,(.+?)\}\);",
    r"return `\2`;",
    code,
    flags=re.DOTALL
)

code = re.sub(
    r"const getCompletedIcon = \(\) => \{\s+return new L\.Icon\(\{.+?iconUrl:\s*'(.+?)',.+?\}\);\s+\};",
    r"const getCompletedIcon = () => {\n  return '\1';\n};",
    code,
    flags=re.DOTALL
)

# 3. ChangeView -> containerStyle
code = re.sub(
    r"// Map view controller(.+?)return null;\n\}",
    "const containerStyle = {\n  width: '100%',\n  height: '100%'\n};",
    code,
    flags=re.DOTALL
)

# 4. App states for Google Map
app_state_insertion = """  const [mapZoom, setMapZoom] = useState(12);
  const [backendReady, setBackendReady] = useState(false);
  const [mapInstance, setMapInstance] = useState(null);
  const [activeMarker, setActiveMarker] = useState(null);

  const { isLoaded } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: GOOGLE_MAPS_API_KEY
  });

  useEffect(() => {
    if (mapInstance) {
      mapInstance.panTo({ lat: mapCenter[0], lng: mapCenter[1] });
      mapInstance.setZoom(mapZoom);
    }
  }, [mapCenter, mapZoom, mapInstance]);"""

code = code.replace(
    "  const [mapZoom, setMapZoom] = useState(12);\n  const [backendReady, setBackendReady] = useState(false);",
    app_state_insertion
)

# 5. Route geometries Fix:
code = code.replace(
    "const points = leg.steps.flatMap(s => s.geometry.coordinates.map(c => [c[1], c[0]]));",
    "const points = leg.steps.flatMap(s => s.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] })));"
)

code = code.replace(
    "[stop.lat, stop.lng],\n                          [nextStop.lat, nextStop.lng]",
    "{ lat: stop.lat, lng: stop.lng },\n                          { lat: nextStop.lat, lng: nextStop.lng }"
)

# 6. Map render block
map_replace_regex = r"<MapContainer.+?</MapContainer>"

def replace_map(m):
    return """{!isLoaded ? (
                <div className="w-full h-full flex items-center justify-center bg-slate-900 text-white font-bold">
                  Loading Maps...
                </div>
              ) : (
                <GoogleMap
                  mapContainerStyle={containerStyle}
                  center={{ lat: mapCenter[0], lng: mapCenter[1] }}
                  zoom={mapZoom}
                  onLoad={(map) => setMapInstance(map)}
                  onUnmount={() => setMapInstance(null)}
                  options={{
                    mapTypeId: mapType === 'dark' ? 'roadmap' : mapType,
                    styles: mapType === 'dark' ? [
                      { elementType: "geometry", stylers: [{ color: "#212121" }] },
                      { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
                      { elementType: "labels.text.fill", stylers: [{ color: "#757575" }] },
                      { elementType: "labels.text.stroke", stylers: [{ color: "#212121" }] },
                      { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#757575" }] },
                      { featureType: "administrative.country", elementType: "labels.text.fill", stylers: [{ color: "#9e9e9e" }] },
                      { featureType: "administrative.land_parcel", stylers: [{ visibility: "off" }] },
                      { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#bdbdbd" }] },
                      { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#757575" }] },
                      { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#181818" }] },
                      { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#616161" }] },
                      { featureType: "poi.park", elementType: "labels.text.stroke", stylers: [{ color: "#1b1b1b" }] },
                      { featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#2c2c2c" }] },
                      { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8a8a8a" }] },
                      { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#373737" }] },
                      { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3c3c3c" }] },
                      { featureType: "road.highway.controlled_access", elementType: "geometry", stylers: [{ color: "#4e4e4e" }] },
                      { featureType: "road.local", elementType: "labels.text.fill", stylers: [{ color: "#616161" }] },
                      { featureType: "transit", elementType: "labels.text.fill", stylers: [{ color: "#757575" }] },
                      { featureType: "water", elementType: "geometry", stylers: [{ color: "#000000" }] },
                      { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3d3d3d" }] }
                    ] : [],
                    disableDefaultUI: true,
                    zoomControl: true,
                    tilt: is3DMode ? 45 : 0,
                    heading: isCompassMode ? userHeading : 0
                  }}
                >
                  {optimizedRoute && optimizedRoute.length > 1 && (
                    optimizedRoute.slice(0, optimizedRoute.length - 1).map((stop, i) => {
                      if (i < simIndex - 1) return null;
                      const nextStop = optimizedRoute[i + 1];
                      const isHighTraffic = nextStop.traffic > 3;
                      
                      return (
                        <PolylineF
                          key={`path-${i}`}
                          path={routeGeometries[i] ? routeGeometries[i] : [
                            { lat: stop.lat, lng: stop.lng },
                            { lat: nextStop.lat, lng: nextStop.lng }
                          ]}
                          options={{
                            strokeColor: isHighTraffic ? '#ef4444' : '#22c55e',
                            strokeWeight: 5,
                            strokeOpacity: 0.8,
                          }}
                        />
                      );
                    })
                  )}

                  {userLocation && (
                    <MarkerF
                      position={{ lat: userLocation[0], lng: userLocation[1] }}
                      icon={{
                        url: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
                        scaledSize: new window.google.maps.Size(25, 41)
                      }}
                      zIndex={2000}
                      onClick={() => setActiveMarker('user')}
                    >
                      {activeMarker === 'user' && (
                        <InfoWindowF onCloseClick={() => setActiveMarker(null)}>
                          <div className="p-2 text-center text-slate-800">
                            <p className="text-[10px] font-bold text-blue-500 uppercase mb-1">Live Location</p>
                            <p className="text-xs font-bold">You are here</p>
                          </div>
                        </InfoWindowF>
                      )}
                    </MarkerF>
                  )}

                  {isSimulating && optimizedRoute && simIndex < optimizedRoute.length && (
                    <MarkerF
                      position={{ lat: optimizedRoute[simIndex].lat, lng: optimizedRoute[simIndex].lng }}
                      icon={{
                        url: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-black.png',
                        scaledSize: new window.google.maps.Size(25, 41)
                      }}
                      zIndex={1000}
                      onClick={() => setActiveMarker('truck')}
                    >
                      {activeMarker === 'truck' && (
                        <InfoWindowF onCloseClick={() => setActiveMarker(null)}>
                          <div className="p-2 text-center text-slate-800">
                            <p className="text-[10px] font-bold text-indigo-500 uppercase mb-1">Live Tracking</p>
                            <p className="text-xs font-bold">Delivery Truck 01</p>
                            <p className="text-[10px] text-slate-500 mt-1">Status: Moving to Stop #{simIndex + 2}</p>
                          </div>
                        </InfoWindowF>
                      )}
                    </MarkerF>
                  )}

                  {optimizedRoute && optimizedRoute.map((stop, i) => {
                    const isCompleted = i < simIndex;
                    return (
                      <MarkerF
                        key={i}
                        position={{ lat: stop.lat, lng: stop.lng }}
                        icon={{
                          url: isCompleted ? getCompletedIcon() : getRiskIcon(stop.risk_level),
                          scaledSize: new window.google.maps.Size(25, 41)
                        }}
                        opacity={isCompleted ? 0.7 : 1}
                        onClick={() => setActiveMarker(`stop-${i}`)}
                      >
                        {activeMarker === `stop-${i}` && (
                          <InfoWindowF onCloseClick={() => setActiveMarker(null)}>
                            <div className="p-2 min-w-[140px] text-slate-800">
                              <div className="flex justify-between items-start mb-2">
                                <span className="text-[10px] font-bold text-slate-500 uppercase">Stop #{i + 1}</span>
                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${
                                  isCompleted ? 'bg-emerald-100 text-emerald-600' :
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
                          </InfoWindowF>
                        )}
                      </MarkerF>
                    );
                  })}
                </GoogleMap>
              )}"""

code = re.sub(map_replace_regex, replace_map, code, flags=re.DOTALL)

with open('App.jsx', 'w', encoding='utf-8') as f:
    f.write(code)

print("SUCCESS")
