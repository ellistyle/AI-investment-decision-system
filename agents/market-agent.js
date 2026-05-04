// 市场 Agent：大盘M信号、情绪温度计、北向资金
const dayjs = require('dayjs');
const { chat } = require('./llm');
const { runPython } = require('../scripts/pyrunner');
const { trendAlignment } = require('../engine/technical');
const { Cache } = require('../database/repo');

const CACHE_KEY = (d) => `market:${d}`;

async function fetchIndex(code) {
  const r = await runPython('index', { code });
  if (!r.ok) return [];
  return (r.data || []).map((row) => ({
    date: String(row.date).slice(0, 10),
    open: +row.open,
    high: +row.high,
    low: +row.low,
    close: +row.close,
    volume: +(row.volume || 0),
    amount: +(row.amount || 0),
    pct_chg: +(row.pct_chg || 0),
  }));
}

async function analyzeMarket({ force = false } = {}) {
  const today = dayjs().format('YYYY-MM-DD');
  const key = CACHE_KEY(today);
  if (!force) {
    const cached = Cache.get(key);
    if (cached) return { ...cached, cached: true };
  }

  // 四指数：上证 000001 / 创业板 399006 / 深证 399001 / 科创50 000688
  const [sh, gem, sz, star] = await Promise.all([
    fetchIndex('000001'),
    fetchIndex('399006'),
    fetchIndex('399001'),
    fetchIndex('000688'),
  ]);
  const shTrend   = sh.length   ? trendAlignment(sh)   : 'unknown';
  const gemTrend  = gem.length  ? trendAlignment(gem)  : 'unknown';
  const szTrend   = sz.length   ? trendAlignment(sz)   : 'unknown';
  const starTrend = star.length ? trendAlignment(star) : 'unknown';

  // 近5日涨跌明细
  function recentChanges(prices, n = 5) {
    return prices.slice(-n).map((r) => ({ date: r.date, pct_chg: +r.pct_chg.toFixed(2) }));
  }
  const shRecent   = sh.length   ? recentChanges(sh)   : [];
  const gemRecent  = gem.length  ? recentChanges(gem)  : [];
  const szRecent   = sz.length   ? recentChanges(sz)   : [];
  const starRecent = star.length ? recentChanges(star) : [];

  // 情绪温度计（简化：涨跌家数 / 涨跌停 / 均线位置）
  let sentiment = null;
  try {
    const r = await runPython('market_sentiment', {}, { timeoutMs: 60000 });
    if (r.ok) sentiment = r.data;
  } catch (_) {}

  // M 信号裁决：四指数多数表决
  const trends = [shTrend, gemTrend, szTrend, starTrend].filter((t) => t !== 'unknown');
  const bullCount = trends.filter((t) => t === 'bull').length;
  const bearCount = trends.filter((t) => t === 'bear').length;
  const mVerdict =
    bullCount >= 3 ? 'bull' : bearCount >= 3 ? 'bear' : 'mixed';

  const factual = {
    date: today,
    shanghaiTrend: shTrend,
    gemTrend,
    szTrend,
    starTrend,
    mVerdict,
    sentiment,
    shRecent,
    gemRecent,
    szRecent,
    starRecent,
  };

  // AI 解读（可选，有 API KEY 才调）
  let aiBrief = '';
  const prompt = buildMarketPrompt(factual);
  const aiRes = await chat({
    system:
      '你是专业A股策略师。基于欧奈尔CANSLIM的M维度框架，用不超过200字中文给出今日大盘研判、操作倾向（进攻/防守/观望）、以及关注方向。',
    user: prompt,
    temperature: 0.3,
    maxTokens: 1500,
  });
  aiBrief = aiRes.text || '';

  const result = {
    ...factual,
    aiBrief,
    mockAi: !aiRes.ok && aiRes.mock,
  };

  // 缓存至当日 16:00
  const expires = dayjs().hour(16).minute(0).second(0).toISOString();
  Cache.set(key, 'market', result, expires);
  return result;
}

function buildMarketPrompt(factual) {
  const fmt = (arr) => arr.map((r) => `${r.date} ${r.pct_chg > 0 ? '+' : ''}${r.pct_chg}%`).join('，');
  return `今日 ${factual.date} A股：
上证指数均线趋势：${factual.shanghaiTrend}，近5日：${fmt(factual.shRecent)}
深证成指均线趋势：${factual.szTrend}，近5日：${fmt(factual.szRecent)}
创业板均线趋势：${factual.gemTrend}，近5日：${fmt(factual.gemRecent)}
科创50均线趋势：${factual.starTrend}，近5日：${fmt(factual.starRecent)}
涨停数：${factual.sentiment?.limit_up_count ?? '未知'} / 跌停数：${factual.sentiment?.limit_down_count ?? '未知'}
M维度裁决（四指数多数表决）：${factual.mVerdict}
请基于以上真实数据给出200字内研判，不要与实际涨跌幅矛盾。`;
}

module.exports = { analyzeMarket };
