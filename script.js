// =========================
// 1) CONFIGURATION
// =========================
const MADRID_CENTER = [40.4168, -3.7038];
const INITIAL_ZOOM = 12;
const SEARCH_RADIUS_METERS = 1000;
const WALKING_SPEED_M_PER_MIN = 80;
const DISTANCE_CORRECTION_FACTOR = 1.2;
const STATION_ICON_SWITCH_ZOOM = 14;

const DATA_URLS = {
  stations: "https://cdn.jsdelivr.net/gh/ysrifi/madrid-map-data@main/stations.geojson",
  lignes: "https://cdn.jsdelivr.net/gh/ysrifi/madrid-map-data@main/lignes.geojson",
  places: "https://cdn.jsdelivr.net/gh/ysrifi/madrid-map-data@main/places.geojson",
  monuments: "https://cdn.jsdelivr.net/gh/ysrifi/madrid-map-data@main/monuments.geojson",
  musees: "https://cdn.jsdelivr.net/gh/ysrifi/madrid-map-data@main/musees.geojson",
  parcs: "https://cdn.jsdelivr.net/gh/ysrifi/madrid-map-data@main/parcs.geojson",
  activites: "https://cdn.jsdelivr.net/gh/ysrifi/madrid-map-data@main/activites.geojson",
  shopping: "https://cdn.jsdelivr.net/gh/ysrifi/madrid-map-data@main/shopping.geojson"
};

// =========================
// 2) CARTE
// =========================
const map = L.map("map", {
  center: MADRID_CENTER,
  zoom: INITIAL_ZOOM,
  zoomControl: true
});

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
}).addTo(map);

// =========================
// 3) CONTROLES
// =========================
L.control.locate({
  position: "topright",
  flyTo: true,
  keepCurrentZoomLevel: false,
  initialZoomLevel: 15,
  strings: {
    title: "Me localiser"
  }
}).addTo(map);

// =========================
// 4) VARIABLES GLOBALES
// =========================
const layers = {};
const rawData = {};
const visibleMetroLines = new Map();

let temporarySearchMarker = null;
let temporarySearchCircle = null;
let lastSearchTime = 0;
const geocodeCache = new Map();
const manualMetroLines = new Map();

// =========================
// 5) ICÔNES
// =========================
function createPOIIcon(category, symbolClass) {
  return L.divIcon({
    className: "",
    html: `<div class="poi-icon poi-${category}"><i class="${symbolClass}"></i></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -12]
  });
}

const METRO_LOGO_URL = "https://upload.wikimedia.org/wikipedia/commons/2/22/MetroMadridLogoSimplified.svg?utm_source=commons.wikimedia.org&utm_campaign=index&utm_content=original";

function createMetroStationIcon(stationName, showLabel = false) {
  const labelHtml = showLabel
    ? `<div class="metro-station-label">${escapeHtml(stationName)}</div>`
    : "";

  return L.divIcon({
    className: "",
    html: `
      <div class="metro-station-icon">
        <img class="metro-station-logo" src="${METRO_LOGO_URL}" alt="Metro Madrid">
        ${labelHtml}
      </div>
    `,
    iconSize: [22, 22],          // ✅ TOUJOURS FIXE
    iconAnchor: [11, 11],        // ✅ CENTRÉ SUR LE LOGO
    popupAnchor: [0, -12]
  });
}

const categoryIconMap = {
  places: () => createPOIEmojiIcon("places", "🌟"),
  monuments: () => createPOIEmojiIcon("monuments", "🏰"),
  musees: () => createPOIEmojiIcon("musees", "🏛️"),
  parcs: () => createPOIEmojiIcon("parcs", "🌳"),
  activites: () => createPOIEmojiIcon("activites", "🎯"),
  shopping: () => createPOIEmojiIcon("shopping", "🛍️")
};
function createPOIEmojiIcon(category, emoji) {
  return L.divIcon({
    className: "",
    html: `<div class="poi-icon poi-${category} poi-emoji-icon">${emoji}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -12]
  });
}
// =========================
// 6) OUTILS
// =========================
function getFeatureTitle(feature) {
  return feature?.properties?.title ||
         feature?.properties?.name ||
         "Sans titre";
}

function getFeatureDescription(feature) {
  return feature?.properties?.description || "";
}

