-- A股智能投资决策系统 - 数据库Schema
-- 对应PRD §4.1 七张核心表

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. 股票基础信息池
CREATE TABLE IF NOT EXISTS stocks (
  code         TEXT PRIMARY KEY,         -- 代码如 '600519'
  name         TEXT NOT NULL,
  industry     TEXT,
  market       TEXT,                      -- 'SH' / 'SZ' / 'BJ'
  is_watch     INTEGER NOT NULL DEFAULT 0,-- 是否自选
  is_position  INTEGER NOT NULL DEFAULT 0,-- 是否持仓
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stocks_watch ON stocks(is_watch);
CREATE INDEX IF NOT EXISTS idx_stocks_position ON stocks(is_position);

-- 2. 持仓记录
CREATE TABLE IF NOT EXISTS positions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL,
  name         TEXT,
  buy_date     TEXT NOT NULL,            -- YYYY-MM-DD
  buy_price    REAL NOT NULL,
  quantity     INTEGER NOT NULL,
  buy_logic    TEXT,                     -- 买入逻辑文字
  stop_loss    REAL NOT NULL,            -- 止损位，默认 buy_price * 0.92
  target_price REAL,                     -- 目标价
  status       TEXT NOT NULL DEFAULT 'open',-- open/closed
  sell_date    TEXT,
  sell_price   REAL,
  sell_reason  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_positions_code ON positions(code);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

-- 3. 买卖信号历史
CREATE TABLE IF NOT EXISTS signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL,
  name         TEXT,
  signal_type  TEXT NOT NULL,            -- BUY_STRONG / BUY_WATCH / HOLD / AVOID / SELL
  price        REAL,
  canslim_score REAL,                     -- 0-100
  odds_ratio   REAL,                     -- 赔率比
  expected_score REAL,                   -- 期望值综合得分
  pivot_price  REAL,                     -- 枢轴点
  stop_loss    REAL,
  target_price REAL,
  reasons      TEXT,                     -- JSON 文本：{C,A,N,S,L,I,M,patterns,...}
  action       TEXT,                     -- 操作建议
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_code ON signals(code);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);

-- 4. 风控预警日志
CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT,
  alert_type   TEXT NOT NULL,            -- STOP_LOSS / POSITION_EXCEED / INDUSTRY_CONCENTRATION / HOLDINGS_COUNT / TARGET_HIT / TREND_BROKEN
  level        TEXT NOT NULL,            -- red/yellow/green
  trigger_value REAL,
  threshold    REAL,
  message      TEXT NOT NULL,
  handled      INTEGER NOT NULL DEFAULT 0,
  pushed_at    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_handled ON alerts(handled);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

-- 5. AI分析结果缓存（当日有效）
CREATE TABLE IF NOT EXISTS analysis_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key    TEXT NOT NULL UNIQUE,     -- 例如 stock:600519:2026-04-24
  kind         TEXT NOT NULL,            -- market / stock / report
  payload      TEXT NOT NULL,            -- JSON
  expires_at   TEXT NOT NULL,            -- 当日收盘时间
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON analysis_cache(expires_at);

-- 6. 回测结果
CREATE TABLE IF NOT EXISTS backtest_results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT,                     -- 回测命名
  params       TEXT NOT NULL,            -- JSON：区间、权重、股票池
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  win_rate     REAL,
  avg_profit_loss REAL,
  max_drawdown REAL,
  annual_return REAL,
  sharpe_ratio REAL,
  trades       TEXT,                     -- JSON：逐笔记录
  equity_curve TEXT,                     -- JSON：权益曲线 [{date,value}]
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 7. 用户决策日志
CREATE TABLE IF NOT EXISTS decision_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL,
  name         TEXT,
  ai_signal    TEXT,                     -- AI建议
  ai_expected  REAL,
  user_action  TEXT,                     -- BUY/SELL/IGNORE
  user_price   REAL,
  user_quantity INTEGER,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decision_created ON decision_log(created_at);

-- 额外：行情与财务快照（避免重复拉akshare），按日存
CREATE TABLE IF NOT EXISTS price_daily (
  code      TEXT NOT NULL,
  date      TEXT NOT NULL,
  open      REAL, high REAL, low REAL, close REAL,
  volume    REAL,
  amount    REAL,
  pct_chg   REAL,
  PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_price_code_date ON price_daily(code, date);

CREATE TABLE IF NOT EXISTS fundamentals (
  code          TEXT NOT NULL,
  report_date   TEXT NOT NULL,           -- 报告期 YYYY-MM-DD
  eps           REAL,
  eps_yoy       REAL,                    -- 当季同比 %
  revenue_yoy   REAL,
  roe           REAL,
  goodwill_ratio REAL,
  non_recurring_ratio REAL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code, report_date)
);

CREATE TABLE IF NOT EXISTS northbound_flow (
  code      TEXT NOT NULL,
  date      TEXT NOT NULL,
  net_flow  REAL,                        -- 净流入
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS dragon_tiger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  date       TEXT NOT NULL,
  reason     TEXT,
  net_buy    REAL,
  institution_net REAL,
  raw        TEXT                        -- JSON 原始数据
);
CREATE INDEX IF NOT EXISTS idx_dt_code_date ON dragon_tiger(code, date);

-- 记录 schema 版本，便于后续迁移
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
