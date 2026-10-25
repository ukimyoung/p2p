-- Email-verified Supabase Auth users. The application accesses this private schema directly.
CREATE TABLE p2p.member_profiles (
  user_id uuid PRIMARY KEY,
  email text NOT NULL,
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email_verified_at bigint NOT NULL,
  created_at bigint NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint
);
CREATE UNIQUE INDEX member_profiles_email_lower ON p2p.member_profiles (lower(email));
ALTER TABLE p2p.member_profiles ENABLE ROW LEVEL SECURITY;
