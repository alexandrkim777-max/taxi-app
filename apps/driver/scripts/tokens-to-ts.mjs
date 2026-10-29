// Builds src/theme/tokens.ts from the design system's tokens.json (day and night themes).
// A designer changes tokens.json; the app picks it up on the next start. Never hand-edit the output.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const tokens = JSON.parse(readFileSync(here('../../../packages/shared/design/tokens.json'), 'utf8'));
const byName = Object.fromEntries(tokens.color.tokens.map((t) => [t.name, t.value]));
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const light = {};
const dark = {};
for (const t of tokens.color.tokens) {
  const v = typeof t.value === 'string' ? byName[t.value.replace(/[{}]/g, '')] : t.value;
  light[camel(t.name)] = v.light;
  dark[camel(t.name)] = v.dark;
}
const num = (v) => Number(String(v).replace('px', ''));
const space = Object.fromEntries(tokens.spacing.tokens.map((t) => [camel(t.name.replace('space-', 's')), num(t.value)]));
const radius = Object.fromEntries(tokens.radius.tokens.map((t) => [camel(t.name.replace('radius-', '')), num(t.value)]));
const size = Object.fromEntries(tokens.size.tokens.map((t) => [camel(t.name), num(t.value)]));
const type = Object.fromEntries(tokens.type.groups.flatMap((g) => g.styles.map((s) => [camel(s.name), { fontSize: num(s.fontSize), lineHeight: num(s.lineHeight), fontWeight: String(s.fontWeight) }])));

mkdirSync(here('../src/theme'), { recursive: true });
writeFileSync(here('../src/theme/tokens.ts'), `// Generated from packages/shared/design/tokens.json by scripts/tokens-to-ts.mjs. Do not edit.
export const colors = ${JSON.stringify({ light, dark }, null, 2)} as const;
export const space = ${JSON.stringify(space)} as const;
export const radius = ${JSON.stringify(radius)} as const;
export const size = ${JSON.stringify(size)} as const;
export const type = ${JSON.stringify(type, null, 2)} as const;
export type Palette = { [K in keyof typeof colors.light]: string };
`);
console.log('tokens.ts written');
