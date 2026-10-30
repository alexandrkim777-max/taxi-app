-- 019_route_line.sql — the road route of a ride (from routing, simplified), so the apps draw the
-- real way along the streets instead of straight lines between stops. Updated with route changes.
ALTER TABLE rides ADD COLUMN route_line geometry(LineString, 4326);
