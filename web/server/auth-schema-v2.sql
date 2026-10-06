ALTER TABLE users ADD COLUMN verified_email text;
ALTER TABLE users ADD CONSTRAINT users_verified_email_length CHECK (verified_email IS NULL OR (length(verified_email) BETWEEN 3 AND 254 AND verified_email = lower(verified_email)));
