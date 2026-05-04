// 回测引擎：历史CANSLIM + 赔率策略
// 简化版：对每只股票按日滚动评分，期望值>=75买入，8%止损/目标价止盈

const dayjs = require('dayjs');
const { runPython } = require('../scripts/pyrunner');
const { Market, Backtest } = require('../database/repo');
const { composeCanslim } = require('../engine/canslim');
const { trendAlignment } = require('../engine/technical');
const { detectAll } = require('../engine/pattern');
const { computeOdds, suggestTargetPrice, composeExpected } = require('../engine/odds');

async function loadPrices(code, start, end) {
  const rows = await runPython('price', { code, start, end });
  if (!rows.ok) return [];
  return (rows.data || [])
    .map((x) => ({
      date: String(x.date).slice(0, 10),
      open: +x.open,
      high: +x.high,
      low: +x.low,
      close: +x.close,
      volume: +(x.volume || 0),
      amount: +(x.amount || 0),
      pct_chg: +(x.pct_chg || 0),
    }))
    .filter((r) => r.date >= start && r.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 运行回测。
 * @param {Object} opts
 * @param {string[]} opts.codes
 * @param {string} opts.start 'YYYY-MM-DD'
 * @param {string} opts.end
 * @param {number} [opts.initialCash=1_000_000]
 * @param {number} [opts.buyThreshold=75]
 * @param {number} [opts.maxPositions=5]
 */
async function runBacktest({
  codes = [],
  start,
  end,
  initialCash = 1_000_000,
  buyThreshold = 75,
  maxPositions = 5,
  name = '',
  weights,
}) {
  if (!codes.length || !start || !end) throw new Error('codes/start/end required');

  // 加载所有股票 + 大盘
  const pricesByCode = {};
  for (const c of codes) {
    pricesByCode[c] = await loadPrices(c, start, end);
  }
  const marketRaw = await runPython('index', { code: '000001' });
  const marketPrices =
    (marketRaw.data || [])
      .map((x) => ({
        date: String(x.date).slice(0, 10),
        open: +x.open,
        high: +x.high,
        low: +x.low,
        close: +x.close,
        volume: +(x.volume || 0),
        amount: +(x.amount || 0),
        pct_chg: +(x.pct_chg || 0),
      }))
      .filter((r) => r.date >= start && r.date <= end)
      .sort((a, b) => (a.date < b.date ? -1 : 1)) || [];

  // 按交易日遍历
  const allDates = Array.from(
    new Set(Object.values(pricesByCode).flat().map((r) => r.date))
  ).sort();

  const trades = [];
  const equityCurve = [];
  const holdings = new Map(); // code -> {buyDate, buyPrice, qty, stopLoss, targetPrice}
  let cash = initialCash;

  for (const today of allDates) {
    const marketSlice = marketPrices.filter((r) => r.date <= today);
    const mTrend = marketSlice.length > 60 ? trendAlignment(marketSlice) : 'unknown';

    // 1. 先处理平仓（止损/止盈）
    for (const [code, h] of [...holdings.entries()]) {
      const p = pricesByCode[code];
      const today_ = p.find((r) => r.date === today);
      if (!today_) continue;
      // 日内最低 <= 止损 → 以止损价卖出
      if (today_.low <= h.stopLoss) {
        cash += h.stopLoss * h.qty;
        trades.push({
          code,
          action: 'SELL',
          reason: 'STOP_LOSS',
          buyDate: h.buyDate,
          sellDate: today,
          buyPrice: h.buyPrice,
          sellPrice: h.stopLoss,
          qty: h.qty,
          pnl: (h.stopLoss - h.buyPrice) * h.qty,
        });
        holdings.delete(code);
        continue;
      }
      // 日内最高 >= 目标价 → 以目标价卖出
      if (today_.high >= h.targetPrice) {
        cash += h.targetPrice * h.qty;
        trades.push({
          code,
          action: 'SELL',
          reason: 'TARGET_HIT',
          buyDate: h.buyDate,
          sellDate: today,
          buyPrice: h.buyPrice,
          sellPrice: h.targetPrice,
          qty: h.qty,
          pnl: (h.targetPrice - h.buyPrice) * h.qty,
        });
        holdings.delete(code);
      }
    }

    // 2. 扫描买入机会
    if (holdings.size < maxPositions) {
      const candidates = [];
      for (const code of codes) {
        if (holdings.has(code)) continue;
        const p = pricesByCode[code];
        const upto = p.filter((r) => r.date <= today);
        if (upto.length < 120) continue;
        const last = upto[upto.length - 1];

        const canslim = composeCanslim({
          fundamentalsLatest: null,
          fundamentalsList: [],
          prices: upto,
          marketPrices: marketSlice,
          institutional: {},
          market: { shanghaiTrend: mTrend, gemTrend: mTrend },
        });
        const pattern = detectAll(upto);
        const pivot = pattern.best?.pivot || last.close;
        const target = suggestTargetPrice(upto, pivot);
        const odds = computeOdds({
          currentPrice: last.close,
          pivot,
          stopLoss: pivot * 0.92,
          targetPrice: target,
        });
        const exp = composeExpected({
          canslimScore: canslim.score,
          odds,
        });
        if (exp.expected >= buyThreshold && odds.oddsRatio >= 2) {
          candidates.push({ code, last, odds, exp, canslim });
        }
      }
      candidates.sort((a, b) => b.exp.expected - a.exp.expected);
      for (const c of candidates) {
        if (holdings.size >= maxPositions) break;
        // 均分剩余仓位
        const slots = maxPositions - holdings.size;
        const budget = cash / slots;
        const qty = Math.floor(budget / c.last.close / 100) * 100; // A股100股一手
        if (qty <= 0) continue;
        const cost = qty * c.last.close;
        cash -= cost;
        holdings.set(c.code, {
          buyDate: today,
          buyPrice: c.last.close,
          qty,
          stopLoss: c.odds.stopLoss,
          targetPrice: c.odds.targetPrice,
        });
        trades.push({
          code: c.code,
          action: 'BUY',
          reason: 'SIGNAL',
          buyDate: today,
          buyPrice: c.last.close,
          qty,
          canslim: c.canslim.score,
          expected: c.exp.expected,
          odds: c.odds.oddsRatio,
        });
      }
    }

    // 3. 记录当日净值
    let equity = cash;
    for (const [code, h] of holdings.entries()) {
      const p = pricesByCode[code];
      const today_ = p.find((r) => r.date === today);
      equity += (today_?.close || h.buyPrice) * h.qty;
    }
    equityCurve.push({ date: today, value: +equity.toFixed(2) });
  }

  // 强平剩余持仓（期末按收盘）
  const lastDate = allDates[allDates.length - 1];
  for (const [code, h] of holdings.entries()) {
    const p = pricesByCode[code];
    const today_ = p.find((r) => r.date === lastDate);
    const price = today_?.close || h.buyPrice;
    cash += price * h.qty;
    trades.push({
      code,
      action: 'SELL',
      reason: 'END_OF_BACKTEST',
      buyDate: h.buyDate,
      sellDate: lastDate,
      buyPrice: h.buyPrice,
      sellPrice: price,
      qty: h.qty,
      pnl: (price - h.buyPrice) * h.qty,
    });
  }

  // 绩效指标
  const sellTrades = trades.filter((t) => t.action === 'SELL');
  const wins = sellTrades.filter((t) => t.pnl > 0);
  const winRate = sellTrades.length ? wins.length / sellTrades.length : 0;
  const totalPnl = sellTrades.reduce((a, b) => a + (b.pnl || 0), 0);
  const avgPL =
    sellTrades.length && wins.length && sellTrades.length > wins.length
      ? (wins.reduce((a, b) => a + b.pnl, 0) / wins.length) /
        Math.abs(
          sellTrades
            .filter((t) => t.pnl <= 0)
            .reduce((a, b) => a + b.pnl, 0) /
            Math.max(1, sellTrades.length - wins.length)
        )
      : null;

  const finalEquity = equityCurve[equityCurve.length - 1]?.value ?? initialCash;
  const years = Math.max(
    1 / 365,
    dayjs(end).diff(dayjs(start), 'day') / 365
  );
  const annualReturn = Math.pow(finalEquity / initialCash, 1 / years) - 1;
  const maxDrawdown = calcMaxDrawdown(equityCurve.map((e) => e.value));
  const sharpe = calcSharpe(equityCurve.map((e) => e.value));

  const result = {
    name: name || `backtest_${dayjs().format('YYYYMMDD_HHmmss')}`,
    params: { codes, start, end, initialCash, buyThreshold, maxPositions, weights },
    start_date: start,
    end_date: end,
    win_rate: +winRate.toFixed(4),
    avg_profit_loss: avgPL != null ? +avgPL.toFixed(3) : null,
    max_drawdown: +maxDrawdown.toFixed(4),
    annual_return: +annualReturn.toFixed(4),
    sharpe_ratio: +sharpe.toFixed(3),
    total_pnl: +totalPnl.toFixed(2),
    final_equity: +finalEquity.toFixed(2),
    trades,
    equity_curve: equityCurve,
  };

  const id = Backtest.create(result);
  return { id, ...result };
}

function calcMaxDrawdown(values) {
  let peak = values[0] || 0;
  let maxDd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

function calcSharpe(values, rf = 0.03) {
  if (values.length < 2) return 0;
  const daily = [];
  for (let i = 1; i < values.length; i++) {
    const r = (values[i] - values[i - 1]) / values[i - 1];
    daily.push(r);
  }
  const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
  const std = Math.sqrt(
    daily.reduce((a, b) => a + (b - mean) ** 2, 0) / daily.length
  );
  if (std === 0) return 0;
  const annualized = (mean * 250 - rf) / (std * Math.sqrt(250));
  return annualized;
}

module.exports = { runBacktest };
