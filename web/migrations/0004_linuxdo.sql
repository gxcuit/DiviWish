-- Preserve existing account IDs, sessions and portfolios without rebuilding users.
ALTER TABLE users ADD COLUMN linuxdo_id TEXT;
ALTER TABLE users ADD COLUMN linuxdo_username TEXT;
CREATE UNIQUE INDEX users_linuxdo_id ON users(linuxdo_id) WHERE linuxdo_id IS NOT NULL;
CREATE TABLE auth_oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_oauth_states_expiry ON auth_oauth_states(expires_at);
