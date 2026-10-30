# Our own maps

Like Uklon and WB Taxi, we do not pay Google / Yandex per map view or route. Everything runs on our
servers from OpenStreetMap data, with our own look and our own entrance data.

| Piece | What | Tool (open source) |
| --- | --- | --- |
| Map data | OpenStreetMap extract for Uzbekistan, refreshed weekly | Geofabrik `uzbekistan-latest.osm.pbf` |
| Vector tiles | Built once from the extract into one file | Planetiler → `uzbekistan.pmtiles` (OpenMapTiles schema) |
| Tile server | Serves tiles and fonts to the apps | Martin (or any static server for `.pmtiles`) |
| Map look | Our style, generated from the design tokens, day and night | `packages/shared/src/mapStyle.ts` |
| Map in the apps | Native vector map renderer | MapLibre Native (`@maplibre/maplibre-react-native`) |
| Routing, ETA, km | Car routes and times for prices and dispatch | OSRM (`ROUTE_PROVIDER=osrm`) |
| Address search | Search and "what is here" | Nominatim (`GEO_PROVIDER=nominatim`) |
| Entrances (подъезды) | Our own database, separate from OSM | `entrances` table; grows from real pickups |

## Build (on the map server)

```bash
# 1. Data
curl -O https://download.geofabrik.de/asia/uzbekistan-latest.osm.pbf

# 2. Vector tiles (Java 21), ~5 minutes for Uzbekistan
java -Xmx4g -jar planetiler.jar --osm-path=uzbekistan-latest.osm.pbf --output=uzbekistan.pmtiles

# 3. Serve tiles + fonts
martin --listen-addresses 0.0.0.0:3001 uzbekistan.pmtiles   # plus a /fonts folder with Noto Sans Regular / Bold glyph PBFs

# 4. Routing
docker run -v $PWD:/data osrm/osrm-backend osrm-extract -p /opt/car.lua /data/uzbekistan-latest.osm.pbf
docker run -v $PWD:/data osrm/osrm-backend osrm-partition /data/uzbekistan-latest.osrm
docker run -v $PWD:/data osrm/osrm-backend osrm-customize /data/uzbekistan-latest.osrm
docker run -p 5000:5000 -v $PWD:/data osrm/osrm-backend osrm-routed --algorithm mld /data/uzbekistan-latest.osrm

# 5. Address search
docker run -e PBF_URL=https://download.geofabrik.de/asia/uzbekistan-latest.osm.pbf -p 8080:8080 mediagis/nominatim:4.4
```

API settings: `ROUTE_PROVIDER=osrm OSRM_URL=http://maps:5000 GEO_PROVIDER=nominatim NOMINATIM_URL=http://maps:8080`.
Apps: `EXPO_PUBLIC_TILES_URL=https://maps.<our-domain>`.

## Test builds before the map server is up

Set `EXPO_PUBLIC_TILEJSON_URL=https://tiles.openfreemap.org/planet` and
`EXPO_PUBLIC_GLYPHS_URL=https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf` (OpenFreeMap: free,
OpenStreetMap data in the same OpenMapTiles schema). Production uses `EXPO_PUBLIC_TILES_URL` (our server).

## Rules

- Every map shows "© OpenStreetMap contributors" (the OSM licence, ODbL).
- Our entrance database stays separate from OSM data, so it remains ours. If we ever add entrances
  back to OpenStreetMap, that is a deliberate decision, not a side effect.
- Data and tiles are hosted in Uzbekistan together with the rest of the system.
