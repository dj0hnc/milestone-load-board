'use strict';
/*
 * geo-dwell — turn a truck's Samsara GPS breadcrumbs into the REAL places it loaded/unloaded.
 * Shared by the desktop (main.js) and the mobile server (mab-mobile/server/samsara.js).
 *
 * Why: a NewMile order only carries the pickup/drop NAME (no address). Geocoding a name is a guess.
 * But the trucks assigned to that order physically DRIVE there — so where they DWELL (sit still for
 * a while) IS the real pickup and dropoff. This module clusters the slow/stopped breadcrumbs into
 * dwell stops, then (given the rough geocoded pickup/drop) labels which dwell is the pickup and which
 * is the dropoff. Pure functions, no I/O — easy to unit-test.
 */

function haversineMi(la1, lo1, la2, lo2) {
  const R = 3958.8, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Cluster one vehicle's breadcrumbs into dwell stops. A breadcrumb counts toward a dwell when its
// speed < maxMph. Greedy spatial clustering within radiusMi of a running centroid. Keeps clusters
// whose first→last span is >= minMin. Each crumb = {lat,lng,speed,time,addr}.
// Returns [{lat,lng,min,n,first,last,addr}] sorted by dwell minutes desc.
function dwellClusters(gps, opts) {
  opts = opts || {};
  const maxMph = opts.maxMph != null ? opts.maxMph : 3;
  const radiusMi = opts.radiusMi != null ? opts.radiusMi : 0.35;
  const minMin = opts.minMin != null ? opts.minMin : 12;
  const slow = (gps || [])
    .filter(g => g && g.lat != null && g.lng != null && g.speed != null && g.speed < maxMph && g.time)
    .sort((a, b) => new Date(a.time) - new Date(b.time));
  const cl = [];
  for (const g of slow) {
    let f = null, bd = radiusMi;
    for (const c of cl) { const d = haversineMi(c.lat, c.lng, g.lat, g.lng); if (d < bd) { bd = d; f = c; } }
    if (!f) { f = { lat: g.lat, lng: g.lng, n: 0, _sLat: 0, _sLng: 0, first: g.time, last: g.time, addr: g.addr || '' }; cl.push(f); }
    f.n++; f._sLat += g.lat; f._sLng += g.lng; f.lat = f._sLat / f.n; f.lng = f._sLng / f.n;
    if (new Date(g.time) < new Date(f.first)) f.first = g.time;
    if (new Date(g.time) > new Date(f.last)) f.last = g.time;
    if (g.addr) f.addr = g.addr;
  }
  cl.forEach(c => { c.min = Math.round((new Date(c.last) - new Date(c.first)) / 60000); delete c._sLat; delete c._sLng; });
  return cl.filter(c => c.min >= minMin).sort((a, b) => b.min - a.min);
}

// Merge dwell clusters from MANY trucks that fall on the same spot (within radiusMi) so a place all
// trucks visited becomes one strong cluster (summed minutes + visit count). Returns merged clusters.
function mergeClusters(clusters, radiusMi) {
  radiusMi = radiusMi != null ? radiusMi : 0.4;
  const out = [];
  for (const c of (clusters || []).slice().sort((a, b) => b.min - a.min)) {
    let f = null;
    for (const m of out) { if (haversineMi(m.lat, m.lng, c.lat, c.lng) < radiusMi) { f = m; break; } }
    if (!f) { out.push({ lat: c.lat, lng: c.lng, min: c.min, visits: 1, addr: c.addr || '' }); }
    else { f.min += c.min; f.visits++; if (!f.addr && c.addr) f.addr = c.addr; }
  }
  return out.sort((a, b) => b.visits - a.visits || b.min - a.min);
}

// Given merged dwell clusters + the rough geocoded pickup/drop, pick the dwell nearest each as the
// GPS-verified point. Drops obvious overnight PARKING (a very long dwell that isn't near either
// rough point — that's the yard, not a work site). Each returned stop carries distMi from the rough
// point + a confidence (close + multi-truck = high).
function assignStops(clusters, pickupApprox, dropApprox, opts) {
  opts = opts || {};
  const parkMin = opts.parkMin != null ? opts.parkMin : 300;   // >5h dwell = likely the yard
  const nearMi = opts.nearMi != null ? opts.nearMi : 3.0;       // "at" a rough point if within this
  let work = (clusters || []).filter(c => {
    if (c.min < parkMin) return true;
    const nearP = pickupApprox && haversineMi(c.lat, c.lng, pickupApprox.lat, pickupApprox.lng) < nearMi;
    const nearD = dropApprox && haversineMi(c.lat, c.lng, dropApprox.lat, dropApprox.lng) < nearMi;
    return nearP || nearD;   // keep a long dwell only if it sits at a work site
  });
  const maxMi = opts.maxMi != null ? opts.maxMi : 60;   // beyond this the rough point is junk (e.g. wrong-state geocode) → don't suggest, let the dispatcher pick
  function nearest(approx) {
    if (!approx || approx.lat == null) return null;
    let best = null, bd = 1e9;
    for (const c of work) { const d = haversineMi(c.lat, c.lng, approx.lat, approx.lng); if (d < bd) { bd = d; best = c; } }
    if (!best || bd > maxMi) return null;
    const distMi = Math.round(bd * 10) / 10;
    return { lat: best.lat, lng: best.lng, addr: best.addr || '', min: best.min, visits: best.visits || 1, distMi, conf: (distMi <= nearMi && (best.visits || 1) >= 1) ? 'high' : (distMi <= 6 ? 'med' : 'low') };
  }
  return { pickup: nearest(pickupApprox), drop: nearest(dropApprox) };
}

module.exports = { haversineMi, dwellClusters, mergeClusters, assignStops };
