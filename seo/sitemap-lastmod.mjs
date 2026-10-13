// Set each sitemap <lastmod> to the date its page last changed in git.
// The home page also counts storm data updates, since that's what it shows.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const lastChange = paths => execSync(`git log -1 --format=%cs -- ${paths}`).toString().trim();
const file = loc => {
  const p = new URL(loc).pathname.replace(/^\//, '');
  return p === '' ? 'index.html data/storms.json' : p + 'index.html';
};

let xml = readFileSync('sitemap.xml', 'utf8');
xml = xml.replace(/<loc>([^<]+)<\/loc>(\s*)<lastmod>[^<]*<\/lastmod>/g, (all, loc, ws) => {
  const d = lastChange(file(loc));
  return d ? `<loc>${loc}</loc>${ws}<lastmod>${d}</lastmod>` : all;
});
writeFileSync('sitemap.xml', xml);
