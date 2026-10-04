// Database schema, applied in order by migrate() in db.ts.
//
// Versions 1 and 2 were the two SQLite-era migrations; a database seeded from
// the SQLite export already records both, so version 2 is the Postgres baseline.
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 2,
    sql: `
CREATE TABLE properties (
  id text PRIMARY KEY,                 -- county PARCEL_ID, text keeps leading zeros
  address text NOT NULL,
  city text NOT NULL,
  zip text NOT NULL,
  category text NOT NULL,
  year double precision,               -- WGT_AVE_RI_YB, may be fractional
  sqft double precision,
  lng double precision,
  lat double precision,
  active boolean NOT NULL DEFAULT true,
  conflict boolean NOT NULL DEFAULT false,
  issues jsonb NOT NULL DEFAULT '[]',
  source_at timestamptz NOT NULL,
  -- Owner and assessment columns from the county parcel layer.
  owner text,
  mail_address text,
  mail_city text,
  mail_zip text,
  tax_year integer,
  tax_area integer,
  market_value double precision,
  taxable_value double precision,
  tax_rate double precision,
  net_assessment double precision,
  direct_charges double precision,
  penalty double precision,
  payments double precision,
  total_charge double precision,
  acres double precision,
  neighborhood text,
  subdivision text,
  quality double precision,
  condition double precision,
  account_type text
);
CREATE INDEX properties_city ON properties (city, active);
CREATE INDEX properties_position ON properties (lng, lat);
CREATE INDEX properties_owner ON properties (owner);

CREATE TABLE geometries (
  source_id integer PRIMARY KEY,       -- county OBJECTID
  property_id text NOT NULL REFERENCES properties (id),
  geojson jsonb
);
CREATE INDEX geometries_parcel ON geometries (property_id);

CREATE TABLE prospects (
  property_id text PRIMARY KEY REFERENCES properties (id),
  status text NOT NULL CHECK (status IN ('Not visited', 'No answer', 'Interested', 'Not interested', 'Do not contact')),
  updated_at timestamptz NOT NULL
);

CREATE TABLE visits (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties (id),
  occurred_at timestamptz NOT NULL,
  result text NOT NULL,
  notes text NOT NULL
);
CREATE INDEX visits_parcel ON visits (property_id, occurred_at);

CREATE TABLE follow_ups (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties (id),
  due_date date NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'completed', 'cancelled')),
  notes text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX follow_ups_parcel ON follow_ups (property_id, state, due_date);
CREATE INDEX follow_ups_due ON follow_ups (state, due_date);

CREATE TABLE imports (
  id text PRIMARY KEY,
  state text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  total integer NOT NULL DEFAULT 0,
  processed integer NOT NULL DEFAULT 0,
  parcels integer NOT NULL DEFAULT 0,
  issues integer NOT NULL DEFAULT 0,
  message text NOT NULL DEFAULT 'Connecting to Weber County…'
);

CREATE TABLE staging (
  run_id text NOT NULL REFERENCES imports (id),
  source_id integer NOT NULL,
  parcel_id text NOT NULL,
  attributes jsonb NOT NULL,
  geometry jsonb,
  lng double precision,
  lat double precision,
  issues jsonb NOT NULL,
  county jsonb,
  PRIMARY KEY (run_id, source_id)
);

CREATE TABLE metadata (
  key text PRIMARY KEY,
  value text NOT NULL
);

-- Weber County Parcel Search details (taxes + property characteristics).
CREATE TABLE county_details (
  property_id text PRIMARY KEY REFERENCES properties (id),
  state text NOT NULL CHECK (state IN ('ok', 'error')),
  fetched_at timestamptz NOT NULL,
  error text,
  data jsonb
);

CREATE TABLE details_runs (
  id text PRIMARY KEY,
  state text NOT NULL,
  mode text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  total integer NOT NULL DEFAULT 0,
  processed integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  message text NOT NULL DEFAULT 'Starting…'
);

INSERT INTO metadata VALUES ('revision', '0');
`,
  },
  {
    version: 3,
    sql: `
-- Photos taken by reps. The image lives in Cloudinary; this row links it to the property.
CREATE TABLE property_photos (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties (id),
  public_id text NOT NULL UNIQUE,
  url text NOT NULL,
  width integer,
  height integer,
  bytes integer,
  format text,
  created_at timestamptz NOT NULL
);
CREATE INDEX property_photos_parcel ON property_photos (property_id, created_at);
-- The server connects as the table owner, which row level security does not
-- restrict; enabling it keeps the table closed to Supabase's public API.
ALTER TABLE property_photos ENABLE ROW LEVEL SECURITY;
`,
  },
];