function getLatLngFromFeature(feature) {
  const type = feature?.geometry?.type;
  const coords = feature?.geometry?.coordinates;

  if (!type || !coords) return null;

  if (type === "Point") {
    return L.latLng(coords[1], coords[0]);
  }

  if (type === "LineString") {
    const mid = coords[Math.floor(coords.length / 2)];
    return L.latLng(mid[1], mid[0]);
  }

  if (type === "MultiLineString") {
    const firstLine = coords[0];
    if (!firstLine || !firstLine.length) return null;
    const mid = firstLine[Math.floor(firstLine.length / 2)];
    return L.latLng(mid[1], mid[0]);
  }

  if (type === "Polygon") {
    const ring = coords[0];
    if (!ring || !ring.length) return null;
    const mid = ring[Math.floor(ring.length / 2)];
    return L.latLng(mid[1], mid[0]);
  }

  if (type === "MultiPolygon") {
    const ring = coords[0]?.[0];
    if (!ring || !ring.length) return null;
    const mid = ring[Math.floor(ring.length / 2)];
    return L.latLng(mid[1], mid[0]);
  }

  return null;
}

function haversineDistanceMeters(latlng1, latlng2) {
  return latlng1.distanceTo(latlng2);
}

function getEstimatedWalkingDistance(distanceMeters) {
  return Math.round(distanceMeters * DISTANCE_CORRECTION_FACTOR);
}

function getEstimatedWalkingMinutes(distanceMeters) {
  const corrected = getEstimatedWalkingDistance(distanceMeters);
  return Math.max(1, Math.round(corrected / WALKING_SPEED_M_PER_MIN));
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseStationLines(feature) {
  const props = feature.properties || {};
  const raw = (props.lines || props.description || "").toUpperCase();

  if (!raw) return [];

  const matches = raw.match(/L\d+|R/g);
  return matches ? [...new Set(matches)] : [];
}

function getLineColor(lineCode) {
  const colors = {
    L1:  "#79c7df",
    L2:  "#ef3340",
    L3:  "#ffd100",
    L4:  "#d17c00",
    L5:  "#a4c614",
    L6:  "#bdb7ad",
    L7:  "#f0a202",
    L8:  "#e7a6c9",
    L9:  "#a639a7",
    L10: "#0057b8",
    L11: "#009b3a",
    L12: "#b5a100",
    R:   "#000000"
  };

  return colors[lineCode] || "#333333";
}

function getCategoryColor(category) {
  const colors = {
    places: "#cc6600",
    monuments: "#6a1b9a",
    musees: "#0066cc",
    parcs: "#2e7d32",
    activites: "#795548",
    shopping: "#616161"
  };
  return colors[category] || "#333333";
}

function canSearchNow() {
  const now = Date.now();
  if (now - lastSearchTime < 1000) return false;
  lastSearchTime = now;
  return true;
}

function clearTemporarySearchGraphics() {
  if (temporarySearchMarker) {
    map.removeLayer(temporarySearchMarker);
    temporarySearchMarker = null;
  }
  if (temporarySearchCircle) {
    map.removeLayer(temporarySearchCircle);
    temporarySearchCircle = null;
  }
}

function clearMetroLines() {
  visibleMetroLines.forEach(layer => map.removeLayer(layer));
  visibleMetroLines.clear();

  manualMetroLines.forEach(layer => map.removeLayer(layer));
  manualMetroLines.clear();

  document.querySelectorAll('input[data-metro-line]').forEach(input => {
    input.checked = false;
  });
}

// =========================
// 7) POPUPS
// =========================
function buildPopup(feature, category) {
  const props = feature?.properties || {};

  const title = escapeHtml(props.title || props.name || "Sans titre");
  const desc = escapeHtml(props.description || "");
  const image = props.image || "";
  const imageCredit = props.imageCredit || "";
  const link = props.link || "";
  const linkLabel = escapeHtml(props.linkLabel || "En savoir plus");

  const imageHtml = image
    ? `<div style="margin:10px 0;">
         <img 
           src="${image}" 
           alt="${title}" 
           style="width:100%; max-width:260px; border-radius:10px; display:block; margin:auto;"
         >
       </div>`
    : "";

  const creditHtml = imageCredit
    ? `<div style="margin-top:4px; font-size:11px; color:#666; line-height:1.3; text-align:center;">
         ${imageCredit}
       </div>`
    : "";

  const descHtml = desc
    ? `<div style="margin-top:8px; line-height:1.4; text-align:center;">
         ${desc}
       </div>`
    : "";

  const linkHtml = link
    ? `<div style="margin-top:10px;">
         <a href="${link}" target="_blank" rel="noopener noreferrer"
            style="
              display:inline-block;
              padding:7px 12px;
              background:#b85c2e;
              color:white;
              text-decoration:none;
              border-radius:8px;
              font-size:13px;
            ">
           ${linkLabel}
         </a>
       </div>`
    : "";

  return `
    <div style="min-width:220px; max-width:280px; text-align:center;">
      <div style="font-weight:700; font-size:15px;">
        ${title}
      </div>

      ${imageHtml}
      ${creditHtml}
      ${descHtml}
      ${linkHtml}
    </div>
  `;
}

window.zoomToFeature = function(lat, lng) {
  map.flyTo([lat, lng], 16);
};

// =========================
// 8) CHARGEMENT DES COUCHES
// =========================
async function loadGeoJSON(url) {
  const finalUrl = `${url}?v=${Date.now()}`;
  console.log("Chargement :", finalUrl);

  const response = await fetch(finalUrl, { cache: "no-store" });
  console.log("Status :", finalUrl, response.status);

  if (!response.ok) {
    throw new Error(`Erreur chargement : ${finalUrl} (${response.status})`);
  }

  const text = await response.text();

  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    console.error("JSON invalide :", finalUrl);
    console.error(text.slice(-500));
    throw e;
  }
}

