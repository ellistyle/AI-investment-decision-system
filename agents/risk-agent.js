// 风控 Agent：纯规则引擎，不调AI，响应 < 100ms
// 对应 PRD §3.5 六条规则

const { Positions, Alerts, Market, Settings } = require('../database/repo');

const RULE_DEFAULTS = {
  STOP_LOSS_PCT: 0.08,
  SINGLE_POSITION_MAX: 0.15,
  INDUSTRY_MAX: 0.4,
  HOLDINGS_MAX: 10,
  TREND_SCORE_MIN: 45,
};

function getRules() {
  const saved = Settings.get('risk_rules');
  return { ...RULE_DEFAULTS, ...saved };
}

// 向外暴露的 RULES 保持兼容，但使用时应调 getRules()
const RULES = RULE_DEFAULTS;

function latestPrice(code) {
  const rows = Market.getPrices(code, 1);
  return rows.length ? rows[0].close : null;
}

function calcPortfolio(openPositions, priceMap) {
  let total = 0;
  const enriched = openPositions.map((p) => {
    const price = priceMap[p.code] ?? p.buy_price;
    const value = price * p.quantity;
    const cost = p.buy_price * p.quantity;
    total += value;
    return { ...p, current_price: price, market_value: value, cost };
  });
  return { enriched, total };
}

/**
 * 对持仓进行一次完整的风控检查。
 * @param {Object} opts
 * @param {Object<string,number>} [opts.priceMap] - code -> 最新价（不传则读DB最后一条）
 * @param {Object<string,number>} [opts.canslimMap] - code -> 当前CANSLIM分（用于趋势走坏检测）
 * @returns {Array} 本次产生的预警列表（已写入 alerts 表）
 */
function checkAll({ priceMap = {}, canslimMap = {} } = {}) {
  const RULES = getRules();
  const positions = Positions.listOpen();
  if (!positions.length) return [];

  // 补全价格
  for (const p of positions) {
    if (priceMap[p.code] == null) {
      const px = latestPrice(p.code);
      if (px != null) priceMap[p.code] = px;
    }
  }

  const { enriched, total } = calcPortfolio(positions, priceMap);
  const alerts = [];

  // 规则 1：止损线
  for (const p of enriched) {
    const drawdown = (p.current_price - p.buy_price) / p.buy_price;
    if (p.current_price <= p.stop_loss || drawdown <= -RULES.STOP_LOSS_PCT) {
      alerts.push({
        code: p.code,
        alert_type: 'STOP_LOSS',
        level: 'red',
        trigger_value: +(drawdown * 100).toFixed(2),
        threshold: -RULES.STOP_LOSS_PCT * 100,
        message: `${p.code} ${p.name || ''} 触发${(RULES.STOP_LOSS_PCT * 100).toFixed(0)}%止损线，当前${p.current_price}，买入${p.buy_price}，回撤${(drawdown * 100).toFixed(2)}%，立即执行止损`,
      });
    }
  }

  // 规则 2：单票仓位上限
  if (total > 0) {
    for (const p of enriched) {
      const w = p.market_value / total;
      if (w > RULES.SINGLE_POSITION_MAX) {
        alerts.push({
          code: p.code,
          alert_type: 'POSITION_EXCEED',
          level: 'red',
          trigger_value: +(w * 100).toFixed(2),
          threshold: RULES.SINGLE_POSITION_MAX * 100,
          message: `${p.code} 单票仓位${(w * 100).toFixed(1)}% 超过上限${(RULES.SINGLE_POSITION_MAX * 100).toFixed(0)}%`,
        });
      }
    }
  }

  // 规则 3：行业集中度
  if (total > 0) {
    const indMap = {};
    for (const p of enriched) {
      const ind = p.industry || '未分类';
      indMap[ind] = (indMap[ind] || 0) + p.market_value;
    }
    for (const [ind, v] of Object.entries(indMap)) {
      const w = v / total;
      if (w > RULES.INDUSTRY_MAX) {
        alerts.push({
          code: null,
          alert_type: 'INDUSTRY_CONCENTRATION',
          level: 'yellow',
          trigger_value: +(w * 100).toFixed(2),
          threshold: RULES.INDUSTRY_MAX * 100,
          message: `行业[${ind}]集中度${(w * 100).toFixed(1)}% 超过${(RULES.INDUSTRY_MAX * 100).toFixed(0)}%，建议分散`,
        });
      }
    }
  }

  // 规则 4：持仓只数
  if (enriched.length > RULES.HOLDINGS_MAX) {
    alerts.push({
      code: null,
      alert_type: 'HOLDINGS_COUNT',
      level: 'yellow',
      trigger_value: enriched.length,
      threshold: RULES.HOLDINGS_MAX,
      message: `持仓${enriched.length}只 超过建议上限${RULES.HOLDINGS_MAX}，注意分散风险`,
    });
  }

  // 规则 5：目标价到达
  for (const p of enriched) {
    if (p.target_price && p.current_price >= p.target_price) {
      alerts.push({
        code: p.code,
        alert_type: 'TARGET_HIT',
        level: 'green',
        trigger_value: p.current_price,
        threshold: p.target_price,
        message: `${p.code} 达到目标价${p.target_price}，当前${p.current_price}，建议考虑止盈`,
      });
    }
  }

  // 规则 6：趋势走坏（CANSLIM < 45）
  for (const p of enriched) {
    const sc = canslimMap[p.code];
    if (sc != null && sc < RULES.TREND_SCORE_MIN) {
      alerts.push({
        code: p.code,
        alert_type: 'TREND_BROKEN',
        level: 'green',
        trigger_value: sc,
        threshold: RULES.TREND_SCORE_MIN,
        message: `${p.code} CANSLIM评分${sc.toFixed(1)}跌破${RULES.TREND_SCORE_MIN}，复核趋势`,
      });
    }
  }

  // 写入 alerts 表
  const ids = alerts.map((a) => Alerts.create(a));
  return alerts.map((a, i) => ({ ...a, id: ids[i] }));
}

// 预建仓检查：给定一个拟买入的股票，判断是否违反分散纪律
function checkPrePurchase({ code, amount, industry }) {
  const RULES = getRules();
  const positions = Positions.listOpen();
  const priceMap = {};
  for (const p of positions) {
    const px = latestPrice(p.code);
    if (px != null) priceMap[p.code] = px;
  }
  const { enriched, total } = calcPortfolio(positions, priceMap);
  const newTotal = total + amount;
  const warnings = [];

  if (enriched.length + 1 > RULES.HOLDINGS_MAX) {
    warnings.push(`新增一只后持仓数将达${enriched.length + 1}，超过${RULES.HOLDINGS_MAX}`);
  }
  const newWeight = amount / newTotal;
  if (newWeight > RULES.SINGLE_POSITION_MAX) {
    warnings.push(`该股将占总仓${(newWeight * 100).toFixed(1)}%，超过${(RULES.SINGLE_POSITION_MAX * 100).toFixed(0)}%`);
  }
  if (industry) {
    const indVal = enriched
      .filter((p) => (p.industry || '未分类') === industry)
      .reduce((a, b) => a + b.market_value, 0);
    const newIndW = (indVal + amount) / newTotal;
    if (newIndW > RULES.INDUSTRY_MAX) {
      warnings.push(
        `加仓后[${industry}]行业占比${(newIndW * 100).toFixed(1)}%，超过${(RULES.INDUSTRY_MAX * 100).toFixed(0)}%`
      );
    }
  }
  return { ok: warnings.length === 0, warnings };
}

module.exports = { RULES, getRules, checkAll, checkPrePurchase };
