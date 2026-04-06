CREATE TABLE IF NOT EXISTS node_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  group_id TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  os TEXT DEFAULT '',
  arch TEXT DEFAULT '',
  version TEXT DEFAULT '',
  location TEXT DEFAULT '',
  public_note TEXT DEFAULT '',
  private_note TEXT DEFAULT '',
  hidden INTEGER DEFAULT 0,
  ddns_enabled INTEGER DEFAULT 1,
  public_ipv4 TEXT DEFAULT '',
  public_ipv6 TEXT DEFAULT '',
  private_ipv4 TEXT DEFAULT '',
  private_ipv6 TEXT DEFAULT '',
  -- 移除详细的指标字段，只保留基本信息
  last_seen INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (group_id) REFERENCES node_groups(id)
);

-- heartbeats表已移除，不再存储详细心跳数据
-- resource_samples表已移除，不再存储时序指标数据

CREATE TABLE IF NOT EXISTS ddns_records (
  hostname TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'A',
  content TEXT NOT NULL,
  proxied INTEGER NOT NULL DEFAULT 0,
  ttl INTEGER NOT NULL DEFAULT 60,
  zone_id TEXT DEFAULT '',
  zone_name TEXT DEFAULT '',
  comment TEXT DEFAULT '',
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  target_node_id TEXT DEFAULT '',
  interval_sec INTEGER NOT NULL DEFAULT 60,
  timeout_ms INTEGER NOT NULL DEFAULT 5000,
  expected_status INTEGER DEFAULT 200,
  keyword TEXT DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (target_node_id) REFERENCES nodes(id)
);

CREATE TABLE IF NOT EXISTS monitor_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER DEFAULT 0,
  detail TEXT DEFAULT '',
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id),
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE INDEX IF NOT EXISTS idx_monitor_results_lookup
  ON monitor_results(monitor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'command',
  command_text TEXT NOT NULL,
  target_node_id TEXT DEFAULT '',
  schedule_kind TEXT NOT NULL DEFAULT 'manual',
  interval_sec INTEGER DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  run_once INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER DEFAULT 0,
  last_run_at INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (target_node_id) REFERENCES nodes(id)
);

CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  output TEXT DEFAULT '',
  exit_code INTEGER DEFAULT 0,
  started_at INTEGER DEFAULT 0,
  finished_at INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE INDEX IF NOT EXISTS idx_task_runs_lookup
  ON task_runs(task_id, node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS alert_states (
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT DEFAULT '',
  last_sent_at INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  level TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  response_text TEXT DEFAULT '',
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (channel_id) REFERENCES notification_channels(id)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  permissions TEXT DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry
  ON sessions(user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  permissions TEXT DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT DEFAULT '',
  last_used_at INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at INTEGER DEFAULT (unixepoch())
);