async function initializeData() {
  const entries = Object.entries(DATA_URLS);

  const results = await Promise.allSettled(
    entries.map(([key, url]) => loadGeoJSON(url))
  );

  let loadedCount = 0;
  let failed = [];

  results.forEach((result, index) => {
    const key = entries[index][0];

    if (result.status === "fulfilled") {
      rawData[key] = result.value;
      loadedCount++;
    } else {
      console.error(`Échec chargement ${key}:`, result.reason);
      failed.push(key);
    }
  });

  console.log(`Couches chargées : ${loadedCount}/${entries.length}`);

  if (!loadedCount) {
    setResultsHtml("<p>Impossible de charger les données de la carte.</p>");
    return;
  }

  createCategoryLayers();
  createStationsLayer();
  setupLayerControls();
  updateStationStyleByZoom();

  if (layers.stations && layers.stations.getBounds && layers.stations.getBounds().isValid()) {
    map.fitBounds(layers.stations.getBounds(), { padding: [30, 30] });
  }

  if (failed.length) {
    console.warn("Certaines couches n'ont pas pu être chargées :", failed.join(", "));
    setResultsHtml(
      `<p>Carte chargée partiellement. Couches indisponibles : ${failed.join(", ")}</p>`
    );
  }
}

function createCategoryLayers() {
  ["places", "monuments", "musees", "parcs", "activites", "shopping"].forEach(category => {
    if (!rawData[category]) return;

    layers[category] = L.geoJSON(rawData[category], {
      pointToLayer: (feature, latlng) => {
        return L.marker(latlng, {
          icon: categoryIconMap[category]()
        });
      },

      style: (feature) => {
        const color = getCategoryColor(category);
        const type = feature?.geometry?.type;

        if (type === "LineString" || type === "MultiLineString") {
          return {
            color: color,
            weight: 4,
            opacity: 0.9
          };
        }

        if (type === "Polygon" || type === "MultiPolygon") {
          return {
            color: color,
            weight: 2,
            opacity: 0.9,
            fillColor: color,
            fillOpacity: 0.15
          };
        }

        return {
          color: color,
          weight: 2
        };
      },

      onEachFeature: (feature, layer) => {
        layer.bindPopup(buildPopup(feature, category));
      }
    });

if (document.querySelector(`input[data-layer="${category}"]`)?.checked) {
  layers[category].addTo(map);
}

    console.log(`Couche ${category} créée :`, layers[category]);
  });
}

