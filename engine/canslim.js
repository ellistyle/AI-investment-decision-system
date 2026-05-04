// CANSLIM 评分引擎（PRD §3.1 A股本土化改造）
// 七维度，M 为大盘方向，一票否决。

const {
  movingAverages,
  high52wDistance,
  volumeRatio,
  relativeStrengthScore,
  cumReturn,
} = require('./technical');

// 权重（A股调整后）
const WEIGHTS = {
  C: 0.2,
  A: 0.15,
  N: 0.2,
  S: 0.2,
  L: 0.15,
  I: 0.05,
  // M 为一票否决，不参与加权
};

// ========== 单维度打分（0-100） ==========

// C: 当季 EPS 同比增速 > 25%
function scoreC(fundamentals) {
  if (!fundamentals || fundamentals.eps_yoy == null)
    return { score: 50, reason: '无当季业绩数据，中性评分' };
  const y = fundamentals.eps_yoy; // %
  let score;
  if (y >= 100) score = 100;
  else if (y >= 50) score = 85 + ((y - 50) / 50) * 15;
  else if (y >= 25) score = 65 + ((y - 25) / 25) * 20;
  else if (y >= 0) score = 40 + (y / 25) * 25;
  else if (y >= -25) score = 20 + ((y + 25) / 25) * 20;
  else score = 10;

  // 惩罚：商誉减值 / 非经常损益过高
  let penalty = 0;
  const notes = [];
  if (fundamentals.goodwill_ratio && fundamentals.goodwill_ratio > 0.3) {
    penalty += 10;
    notes.push(`商誉占比${(fundamentals.goodwill_ratio * 100).toFixed(1)}%偏高`);
  }
  if (
    fundamentals.non_recurring_ratio &&
    Math.abs(fundamentals.non_recurring_ratio) > 0.5
  ) {
    penalty += 10;
    notes.push(`非经常损益占比${(fundamentals.non_recurring_ratio * 100).toFixed(1)}%`);
  }
  score = Math.max(0, score - penalty);
  return {
    score,
    reason: `当季EPS同比 ${y.toFixed(1)}%${notes.length ? '，' + notes.join('；') : ''}`,
  };
}

// A: 近3年EPS年度增速 > 25%（用历年eps_yoy年均作近似）
function scoreA(fundamentalsList) {
  if (!fundamentalsList || fundamentalsList.length < 2)
    return { score: 50, reason: '历史业绩不足，中性评分' };
  const yoys = fundamentalsList
    .map((f) => f.eps_yoy)
    .filter((v) => v != null);
  if (yoys.length < 2) return { score: 50, reason: '历史业绩不足' };
  const avg = yoys.reduce((a, b) => a + b, 0) / yoys.length;
  let score;
  if (avg >= 50) score = 95;
  else if (avg >= 25) score = 75 + ((avg - 25) / 25) * 20;
  else if (avg >= 0) score = 45 + (avg / 25) * 30;
  else score = Math.max(10, 40 + avg);
  return { score, reason: `近3年EPS平均增速 ${avg.toFixed(1)}%` };
}

// N: 距52周高点 < -15% 给高分；越近高点分越高
function scoreN(prices) {
  const d = high52wDistance(prices);
  if (d == null) return { score: 50, reason: '数据不足' };
  // d 是负数：-0.05 = 距高点5%
  let score;
  if (d >= 0) score = 100;
  else if (d >= -0.05) score = 90 + (d + 0.05) * 200; // -0.05 -> 80
  else if (d >= -0.15) score = 65 + ((d + 0.15) / 0.1) * 25; // -0.15->65, -0.05->90
  else if (d >= -0.3) score = 40 + ((d + 0.3) / 0.15) * 25;
  else score = Math.max(10, 40 + (d + 0.3) * 100);
  score = Math.max(0, Math.min(100, score));
  return { score, reason: `距52周高点 ${(d * 100).toFixed(2)}%` };
}

// S: 突破时成交量 > 均量 180%（A股调整）
function scoreS(prices) {
  const vr = volumeRatio(prices, 50);
  if (vr == null) return { score: 50, reason: '数据不足' };
  let score;
  if (vr >= 2.5) score = 100;
  else if (vr >= 1.8) score = 80 + ((vr - 1.8) / 0.7) * 20;
  else if (vr >= 1.2) score = 55 + ((vr - 1.2) / 0.6) * 25;
  else if (vr >= 0.8) score = 40 + ((vr - 0.8) / 0.4) * 15;
  else score = 25;
  return { score, reason: `成交量/均量 ${vr.toFixed(2)}x` };
}

