// Generated from packages/shared/design/tokens.json by scripts/tokens-to-ts.mjs. Do not edit.
export const colors = {
  "light": {
    "surfacePage": "#F7F2EA",
    "surfaceCard": "#FFFFFF",
    "surfaceSunken": "#EDE6DA",
    "border": "#D8CDBB",
    "ink": "#1B2A3A",
    "inkMuted": "#5E6B78",
    "brand": "#0B6A70",
    "onBrand": "#FFFFFF",
    "link": "#0B6A70",
    "warm": "#B5532E",
    "warmTint": "#FBE7DE",
    "warmInk": "#8E3B1C",
    "success": "#1E7F4E",
    "danger": "#B42318",
    "mapRoad": "#FFFFFF",
    "route": "#0B6A70"
  },
  "dark": {
    "surfacePage": "#0E1116",
    "surfaceCard": "#1B222B",
    "surfaceSunken": "#161B22",
    "border": "#2C333D",
    "ink": "#F2F4F7",
    "inkMuted": "#A3ACB9",
    "brand": "#C6F432",
    "onBrand": "#0E1116",
    "link": "#C6F432",
    "warm": "#E07A52",
    "warmTint": "#3A2621",
    "warmInk": "#F2A98A",
    "success": "#4CD08A",
    "danger": "#FF6B5E",
    "mapRoad": "#232A33",
    "route": "#C6F432"
  }
} as const;
export const space = {"s1":4,"s2":8,"s3":12,"s4":16,"s5":20,"s6":24} as const;
export const radius = {"sm":12,"md":16,"lg":20,"xl":32,"pill":28} as const;
export const size = {"touchMin":44,"buttonMain":56} as const;
export const type = {
  "display": {
    "fontSize": 36,
    "lineHeight": 40,
    "fontWeight": "800"
  },
  "title": {
    "fontSize": 22,
    "lineHeight": 28,
    "fontWeight": "800"
  },
  "heading": {
    "fontSize": 17,
    "lineHeight": 24,
    "fontWeight": "700"
  },
  "body": {
    "fontSize": 15,
    "lineHeight": 22,
    "fontWeight": "400"
  },
  "bodyStrong": {
    "fontSize": 15,
    "lineHeight": 22,
    "fontWeight": "700"
  },
  "price": {
    "fontSize": 17,
    "lineHeight": 22,
    "fontWeight": "800"
  },
  "caption": {
    "fontSize": 12,
    "lineHeight": 16,
    "fontWeight": "400"
  },
  "label": {
    "fontSize": 11,
    "lineHeight": 14,
    "fontWeight": "600"
  }
} as const;
export type Palette = { [K in keyof typeof colors.light]: string };
