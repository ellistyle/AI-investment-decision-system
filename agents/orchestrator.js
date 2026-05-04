// Orchestrator：协调 市场/个股/风控 Agent，生成最终报告
const dayjs = require('dayjs');
const pLimit = require('p-limit');
const config = require('../config');
const { analyzeMarket } = require('./market-agent');
const { analyzeStock } = require('./stock-agent');
const { checkAll } = require('./risk-agent');
const { Stocks, Alerts } = require('../database/repo');

async function runDailyBrief({ kind = 'morning', force = false, codes = null } = {}) {
  const startedAt = Date.now();
  // 1. 市场 Agent
  const market = await analyzeMarket({ force });

  // 2. 确定扫描池
  const watchList = codes
    ? codes.map((c) => ({ code: c }))
    : Stocks.list({ watch: true });
  const positions = Stocks.list({ position: true });
  // 持仓必扫
  const merged = new Map();
  for (const s of watchList) merged.set(s.code, s);
  for (const s of positions) merged.set(s.code, s);
  const targets = [...merged.values()];

  // 3. 个股 Agent 并发
  const limit = pLimit(config.ai.concurrency || 5);
  const canslimMap = {};
  const stockResults = [];
  await Promise.all(
    targets.map((s) =>
      limit(async () => {
        try {
          const r = await analyzeStock(s.code, {
            force,
            marketContext: {
              shanghaiTrend: market.shanghaiTrend,
              gemTrend: market.gemTrend,
            },
          });
          stockResults.push(r);
          if (r.ok && r.canslim?.score != null) canslimMap[s.code] = r.canslim.score;
        } catch (e) {
          stockResults.push({ ok: false, code: s.code, error: e.message });
        }
      })
    )
  );

  // 4. 风控 Agent
  const priceMap = {};
  for (const r of stockResults) if (r.ok && r.price) priceMap[r.code] = r.price;
  const alerts = checkAll({ priceMap, canslimMap });

  // 5. 排序 & 构造报告
  const ok = stockResults.filter((r) => r.ok);
  ok.sort((a, b) => (b.expected?.expected || 0) - (a.expected?.expected || 0));

  const summary = {
    kind,
    date: dayjs().format('YYYY-MM-DD HH:mm'),
    market,
    topBuys: ok
      .filter((r) => ['BUY_STRONG', 'BUY_WATCH'].includes(r.expected?.signal))
      .slice(0, 10)
      .map(pickSignal),
    avoid: ok
      .filter((r) => r.expected?.signal === 'AVOID')
      .slice(0, 5)
      .map(pickSignal),
    positions: stockResults
      .filter((r) => r.ok && positions.find((p) => p.code === r.code))
      .map(pickSignal),
    alerts,
    stats: {
      scanned: stockResults.length,
      succeeded: ok.length,
      failed: stockResults.length - ok.length,
      elapsedMs: Date.now() - startedAt,
    },
  };
  return summary;
}

function pickSignal(r) {
  return {
    code: r.code,
    name: r.name,
    price: r.price,
    canslim: r.canslim?.score,
    oddsRatio: r.odds?.oddsRatio,
    expected: r.expected?.expected,
    signal: r.expected?.signal,
    pivot: r.pattern?.pivot,
    stopLoss: r.odds?.stopLoss,
    targetPrice: r.odds?.targetPrice,
    action: r.expected?.action,
    aiComment: r.aiComment,
  };
}

module.exports = { runDailyBrief };
