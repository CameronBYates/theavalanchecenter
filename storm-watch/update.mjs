// Storm watch updater. Run by .github/workflows/storm-watch.yml on a schedule.
// Reads storm-watch/points.json, asks Open-Meteo for snowfall at every point (the last 72 hours
// and the next 72), the US National Weather Service for active winter alerts at US points, and
// USDA SNOTEL stations for measured snow depth near US points, then writes data/storms.json for
// index.html to read. Only flagged centers are written, plus recent snowfall for every center.
// Usage: node storm-watch/update.mjs [output path]   (no output path: print only)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const HEAVY_CM = 30;   // 72-hour forecast total that counts as a big storm
const NOTABLE_CM = 15; // smaller but still worth a mention
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]); // WMO weather codes for falling snow
const NWS_EVENTS = new Set([
  'Blizzard Warning', 'Winter Storm Warning', 'Winter Storm Watch',
  'Lake Effect Snow Warning', 'Ice Storm Warning'
]);
const UA = 'theavalanchecenter.com storm watch (https://theavalanchecenter.com)';
const SNOTEL_KM = 30; // SNOTEL stations this close to a center's point count for that center
const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1';

const REGIONS = { US: 'North America', CA: 'North America', JP: 'Japan', NZ: 'New Zealand' }; // everything else is Europe
const region = country => REGIONS[country] || 'Europe';
const round1 = n => Math.round(n * 10) / 10;

const out = process.argv[2];
const { centers } = JSON.parse(await readFile(new URL('./points.json', import.meta.url)));
const points = centers.flatMap(c => c.points.map(([lat, lon, place, elev]) => ({ center: c, lat, lon, place, elev })));
// Well-known ski areas, reported on their own for recent snowfall. Asked for together with the points.
const resorts = centers.flatMap(c => (c.resorts || []).map(([lat, lon, place, elev, radius = 8]) => ({ center: c, lat, lon, place, elev, radius, resort: true })));
const allPoints = [...points, ...resorts];

async function getJSON(url, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
    if (res.ok) return res.json();
    if (attempt >= 3) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    await new Promise(r => setTimeout(r, 5000 * attempt));
  }
}

let binsStart = null; // GMT start of the first 6-hour bin
// Open-Meteo takes many coordinates in one call; send them in chunks to keep URLs short.
async function snowfall() {
  const results = [];
  for (let i = 0; i < allPoints.length; i += 50) {
    const chunk = allPoints.slice(i, i + 50);
    const qs = new URLSearchParams({
      latitude: chunk.map(p => p.lat).join(','),
      longitude: chunk.map(p => p.lon).join(','),
      elevation: chunk.map(p => p.elev).join(','), // forecast for alpine terrain, not the valley floor
      current: 'weather_code,snowfall',
      hourly: 'snowfall',
      past_hours: '72',
      forecast_hours: '72',
      timezone: 'GMT'
    });
    const data = await getJSON(`https://api.open-meteo.com/v1/forecast?${qs}`);
    results.push(...(Array.isArray(data) ? data : [data]));
  }
  // The hourly series runs from 72 hours ago to 72 hours ahead; split it at the current hour.
  const times = results[0]?.hourly?.time || [];
  const nowHour = (results[0]?.current?.time || '').slice(0, 13) + ':00';
  const split = times.indexOf(nowHour) >= 0 ? times.indexOf(nowHour) : 72;
  binsStart = times[split] ? times[split] + 'Z' : null;
  return allPoints.map((p, i) => {
    const r = results[i];
    const all = r.hourly.snowfall.map(v => v || 0);
    const past = all.slice(0, split).reduce((a, b) => a + b, 0);
    const hourly = all.slice(split, split + 72);
    const total = hourly.reduce((a, b) => a + b, 0);
    // Twelve 6-hour bins show when the snow arrives; the page draws them as a small bar chart.
    const bins = Array.from({ length: 12 }, (_, b) => round1(hourly.slice(b * 6, b * 6 + 6).reduce((a, v) => a + v, 0)));
    const snowing = SNOW_CODES.has(r.current.weather_code) || r.current.snowfall > 0;
    return { ...p, total, past, bins, snowing };
  });
}

async function nwsAlerts(p) {
  const data = await getJSON(`https://api.weather.gov/alerts/active?point=${p.lat},${p.lon}`, { Accept: 'application/geo+json' });
  return data.features
    .map(f => f.properties)
    .filter(a => NWS_EVENTS.has(a.event))
    .map(a => ({ event: a.event, ends: a.ends || a.expires || null }));
}

const km = (a, b, c, d) => {
  const r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r;
  return Math.hypot(x, y) * 6371;
};

