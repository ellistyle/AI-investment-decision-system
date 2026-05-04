// 数据访问层封装
const { getDb } = require('./init');

const Stocks = {
  upsert(s) {
    const db = getDb();
    db.prepare(
      `INSERT INTO stocks(code, name, industry, market, is_watch, is_position, updated_at)
       VALUES (?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(code) DO UPDATE SET
         name=excluded.name, industry=excluded.industry, market=excluded.market,
         is_watch=COALESCE(excluded.is_watch, stocks.is_watch),
         is_position=COALESCE(excluded.is_position, stocks.is_position),
         updated_at=datetime('now')`
    ).run(
      s.code,
      s.name || '',
      s.industry || '',
      s.market || '',
      s.is_watch ? 1 : 0,
      s.is_position ? 1 : 0
    );
  },
  find(code) {
    return getDb().prepare('SELECT * FROM stocks WHERE code=?').get(code);
  },
  list({ watch, position } = {}) {
    const conds = [];
    const args = [];
    if (watch !== undefined) {
      conds.push('is_watch=?');
      args.push(watch ? 1 : 0);
    }
    if (position !== undefined) {
      conds.push('is_position=?');
      args.push(position ? 1 : 0);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    return getDb()
      .prepare(`SELECT * FROM stocks ${where} ORDER BY code ASC`)
      .all(...args);
  },
  setWatch(code, flag) {
    getDb()
      .prepare(
        "UPDATE stocks SET is_watch=?, updated_at=datetime('now') WHERE code=?"
      )
      .run(flag ? 1 : 0, code);
  },
  remove(code) {
    getDb().prepare('DELETE FROM stocks WHERE code=?').run(code);
  },
};

const Positions = {
  create(p) {
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO positions(code,name,buy_date,buy_price,quantity,buy_logic,stop_loss,target_price,status)
         VALUES(?,?,?,?,?,?,?,?, 'open')`
      )
      .run(
        p.code,
        p.name || '',
        p.buy_date,
        p.buy_price,
        p.quantity,
        p.buy_logic || '',
        p.stop_loss ?? p.buy_price * 0.92,
        p.target_price ?? null
      );
    db.prepare(
      "UPDATE stocks SET is_position=1, is_watch=1, updated_at=datetime('now') WHERE code=?"
    ).run(p.code);
    return info.lastInsertRowid;
  },
  update(id, patch) {
    const fields = [];
    const args = [];
    for (const k of [
      'stop_loss',
      'target_price',
      'buy_logic',
      'status',
      'sell_date',
      'sell_price',
      'sell_reason',
    ]) {
      if (patch[k] !== undefined) {
        fields.push(`${k}=?`);
        args.push(patch[k]);
      }
    }
    if (!fields.length) return;
    args.push(id);
    getDb()
      .prepare(
        `UPDATE positions SET ${fields.join(
          ','
        )}, updated_at=datetime('now') WHERE id=?`
      )
      .run(...args);
  },
  close(id, { sell_date, sell_price, sell_reason }) {
    const db = getDb();
    const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(id);
    if (!pos) return;
    db.prepare(
      `UPDATE positions SET status='closed', sell_date=?, sell_price=?, sell_reason=?, updated_at=datetime('now') WHERE id=?`
    ).run(sell_date, sell_price, sell_reason || '', id);
    // 若该股无其他 open 持仓，取消 is_position
    const stillOpen = db
      .prepare(
        "SELECT COUNT(*) AS c FROM positions WHERE code=? AND status='open'"
      )
      .get(pos.code);
    if (!stillOpen.c) {
      db.prepare('UPDATE stocks SET is_position=0 WHERE code=?').run(pos.code);
    }
  },
  get(id) {
    return getDb().prepare('SELECT * FROM positions WHERE id=?').get(id);
  },
  listOpen() {
    return getDb()
      .prepare(
        `SELECT p.*, COALESCE(s.industry, '') AS industry, COALESCE(s.market, '') AS market
         FROM positions p
         LEFT JOIN stocks s ON s.code = p.code
         WHERE p.status='open' ORDER BY p.buy_date DESC`
      )
      .all();
  },
  listAll() {
    return getDb()
      .prepare(
        `SELECT p.*, COALESCE(s.industry, '') AS industry, COALESCE(s.market, '') AS market
         FROM positions p
         LEFT JOIN stocks s ON s.code = p.code
         ORDER BY p.buy_date DESC`
      )
      .all();
  },
};

const Signals = {
  create(s) {
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO signals(code,name,signal_type,price,canslim_score,odds_ratio,expected_score,pivot_price,stop_loss,target_price,reasons,action)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        s.code,
        s.name || '',
        s.signal_type,
        s.price ?? null,
        s.canslim_score ?? null,
        s.odds_ratio ?? null,
        s.expected_score ?? null,
        s.pivot_price ?? null,
        s.stop_loss ?? null,
        s.target_price ?? null,
        JSON.stringify(s.reasons || {}),
        s.action || ''
      );
    return info.lastInsertRowid;
  },
  latestByCode(code, limit = 20) {
    return getDb()
      .prepare(
        'SELECT * FROM signals WHERE code=? ORDER BY created_at DESC LIMIT ?'
      )
      .all(code, limit);
  },
  today() {
    return getDb()
      .prepare(
        `SELECT s.* FROM signals s
         INNER JOIN (
           SELECT code, MAX(created_at) AS max_ts
           FROM signals
           WHERE date(created_at)=date('now','localtime')
           GROUP BY code
         ) latest ON s.code=latest.code AND s.created_at=latest.max_ts
         ORDER BY s.expected_score DESC`
      )
      .all();
  },
  list({ limit = 200 } = {}) {
    return getDb()
      .prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  },
};

const Alerts = {
  create(a) {
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO alerts(code,alert_type,level,trigger_value,threshold,message,handled,pushed_at)
         VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        a.code || null,
        a.alert_type,
        a.level || 'yellow',
        a.trigger_value ?? null,
        a.threshold ?? null,
        a.message,
        a.handled ? 1 : 0,
        a.pushed_at || null
      );
    return info.lastInsertRowid;
  },
  markPushed(id) {
    getDb()
      .prepare(
        "UPDATE alerts SET handled=1, pushed_at=datetime('now') WHERE id=?"
      )
      .run(id);
  },
  listUnhandled() {
    return getDb()
      .prepare('SELECT * FROM alerts WHERE handled=0 ORDER BY created_at DESC')
      .all();
  },
  list({ limit = 200 } = {}) {
    return getDb()
      .prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  },
};

const Cache = {
  get(key) {
    const row = getDb()
      .prepare(
        "SELECT * FROM analysis_cache WHERE cache_key=? AND expires_at > datetime('now')"
      )
      .get(key);
    return row ? JSON.parse(row.payload) : null;
  },
  set(key, kind, payload, expiresAtIso) {
    getDb()
      .prepare(
        `INSERT INTO analysis_cache(cache_key,kind,payload,expires_at)
         VALUES(?,?,?,?)
         ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at`
      )
      .run(key, kind, JSON.stringify(payload), expiresAtIso);
  },
  purgeExpired() {
    getDb()
      .prepare("DELETE FROM analysis_cache WHERE expires_at <= datetime('now')")
      .run();
  },
};

const Backtest = {
  create(b) {
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO backtest_results(name,params,start_date,end_date,win_rate,avg_profit_loss,max_drawdown,annual_return,sharpe_ratio,trades,equity_curve)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        b.name || '',
        JSON.stringify(b.params || {}),
        b.start_date,
        b.end_date,
        b.win_rate ?? null,
        b.avg_profit_loss ?? null,
        b.max_drawdown ?? null,
        b.annual_return ?? null,
        b.sharpe_ratio ?? null,
        JSON.stringify(b.trades || []),
        JSON.stringify(b.equity_curve || [])
      );
    return info.lastInsertRowid;
  },
  list() {
    return getDb()
      .prepare(
        'SELECT id,name,start_date,end_date,win_rate,avg_profit_loss,max_drawdown,annual_return,sharpe_ratio,created_at FROM backtest_results ORDER BY created_at DESC'
      )
      .all();
  },
  get(id) {
    return getDb()
      .prepare('SELECT * FROM backtest_results WHERE id=?')
      .get(id);
  },
};

const Decisions = {
  create(d) {
    const res = getDb()
      .prepare(
        `INSERT INTO decision_log(code,name,ai_signal,ai_expected,user_action,user_price,user_quantity,note)
         VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        d.code,
        d.name || '',
        d.ai_signal || '',
        d.ai_expected ?? null,
        d.user_action || '',
        d.user_price ?? null,
        d.user_quantity ?? null,
        d.note || ''
      );
    return res.lastInsertRowid;
  },
  update(id, fields) {
    const sets = Object.keys(fields).map((k) => `${k}=?`).join(',');
    getDb()
      .prepare(`UPDATE decision_log SET ${sets} WHERE id=?`)
      .run(...Object.values(fields), id);
  },
  list() {
    return getDb()
      .prepare('SELECT * FROM decision_log ORDER BY created_at DESC LIMIT 500')
      .all();
  },
  accuracy() {
    // AI建议BUY，用户实际BUY，视为一致；否则不一致
    return getDb()
      .prepare(
        `SELECT ai_signal, user_action, COUNT(*) as n
         FROM decision_log
         GROUP BY ai_signal, user_action`
      )
      .all();
  },
};

