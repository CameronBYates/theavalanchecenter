// Tell Bing (and other IndexNow search engines) which pages changed.
// Usage: node seo/indexnow.mjs [url ...]   (no args = every URL in sitemap.xml)
import { readFileSync, readdirSync } from 'node:fs';

const HOST = 'theavalanchecenter.com';
const key = readdirSync('.').find(f => /^[0-9a-f]{32}\.txt$/.test(f)).slice(0, -4);
let urls = process.argv.slice(2);
if (!urls.length) urls = [...readFileSync('sitemap.xml', 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList: urls }),
});
console.log(`IndexNow: ${res.status} for ${urls.length} URL(s)`);
// 200/202 = accepted. Anything else fails this step so it shows up red.
if (!res.ok) { console.log(await res.text()); process.exit(1); }