function createStationsLayer() {
  if (!rawData.stations) return;

  layers.stations = L.geoJSON(rawData.stations, {
    pointToLayer: (feature, latlng) => {
      const marker = L.marker(latlng, {
       icon: createMetroStationIcon(getFeatureTitle(feature), false)
      });

      const stationTitle = getFeatureTitle(feature);
      const lineCodes = parseStationLines(feature);
      const linesText = lineCodes.length ? lineCodes.join(", ") : "—";

      marker.bindPopup(`
        <div>
          <strong>${escapeHtml(stationTitle)}</strong>
          <br>Lignes : ${escapeHtml(linesText)}
        </div>
      `);

      marker.on("click", () => {
        
        showMetroLines(lineCodes);
        marker.openPopup();
      });
      return marker;
    }
 }).addTo(map);

  console.log("Stations layer créée :", layers.stations);
}

function updateStationStyleByZoom() {
  if (!layers.stations) return;

  const zoom = map.getZoom();

  layers.stations.eachLayer(layer => {
    if (!layer.feature || !layer.setIcon) return;

    const stationName = getFeatureTitle(layer.feature);

    if (zoom < 15) {
      layer.setIcon(createMetroPointIcon());
    } else {
      const showLabel = zoom >= 16;
      layer.setIcon(createMetroStationIcon(stationName, showLabel));
    }
  });
}

map.on("zoomend", () => {
  if (layers.stations) {
    updateStationStyleByZoom();
  }
});

// =========================
// 9) AFFICHAGE DES LIGNES METRO

function showMetroLines(lineCodes) {
  if (!rawData.lignes || !rawData.lignes.features) return;

  lineCodes.forEach(lineCode => {
    if (visibleMetroLines.has(lineCode)) return;

   const matchedFeatures = rawData.lignes.features.filter(feature =>
  featureMatchesLine(feature, lineCode)
);

    if (!matchedFeatures.length) {
      console.warn("Aucune ligne trouvée pour :", lineCode);
      return;
    }

    const layer = L.geoJSON(
      {
        type: "FeatureCollection",
        features: matchedFeatures
      },
      {
        style: () => ({
          color: getLineColor(lineCode),
          weight: 5,
          opacity: 0.95
        })
      }
    ).addTo(map);

    visibleMetroLines.set(lineCode, layer);
  });
}

// =========================
// 11) CALCULS DE PROXIMITE
// =========================
function getAllPOIFeatures() {
  return [
    ...(rawData.places?.features || []).map(f => ({ ...f, __category: "places" })),
    ...(rawData.monuments?.features || []).map(f => ({ ...f, __category: "monuments" })),
    ...(rawData.musees?.features || []).map(f => ({ ...f, __category: "musees" })),
    ...(rawData.parcs?.features || []).map(f => ({ ...f, __category: "parcs" })),
    ...(rawData.activites?.features || []).map(f => ({ ...f, __category: "activites" })),
    ...(rawData.shopping?.features || []).map(f => ({ ...f, __category: "shopping" }))
  ];
}

function findNearestStation(targetLatLng) {
  let nearest = null;
  let minDistance = Infinity;

  (rawData.stations?.features || []).forEach(feature => {
    const stationLatLng = getLatLngFromFeature(feature);
    if (!stationLatLng) return;

    const distance = haversineDistanceMeters(targetLatLng, stationLatLng);

    if (distance < minDistance) {
      minDistance = distance;
      nearest = { feature, distance };
    }
  });

  return nearest;
}

function findNearbyPOIs(targetLatLng, radiusMeters = SEARCH_RADIUS_METERS) {
  const pois = getAllPOIFeatures();

  return pois
    .map(feature => {
      const latlng = getLatLngFromFeature(feature);
      if (!latlng) return null;

      const distance = haversineDistanceMeters(targetLatLng, latlng);
      return { feature, distance };
    })
    .filter(item => item && item.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance);
}

