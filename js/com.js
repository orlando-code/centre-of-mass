/** Time-weighted centre of mass; dates are YYYY-MM. */

/** @param {string} ym */
export function monthIndex(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return NaN;
  return y * 12 + (m - 1);
}

/** @param {number} index */
export function indexToMonth(index) {
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** @param {string} ym */
export function monthAfter(ym) {
  return indexToMonth(monthIndex(ym) + 1);
}

/** Inclusive months; requires end > start. */
export function durationMonths(place) {
  const a = monthIndex(place.start);
  const b = monthIndex(place.end);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return b - a + 1;
}

export function formatDuration(months) {
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;
  const years = Math.round((months / 12) * 10) / 10;
  return `${years} year${years === 1 ? "" : "s"}`;
}

function rangesOverlap(a, b) {
  const a0 = monthIndex(a.start);
  const a1 = monthIndex(a.end);
  const b0 = monthIndex(b.start);
  const b1 = monthIndex(b.end);
  if ([a0, a1, b0, b1].some(Number.isNaN)) return false;
  return a0 <= b1 && b0 <= a1;
}

/** @returns {string | null} error message */
export function validatePlaceDates(place, places, ignoreId) {
  const a = monthIndex(place.start);
  const b = monthIndex(place.end);
  if (Number.isNaN(a) || Number.isNaN(b)) return "Enter start and end as month–year.";
  if (b <= a) return "End must be later than start.";
  for (const other of places) {
    if (ignoreId && other.id === ignoreId) continue;
    if (rangesOverlap(place, other)) {
      return `Dates overlap with ${other.name} (${other.start}–${other.end}).`;
    }
  }
  return null;
}

function toUnit(latDeg, lngDeg) {
  const lat = (Number(latDeg) * Math.PI) / 180;
  const lng = (Number(lngDeg) * Math.PI) / 180;
  const cosLat = Math.cos(lat);
  return [cosLat * Math.cos(lng), cosLat * Math.sin(lng), Math.sin(lat)];
}

/** Great-circle angle (radians) between two unit vectors. */
function angleBetween(a, b) {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot);
}

/**
 * Destination point after travelling `distRad` along bearing `brngRad`
 * from (latDeg, lngDeg). Distances are central angles on the unit sphere.
 */
export function destinationPoint(latDeg, lngDeg, distRad, brngRad) {
  const lat1 = (latDeg * Math.PI) / 180;
  const lng1 = (lngDeg * Math.PI) / 180;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinD = Math.sin(distRad);
  const cosD = Math.cos(distRad);
  const lat2 = Math.asin(sinLat1 * cosD + cosLat1 * sinD * Math.cos(brngRad));
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brngRad) * sinD * cosLat1,
      cosD - sinLat1 * Math.sin(lat2)
    );
  return [(lat2 * 180) / Math.PI, (((lng2 * 180) / Math.PI + 540) % 360) - 180];
}

/** Closed ring of [lng, lat] around a point at angular radius `radiusRad`. */
export function angularCircle(latDeg, lngDeg, radiusRad, steps = 96) {
  if (!(radiusRad > 1e-8)) return [];
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const brng = (i / steps) * Math.PI * 2;
    const [lat, lng] = destinationPoint(latDeg, lngDeg, radiusRad, brng);
    coords.push([lng, lat]);
  }
  return coords;
}

export function formatSpread(rmsDeg) {
  if (!(rmsDeg > 0.05)) return "0°";
  if (rmsDeg < 1) return `${rmsDeg.toFixed(2)}°`;
  return `${rmsDeg.toFixed(1)}°`;
}

/**
 * Time-weighted spherical centre of mass, plus variance of angular
 * distance from that centre (0 when every weighted point coincides).
 */
export function computeCentreOfMass(places) {
  if (!places?.length) return null;

  let wx = 0;
  let wy = 0;
  let wz = 0;
  let wsum = 0;
  /** @type {{ w: number, u: number[] }[]} */
  const weighted = [];

  for (const p of places) {
    const w = durationMonths(p);
    if (w <= 0) continue;
    const u = toUnit(p.lat, p.lng);
    weighted.push({ w, u });
    wx += w * u[0];
    wy += w * u[1];
    wz += w * u[2];
    wsum += w;
  }

  if (wsum <= 0) return null;

  wx /= wsum;
  wy /= wsum;
  wz /= wsum;
  const norm = Math.hypot(wx, wy, wz) || 1;
  const com = [wx / norm, wy / norm, wz / norm];

  let varianceRad2 = 0;
  for (const { w, u } of weighted) {
    const theta = angleBetween(u, com);
    varianceRad2 += w * theta * theta;
  }
  varianceRad2 /= wsum;
  const rmsRad = Math.sqrt(varianceRad2);
  const rmsDeg = (rmsRad * 180) / Math.PI;

  return {
    lat: (Math.asin(com[2]) * 180) / Math.PI,
    lng: (Math.atan2(com[1], com[0]) * 180) / Math.PI,
    totalMonths: wsum,
    /** Time-weighted mean of squared angular distance (rad²). */
    varianceRad2,
    /** RMS angular distance from CoM (degrees) — 0 if all points coincide. */
    rmsSpreadDeg: rmsDeg,
    rmsSpreadRad: rmsRad,
  };
}
