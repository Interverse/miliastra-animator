// Reports translation keys used in the UI that are missing from en.js, and
// keys missing from the other locales (they fall back to English).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const en = (await import('../js/i18n/locales/en.js')).default;
const used = new Set();
const walk = (dir) => { for (const f of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, f.name); if (f.isDirectory()) { if (!/locales|node_modules/.test(p)) walk(p); } else if (/\.(js|html)$/.test(f.name)) scan(readFileSync(p, 'utf8')); } };
const scan = (src) => {
  for (const m of src.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) used.add(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) used.add(m[1]);
};
walk(join(root, 'js')); scan(readFileSync(join(root, 'index.html'), 'utf8'));
const missing = [...used].filter((k) => !k.endsWith('.') && !(k in en));
console.log(`i18n: ${used.size} static keys used, ${Object.keys(en).length} keys in en.js`);
if (missing.length) { console.log('MISSING in en.js:\n  ' + missing.join('\n  ')); }
let bad = 0;
for (const f of readdirSync(join(root, 'js/i18n/locales'))) {
  if (f === 'en.js') continue;
  const d = (await import('../js/i18n/locales/' + f)).default;
  const miss = Object.keys(en).filter((k) => !(k in d));
  const extra = Object.keys(d).filter((k) => !(k in en));
  // placeholder consistency
  const badPh = Object.keys(d).filter((k) => en[k] && [...String(en[k]).matchAll(/\{(\w+)\}/g)].some((m) => !String(d[k]).includes('{' + m[1] + '}')));
  console.log(`  ${f}: ${Object.keys(d).length} keys${miss.length ? ', missing ' + miss.length : ''}${extra.length ? ', extra ' + extra.length : ''}${badPh.length ? ', placeholder mismatch: ' + badPh.join(',') : ''}`);
  if (miss.length) { console.log('    missing: ' + miss.slice(0, 20).join(', ') + (miss.length > 20 ? ' …' : '')); bad++; }
  if (badPh.length) bad++;
}
process.exit(missing.length || bad ? 1 : 0);