// SNOTEL: automated USDA snow stations in the western US and Alaska, reporting snow depth every hour.
// New snow is the biggest rise in depth over the last 72 hours, measured from the lowest point before it,
// after smoothing out sensor jitter. Settling makes this a little conservative, but it is a measurement.
// Each spot is matched to the stations within its own radius (km).
async function snotel(usPoints) {
  const stations = await getJSON(`${AWDB}/stations?stationTriplets=*:*:SNTL&activeOnly=true&returnStationElements=false&returnForecastPointMetadata=false&returnReservoirMetadata=false`);
  const near = new Map(); // station triplet -> station, for stations close to any US point
  const byPoint = new Map();
  for (const p of usPoints) {
    const mine = stations
      .map(s => ({ s, d: km(p.lat, p.lon, s.latitude, s.longitude) }))
      .filter(x => x.d <= (p.radius || SNOTEL_KM))
      .sort((a, b) => a.d - b.d);
    byPoint.set(p, mine.map(x => x.s.stationTriplet));
    for (const { s } of mine) near.set(s.stationTriplet, s);
  }
  const fmt = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  // SNOTEL dates are in each station's local standard time, so ask for a wider window and keep the last 72 readings.
  const end = Date.now() + 3600 * 1000, begin = end - 90 * 3600 * 1000;
  const depth = new Map(); // triplet -> new snow in cm
  const triplets = [...near.keys()];
  for (let i = 0; i < triplets.length; i += 40) {
    const qs = new URLSearchParams({
      stationTriplets: triplets.slice(i, i + 40).join(','),
      elements: 'SNWD', duration: 'HOURLY', beginDate: fmt(begin), endDate: fmt(end)
    });
    const data = await getJSON(`${AWDB}/data?${qs}`);
    for (const st of data) {
      const vals = (st.data?.[0]?.values || []).map(v => v.value).filter(v => typeof v === 'number' && v >= 0 && v < 1000).slice(-72);
      if (vals.length < 24) continue; // too patchy to trust
      // Median of each 5-hour window irons out the depth sensor's inch-or-two jitter.
      const smooth = vals.map((_, k) => { const w = vals.slice(Math.max(0, k - 2), k + 3).sort((a, b) => a - b); return w[w.length >> 1]; });
      let low = Infinity, rise = 0;
      for (const v of smooth) { low = Math.min(low, v); rise = Math.max(rise, v - low); }
      depth.set(st.stationTriplet, rise * 2.54);
    }
  }
  const result = new Map(); // point -> deepest station { cm, station }
  for (const [p, list] of byPoint) {
    const best = list.filter(t => depth.has(t)).map(t => ({ cm: depth.get(t), station: near.get(t).name }))
      .reduce((a, b) => (!a || b.cm > a.cm ? b : a), null);
    if (best) result.set(p, best);
  }
  console.log(`SNOTEL: ${stations.length} stations, ${near.size} near our points, ${depth.size} with usable depth data`);
  return result;
}

const everywhere = await snowfall();
const snow = everywhere.filter(s => !s.resort); // the center's own points; ski areas are kept apart
const resortSnow = everywhere.filter(s => s.resort);
const usPoints = points.filter(p => p.center.country === 'US');
const alerts = new Map();
for (const p of usPoints) {
  try {
    alerts.set(`${p.lat},${p.lon}`, await nwsAlerts(p));
  } catch (err) {
    console.warn(`NWS alerts failed for ${p.place}: ${err.message}`);
  }
  await new Promise(r => setTimeout(r, 300));
}

let measured = new Map();
try {
  measured = await snotel(everywhere.filter(s => s.center.country === 'US'));
} catch (err) {
  console.warn(`SNOTEL failed, using model estimates only: ${err.message}`);
}

// Recent snowfall for every center: measured by SNOTEL where a US center has stations close by,
// otherwise Open-Meteo's estimate of what fell in the last 72 hours.
const recent = {};
const deepestOf = list => list.reduce((a, b) => (b.cm > a.cm ? b : a));
const roundRecent = cm => Math.round(cm / 2.5) * 2.5; // coarse rounding keeps the file from changing every run
for (const c of centers) {
  const mine = everywhere.filter(s => s.center === c);
  const gauged = mine.filter(s => measured.has(s));
  const best = gauged.length
    ? deepestOf(gauged.map(s => ({ cm: measured.get(s).cm, place: measured.get(s).station, source: 'snotel' })))
    : deepestOf(mine.map(s => ({ cm: s.past, place: s.place, source: 'model' })));
  // Each ski area on its own: measured at its nearest SNOTEL stations when it has any, otherwise estimated.
  const areas = resortSnow.filter(s => s.center === c).map(s => measured.has(s)
    ? { name: s.place, cm: roundRecent(measured.get(s).cm), station: measured.get(s).station, source: 'snotel' }
    : { name: s.place, cm: roundRecent(s.past), source: 'model' })
    .sort((a, b) => b.cm - a.cm); // kept even at zero, so a storm card can show that a ski area has had none yet
  const cm = roundRecent(best.cm);
  if (cm >= 2.5 || areas.length) recent[c.href] = { name: c.name, units: c.units, region: region(c.country), cm, place: best.place, source: best.source, resorts: areas };
}

