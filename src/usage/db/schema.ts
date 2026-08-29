/**
 * The usage store's tables.
 *
 * Two grains live here on purpose. `event` is the per-occurrence decomposition —
 * roughly 2.5M rows over a full corpus — and answers anything sub-day,
 * per-turn, or sequential. The `day*` tables are a materialized rollup of those
 * same events, about 82k rows, and are what every report that exists today
 * reads: keeping them means a rollup never scans the event table, and means the
 * reports produce byte-identical output to the JSON shard cache they replaced,
 * because they are fed the same `DayBucket` shape from the same numbers.
 *
 * Writing both is cheap. Deriving the buckets from `event` at query time instead
 * would make every report pay for a grain it does not use, and deriving them at
 * import time from anything but the provider's own bucket would risk the two
 * disagreeing — see `tests/unit/usage-events.test.ts`, which is what pins them
 * together.
 */
export const SCHEMA_V1 = `
CREATE TABLE meta(
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE file(
  id                INTEGER PRIMARY KEY,
  provider          TEXT    NOT NULL,
  relative          TEXT    NOT NULL,
  path              TEXT    NOT NULL,
  size              INTEGER NOT NULL,
  mtime_ms          REAL    NOT NULL,
  session_id        TEXT    NOT NULL,
  kind              TEXT    NOT NULL,
  parent_session_id TEXT,
  agent_id          TEXT,
  agent_type        TEXT,
  agent_path        TEXT,
  spawn_depth       INTEGER,
  project           TEXT    NOT NULL,
  title             TEXT,
  git_branch        TEXT,
  tool_version      TEXT,
  first_ts          TEXT    NOT NULL,
  last_ts           TEXT    NOT NULL,
  malformed_lines   INTEGER NOT NULL DEFAULT 0,
  imported_at       TEXT    NOT NULL,
  UNIQUE(provider, relative)
);

CREATE TABLE event(
  id             INTEGER PRIMARY KEY,
  file_id        INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  ts             TEXT    NOT NULL,
  day            TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  model          TEXT,
  tool           TEXT,
  name           TEXT,
  status         TEXT,
  duration_ms    INTEGER,
  depth          INTEGER,
  input          INTEGER,
  output         INTEGER,
  cache_read     INTEGER,
  cache_write    INTEGER,
  cache_write_5m INTEGER,
  cache_write_1h INTEGER,
  thinking       INTEGER,
  web_search     INTEGER,
  web_fetch      INTEGER,
  requests       INTEGER
);

CREATE TABLE day(
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  day         TEXT    NOT NULL,
  prompts     INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0,
  compactions INTEGER NOT NULL DEFAULT 0,
  UNIQUE(file_id, day)
);

CREATE TABLE day_model(
  day_id         INTEGER NOT NULL REFERENCES day(id) ON DELETE CASCADE,
  model          TEXT    NOT NULL,
  input          INTEGER NOT NULL DEFAULT 0,
  output         INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  cache_write    INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  thinking       INTEGER NOT NULL DEFAULT 0,
  web_search     INTEGER NOT NULL DEFAULT 0,
  web_fetch      INTEGER NOT NULL DEFAULT 0,
  requests       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day_id, model)
);

CREATE TABLE day_tool(
  day_id INTEGER NOT NULL REFERENCES day(id) ON DELETE CASCADE,
  tool   TEXT    NOT NULL,
  calls  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day_id, tool)
);

CREATE TABLE day_skill(
  day_id INTEGER NOT NULL REFERENCES day(id) ON DELETE CASCADE,
  skill  TEXT    NOT NULL,
  calls  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day_id, skill)
);

CREATE TABLE day_command(
  day_id  INTEGER NOT NULL REFERENCES day(id) ON DELETE CASCADE,
  command TEXT    NOT NULL,
  calls   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day_id, command)
);

CREATE TABLE day_agent(
  day_id    INTEGER NOT NULL REFERENCES day(id) ON DELETE CASCADE,
  agent     TEXT    NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  max_depth INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day_id, agent)
);

CREATE TABLE day_hook(
  day_id    INTEGER NOT NULL REFERENCES day(id) ON DELETE CASCADE,
  hook      TEXT    NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  failures  INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  total_ms  INTEGER NOT NULL DEFAULT 0,
  max_ms    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day_id, hook)
);

CREATE INDEX file_provider_session ON file(provider, session_id);
CREATE INDEX file_project          ON file(project);
CREATE INDEX file_kind             ON file(provider, kind);
CREATE INDEX day_file              ON day(file_id);
CREATE INDEX day_day               ON day(day);
CREATE INDEX event_file_ts         ON event(file_id, ts);
CREATE INDEX event_day_kind        ON event(day, kind);
`;
