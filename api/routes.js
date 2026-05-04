// REST API 路由
const express = require('express');
const {
  Stocks,
  Positions,
  Signals,
  Alerts,
  Decisions,
  Backtest,
  Market,
  Settings,
  Briefs,
} = require('../database/repo');
const { runPython } = require('../scripts/pyrunner');
const { analyzeStock } = require('../agents/stock-agent');
const { analyzeMarket } = require('../agents/market-agent');
const { runDailyBrief } = require('../agents/orchestrator');
const { checkAll, checkPrePurchase, RULES, getRules } = require('../agents/risk-agent');
const { chat } = require('../agents/llm');
const { runBacktest } = require('../backtest/engine');
const { listJobs, triggerJob } = require('../scheduler/jobs');
const {
  pushMorningBrief,
  pushAfterClose,
  pushAlert,
  pushAlertsDigest,
  sendText,
} = require('../push/wechat');

const router = express.Router();

// 健康检查
router.get('/health', (req, res) =>
  res.json({ ok: true, ts: Date.now(), uptime: process.uptime() })
);

// ---------- 股票池 ----------
router.get('/stocks', (req, res) => {
  const list = Stocks.list({
    watch: req.query.watch !== undefined ? req.query.watch === 'true' : undefined,
    position: req.query.position !== undefined ? req.query.position === 'true' : undefined,
  });
  res.json({ data: list });
});

router.post('/stocks', async (req, res) => {
  const { code, name, industry, market, is_watch } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  let meta = { code, name, industry, market };
  if (!name || !industry) {
    const info = await runPython('stock_info', { code });
    if (info.ok) {
      meta = { ...meta, ...info.data };
    }
  }
  Stocks.upsert({ ...meta, is_watch });
  res.json({ ok: true, data: Stocks.find(code) });
});

router.patch('/stocks/:code/watch', (req, res) => {
  Stocks.setWatch(req.params.code, !!req.body.watch);
  res.json({ ok: true });
});

router.delete('/stocks/:code', (req, res) => {
  Stocks.remove(req.params.code);
  res.json({ ok: true });
});

// ---------- 持仓 ----------
router.get('/positions', (req, res) => {
  const all = req.query.all === 'true';
  const list = all ? Positions.listAll() : Positions.listOpen();
  // 附加最新价与盈亏
  const withPnl = list.map((p) => {
    const last = Market.getPrices(p.code, 1);
    const price = last[0]?.close || p.buy_price;
    const pnl = (price - p.buy_price) * p.quantity;
    const pnlPct = (price - p.buy_price) / p.buy_price;
    return { ...p, current_price: price, pnl, pnl_pct: pnlPct };
  });
  res.json({ data: withPnl });
});

router.post('/positions', async (req, res) => {
  const p = req.body;
  if (!p.code || !p.buy_date || !p.buy_price || !p.quantity)
    return res.status(400).json({ error: 'code/buy_date/buy_price/quantity required' });
  // 自动补全股票名称和行业
  if (!p.name) {
    const stock = Stocks.find(p.code);
    if (stock?.name) {
      p.name = stock.name;
      p.industry = p.industry || stock.industry;
    } else {
      // stocks 表里没有，调 akshare 拉一次
      const info = await runPython('stock_info', { code: p.code });
      if (info.ok && info.data?.name) {
        p.name = info.data.name;
        p.industry = p.industry || info.data.industry;
        // 顺便写入 stocks 表
        Stocks.upsert({ code: p.code, name: p.name, industry: p.industry || '', market: info.data.market || '' });
      }
    }
  }
  const id = Positions.create(p);

  // 写决策日志：先用已有信号，若无则后台触发分析后补填
  const sig = Signals.latestByCode(p.code, 1)[0];
  const decisionBase = {
    code: p.code,
    name: p.name || '',
    user_action: 'BUY',
    user_price: +p.buy_price,
    user_quantity: +p.quantity,
    note: p.buy_logic || '',
  };
  if (sig) {
    Decisions.create({ ...decisionBase, ai_signal: sig.signal_type, ai_expected: sig.expected_score ?? null });
  } else {
    // 先写占位，再后台分析补填
    const decId = Decisions.create({ ...decisionBase, ai_signal: '', ai_expected: null });
    analyzeStock(p.code).then((r) => {
      if (r?.ok) {
        const newSig = Signals.latestByCode(p.code, 1)[0];
        if (newSig && decId) {
          Decisions.update(decId, { ai_signal: newSig.signal_type, ai_expected: newSig.expected_score ?? null });
        }
      }
    }).catch(() => {});
  }

  res.json({ ok: true, id, name: p.name || '' });
});

router.patch('/positions/:id', (req, res) => {
  Positions.update(+req.params.id, req.body);
  res.json({ ok: true });
});

router.post('/positions/:id/close', (req, res) => {
  const { sell_date, sell_price, sell_reason } = req.body;
  if (!sell_date || !sell_price) return res.status(400).json({ error: 'sell_date/sell_price required' });

  const pos = Positions.get(+req.params.id);
  Positions.close(+req.params.id, { sell_date, sell_price, sell_reason });

  // 写决策日志：平仓 = SELL
  try {
    const sig = pos ? Signals.latestByCode(pos.code, 1)[0] : null;
    Decisions.create({
      code: pos?.code || '',
      name: pos?.name || '',
      ai_signal: sig?.signal_type || '',
      ai_expected: sig?.expected_score ?? null,
      user_action: 'SELL',
      user_price: +sell_price,
      user_quantity: pos?.quantity ?? null,
      note: sell_reason || '',
    });
  } catch (_) {}

  res.json({ ok: true });
});