const Market = {
  upsertPrice(row) {
    getDb()
      .prepare(
        `INSERT INTO price_daily(code,date,open,high,low,close,volume,amount,pct_chg)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(code,date) DO UPDATE SET
           open=excluded.open, high=excluded.high, low=excluded.low,
           close=excluded.close, volume=excluded.volume, amount=excluded.amount, pct_chg=excluded.pct_chg`
      )
      .run(
        row.code,
        row.date,
        row.open,
        row.high,
        row.low,
        row.close,
        row.volume,
        row.amount,
        row.pct_chg
      );
  },
  upsertPrices(rows) {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO price_daily(code,date,open,high,low,close,volume,amount,pct_chg)
       VALUES(@code,@date,@open,@high,@low,@close,@volume,@amount,@pct_chg)
       ON CONFLICT(code,date) DO UPDATE SET
         open=excluded.open, high=excluded.high, low=excluded.low,
         close=excluded.close, volume=excluded.volume, amount=excluded.amount, pct_chg=excluded.pct_chg`
    );
    const tx = db.transaction((list) => {
      for (const r of list) stmt.run(r);
    });
    tx(rows);
  },
  getPrices(code, limit = 250) {
    return getDb()
      .prepare(
        'SELECT * FROM price_daily WHERE code=? ORDER BY date DESC LIMIT ?'
      )
      .all(code, limit)
      .reverse();
  },
  upsertFundamentals(row) {
    getDb()
      .prepare(
        `INSERT INTO fundamentals(code,report_date,eps,eps_yoy,revenue_yoy,roe,goodwill_ratio,non_recurring_ratio)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(code,report_date) DO UPDATE SET
           eps=excluded.eps, eps_yoy=excluded.eps_yoy, revenue_yoy=excluded.revenue_yoy,
           roe=excluded.roe, goodwill_ratio=excluded.goodwill_ratio,
           non_recurring_ratio=excluded.non_recurring_ratio,
           updated_at=datetime('now')`
      )
      .run(
        row.code,
        row.report_date,
        row.eps,
        row.eps_yoy,
        row.revenue_yoy,
        row.roe,
        row.goodwill_ratio,
        row.non_recurring_ratio
      );
  },
  latestFundamentals(code) {
    return getDb()
      .prepare(
        'SELECT * FROM fundamentals WHERE code=? ORDER BY report_date DESC LIMIT 1'
      )
      .get(code);
  },
  listFundamentals(code, limit = 12) {
    return getDb()
      .prepare(
        'SELECT * FROM fundamentals WHERE code=? ORDER BY report_date DESC LIMIT ?'
      )
      .all(code, limit);
  },
  upsertNorthbound(row) {
    getDb()
      .prepare(
        `INSERT INTO northbound_flow(code,date,net_flow) VALUES(?,?,?)
         ON CONFLICT(code,date) DO UPDATE SET net_flow=excluded.net_flow`
      )
      .run(row.code, row.date, row.net_flow);
  },
  getNorthbound(code, days = 30) {
    return getDb()
      .prepare(
        'SELECT * FROM northbound_flow WHERE code=? ORDER BY date DESC LIMIT ?'
      )
      .all(code, days)
      .reverse();
  },
  insertDragonTiger(row) {
    getDb()
      .prepare(
        `INSERT INTO dragon_tiger(code,date,reason,net_buy,institution_net,raw)
         VALUES(?,?,?,?,?,?)`
      )
      .run(
        row.code,
        row.date,
        row.reason || '',
        row.net_buy ?? null,
        row.institution_net ?? null,
        JSON.stringify(row.raw || {})
      );
  },
  listDragonTiger(code, days = 90) {
    return getDb()
      .prepare(
        "SELECT * FROM dragon_tiger WHERE code=? AND date >= date('now',?) ORDER BY date DESC"
      )
      .all(code, `-${days} day`);
  },
};

const Settings = {
  get(key) {
    const row = getDb().prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  },
  set(key, value) {
    getDb()
      .prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  },
};

const Briefs = {
  save({ kind, date, content, summary }) {
    const db = getDb();
    const key = `brief:${kind}:${date}`;
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify({ kind, date, content, summary, savedAt: new Date().toISOString() }));
    // 只保留最近 30 条
    const all = db.prepare("SELECT key FROM meta WHERE key LIKE 'brief:%' ORDER BY key DESC").all();
    if (all.length > 30) {
      for (const row of all.slice(30)) db.prepare('DELETE FROM meta WHERE key=?').run(row.key);
    }
  },
  list(limit = 20) {
    const rows = getDb()
      .prepare("SELECT value FROM meta WHERE key LIKE 'brief:%' ORDER BY key DESC LIMIT ?")
      .all(limit);
    return rows.map((r) => JSON.parse(r.value));
  },
};

module.exports = {
  Stocks,
  Positions,
  Signals,
  Alerts,
  Cache,
  Backtest,
  Decisions,
  Market,
  Settings,
  Briefs,
};
