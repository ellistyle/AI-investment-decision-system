// 技术指标计算：MA / MACD / KDJ / 量能
// 输入：prices 为按日期升序的 [{date,open,high,low,close,volume,amount,pct_chg}]
// 所有函数纯函数，便于单测

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      prev = v;
    } else {
      prev = v * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

function movingAverages(prices, periods = [5, 10, 20, 60, 120]) {
  const closes = prices.map((p) => p.close);
  const res = {};
  for (const p of periods) res[`MA${p}`] = sma(closes, p);
  return res;
}

function macd(prices, { fast = 12, slow = 26, signal = 9 } = {}) {
  const closes = prices.map((p) => p.close);
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const difForSignal = dif.map((v) => (v == null ? 0 : v));
  const dea = ema(difForSignal, signal);
  const hist = dif.map((v, i) =>
    v != null && dea[i] != null ? (v - dea[i]) * 2 : null
  );
  return { dif, dea, hist };
}

// KDJ: 9,3,3
function kdj(prices, { n = 9, m1 = 3, m2 = 3 } = {}) {
  const K = new Array(prices.length).fill(null);
  const D = new Array(prices.length).fill(null);
  const J = new Array(prices.length).fill(null);
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < prices.length; i++) {
    const start = Math.max(0, i - n + 1);
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = start; j <= i; j++) {
      hh = Math.max(hh, prices[j].high);
      ll = Math.min(ll, prices[j].low);
    }
    const rsv = hh === ll ? 0 : ((prices[i].close - ll) / (hh - ll)) * 100;
    const k = (prevK * (m1 - 1) + rsv) / m1;
    const d = (prevD * (m2 - 1) + k) / m2;
    const j = 3 * k - 2 * d;
    K[i] = k;
    D[i] = d;
    J[i] = j;
    prevK = k;
    prevD = d;
  }
  return { K, D, J };
}

// 52周高点距离（N维度）: (close - maxHigh52W)/maxHigh52W
function high52wDistance(prices) {
  const closes = prices.map((p) => p.close);
  const highs = prices.map((p) => p.high);
  const len = prices.length;
  const window = Math.min(len, 250);
  const slice = highs.slice(Math.max(0, len - window));
  const hh = slice.length ? Math.max(...slice) : null;
  const last = closes[len - 1];
  if (hh == null || last == null) return null;
  return (last - hh) / hh; // 负数表示距高点多远
}

// 成交量相对均量倍数
function volumeRatio(prices, period = 50) {
  const vols = prices.map((p) => p.volume);
  const avg = sma(vols, period);
  const len = prices.length;
  const last = prices[len - 1];
  const a = avg[len - 1];
  if (!a) return null;
  return last.volume / a;
}

// 相对强度 RS（简化版）：近一个月涨幅相对于大盘涨幅的百分位
// 输入 stockPct, marketPct（同时间段累计涨幅），返回 0-100 分位估算
function relativeStrengthScore(stockReturn, marketReturn) {
  if (stockReturn == null || marketReturn == null) return 50;
  const diff = stockReturn - marketReturn;
  // 映射：-20%→0, 0%→50, +30%→100
  let score = 50 + diff * 150; // 0.1 差异 => +15
  score = Math.max(0, Math.min(100, score));
  return score;
}

function cumReturn(prices, days) {
  const len = prices.length;
  if (len < days + 1) return null;
  const start = prices[len - days - 1].close;
  const end = prices[len - 1].close;
  return (end - start) / start;
}

// 多空排列：MA5>MA10>MA20>MA60 为多头排列
function trendAlignment(prices) {
  const mas = movingAverages(prices, [5, 10, 20, 60]);
  const i = prices.length - 1;
  const v5 = mas.MA5[i];
  const v10 = mas.MA10[i];
  const v20 = mas.MA20[i];
  const v60 = mas.MA60[i];
  if ([v5, v10, v20, v60].some((x) => x == null)) return 'unknown';

  let align;
  if (v5 > v10 && v10 > v20 && v20 > v60) align = 'bull';
  else if (v5 < v10 && v10 < v20 && v20 < v60) align = 'bear';
  else align = 'mixed';

  // 近5日累计涨跌：若均线多头但近期持续下跌 >3%，降级为 mixed
  if (prices.length >= 6) {
    const recent = prices.slice(-6);
    const cum5d = (recent[5].close - recent[0].close) / recent[0].close;
    if (align === 'bull' && cum5d < -0.03) align = 'mixed';
    if (align === 'bear' && cum5d > 0.03) align = 'mixed';
  }

  return align;
}

module.exports = {
  sma,
  ema,
  movingAverages,
  macd,
  kdj,
  high52wDistance,
  volumeRatio,
  relativeStrengthScore,
  cumReturn,
  trendAlignment,
};
