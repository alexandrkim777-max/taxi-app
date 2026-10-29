// Our own map style (MapLibre style spec) for OpenMapTiles-schema vector tiles that we build from
// OpenStreetMap data ourselves (see docs/maps.md). Colours come from the design tokens, so the map
// matches the app in day and night themes. No third-party map service is involved.

export interface MapPalette {
  surfaceSunken: string; mapRoad: string; border: string; ink: string; inkMuted: string;
  brand: string; warm: string; success: string; surfaceCard: string; surfacePage: string;
}

/** tilesUrl: our tile server, e.g. https://maps.example.uz (serves /uzbekistan/{z}/{x}/{y}.pbf and /fonts). */
export function mapStyle(p: MapPalette, tilesUrl: string, dark: boolean): Record<string, unknown> {
  const font = ['Noto Sans Regular'];
  const fontBold = ['Noto Sans Medium'];
  const water = dark ? '#16303A' : '#BFD9DA';
  const park = dark ? '#18261E' : '#DCE7CF';
  const building = dark ? '#1F262F' : '#E4DACA';
  const minor = p.mapRoad;
  const major = dark ? '#2E3742' : '#FFFFFF';
  const casing = dark ? '#0E1116' : p.border;
  const road = (id: string, classes: string[], width: [number, number][], color: string, minzoom = 0, casingColor?: string) => [
    ...(casingColor ? [{
      id: `${id}-casing`, type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom,
      filter: ['in', ['get', 'class'], ['literal', classes]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': casingColor, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], ...width.flatMap(([z, w]) => [z, w + 1.5])] },
    }] : []),
    {
      id, type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom,
      filter: ['in', ['get', 'class'], ['literal', classes]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], ...width.flatMap(([z, w]) => [z, w])] },
    },
  ];

  return {
    version: 8,
    name: dark ? 'taxi-night' : 'taxi-day',
    glyphs: `${tilesUrl}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      omt: { type: 'vector', tiles: [`${tilesUrl}/uzbekistan/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14, attribution: '© OpenStreetMap contributors' },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': p.surfaceSunken } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': park } },
      { id: 'landcover-grass', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['grass', 'wood']]], paint: { 'fill-color': park, 'fill-opacity': 0.7 } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': water } },
      { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', paint: { 'line-color': water, 'line-width': 1.5 } },
      { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': building, 'fill-outline-color': casing } },
      ...road('road-minor', ['minor', 'service', 'track'], [[13, 1], [16, 6], [18, 16]], minor, 12),
      ...road('road-secondary', ['secondary', 'tertiary'], [[10, 1], [14, 4], [18, 22]], major, 9, casing),
      ...road('road-primary', ['primary', 'trunk'], [[8, 1], [14, 6], [18, 28]], major, 7, casing),
      ...road('road-motorway', ['motorway'], [[6, 1], [14, 8], [18, 32]], dark ? '#3A4452' : '#FFF6E6', 5, casing),
      { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': p.border, 'line-width': 1, 'line-dasharray': [3, 3] } },
      {
        id: 'housenumber', type: 'symbol', source: 'omt', 'source-layer': 'housenumber', minzoom: 17,
        layout: { 'text-field': ['get', 'housenumber'], 'text-font': font, 'text-size': 11 },
        paint: { 'text-color': p.inkMuted },
      },
      {
        id: 'road-label', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 13,
        layout: { 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name:uz'], ['get', 'name']], 'text-font': font, 'text-size': 12 },
        paint: { 'text-color': p.ink, 'text-halo-color': p.surfaceSunken, 'text-halo-width': 1.5 },
      },
      {
        id: 'poi', type: 'symbol', source: 'omt', 'source-layer': 'poi', minzoom: 15, filter: ['<=', ['get', 'rank'], 20],
        layout: { 'text-field': ['coalesce', ['get', 'name:uz'], ['get', 'name']], 'text-font': font, 'text-size': 11, 'text-max-width': 8 },
        paint: { 'text-color': p.inkMuted, 'text-halo-color': p.surfaceSunken, 'text-halo-width': 1.5 },
      },
      {
        id: 'place', type: 'symbol', source: 'omt', 'source-layer': 'place', filter: ['in', ['get', 'class'], ['literal', ['city', 'suburb', 'quarter', 'neighbourhood']]],
        layout: { 'text-field': ['coalesce', ['get', 'name:uz'], ['get', 'name']], 'text-font': fontBold, 'text-size': ['match', ['get', 'class'], 'city', 16, 13] },
        paint: { 'text-color': p.ink, 'text-halo-color': p.surfacePage, 'text-halo-width': 2 },
      },
    ],
  };
}
