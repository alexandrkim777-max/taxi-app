-- 010_rating_tags.sql — "what did you like?" tags on the end-of-ride rating screen.
-- Tag codes are defined in packages/shared/src/ratingTags.ts and validated by the API.

ALTER TABLE ratings ADD COLUMN tags text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(tags) <= 5);
-- A low score needs a reason: a written one or at least one tag.
ALTER TABLE ratings DROP CONSTRAINT ratings_reason_for_low;
ALTER TABLE ratings ADD CONSTRAINT ratings_reason_for_low
  CHECK (score >= 4 OR char_length(coalesce(reason, '')) >= 3 OR cardinality(tags) > 0);
CREATE INDEX ratings_tags_idx ON ratings USING gin (tags);
