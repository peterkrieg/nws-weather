-- Trail condition reports. Each keeps the model's full inputs at that spot and time (terrain,
-- soil, tree cover, hourly weather), so the model can be re-run and scored after any change.
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,   -- unix seconds
  observed_at INTEGER NOT NULL,  -- when the trail was seen like this
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  state TEXT NOT NULL,           -- dry | tacky | damp | muddy | frozen | icy | packed_snow | soft_snow
  extent TEXT NOT NULL DEFAULT 'spot', -- spot | stretch | trail
  trail TEXT,
  source TEXT NOT NULL DEFAULT 'app',  -- app | relayed (e.g. a review someone read)
  weight REAL NOT NULL DEFAULT 1,
  reporter TEXT,
  model_state TEXT,              -- what the model said at the time
  inputs TEXT,                   -- JSON: model inputs for re-scoring
  note TEXT
);
CREATE INDEX reports_place ON reports (lat, lon);
CREATE INDEX reports_time ON reports (observed_at);