function renderSearchResults(title, targetLatLng) {
  const nearestStation = findNearestStation(targetLatLng);
  const nearbyPOIs = findNearbyPOIs(targetLatLng);

  let stationHtml = `<p>Aucune station trouvée.</p>`;

  if (nearestStation) {
    const stationTitle = getFeatureTitle(nearestStation.feature);
    const distance = getEstimatedWalkingDistance(nearestStation.distance);
    const minutes = getEstimatedWalkingMinutes(nearestStation.distance);

    stationHtml = `
      <div class="result-block">
        <h3>Station de métro la plus proche</h3>
        <p><strong>${escapeHtml(stationTitle)}</strong></p>
        <p>${distance} m — ${minutes} min à pied</p>
      </div>
    `;
  }

  let poiHtml = `
    <div class="result-block">
      <h3>Lieux d’intérêt à moins de ${SEARCH_RADIUS_METERS} m</h3>
      <p>Aucun lieu trouvé dans ce rayon.</p>
    </div>
  `;

  if (nearbyPOIs.length) {
    const items = nearbyPOIs.map(item => {
      const poiTitle = getFeatureTitle(item.feature);
      const distance = getEstimatedWalkingDistance(item.distance);
      const minutes = getEstimatedWalkingMinutes(item.distance);
      return `<li>${escapeHtml(poiTitle)} — ${distance} m — ${minutes} min</li>`;
    }).join("");

    poiHtml = `
      <div class="result-block">
        <h3>Lieux d’intérêt à moins de ${SEARCH_RADIUS_METERS} m</h3>
        <ul class="poi-list">${items}</ul>
      </div>
    `;
  }

  setResultsHtml(`
    <div class="result-block">
      <h3>Lieu recherché</h3>
      <p><strong>${escapeHtml(title)}</strong></p>
    </div>
    ${stationHtml}
    ${poiHtml}
  `);
}

// =========================
// 12) RECHERCHE NOMINATIM
// =========================
async function geocodeWithNominatim(query) {
  const key = query.trim().toLowerCase();

  if (geocodeCache.has(key)) {
    return geocodeCache.get(key);
  }

  const finalQuery = `${query}, Madrid, Spain`;

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "es");
  url.searchParams.set("q", finalQuery);
  url.searchParams.set("accept-language", "fr");
  url.searchParams.set("addressdetails", "1");

  console.log("URL Nominatim :", url.toString());

  const response = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json"
    }
  });

  console.log("Status Nominatim :", response.status);

  if (!response.ok) {
    throw new Error(`Erreur Nominatim (${response.status})`);
  }

  const data = await response.json();
  geocodeCache.set(key, data);
  return data;
}
function chooseBestResult(results) {
  if (!results.length) return null;

  const madridResult = results.find(r =>
    (r.display_name || "").toLowerCase().includes("madrid")
  );

  return madridResult || results[0];
}
function setResultsHtml(html) {
  const el = document.getElementById("resultsContent");
  if (el) {
    el.innerHTML = html;
  } else {
    console.warn("resultsContent introuvable");
  }
}

async function runSearch() {
  console.log("runSearch déclenchée");

  const input = document.getElementById("searchInput");
  if (!input) {
    console.error("Champ #searchInput introuvable");
    return;
  }

  const query = input.value.trim();
  console.log("Recherche :", query);

  if (!query) {
    setResultsHtml("<p>Veuillez entrer le nom ou l’adresse de votre hébergement.</p>");
    return;
  }

  if (!canSearchNow()) {
    setResultsHtml("<p>Merci d’attendre une seconde avant une nouvelle recherche.</p>");
    return;
  }

  setResultsHtml("<p>Recherche en cours…</p>");

  try {
    const results = await geocodeWithNominatim(query);
    console.log("Résultats Nominatim :", results);

    if (!results || !results.length) {
      setResultsHtml("<p>Aucun résultat trouvé. Essayez avec le nom complet de l’hôtel ou une adresse plus précise.</p>");
      return;
    }

    const best = chooseBestResult(results);
    const lat = parseFloat(best.lat);
    const lon = parseFloat(best.lon);
    const latlng = L.latLng(lat, lon);

    clearTemporarySearchGraphics();

    temporarySearchMarker = L.marker(latlng).addTo(map);
    temporarySearchCircle = L.circle(latlng, {
      radius: SEARCH_RADIUS_METERS,
      color: "#b85c2e",
      weight: 2,
      fillColor: "#b85c2e",
      fillOpacity: 0.08
    }).addTo(map);

    map.flyTo(latlng, 15);

    const title = best.display_name || query;
    temporarySearchMarker.bindPopup(`<strong>${escapeHtml(title)}</strong>`).openPopup();

    renderSearchResults(title, latlng);

  } catch (error) {
    console.error("Erreur runSearch :", error);
    setResultsHtml("<p>Erreur lors de la recherche. Réessayez dans quelques secondes.</p>");
  }
}
// =========================
// 13) GEOLOCALISATION
// =========================
map.on("locationfound", (e) => {
  clearTemporarySearchGraphics();

  temporarySearchMarker = L.marker(e.latlng).addTo(map);
  temporarySearchCircle = L.circle(e.latlng, {
    radius: SEARCH_RADIUS_METERS,
    color: "#1565c0",
    weight: 2,
    fillColor: "#1565c0",
    fillOpacity: 0.08
  }).addTo(map);

  renderSearchResults("Ma position actuelle", e.latlng);
});