router.post('/positions/pre-check', (req, res) => {
  const r = checkPrePurchase(req.body);
  res.json(r);
});

// ---------- 信号 ----------
router.get('/signals', (req, res) => {
  const list = req.query.today === 'true' ? Signals.today() : Signals.list();
  // reasons 反序列化
  const data = list.map((s) => ({ ...s, reasons: safeParse(s.reasons) }));
  res.json({ data });
});

router.get('/signals/:code', (req, res) => {
  const list = Signals.latestByCode(req.params.code, 30).map((s) => ({
    ...s,
    reasons: safeParse(s.reasons),
  }));
  res.json({ data: list });
});

// ---------- 预警 ----------
router.get('/alerts', (req, res) => {
  const list = req.query.unhandled === 'true' ? Alerts.listUnhandled() : Alerts.list();
  res.json({ data: list });
});

router.post('/alerts/check', async (req, res) => {
  const alerts = checkAll();
  res.json({ ok: true, alerts });
});

// ---------- 分析 ----------
router.post('/analyze/market', async (req, res) => {
  const r = await analyzeMarket({ force: req.body.force });
  res.json({ ok: true, data: r });
});

router.post('/analyze/stock', async (req, res) => {
  const { code, force } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const r = await analyzeStock(code, { force });
  res.json(r);
});

router.post('/analyze/brief', async (req, res) => {
  const r = await runDailyBrief({
    kind: req.body.kind || 'manual',
    force: !!req.body.force,
    codes: req.body.codes || null,
  });
  res.json({ ok: true, data: r });
});

// ---------- 推送 ----------
router.post('/push/morning', async (req, res) => {
  const summary = await runDailyBrief({ kind: 'morning', force: !!req.body.force });
  const r = await pushMorningBrief(summary);
  res.json({ ok: r.ok, pushResult: r, summary });
});

router.post('/push/after-close', async (req, res) => {
  const summary = await runDailyBrief({ kind: 'after-close', force: !!req.body.force });
  const r = await pushAfterClose(summary);
  res.json({ ok: r.ok, pushResult: r, summary });
});

router.post('/push/alerts', async (req, res) => {
  const alerts = checkAll();
  const r = await pushAlertsDigest(alerts);
  res.json({ ok: r.ok, alerts });
});

router.post('/push/test', async (req, res) => {
  const r = await sendText('🧪 测试推送', req.body.content || '这是一条来自A股投资系统的测试');
  res.json(r);
});

// ---------- K线 & 技术指标 ----------
router.get('/chart/:code', async (req, res) => {
  const code = req.params.code;
  let prices = Market.getPrices(code, 500);
  if (!prices.length) {
    const r = await runPython('price', { code });
    if (r.ok && r.data?.length) {
      Market.upsertPrices(
        r.data.map((x) => ({
          code,
          date: x.date,
          open: +x.open,
          high: +x.high,
          low: +x.low,
          close: +x.close,
          volume: +(x.volume || 0),
          amount: +(x.amount || 0),
          pct_chg: +(x.pct_chg || 0),
        }))
      );
      prices = Market.getPrices(code, 500);
    }
  }
  res.json({ data: prices });
});

// ---------- AI 对话 ----------
router.post('/chat', async (req, res) => {
  const { system, user, temperature } = req.body;
  if (!user) return res.status(400).json({ error: 'user required' });
  const r = await chat({ system, user, temperature });
  res.json(r);
});

// ---------- 回测 ----------
router.post('/backtest/run', async (req, res) => {
  try {
    const r = await runBacktest(req.body || {});
    res.json({ ok: true, data: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/backtest', (req, res) => {
  res.json({ data: Backtest.list() });
});

router.get('/backtest/:id', (req, res) => {
  const b = Backtest.get(+req.params.id);
  if (!b) return res.status(404).end();
  res.json({
    data: {
      ...b,
      params: safeParse(b.params),
      trades: safeParse(b.trades),
      equity_curve: safeParse(b.equity_curve),
    },
  });
});

// ---------- 决策日志 ----------
router.post('/decisions', (req, res) => {
  Decisions.create(req.body);
  res.json({ ok: true });
});

router.get('/decisions', (req, res) => {
  res.json({ data: Decisions.list(), accuracy: Decisions.accuracy() });
});

// ---------- 风控配置 ----------
router.get('/risk/rules', (req, res) => res.json({ data: getRules() }));

router.put('/risk/rules', (req, res) => {
  const allowed = ['STOP_LOSS_PCT', 'SINGLE_POSITION_MAX', 'INDUSTRY_MAX', 'HOLDINGS_MAX', 'TREND_SCORE_MIN'];
  const patch = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) patch[k] = +req.body[k];
  }
  const current = getRules();
  Settings.set('risk_rules', { ...current, ...patch });
  res.json({ ok: true, data: getRules() });
});

// ---------- 定时任务 ----------
router.get('/scheduler/jobs', (req, res) => res.json({ data: listJobs() }));

router.post('/scheduler/jobs/:id/run', (req, res) => {
  const ok = triggerJob(req.params.id);
  if (!ok) return res.status(400).json({ error: 'job not found or already running' });
  res.json({ ok: true });
});

router.get('/scheduler/briefs', (req, res) => {
  const limit = Math.min(+(req.query.limit || 20), 50);
  res.json({ data: Briefs.list(limit) });
});

function safeParse(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

module.exports = router;
