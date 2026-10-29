// Builds the panel's CSS variables from the design system's tokens.json (both themes).
// A designer changes a value in tokens.json; this regenerates src/tokens.css. Never hand-edit it.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const tokens = JSON.parse(readFileSync(here('../../../packages/shared/design/tokens.json'), 'utf8'));

const light = [];
const dark = [];
const byName = Object.fromEntries(tokens.color.tokens.map((t) => [t.name, t.value]));
for (const t of tokens.color.tokens) {
  const v = typeof t.value === 'string' ? byName[t.value.replace(/[{}]/g, '')] : t.value;
  light.push(`  --${t.name}: ${v.light};`);
  dark.push(`  --${t.name}: ${v.dark};`);
}
const other = [];
for (const group of ['spacing', 'radius', 'size']) {
  for (const t of tokens[group].tokens) other.push(`  --${t.name}: ${t.value};`);
}
other.push(`  --font-sans: ${tokens.type.families.sans};`);

const css = `/* Generated from packages/shared/design/tokens.json by scripts/tokens-to-css.mjs. Do not edit. */
:root {
${light.join('\n')}
${other.join('\n')}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${dark.map((l) => '  ' + l).join('\n')}
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
${dark.join('\n')}
  color-scheme: dark;
}
`;
writeFileSync(here('../src/tokens.css'), css);
console.log('tokens.css written');
