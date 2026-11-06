-- Only automatically fetched public data is shared. Manual parameters stay in portfolios.
CREATE TABLE IF NOT EXISTS public_forecast_cache (
  cache_key TEXT PRIMARY KEY,
  snapshot TEXT,
  cache_day TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS public_forecast_documents (
  announcement_id TEXT PRIMARY KEY,
  pages TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
