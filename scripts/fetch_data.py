#!/usr/bin/env python3
"""
akshare 数据采集脚本
被 Node.js 通过 child_process 调用，输出 JSON 到 stdout。

用法：
  python3 fetch_data.py price --code 600519 --start 2024-01-01 --end 2026-04-24
  python3 fetch_data.py fundamentals --code 600519
  python3 fetch_data.py northbound --code 600519
  python3 fetch_data.py dragon_tiger --date 2026-04-23
  python3 fetch_data.py index --code 000001
  python3 fetch_data.py stock_info --code 600519
  python3 fetch_data.py realtime --codes 600519,000001
  python3 fetch_data.py fund_holdings --code 600519

为了让项目在 akshare 未安装时也可以先跑通前后端，
脚本会在 import 失败时返回 {"ok": false, "error": "..."}，
后端会回退到本地缓存 / Mock 数据。
"""
import sys
import json
import argparse
import traceback
from datetime import datetime, timedelta


def _out(payload):
    import math
    def _clean(obj):
        if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
            return None
        if isinstance(obj, dict):
            return {k: _clean(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_clean(v) for v in obj]
        return obj
    print(json.dumps(_clean(payload), ensure_ascii=False, default=str))


def _err(msg, code="ERR"):
    _out({"ok": False, "error": msg, "code": code})
    sys.exit(0)  # 让 Node 从 stdout 读错误而不是 exit code


def _ak():
    try:
        import akshare as ak  # noqa
        return ak
    except Exception as e:
        _err(f"akshare not available: {e}", "NO_AKSHARE")


def _market_prefix(code: str) -> str:
    code = code.strip()
    if code.startswith(("60", "68", "90")):
        return "SH"
    if code.startswith(("00", "30", "20")):
        return "SZ"
    if code.startswith(("43", "83", "87", "88")):
        return "BJ"
    return ""


def _market_prefix(code):
    """根据代码前缀判断交易所，返回 'SH' 或 'SZ'"""
    if code.startswith("6"):
        return "SH"
    return "SZ"


def _fetch_price_baostock(code, start, end):
    """BaoStock 兜底：socket 协议，不受 TLS 代理影响，前复权 adjustflag=2"""
    try:
        import baostock as bs
        prefix = "sh" if _market_prefix(code) == "SH" else "sz"
        bs_code = f"{prefix}.{code}"
        bs.login()
        rs = bs.query_history_k_data_plus(
            bs_code,
            "date,open,high,low,close,volume,amount,pctChg",
            start_date=f"{start[:4]}-{start[4:6]}-{start[6:]}",
            end_date=f"{end[:4]}-{end[4:6]}-{end[6:]}",
            frequency="d",
            adjustflag="2",
        )
        rows = []
        while rs.error_code == "0" and rs.next():
            r = dict(zip(rs.fields, rs.get_row_data()))
            rows.append({
                "code": code,
                "date": r.get("date", ""),
                "open": float(r["open"]) if r.get("open") else None,
                "high": float(r["high"]) if r.get("high") else None,
                "low": float(r["low"]) if r.get("low") else None,
                "close": float(r["close"]) if r.get("close") else None,
                "volume": float(r["volume"]) if r.get("volume") else 0,
                "amount": float(r["amount"]) if r.get("amount") else 0,
                "pct_chg": float(r["pctChg"]) if r.get("pctChg") else 0,
            })
        bs.logout()
        return [r for r in rows if r.get("close")]
    except Exception:
        return []


def fetch_price(args):
    ak = _ak()
    code = args.code
    start = args.start or (datetime.now() - timedelta(days=365)).strftime("%Y%m%d")
    end = args.end or datetime.now().strftime("%Y%m%d")
    start = start.replace("-", "")
    end = end.replace("-", "")
    df = None
    try:
        df = ak.stock_zh_a_hist(
            symbol=code, period="daily", start_date=start, end_date=end, adjust="qfq"
        )
    except Exception:
        pass
    if df is not None and not df.empty:
        rename = {
            "日期": "date", "开盘": "open", "收盘": "close",
            "最高": "high", "最低": "low",
            "成交量": "volume", "成交额": "amount",
            "涨跌幅": "pct_chg",
        }
        df = df.rename(columns=rename)
        keep = ["date", "open", "high", "low", "close", "volume", "amount", "pct_chg"]
        df = df[[c for c in keep if c in df.columns]]
        df["date"] = df["date"].astype(str).str[:10]
        rows = df.to_dict(orient="records")
        for r in rows:
            r["code"] = code
        _out({"ok": True, "data": rows})
        return
    # 东方财富失败，BaoStock 兜底
    rows = _fetch_price_baostock(code, start, end)
    if rows:
        _out({"ok": True, "data": rows})
    else:
        _err(f"price fetch failed for {code} (both eastmoney and baostock)")


def fetch_fundamentals(args):
    """
    使用 stock_financial_abstract 接口（同花顺，~2秒），
    输出按报告期排列的季度 EPS（单季）、YoY、ROE、商誉占比等字段。
    """
    ak = _ak()
    code = args.code
    try:
        df = ak.stock_financial_abstract(symbol=code)
        if df is None or df.empty:
            _out({"ok": True, "data": []})
            return

        # 取第一次出现的"基本每股收益"行（累计值）和其他指标
        def get_row(name):
            rows = df[df["指标"] == name]
            return rows.iloc[0] if not rows.empty else None

        eps_row      = get_row("基本每股收益")       # 累计 EPS
        roe_row      = get_row("净资产收益率(ROE)")
        goodwill_row = get_row("商誉")
        profit_row   = get_row("归母净利润")
        rev_growth   = get_row("营业总收入增长率")
        profit_growth= get_row("归属母公司净利润增长率")

        if eps_row is None:
            _out({"ok": True, "data": []})
            return

        # 报告期列（格式 YYYYMMDD），按降序排列
        period_cols = [c for c in df.columns if c not in ("选项", "指标") and str(c).isdigit()]
        period_cols = sorted(period_cols, reverse=True)   # 最新在前

        def safe_float(row, col):
            if row is None: return None
            v = row.get(col)
            if v is None or v == "" or str(v) in ("nan", "NaN"): return None
            try: return float(v)
            except: return None

        def fmt_date(col):
            s = str(col)
            return f"{s[:4]}-{s[4:6]}-{s[6:]}"

        # 计算单季 EPS：累计 EPS 相邻报告期相减（同年内）
        cumulative = {}
        for col in period_cols:
            cumulative[col] = safe_float(eps_row, col)

        def single_quarter_eps(col, all_cols):
            """
            col 格式 YYYYMMDD；Q1 = 累计值，其余 = 本期累计 - 上期累计
            """
            suffix = col[4:]   # MMDD
            if suffix == "0331":    # Q1 直接用累计
                return cumulative.get(col)
            year = col[:4]
            prev_map = {"0630": f"{year}0331", "0930": f"{year}0630", "1231": f"{year}0930"}
            prev_col = prev_map.get(suffix)
            if not prev_col or prev_col not in cumulative:
                return None
            cur  = cumulative.get(col)
            prev = cumulative.get(prev_col)
            if cur is None or prev is None: return None
            return cur - prev

        results = []
        for i, col in enumerate(period_cols[:16]):     # 最近16个季度
            eps_single = single_quarter_eps(col, period_cols)
            if eps_single is None:
                continue

            # 同比：找去年同期
            year  = int(col[:4])
            suffix = col[4:]
            prev_year_col = f"{year-1}{suffix}"
            eps_prev = single_quarter_eps(prev_year_col, period_cols) if prev_year_col in cumulative else None
            eps_yoy = None
            if eps_prev and eps_prev != 0:
                eps_yoy = (eps_single - eps_prev) / abs(eps_prev) * 100

            # 商誉占净利润比例（简单风险指标）
            gw  = safe_float(goodwill_row, col)
            pft = safe_float(profit_row, col)
            goodwill_ratio = (gw / pft) if (gw and pft and pft != 0) else None

            roe = safe_float(roe_row, col)
            results.append({
                "code": code,
                "report_date": fmt_date(col),
                "eps": round(eps_single, 4),
                "eps_yoy": round(eps_yoy, 2) if eps_yoy is not None else None,
                "revenue_yoy": safe_float(rev_growth, col),
                "roe": roe,
                "goodwill_ratio": round(goodwill_ratio, 4) if goodwill_ratio is not None else None,
                "non_recurring_ratio": None,   # 此接口无此字段
            })

        _out({"ok": True, "data": results})
    except Exception as e:
        import traceback
        _err(f"fundamentals failed: {e}\n{traceback.format_exc()}")


def fetch_northbound(args):
    """
    用个股主力资金净流向替代北向资金（北向接口数据延迟且极慢）。
    主力净流入 = 超大单 + 大单净买入，是机构/游资活动的实时代理指标。
    """
    ak = _ak()
    code = args.code
    market = "sh" if _market_prefix(code) == "SH" else "sz"
    try:
        df = ak.stock_individual_fund_flow(stock=code, market=market)
        if df is None or df.empty:
            _out({"ok": True, "data": []})
            return
        df = df.rename(columns={"日期": "date", "主力净流入-净额": "net_flow"})
        df["date"] = df["date"].astype(str).str[:10]
        rows = [
            {"code": code, "date": str(r["date"]), "net_flow": float(r.get("net_flow") or 0)}
            for _, r in df.iterrows()
        ]
        _out({"ok": True, "data": rows})
    except Exception as e:
        _err(f"northbound failed: {e}")


def fetch_dragon_tiger(args):
    ak = _ak()
    date = (args.date or datetime.now().strftime("%Y%m%d")).replace("-", "")
    try:
        df = ak.stock_lhb_detail_em(start_date=date, end_date=date)
        if df is None or df.empty:
            _out({"ok": True, "data": []})
            return
        rename = {"代码": "code", "名称": "name", "上榜日": "date",
                  "解读": "reason", "上榜原因": "reason",
                  "龙虎榜净买额": "net_buy", "机构买入净额": "institution_net"}
        df = df.rename(columns=rename)
        rows = []
        for _, r in df.iterrows():
            rows.append({
                "code": str(r.get("code", "")),
                "date": str(r.get("date", ""))[:10],
                "reason": str(r.get("reason", "")),
                "net_buy": float(r.get("net_buy") or 0) if "net_buy" in r else None,
                "institution_net": float(r.get("institution_net") or 0) if "institution_net" in r else None,
                "raw": {k: (str(v) if v is not None else None) for k, v in r.items()}
            })
        _out({"ok": True, "data": rows})
    except Exception as e:
        _err(f"dragon_tiger failed: {e}")


def fetch_index(args):
    """
    大盘指数日线。优先用新浪数据源（stock_zh_index_daily），
    不依赖 curl_cffi，在系统代理环境下也能正常访问。
    symbol 格式：sh000001（上证）/ sz399006（创业板）/ sz399300（沪深300）
    """
    ak = _ak()
    code = args.code  # 传入如 000001 / 399006
    # 自动补前缀
    if not code.startswith(("sh", "sz")):
        prefix = "sh" if code.startswith(("000", "001")) else "sz"
        symbol = prefix + code
    else:
        symbol = code
    try:
        df = ak.stock_zh_index_daily(symbol=symbol)
        if df is None or df.empty:
            _out({"ok": True, "data": []})
            return
        rename = {"date": "date", "open": "open", "high": "high",
                  "low": "low", "close": "close", "volume": "volume"}
        df = df.rename(columns=rename)
        df["date"] = df["date"].astype(str).str[:10]
        # 只取近 400 个交易日
        df = df.sort_values("date").tail(400)
        # 补充 pct_chg
        df["pct_chg"] = df["close"].pct_change() * 100
        df["amount"] = 0
        _out({"ok": True, "data": df.to_dict(orient="records")})
    except Exception as e:
        _err(f"index failed: {e}")


def fetch_stock_info(args):
    ak = _ak()
    code = args.code
    try:
        info = {}
        name_fallback = ""
        # 方案一：东方财富个股详情（有行业，但依赖 push2.eastmoney.com，网络不通时会失败）
        try:
            df = ak.stock_individual_info_em(symbol=code)
            for _, r in df.iterrows():
                info[str(r.get("item", ""))] = str(r.get("value", ""))
        except Exception:
            pass
        raw_name = info.get("股票简称") or info.get("股票名称") or ""
        # 方案二：新浪 A 股代码名称列表（push2 不通时的名称兜底）
        if not raw_name:
            try:
                df2 = ak.stock_info_a_code_name()
                rows = df2[df2["code"] == code]
                if not rows.empty:
                    name_fallback = str(rows.iloc[0]["name"])
            except Exception:
                pass
        # 方案三：baostock 行业兜底（证监会行业分类，使用 socket，不受 TLS 指纹限制）
        if not info.get("行业"):
            try:
                import re as _re, baostock as bs
                prefix = "sh" if _market_prefix(code) == "SH" else "sz"
                bs.login()
                rs = bs.query_stock_industry(code=f"{prefix}.{code}")
                if rs.error_code == "0" and rs.next():
                    row = dict(zip(rs.fields, rs.get_row_data()))
                    ind = row.get("industry", "")
                    # 去掉 "C15" 这类证监会字母+数字前缀
                    ind = _re.sub(r"^[A-Z]\d+", "", ind).strip()
                    if ind:
                        info["行业"] = ind
                bs.logout()
            except Exception:
                pass
        # akshare 部分接口名称字符间有空格，统一去掉
        raw_name = raw_name or name_fallback
        clean_name = raw_name.replace(" ", "").replace("　", "").strip()
        _out({"ok": True, "data": {
            "code": code,
            "name": clean_name,
            "industry": info.get("行业") or "",
            "market": _market_prefix(code),
            "raw": info,
        }})
    except Exception as e:
        _err(f"stock_info failed: {e}")


def fetch_realtime(args):
    ak = _ak()
    codes = [c.strip() for c in (args.codes or "").split(",") if c.strip()]
    try:
        df = ak.stock_zh_a_spot_em()
        if df is None or df.empty:
            _out({"ok": True, "data": []})
            return
        rename = {"代码": "code", "名称": "name", "最新价": "price",
                  "涨跌幅": "pct_chg", "成交量": "volume", "成交额": "amount",
                  "换手率": "turnover", "总市值": "market_cap"}
        df = df.rename(columns=rename)
        df["code"] = df["code"].astype(str)
        if codes:
            df = df[df["code"].isin(codes)]
        _out({"ok": True, "data": df.to_dict(orient="records")})
    except Exception as e:
        _err(f"realtime failed: {e}")


def fetch_market_sentiment(args):
    ak = _ak()
    try:
        now = datetime.now()
        today_str = now.strftime("%Y%m%d")
        market_close = now.replace(hour=15, minute=0, second=0, microsecond=0)
        # 使用交易日历确定"最近已收盘交易日"
        try:
            cal = ak.tool_trade_date_hist_sina()
            trade_dates = set(cal["trade_date"].astype(str).str.replace("-", ""))
            today_is_trading = today_str in trade_dates
            if today_is_trading and now >= market_close:
                # 今天是交易日且已收盘，取今日最终数据
                query_date = today_str
            else:
                # 非交易日 or 盘中：取最近已收盘的交易日
                past = sorted([d for d in trade_dates if d < today_str], reverse=True)
                query_date = past[0] if past else today_str
        except Exception:
            query_date = today_str if now >= market_close else (now - timedelta(days=1)).strftime("%Y%m%d")
        query_label = f"{query_date[:4]}-{query_date[4:6]}-{query_date[6:]}"

        out = {"date": query_label}
        # 涨跌停
        try:
            df_up = ak.stock_zt_pool_em(date=query_date)
            out["limit_up_count"] = int(len(df_up)) if df_up is not None else 0
        except Exception:
            out["limit_up_count"] = None
        try:
            df_dt = ak.stock_zt_pool_dtgc_em(date=query_date)
            out["limit_down_count"] = int(len(df_dt)) if df_dt is not None else 0
        except Exception:
            out["limit_down_count"] = None
        # 北向资金
        try:
            hsgt = ak.stock_hsgt_fund_flow_summary_em()
            out["hsgt_summary"] = hsgt.to_dict(orient="records") if hsgt is not None else []
        except Exception:
            out["hsgt_summary"] = []
        _out({"ok": True, "data": out})
    except Exception as e:
        _err(f"market_sentiment failed: {e}")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("price"); p.add_argument("--code", required=True); p.add_argument("--start"); p.add_argument("--end")
    p = sub.add_parser("fundamentals"); p.add_argument("--code", required=True)
    p = sub.add_parser("northbound"); p.add_argument("--code", required=True)
    p = sub.add_parser("dragon_tiger"); p.add_argument("--date")
    p = sub.add_parser("index"); p.add_argument("--code", required=True)
    p = sub.add_parser("stock_info"); p.add_argument("--code", required=True)
    p = sub.add_parser("realtime"); p.add_argument("--codes", default="")
    p = sub.add_parser("market_sentiment")

    args = parser.parse_args()
    try:
        {
            "price": fetch_price,
            "fundamentals": fetch_fundamentals,
            "northbound": fetch_northbound,
            "dragon_tiger": fetch_dragon_tiger,
            "index": fetch_index,
            "stock_info": fetch_stock_info,
            "realtime": fetch_realtime,
            "market_sentiment": fetch_market_sentiment,
        }[args.cmd](args)
    except Exception as e:
        _err(f"{type(e).__name__}: {e}\n{traceback.format_exc()}")


if __name__ == "__main__":
    main()
