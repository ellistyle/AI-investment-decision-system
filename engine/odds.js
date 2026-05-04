// 赔率/胜率 & 期望值（PRD §3.2）
// 赔率比 = 上行空间 / 下行风险
// 期望值 = CANSLIM × 0.6 + 赔率分 × 0.4

const { detectAll } = require('./pattern');

const STOP_LOSS_PCT = 0.08; // 欧奈尔8%铁律

// 14日 ATR
function calcATR(prices, period = 14) {
  if (prices.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < prices.length; i++) {
    const { high: h, low: l } = prices[i];
    const pc = prices[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// 止损：近5根K线摆动低点 vs ATR×1.5 取较高者，区间 [2%, 8%] 铁律
function suggestStopLoss(prices, pivot) {
  const hardFloor = pivot * (1 - STOP_LOSS_PCT); // 最低 -8%
  const minStop = pivot * 0.98;                  // 最高 -2%（至少留2%空间）
  const swingLow = Math.min(...prices.slice(-5).map((p) => p.low));
  const atrStop = pivot - calcATR(prices, 14) * 1.5;
  const raw = Math.max(Math.max(swingLow, atrStop), hardFloor);
  return +Math.min(raw, minStop).toFixed(3);
}

// 目标价：形态优先，其次52周高点，再次ATR×5投射
function suggestTargetPrice(prices, pivot) {
  const base = pivot || prices[prices.length - 1].close;
  const { all } = detectAll(prices);

  if (all.cupHandle?.found) {
    const { leftPeak, bottom } = all.cupHandle.detail;
    return +(base + (leftPeak - bottom)).toFixed(3);
  }
  if (all.flatBase?.found) {
    const { hi, lo } = all.flatBase.detail;
    return +(base + (hi - lo) * 2).toFixed(3);
  }

  // 52周高点高出5%以上则作为目标（回归前高）
  const high52w = Math.max(...prices.slice(-250).map((p) => p.high));
  if (high52w > base * 1.05) {
    return +high52w.toFixed(3);
  }

  // 近新高区域：ATR×5投射，最低保底10%
  const atrVal = calcATR(prices, 14);
  return +Math.max(base + atrVal * 5, base * 1.10).toFixed(3);
}

function computeOdds({ currentPrice, pivot, stopLoss, targetPrice }) {
  const ref = pivot || currentPrice;
  // stop 必须低于现价，最多在现价 2% 以内（防止 pivot 高于现价时止损倒挂）
  const rawStop = stopLoss ?? ref * (1 - STOP_LOSS_PCT);
  const stop = Math.min(rawStop, currentPrice * 0.98);
  const target = targetPrice ?? ref * 1.15;
  const upside = (target - currentPrice) / currentPrice;
  const downside = Math.max(0.0001, (currentPrice - stop) / currentPrice);
  const ratio = upside / downside;
  return {
    current: +currentPrice.toFixed(3),
    pivot: ref ? +ref.toFixed(3) : null,
    stopLoss: +stop.toFixed(3),
    targetPrice: +target.toFixed(3),
    upsidePct: +(upside * 100).toFixed(2),
    downsidePct: +(downside * 100).toFixed(2),
    oddsRatio: +ratio.toFixed(2),
  };
}

// 赔率得分映射：< 1.5 => 回避分；>=2 => 合格；>=3 优秀
function oddsScore(ratio) {
  if (ratio == null || !isFinite(ratio)) return 30;
  if (ratio >= 4) return 100;
  if (ratio >= 3) return 85 + (ratio - 3) * 15;
  if (ratio >= 2) return 65 + (ratio - 2) * 20;
  if (ratio >= 1.5) return 45 + (ratio - 1.5) * 40;
  if (ratio >= 1) return 25 + (ratio - 1) * 40;
  return Math.max(5, ratio * 25);
}

function composeExpected({ canslimScore, odds }) {
  const oScore = oddsScore(odds.oddsRatio);
  const expected = canslimScore * 0.6 + oScore * 0.4;
  let signal;
  let action;
  if (expected >= 75) {
    signal = 'BUY_STRONG';
    action = '强烈买入：可按计划仓位建仓，严格执行8%止损';
  } else if (expected >= 60) {
    signal = 'BUY_WATCH';
    action = '关注买入：等待枢轴点突破，带量确认';
  } else if (expected >= 45) {
    signal = 'HOLD';
    action = '持有观望：不加仓，视走势决定';
  } else {
    signal = 'AVOID';
    action = '回避/止损：不满足期望值阈值';
  }
  return {
    canslimScore: +canslimScore.toFixed(2),
    oddsScore: +oScore.toFixed(2),
    expected: +expected.toFixed(2),
    signal,
    action,
  };
}

module.exports = {
  STOP_LOSS_PCT,
  calcATR,
  suggestStopLoss,
  suggestTargetPrice,
  computeOdds,
  oddsScore,
  composeExpected,
};