map.on("locationerror", () => {
  setResultsHtml("<p>Impossible d’accéder à votre position.</p>");
});

// =========================
// 14) BOUTONS ET TOGGLES
// =========================
function setupLayerControls() {
  document.querySelectorAll("input[data-layer]").forEach(input => {
    input.addEventListener("change", (e) => {
      const layerName = e.target.dataset.layer;
      const checked = e.target.checked;

      if (!layers[layerName]) return;

      if (checked) {
        map.addLayer(layers[layerName]);
      } else {
        map.removeLayer(layers[layerName]);
      }
    });
  });

  document.querySelectorAll("input[data-metro-line]").forEach(input => {
    input.addEventListener("change", (e) => {
      const lineCode = e.target.dataset.metroLine;
      const checked = e.target.checked;

      if (checked) {
        showManualMetroLine(lineCode);
      } else {
        hideManualMetroLine(lineCode);
      }
    });
  });
  
  const showAllBtn = document.getElementById("showAllBtn");
  const hideAllBtn = document.getElementById("hideAllBtn");
  const clearLinesBtn = document.getElementById("clearLinesBtn");
  const resetMapBtn = document.getElementById("resetMapBtn");
  const searchBtn = document.getElementById("searchBtn");
  const searchInput = document.getElementById("searchInput");

  if (showAllBtn) {
    showAllBtn.addEventListener("click", () => {
      document.querySelectorAll("input[data-layer]").forEach(input => {
        input.checked = true;
        const layerName = input.dataset.layer;
        if (layers[layerName]) map.addLayer(layers[layerName]);
      });
    });
  }

  if (hideAllBtn) {
    hideAllBtn.addEventListener("click", () => {
      document.querySelectorAll("input[data-layer]").forEach(input => {
        input.checked = false;
        const layerName = input.dataset.layer;
        if (layers[layerName]) map.removeLayer(layers[layerName]);
      });
    });
  }

  if (clearLinesBtn) {
    clearLinesBtn.addEventListener("click", () => {
      clearMetroLines();
    });
  }

  if (resetMapBtn) {
    resetMapBtn.addEventListener("click", () => {
      clearMetroLines();
      clearTemporarySearchGraphics();
      map.flyTo(MADRID_CENTER, INITIAL_ZOOM);
      setResultsHtml("<p>Recherchez un hébergement ou utilisez la géolocalisation.</p>");
    });
  }

  if (searchBtn) {
    searchBtn.addEventListener("click", runSearch);
  }

  if (searchInput) {
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runSearch();
    });
  }
}

// =========================
// 15) LANCEMENT
// =========================
initializeData();

function updateResultsForStation(stationFeature, stationTitle, lineCodes) {
  const lines = lineCodes.length ? lineCodes.join(", ") : "—";

  document.getElementById("resultsContent").innerHTML = `
    <div class="result-block">
      <h3>Station sélectionnée</h3>
      <p><strong>${stationTitle}</strong></p>
      <p>Lignes : ${lines}</p>
    </div>
  `;
}

function showManualMetroLine(lineCode) {
  if (!rawData.lignes || !rawData.lignes.features) return;
  if (manualMetroLines.has(lineCode)) return;

 const matchedFeatures = rawData.lignes.features.filter(feature =>
  featureMatchesLine(feature, lineCode)
);
  if (!matchedFeatures.length) {
    console.warn("Aucune ligne trouvée pour :", lineCode);
    return;
  }

  const layer = L.geoJSON(
    {
      type: "FeatureCollection",
      features: matchedFeatures
    },
    {
      style: () => ({
        color: getLineColor(lineCode),
        weight: 5,
        opacity: 0.95
      })
    }
  ).addTo(map);

  manualMetroLines.set(lineCode, layer);
}

function hideManualMetroLine(lineCode) {
  if (!manualMetroLines.has(lineCode)) return;
  map.removeLayer(manualMetroLines.get(lineCode));
  manualMetroLines.delete(lineCode);
}

