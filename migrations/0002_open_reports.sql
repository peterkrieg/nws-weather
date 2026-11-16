-- Open reporting: anyone can report. Each report carries an anonymous device id (random, made
-- in the browser) and a daily-rotating salted hash of the network address, both only for limits,
-- de-duplication and weighting. Reports with a valid reporter key are marked trusted.
ALTER TABLE reports ADD COLUMN device TEXT;
ALTER TABLE reports ADD COLUMN ip_hash TEXT;
ALTER TABLE reports ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0;
UPDATE reports SET trusted = 1 WHERE reporter IS NOT NULL;
CREATE INDEX reports_device ON reports (device, created_at);
CREATE INDEX reports_ip ON reports (ip_hash, created_at);