const flagged = {};
for (const c of centers) {
  const mine = snow.filter(s => s.center === c);
  const top = mine.reduce((a, b) => (b.total > a.total ? b : a));
  const snowingAt = mine.filter(s => s.snowing).map(s => s.place);
  const centerAlerts = [];
  for (const p of mine) {
    for (const a of alerts.get(`${p.lat},${p.lon}`) || []) {
      if (!centerAlerts.some(x => x.event === a.event)) {
        centerAlerts.push({ ...a, place: p.place, link: `https://forecast.weather.gov/MapClick.php?lat=${p.lat}&lon=${p.lon}` });
      }
    }
  }
  const cm = Math.round(top.total / 5) * 5; // coarse rounding keeps the file from changing every run
  const level = top.total >= HEAVY_CM ? 'heavy' : top.total >= NOTABLE_CM ? 'notable' : null;
  if (!level && !snowingAt.length && !centerAlerts.length) continue;
  flagged[c.href] = {
    name: c.name,
    units: c.units,
    region: region(c.country),
    level,
    snow72cm: level ? cm : null,
    place: level ? top.place : null,
    bins: level ? top.bins : null,
    snowingAt,
    alerts: centerAlerts,
    recentCm: recent[c.href]?.cm ?? null
  };
}

const result = {
  updated: new Date().toISOString(),
  thresholds: { heavyCm: HEAVY_CM, notableCm: NOTABLE_CM, hours: 72 },
  binsStart,
  sources: [
    { name: 'Open-Meteo', url: 'https://open-meteo.com/', license: 'CC BY 4.0' },
    { name: 'NOAA National Weather Service', url: 'https://www.weather.gov/' },
    { name: 'USDA NRCS SNOTEL', url: 'https://www.nrcs.usda.gov/wps/portal/wcc/home/' }
  ],
  centers: flagged,
  // Snow that fell in the last 72 hours, for every center with some, deepest first.
  recent: Object.fromEntries(Object.entries(recent).sort((a, b) => b[1].cm - a[1].cm)),
  // The five deepest 72-hour forecasts anywhere, flagged or not, so the panel has something to show between storms.
  deepest: [...snow].sort((a, b) => b.total - a.total)
    .filter((s, i, all) => all.findIndex(t => t.center === s.center) === i)
    .slice(0, 5)
    .map(s => ({ href: s.center.href, name: s.center.name, place: s.place, region: region(s.center.country), units: s.center.units, cm: Math.round(s.total) }))
};

console.log(`${points.length} points, ${Object.keys(flagged).length} centers flagged`);
for (const s of [...snow].sort((a, b) => b.total - a.total).filter(s => s.total >= 2)) {
  console.log(`  ${s.total.toFixed(1).padStart(6)} cm  ${s.snowing ? 'snowing' : '       '}  ${s.place} (${s.center.name})`);
}
for (const [, r] of Object.entries(result.recent)) {
  console.log(`  RECENT ${r.cm.toString().padStart(5)} cm  ${r.source.padEnd(6)}  ${r.place} (${r.name})`);
  for (const a of r.resorts) console.log(`         ${a.cm.toString().padStart(5)} cm  ${a.source.padEnd(6)}  ${a.name}${a.station ? ' at ' + a.station : ''}`);
}
for (const [href, f] of Object.entries(flagged)) console.log(`  FLAG ${f.name}: ${JSON.stringify({ level: f.level, cm: f.snow72cm, snowingAt: f.snowingAt, alerts: f.alerts.map(a => a.event) })}`);

if (out) {
  let previous = null;
  try { previous = JSON.parse(await readFile(out, 'utf8')); } catch {}
  const same = previous && JSON.stringify({ ...previous, updated: 0 }) === JSON.stringify({ ...result, updated: 0 });
  // Rewrite at least daily even when nothing changed, so the page can tell fresh data from a stalled job.
  const fresh = previous && Date.now() - Date.parse(previous.updated) < 20 * 3600 * 1000;
  if (same && fresh) {
    console.log('No change since last run; leaving the file alone.');
  } else {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(result, null, 1) + '\n');
    console.log(`Wrote ${out}`);
  }
}
