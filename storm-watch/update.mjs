// Storm watch updater. Run by .github/workflows/storm-watch.yml on a schedule.
// Reads storm-watch/points.json, asks Open-Meteo for snowfall at every point and the
// US National Weather Service for active winter alerts at US points, then writes
// data/storms.json for index.html to read. Only flagged centers are written.
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

const REGIONS = { US: 'North America', CA: 'North America', JP: 'Japan', NZ: 'New Zealand' }; // everything else is Europe
const region = country => REGIONS[country] || 'Europe';
const round1 = n => Math.round(n * 10) / 10;

const out = process.argv[2];
const { centers } = JSON.parse(await readFile(new URL('./points.json', import.meta.url)));
const points = centers.flatMap(c => c.points.map(([lat, lon, place, elev]) => ({ center: c, lat, lon, place, elev })));

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
  for (let i = 0; i < points.length; i += 50) {
    const chunk = points.slice(i, i + 50);
    const qs = new URLSearchParams({
      latitude: chunk.map(p => p.lat).join(','),
      longitude: chunk.map(p => p.lon).join(','),
      elevation: chunk.map(p => p.elev).join(','), // forecast for alpine terrain, not the valley floor
      current: 'weather_code,snowfall',
      hourly: 'snowfall',
      forecast_hours: '72',
      timezone: 'GMT'
    });
    const data = await getJSON(`https://api.open-meteo.com/v1/forecast?${qs}`);
    results.push(...(Array.isArray(data) ? data : [data]));
  }
  binsStart = results[0]?.hourly?.time?.[0] ? results[0].hourly.time[0] + 'Z' : null;
  return points.map((p, i) => {
    const r = results[i];
    const hourly = r.hourly.snowfall.map(v => v || 0);
    const total = hourly.reduce((a, b) => a + b, 0);
    // Twelve 6-hour bins show when the snow arrives; the page draws them as a small bar chart.
    const bins = Array.from({ length: 12 }, (_, b) => round1(hourly.slice(b * 6, b * 6 + 6).reduce((a, v) => a + v, 0)));
    const snowing = SNOW_CODES.has(r.current.weather_code) || r.current.snowfall > 0;
    return { ...p, total, bins, snowing };
  });
}

async function nwsAlerts(p) {
  const data = await getJSON(`https://api.weather.gov/alerts/active?point=${p.lat},${p.lon}`, { Accept: 'application/geo+json' });
  return data.features
    .map(f => f.properties)
    .filter(a => NWS_EVENTS.has(a.event))
    .map(a => ({ event: a.event, ends: a.ends || a.expires || null }));
}

const snow = await snowfall();
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
    alerts: centerAlerts
  };
}

const result = {
  updated: new Date().toISOString(),
  thresholds: { heavyCm: HEAVY_CM, notableCm: NOTABLE_CM, hours: 72 },
  binsStart,
  sources: [
    { name: 'Open-Meteo', url: 'https://open-meteo.com/', license: 'CC BY 4.0' },
    { name: 'NOAA National Weather Service', url: 'https://www.weather.gov/' }
  ],
  centers: flagged,
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
