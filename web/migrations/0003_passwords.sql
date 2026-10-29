-- Existing OTP-only users and sessions remain valid; users set a password after
-- proving control of their verified mailbox. No portfolio data is changed.
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE auth_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS auth_challenges_purpose ON auth_challenges(email, purpose, created_at);
