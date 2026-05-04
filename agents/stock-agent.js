// 个股 Agent：CANSLIM + 赔率 + 形态 + AI 讲解
const dayjs = require('dayjs');
const { chat } = require('./llm');
const { runPython } = require('../scripts/pyrunner');
const { composeCanslim } = require('../engine/canslim');
const { detectAll } = require('../engine/pattern');
const { movingAverages, macd, kdj, trendAlignment } = require('../engine/technical');
const { computeOdds, suggestStopLoss, suggestTargetPrice, composeExpected } = require('../engine/odds');
const { Cache, Signals, Stocks, Market } = require('../database/repo');

const CACHE_KEY = (code, d) => `stock:${code}:${d}`;

async function ensureStockPrices(code, days = 365) {
  // 先读 DB，若数据不足再拉 akshare
  let prices = Market.getPrices(code, 300);
  if (!prices.length || prices.length < 120) {
    const end = dayjs().format('YYYY-MM-DD');
    const start = dayjs().subtract(days, 'day').format('YYYY-MM-DD');
    const r = await runPython('price', { code, start, end }, { timeoutMs: 90000 });
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
      prices = Market.getPrices(code, 300);
    }
  }
  return prices;
}

async function ensureFundamentals(code) {
  let list = Market.listFundamentals(code, 12);
  if (!list.length) {
    const r = await runPython('fundamentals', { code }, { timeoutMs: 120000 });
    if (r.ok && r.data?.length) {
      for (const row of r.data) Market.upsertFundamentals(row);
      list = Market.listFundamentals(code, 12);
    }
  }
  return list;
}

async function ensureNorthbound(code) {
  let rows = Market.getNorthbound(code, 60);
  if (!rows.length) {
    const r = await runPython('northbound', { code }, { timeoutMs: 60000 });
    if (r.ok && r.data?.length) {
      for (const x of r.data) Market.upsertNorthbound(x);
      rows = Market.getNorthbound(code, 60);
    }
  }
  return rows;
}

// 上证指数价格缓存（当天内复用，避免每只股票各拉一次）
let _shPricesCache = null;
let _shPricesCacheDate = null;

async function ensureMarketPrices() {
  const today = dayjs().format('YYYY-MM-DD');
  if (_shPricesCache && _shPricesCacheDate === today) return _shPricesCache;
  const r = await runPython('index', { code: '000001' }, { timeoutMs: 60000 });
  if (r.ok && r.data?.length) {
    _shPricesCache = r.data.map((x) => ({
      date: String(x.date).slice(0, 10),
      open: +x.open, high: +x.high, low: +x.low, close: +x.close,
      volume: +(x.volume || 0), amount: +(x.amount || 0), pct_chg: +(x.pct_chg || 0),
    }));
    _shPricesCacheDate = today;
    return _shPricesCache;
  }
  return null;
}

