-- Public provider results only. User portfolios and manual values stay separate.
CREATE TABLE IF NOT EXISTS public_dividend_cache (
  security_key TEXT PRIMARY KEY,
  cache_day TEXT,
  snapshot TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0
);