function featureMatchesLine(feature, lineCode) {
  const props = feature.properties || {};

  const title = (props.title || "").toString().toUpperCase().trim();
  const name = (props.name || "").toString().toUpperCase().trim();
  const code = (props.lineCode || "").toString().toUpperCase().trim();
  const desc = (props.description || "").toString().toUpperCase().trim();

  if (code === lineCode) return true;

  if (lineCode === "R") {
    return (
      code === "R" ||
      title === "LIGNE R" ||
      title === "LÍNEA R" ||
      title === "R" ||
      name === "LIGNE R" ||
      name === "LÍNEA R" ||
      name === "R"
    );
  }

  const lineNumber = lineCode.replace("L", "");

  return (
    title === `LIGNE ${lineNumber}` ||
    title === `LÍNEA ${lineNumber}` ||
    name === `LIGNE ${lineNumber}` ||
    name === `LÍNEA ${lineNumber}` ||
    title === lineCode ||
    name === lineCode ||
    code === lineCode ||
    desc.includes(lineCode)
  );
}

function setupMobileSidebar() {
  const sidebar = document.getElementById("sidebar");
  const handle = document.getElementById("mobileMenuHandle");
  const overlay = document.getElementById("mobileOverlay");

  if (!sidebar || !handle || !overlay) return;

  let startX = 0;
  let currentX = 0;
  let touching = false;

  function isMobile() {
    return window.innerWidth <= 900;
  }

  function openMenu() {
    if (!isMobile()) return;
    sidebar.classList.add("mobile-open");
    overlay.classList.add("active");
  }

  function closeMenu() {
    if (!isMobile()) return;
    sidebar.classList.remove("mobile-open");
    overlay.classList.remove("active");
    sidebar.style.transform = "";
  }

  handle.addEventListener("click", () => {
    if (sidebar.classList.contains("mobile-open")) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  overlay.addEventListener("click", closeMenu);

  document.addEventListener("touchstart", (e) => {
    if (!isMobile()) return;

    const touch = e.touches[0];
    startX = touch.clientX;
    currentX = touch.clientX;

    const menuOpen = sidebar.classList.contains("mobile-open");
    const nearLeftEdge = startX < 24;
    const touchedInsideSidebar = !!e.target.closest("#sidebar");

    if ((!menuOpen && nearLeftEdge) || (menuOpen && touchedInsideSidebar)) {
      touching = true;
    } else {
      touching = false;
    }
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!isMobile() || !touching) return;

    const touch = e.touches[0];
    currentX = touch.clientX;

    const menuOpen = sidebar.classList.contains("mobile-open");
    const deltaX = currentX - startX;
    const sidebarWidth = sidebar.offsetWidth;

    if (!menuOpen) {
      const translate = Math.min(0, -sidebarWidth + Math.max(0, deltaX));
      sidebar.style.transform = `translateX(${translate}px)`;
    } else {
      const translate = Math.min(0, deltaX);
      sidebar.style.transform = `translateX(${translate}px)`;
    }
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!isMobile() || !touching) return;

    const menuOpen = sidebar.classList.contains("mobile-open");
    const deltaX = currentX - startX;

    sidebar.style.transform = "";

    if (!menuOpen && deltaX > 70) {
      openMenu();
    } else if (menuOpen && deltaX < -70) {
      closeMenu();
    } else {
      if (menuOpen) {
        openMenu();
      } else {
        closeMenu();
      }
    }

    touching = false;
  });

  window.addEventListener("resize", () => {
    if (!isMobile()) {
      sidebar.classList.remove("mobile-open");
      overlay.classList.remove("active");
      sidebar.style.transform = "";
    }
  });
}

setupMobileSidebar();

const fullscreenMapBtn = document.getElementById("fullscreenMapBtn");
const app = document.getElementById("app");

if (fullscreenMapBtn && app) {
  fullscreenMapBtn.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) {
        await app.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (error) {
      console.error("Erreur plein écran :", error);
    }
  });

  document.addEventListener("fullscreenchange", () => {
    fullscreenMapBtn.textContent = document.fullscreenElement ? "✕" : "⛶";

    setTimeout(() => {
      if (typeof map !== "undefined" && map.invalidateSize) {
        map.invalidateSize();
      }
    }, 200);
  });
}

function createMetroPointIcon() {
  return L.divIcon({
    className: "",
    html: `<div class="custom-metro-point"></div>`,
    iconSize: [8, 8],
    iconAnchor: [4, 4],
    popupAnchor: [0, -6]
  });
}
