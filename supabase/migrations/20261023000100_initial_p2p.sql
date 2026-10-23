-- Server-side tables only. Do not expose the p2p schema through the Supabase Data API.
-- Apply with a privileged migration connection before creating Render services.
-- All Render services must use the same private PostgreSQL connection string.
CREATE SCHEMA IF NOT EXISTS p2p;
REVOKE ALL ON SCHEMA p2p FROM PUBLIC;

CREATE TABLE p2p.ads (
  id text PRIMARY KEY,
  maker text NOT NULL,
  maker_address text,
  initials text NOT NULL,
  trades integer NOT NULL DEFAULT 0,
  completion double precision NOT NULL DEFAULT 0,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  asset text NOT NULL CHECK (asset IN ('ETH', 'WBTC')),
  price text NOT NULL,
  available_units numeric(78,0) NOT NULL,
  total_units numeric(78,0) NOT NULL,
  min text NOT NULL,
  max text NOT NULL,
  minutes integer NOT NULL CHECK (minutes > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'CLOSED', 'EXPIRED')),
  expires_at bigint,
  created_at bigint,
  created_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  CONSTRAINT ads_inventory_bounds CHECK (available_units >= 0 AND total_units >= 0 AND available_units <= total_units)
);

CREATE TABLE p2p.challenges (
  nonce_hash text PRIMARY KEY,
  address text NOT NULL,
  message text NOT NULL,
  expires_at bigint NOT NULL
);

CREATE TABLE p2p.sessions (
  token_hash text PRIMARY KEY,
  address text NOT NULL,
  expires_at bigint NOT NULL
);

CREATE TABLE p2p.orders (
  id text PRIMARY KEY,
  ad_id text NOT NULL REFERENCES p2p.ads(id),
  taker text NOT NULL,
  idempotency_key text NOT NULL,
  amount text NOT NULL,
  asset_amount numeric(78,0) NOT NULL CHECK (asset_amount > 0),
  fee text NOT NULL,
  price text NOT NULL,
  terms_hash text NOT NULL,
  terms_json text,
  ad_version integer NOT NULL,
  created_at bigint NOT NULL,
  response_due_at bigint,
  expires_at bigint NOT NULL,
  state text NOT NULL CHECK (state IN (
    'RESERVED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED',
    'CHAIN_SIGNING', 'OPEN_PENDING', 'OPEN', 'MAKER_FUNDED',
    'SETTLED', 'REFUNDED', 'SIGNATURE_EXPIRED'
  )),
  UNIQUE (taker, idempotency_key)
);
CREATE INDEX orders_expiry ON p2p.orders(state, expires_at);
CREATE INDEX orders_ad ON p2p.orders(ad_id);

CREATE TABLE p2p.chain_orders (
  order_id text PRIMARY KEY REFERENCES p2p.orders(id),
  onchain_id text NOT NULL UNIQUE,
  chain_id bigint NOT NULL,
  contract text NOT NULL,
  terms_json text NOT NULL,
  maker_signature text,
  taker_signature text,
  open_tx text,
  maker_tx text,
  taker_tx text,
  final_tx text,
  state text NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX chain_orders_chain_contract ON p2p.chain_orders(chain_id, lower(contract));

CREATE TABLE p2p.chain_events (
  chain_id bigint NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  event_name text NOT NULL,
  order_id text NOT NULL REFERENCES p2p.orders(id),
  data_json text NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX chain_events_order ON p2p.chain_events(order_id, block_number, log_index);

CREATE TABLE p2p.chain_blocks (
  chain_id bigint NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE p2p.chain_sync (
  chain_id bigint PRIMARY KEY,
  contract text NOT NULL,
  start_block bigint NOT NULL
);

CREATE TABLE p2p.order_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id text NOT NULL REFERENCES p2p.orders(id),
  state text NOT NULL,
  actor text NOT NULL,
  occurred_at bigint NOT NULL
);
CREATE INDEX order_events_order ON p2p.order_events(order_id, id);

CREATE TABLE p2p.order_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id text NOT NULL REFERENCES p2p.orders(id),
  sender text NOT NULL,
  client_id text NOT NULL,
  body text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (order_id, sender, client_id)
);
CREATE INDEX order_messages_order ON p2p.order_messages(order_id, id);

CREATE TABLE p2p.user_blocks (
  blocker text NOT NULL,
  blocked text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (blocker, blocked)
);

CREATE TABLE p2p.order_reports (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES p2p.orders(id),
  reporter text NOT NULL,
  reported text NOT NULL,
  reason text NOT NULL,
  details text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'DISMISSED')),
  created_at bigint NOT NULL,
  reviewed_at bigint,
  reviewed_by text,
  review_note text,
  UNIQUE (order_id, reporter)
);
CREATE INDEX order_reports_order ON p2p.order_reports(order_id);
CREATE INDEX order_reports_queue ON p2p.order_reports(status, created_at, id);

-- Defense in depth if the schema is ever added to an API exposure list.
-- The SIWE session and participant authorization remain in the server application.
ALTER TABLE p2p.ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE p2p.challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE p2p.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE p2p.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE p2p.chain_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE p2p.chain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE p2p.chain_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE p2p.chain_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE p2p.order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE p2p.order_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE p2p.user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE p2p.order_reports ENABLE ROW LEVEL SECURITY;