// L: RS相对强度 > 80分位
function scoreL(stockPrices, marketPrices, days = 60) {
  const sr = cumReturn(stockPrices, days);
  const mr = cumReturn(marketPrices, days);
  const rs = relativeStrengthScore(sr, mr);
  let score;
  if (rs >= 80) score = 90 + (rs - 80) * 0.5;
  else if (rs >= 60) score = 65 + ((rs - 60) / 20) * 25;
  else if (rs >= 40) score = 40 + ((rs - 40) / 20) * 25;
  else score = Math.max(10, rs);
  return {
    score,
    reason: `RS评级 ${rs.toFixed(0)}（近${days}日相对大盘 ${
      sr != null && mr != null ? ((sr - mr) * 100).toFixed(2) : '-'
    }%）`,
  };
}

// I: 机构资金（主力净流入作为代理指标；A股北向数据延迟且接口不稳定）
function scoreI({ northboundTrend, dragonTigerInstitutionNet }) {
  let base = 50;
  const reasons = [];
  if (northboundTrend != null) {
    // northboundTrend: 近20日主力净流入累计（元）
    const yi = 1e8; // 1亿
    if (northboundTrend > 5 * yi) {
      base += 20;
      reasons.push(`主力20日净流入 ${(northboundTrend / yi).toFixed(2)}亿`);
    } else if (northboundTrend > 0) {
      base += 10;
      reasons.push(`主力近期净流入 ${(northboundTrend / 1e4).toFixed(0)}万`);
    } else if (northboundTrend < -5 * yi) {
      base -= 20;
      reasons.push(`主力20日净流出 ${(-northboundTrend / yi).toFixed(2)}亿`);
    } else if (northboundTrend < 0) {
      base -= 10;
      reasons.push(`主力近期净流出 ${(-northboundTrend / 1e4).toFixed(0)}万`);
    }
  }
  if (dragonTigerInstitutionNet != null && dragonTigerInstitutionNet > 0) {
    base += 15;
    reasons.push(`龙虎榜机构净买`);
  }
  base = Math.max(0, Math.min(100, base));
  return { score: base, reason: reasons.join('；') || '缺少机构数据，中性' };
}

// M: 大盘方向（一票否决）
function scoreM({ shanghaiTrend, gemTrend }) {
  // *Trend: 'bull' | 'bear' | 'mixed' | 'unknown'
  const isBull = (t) => t === 'bull';
  const isBear = (t) => t === 'bear';
  let score;
  let verdict = 'neutral';
  if (isBull(shanghaiTrend) && isBull(gemTrend)) {
    score = 90;
    verdict = 'bull';
  } else if (isBear(shanghaiTrend) || isBear(gemTrend)) {
    score = 25;
    verdict = 'bear';
  } else {
    score = 55;
    verdict = 'mixed';
  }
  return {
    score,
    verdict,
    reason: `上证=${shanghaiTrend || '未知'}, 创业板=${gemTrend || '未知'}`,
  };
}

// ========== 综合 ==========

function composeCanslim(inputs) {
  const { fundamentalsLatest, fundamentalsList, prices, marketPrices, institutional, market } = inputs;
  const C = scoreC(fundamentalsLatest);
  const A = scoreA(fundamentalsList);
  const N = scoreN(prices);
  const S = scoreS(prices);
  const L = scoreL(prices, marketPrices || prices);
  const I = scoreI(institutional || {});
  const M = scoreM(market || {});

  const weighted =
    C.score * WEIGHTS.C +
    A.score * WEIGHTS.A +
    N.score * WEIGHTS.N +
    S.score * WEIGHTS.S +
    L.score * WEIGHTS.L +
    I.score * WEIGHTS.I;

  // M 一票否决：bear 时整体降权 0.6
  let final = weighted;
  if (M.verdict === 'bear') final = weighted * 0.6;
  else if (M.verdict === 'mixed') final = weighted * 0.9;

  return {
    score: +final.toFixed(2),
    dimensions: { C, A, N, S, L, I, M },
    weights: WEIGHTS,
    radar: {
      C: +C.score.toFixed(1),
      A: +A.score.toFixed(1),
      N: +N.score.toFixed(1),
      S: +S.score.toFixed(1),
      L: +L.score.toFixed(1),
      I: +I.score.toFixed(1),
      M: +M.score.toFixed(1),
    },
  };
}

module.exports = {
  scoreC,
  scoreA,
  scoreN,
  scoreS,
  scoreL,
  scoreI,
  scoreM,
  composeCanslim,
  WEIGHTS,
};
