// Storm watch updater. Run by .github/workflows/storm-watch.yml on a schedule.
// Reads storm-watch/points.json and, for every point, asks MET Norway's free worldwide
// forecast whether it is snowing now and roughly how much snow the next 72 hours bring.
// At US points it also uses the National Weather Service's own snowfall forecast (which
// replaces the estimate) and active winter alerts. Writes data/storms.json for index.html.
// Only flagged centers are written. Both sources allow commercial use with credit.
// Usage: node storm-watch/update.mjs [output path]   (no output path: print only)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const HEAVY_CM = 30;   // 72-hour forecast total that counts as a big storm
const NOTABLE_CM = 15; // smaller but still worth a mention
const HOURS = 72;
const NWS_EVENTS = new Set([
  'Blizzard Warning', 'Winter Storm Warning', 'Winter Storm Watch',
  'Lake Effect Snow Warning', 'Ice Storm Warning'
]);
// MET Norway and NWS both ask for a User-Agent that names the app and a way to reach its owner.
const UA = 'theavalanchecenter.com-stormwatch/1.0 https://github.com/CameronBYates/theavalanchecenter';

const out = process.argv[2];
const { centers } = JSON.parse(await readFile(new URL('./points.json', import.meta.url)));
const points = centers.flatMap(c => c.points.map(([lat, lon, place]) => ({ center: c, lat, lon, place })));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
    if (res.ok) return res.json();
    if (attempt >= 3 || res.status === 404) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    await sleep(5000 * attempt);
  }
}

// MET Norway gives precipitation (mm of water) with a weather symbol per step: hourly at
// first, then 6-hourly. Count precipitation as snow when the symbol says snow (half for
// sleet) and convert at the usual 10:1 ratio, so 1 mm of water is about 1 cm of snow.
function snowFraction(symbol = '') {
  if (symbol.includes('snow')) return 1;
  if (symbol.includes('sleet')) return 0.5;
  return 0;
}

async function metNorway(p) {
  const data = await getJSON(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}`);
  const series = data.properties.timeseries;
  const end = Date.now() + HOURS * 3600 * 1000;
  let cm = 0;
  for (let i = 0; i < series.length; i++) {
    const t = Date.parse(series[i].time);
    if (t >= end) break;
    const gap = i + 1 < series.length ? (Date.parse(series[i + 1].time) - t) / 3600000 : 6;
    const block = gap <= 1 ? series[i].data.next_1_hours : series[i].data.next_6_hours;
    if (!block) continue;
    cm += (block.details?.precipitation_amount || 0) * snowFraction(block.summary?.symbol_code);
  }
  const now = series[0]?.data.next_1_hours?.summary?.symbol_code || '';
  return { total: cm, snowing: now.includes('snow') };
}

// NWS forecast grids carry snowfallAmount in mm of snow for intervals like "...T18:00:00+00:00/PT6H".
async function nwsSnowfall(p) {
  const pt = await getJSON(`https://api.weather.gov/points/${p.lat},${p.lon}`, { Accept: 'application/geo+json' });
  const grid = await getJSON(pt.properties.forecastGridData, { Accept: 'application/geo+json' });
  const now = Date.now(), end = now + HOURS * 3600 * 1000;
  let mm = 0;
  for (const v of grid.properties.snowfallAmount?.values || []) {
    const [start, dur] = v.validTime.split('/');
    const s = Date.parse(start);
    const hours = Number((dur.match(/(\d+)H/) || [])[1] || 0) + 24 * Number((dur.match(/(\d+)D/) || [])[1] || 0);
    const e = s + hours * 3600 * 1000;
    if (e <= now || s >= end) continue;
    mm += v.value || 0;
  }
  return mm / 10;
}

async function snowfall() {
  const results = [];
  for (const p of points) {
    let r = { ...p, total: 0, snowing: false, source: null };
    try {
      Object.assign(r, await metNorway(p), { source: 'met' });
    } catch (err) {
      console.warn(`MET Norway failed for ${p.place}: ${err.message}`);
    }
    if (p.center.country === 'US') {
      try {
        r.total = await nwsSnowfall(p);
        r.source = 'nws';
      } catch (err) {
        console.warn(`NWS snowfall failed for ${p.place}: ${err.message}`);
      }
    }
    results.push(r);
    await sleep(250);
  }
  return results;
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
  await sleep(300);
}

const flagged = {};
for (const c of centers) {
  const mine = snow.filter(s => s.center === c);
  if (!mine.some(s => s.source)) continue; // no data at all for this center this run
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
    level,
    snow72cm: level ? cm : null,
    place: level ? top.place : null,
    snowingAt,
    alerts: centerAlerts
  };
}

const result = {
  updated: new Date().toISOString(),
  thresholds: { heavyCm: HEAVY_CM, notableCm: NOTABLE_CM, hours: 72 },
  sources: [
    { name: 'MET Norway', url: 'https://api.met.no/', license: 'CC BY 4.0' },
    { name: 'NOAA National Weather Service', url: 'https://www.weather.gov/' }
  ],
  centers: flagged
};

console.log(`${points.length} points, ${Object.keys(flagged).length} centers flagged`);
for (const s of [...snow].sort((a, b) => b.total - a.total).slice(0, 10)) {
  console.log(`  ${s.total.toFixed(1).padStart(6)} cm  ${s.source || 'none'}  ${s.snowing ? 'snowing' : '       '}  ${s.place} (${s.center.name})`);
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