async function analyzeStock(
  code,
  { force = false, marketContext = null, shPrices = null, gemPrices = null } = {}
) {
  const today = dayjs().format('YYYY-MM-DD');
  const key = CACHE_KEY(code, today);
  if (!force) {
    const cached = Cache.get(key);
    if (cached) return { ...cached, cached: true };
  }

  const stock = Stocks.find(code);
  // 并行拉行情、财务、资金流、大盘（L 维度）
  const [prices, fundList, nb, autoShPrices] = await Promise.all([
    ensureStockPrices(code),
    ensureFundamentals(code),
    ensureNorthbound(code),
    shPrices ? Promise.resolve(shPrices) : ensureMarketPrices(),
  ]);

  if (!prices.length) {
    return { ok: false, code, error: '无行情数据' };
  }
  const fundLatest = fundList[0];
  const nbTrend20 = nb.slice(-20).reduce((a, b) => a + (b.net_flow || 0), 0);
  const resolvedShPrices = shPrices || autoShPrices;

  const last = prices[prices.length - 1];

  // 技术面
  const mas = movingAverages(prices);
  const macdRes = macd(prices);
  const kdjRes = kdj(prices);
  const pattern = detectAll(prices);

  // 大盘/创业板趋势
  const shTrend = resolvedShPrices
    ? trendAlignment(resolvedShPrices)
    : marketContext?.shanghaiTrend;
  const gemTrend = gemPrices ? trendAlignment(gemPrices) : marketContext?.gemTrend;

  // CANSLIM
  const canslim = composeCanslim({
    fundamentalsLatest: fundLatest,
    fundamentalsList: fundList,
    prices,
    marketPrices: resolvedShPrices || prices,
    institutional: {
      northboundTrend: nbTrend20,
      dragonTigerInstitutionNet: null,
    },
    market: { shanghaiTrend: shTrend, gemTrend },
  });

  // 枢轴点 & 赔率
  const pivot = pattern.best?.pivot || last.close;
  const target = suggestTargetPrice(prices, pivot);
  const stopLoss = suggestStopLoss(prices, pivot);
  const odds = computeOdds({
    currentPrice: last.close,
    pivot,
    stopLoss,
    targetPrice: target,
  });
  const expected = composeExpected({
    canslimScore: canslim.score,
    odds,
  });

  const result = {
    ok: true,
    code,
    name: stock?.name || '',
    industry: stock?.industry || '',
    asOf: last.date,
    price: last.close,
    canslim,
    pattern: pattern.best || null,
    patterns: pattern.all,
    odds,
    expected,
    technical: {
      ma: {
        MA5: last5(mas.MA5),
        MA10: last5(mas.MA10),
        MA20: last5(mas.MA20),
        MA60: last5(mas.MA60),
        MA120: last5(mas.MA120),
      },
      macd: {
        dif: last5(macdRes.dif),
        dea: last5(macdRes.dea),
        hist: last5(macdRes.hist),
      },
      kdj: { K: last5(kdjRes.K), D: last5(kdjRes.D), J: last5(kdjRes.J) },
    },
    northbound20Sum: nbTrend20,
  };

  // AI 点评
  const aiRes = await chat({
    system:
      '你是欧奈尔CANSLIM + 机构赔率思维的A股分析师。基于传入的结构化数据，输出300字内的中文点评，包含：① 胜率与赔率解读 ② 关键买点/止损/目标 ③ 最大风险点。不要重复数字堆砌。',
    user: buildStockPrompt(result),
    temperature: 0.3,
    maxTokens: 2500,
  });
  result.aiComment = aiRes.text || '';
  result.mockAi = !aiRes.ok && aiRes.mock;

  // 写 signals 表
  Signals.create({
    code,
    name: result.name,
    signal_type: expected.signal,
    price: last.close,
    canslim_score: canslim.score,
    odds_ratio: odds.oddsRatio,
    expected_score: expected.expected,
    pivot_price: pivot,
    stop_loss: odds.stopLoss,
    target_price: odds.targetPrice,
    reasons: {
      canslim: canslim.dimensions,
      pattern: pattern.best,
    },
    action: expected.action,
  });

  // 缓存至当日 16:00
  const expires = dayjs().hour(16).minute(0).second(0).toISOString();
  Cache.set(key, 'stock', result, expires);
  return result;
}

function last5(arr) {
  if (!arr) return [];
  return arr.slice(-5).map((v) => (v == null ? null : +v.toFixed(3)));
}

function buildStockPrompt(r) {
  const d = r.canslim.dimensions;
  return `个股：${r.code} ${r.name || ''} 行业：${r.industry || '-'}
最新价：${r.price}，当前日期：${r.asOf}
CANSLIM 总分：${r.canslim.score}（C=${d.C.score.toFixed(1)}, A=${d.A.score.toFixed(1)}, N=${d.N.score.toFixed(1)}, S=${d.S.score.toFixed(1)}, L=${d.L.score.toFixed(1)}, I=${d.I.score.toFixed(1)}, M=${d.M.score.toFixed(1)}）
各维度依据：
  C: ${d.C.reason}
  A: ${d.A.reason}
  N: ${d.N.reason}
  S: ${d.S.reason}
  L: ${d.L.reason}
  I: ${d.I.reason}
  M: ${d.M.reason}
形态：${r.pattern ? `${r.pattern.pattern}（置信度${r.pattern.confidence}，枢轴点${r.pattern.pivot.toFixed(2)}，${r.pattern.breakout ? '已突破' : '未突破'}）` : '无明显形态'}
赔率：上行${r.odds.upsidePct}%，下行${r.odds.downsidePct}%，赔率比${r.odds.oddsRatio}
期望值评分：${r.expected.expected}，信号：${r.expected.signal}
请给出300字内点评。`;
}

module.exports = { analyzeStock, ensureStockPrices };
