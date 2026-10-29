// Demo web export -> one self-contained page for a clickable preview (body content only; the
// preview host adds doctype/head/body). Shown at phone width, centred on wide screens.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../dist-demo/', import.meta.url));
const jsDir = dir + '_expo/static/js/web/';
const js = readdirSync(jsDir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(jsDir + f, 'utf8')).join('\n');
const tokens = JSON.parse(readFileSync(fileURLToPath(new URL('../../../packages/shared/design/tokens.json', import.meta.url)), 'utf8'));
const tok = (name, mode) => tokens.color.tokens.find((t) => t.name === name).value[mode];

const out = `<title>Taxi Driver</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
  :root { --page: ${tok('surface-page', 'light')}; --frame: ${tok('surface-sunken', 'light')}; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --page: ${tok('surface-page', 'dark')}; --frame: #05070a; color-scheme: dark; } }
  :root[data-theme="dark"] { --page: ${tok('surface-page', 'dark')}; --frame: #05070a; color-scheme: dark; }
  html, body { height: 100%; }
  body { overflow: hidden; background: var(--frame); }
  #root { display: flex; flex: 1; height: 100%; max-width: 440px; margin: 0 auto; background: var(--page); }
  @media (min-width: 600px) { #root { height: min(100%, 920px); margin-top: max(0px, calc((100% - 920px) / 2)); border-radius: 28px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.25); } }
</style>
<div id="root"></div>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>
`;
writeFileSync(dir + 'preview.html', out);
console.log('preview.html', Math.round(out.length / 1024), 'KB');
