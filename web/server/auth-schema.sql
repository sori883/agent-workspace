CREATE TABLE users (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (issuer, subject)
);
CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  tokens text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE login_flows (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  payload text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX login_flows_expiry ON login_flows(expires_at);
