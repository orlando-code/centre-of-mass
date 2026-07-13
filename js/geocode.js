/**
 * Forward/reverse geocoding with localStorage cache (no backend).
 * Forward: Open-Meteo · Reverse: BigDataCloud
 */

const CACHE_KEY = "com-geocode-cache-v1";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    const entries = Object.entries(cache).sort(
      (a, b) => (a[1].ts || 0) - (b[1].ts || 0)
    );
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify(Object.fromEntries(entries.slice(Math.floor(entries.length / 2))))
      );
    } catch {
      /* ignore */
    }
  }
}

function getCached(key) {
  const cache = loadCache();
  const hit = cache[key];
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    delete cache[key];
    saveCache(cache);
    return null;
  }
  return hit.data;
}

function setCached(key, data) {
  const cache = loadCache();
  cache[key] = { ts: Date.now(), data };
  saveCache(cache);
}

function roundCoord(n) {
  return Math.round(n * 10000) / 10000;
}

/** @returns {Promise<Array<{name: string, lat: number, lng: number, label: string}>>} */
export async function searchPlaces(query, { count = 5 } = {}) {
  const q = query.trim();
  if (!q) return [];

  const cacheKey = `fwd:${q.toLowerCase()}:${count}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", q);
  url.searchParams.set("count", String(count));
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocode failed (${res.status})`);
  const json = await res.json();
  const results = (json.results || []).map((r) => ({
    name: r.name,
    lat: r.latitude,
    lng: r.longitude,
    label: [r.name, r.admin1, r.country].filter(Boolean).join(", "),
  }));

  setCached(cacheKey, results);
  return results;
}

/** @returns {Promise<{name: string, label: string, lat: number, lng: number}>} */
export async function reverseGeocode(lat, lng) {
  const key = `rev:${roundCoord(lat)},${roundCoord(lng)}`;
  const cached = getCached(key);
  if (cached) return cached;

  const url = new URL(
    "https://api.bigdatacloud.net/data/reverse-geocode-client"
  );
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  url.searchParams.set("localityLanguage", "en");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Reverse geocode failed (${res.status})`);
  const json = await res.json();

  const name =
    json.city ||
    json.locality ||
    json.principalSubdivision ||
    json.countryName ||
    "Dropped pin";
  const label = [name, json.principalSubdivision, json.countryName]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");

  const data = { name, label, lat, lng };
  setCached(key, data);
  return data;
}
