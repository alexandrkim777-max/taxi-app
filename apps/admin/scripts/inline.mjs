// Demo build -> one self-contained page (scripts and styles inlined), body content only,
// for publishing a clickable preview with sample data. Not used in production.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../dist-demo/', import.meta.url));
let html = readFileSync(dir + 'index.html', 'utf8');
const assets = readdirSync(dir + 'assets');
for (const f of assets) {
  const code = readFileSync(dir + 'assets/' + f, 'utf8');
  if (f.endsWith('.js')) {
    html = html.replace(new RegExp(`<script[^>]*src="\\./assets/${f.replace('.', '\\.')}"[^>]*></script>`),
      () => `<script type="module">${code.replace(/<\/script/g, '<\\/script')}</script>`);
  } else if (f.endsWith('.css')) {
    html = html.replace(new RegExp(`<link[^>]*href="\\./assets/${f.replace('.', '\\.')}"[^>]*>`), () => `<style>${code}</style>`);
  }
}
// The artifact host adds doctype, html, head and body itself.
const head = html.match(/<head>([\s\S]*)<\/head>/)[1].replace(/<meta charset[^>]*>|<meta name="viewport"[^>]*>/g, '');
const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
const out = `<meta name="claude:viewport-fit-sides" content="cover">\n${head.trim()}\n${body.trim()}\n`;
writeFileSync(dir + 'preview.html', out);
console.log('preview.html', Math.round(out.length / 1024), 'KB');
