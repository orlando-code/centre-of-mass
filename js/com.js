/** Time-weighted centre of mass; each place has amount + unit (days|months|years). */

export const DURATION_UNITS = ["days", "months", "years"];

const DAYS_PER_MONTH = 30.436875;
const DAYS_PER_YEAR = 365.2425;

/** @param {{ amount: number, unit: string }} place */
export function durationDays(place) {
  const amount = Number(place.amount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  switch (place.unit) {
    case "days":
      return amount;
    case "months":
      return amount * DAYS_PER_MONTH;
    case "years":
      return amount * DAYS_PER_YEAR;
    default:
      return 0;
  }
}

/** Fractional months — used for CoM weighting and summary copy. */
export function durationMonths(place) {
  return durationDays(place) / DAYS_PER_MONTH;
}

export function formatDuration(months) {
  if (!(months > 0)) return "0 months";
  if (months < 1) {
    const days = Math.round(months * DAYS_PER_MONTH);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (months < 12) {
    const rounded = Math.round(months * 10) / 10;
    return `${rounded} month${rounded === 1 ? "" : "s"}`;
  }
  const years = Math.round((months / 12) * 10) / 10;
  return `${years} year${years === 1 ? "" : "s"}`;
}

export function formatPlaceDuration(place) {
  const amount = Number(place.amount);
  const unit = place.unit;
  if (!Number.isFinite(amount) || amount <= 0 || !DURATION_UNITS.includes(unit)) {
    return "—";
  }
  const rounded = Number.isInteger(amount) ? amount : Math.round(amount * 10) / 10;
  const label =
    unit === "days"
      ? `day${rounded === 1 ? "" : "s"}`
      : unit === "months"
        ? `month${rounded === 1 ? "" : "s"}`
        : `year${rounded === 1 ? "" : "s"}`;
  return `${rounded} ${label}`;
}

/** @returns {string | null} error message */
export function validatePlaceDuration(place) {
  const amount = Number(place.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "Enter how long you spent there (a positive number).";
  }
  if (!DURATION_UNITS.includes(place.unit)) {
    return "Choose days, months, or years.";
  }
  return null;
}

/**
 * Migrate legacy start/end month entries (and already-duration entries) into
 * { amount, unit }.
 */
export function normalizePlace(raw) {
  if (!raw || typeof raw !== "object") return null;

  const base = {
    id: String(raw.id || ""),
    name: String(raw.name || "").trim(),
    lat: Number(raw.lat),
    lng: Number(raw.lng),
  };
  if (!base.id || !base.name || Number.isNaN(base.lat) || Number.isNaN(base.lng)) {
    return null;
  }

  if (raw.amount != null && raw.unit) {
    const amount = Number(raw.amount);
    const unit = String(raw.unit);
    if (!Number.isFinite(amount) || amount <= 0 || !DURATION_UNITS.includes(unit)) {
      return null;
    }
    return { ...base, amount, unit };
  }

  // Legacy YYYY-MM start/end → inclusive months
  if (raw.start && raw.end) {
    const a = monthIndex(raw.start);
    const b = monthIndex(raw.end);
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
    const months = b - a + 1;
    return { ...base, amount: months, unit: "months" };
  }

  return null;
}

/** @param {string} ym */
function monthIndex(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return NaN;
  return y * 12 + (m - 1);
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
