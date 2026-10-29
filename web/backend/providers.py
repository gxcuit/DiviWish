"""Bounded live quote requests. Dividend snapshots are imported separately."""

import datetime as dt
import json
import re

import requests

from .calculations import number


def search_stocks(query):
    response = requests.get("https://smartbox.gtimg.cn/s3/", params={"q": query, "t": "all"},
                            headers={"User-Agent": "Mozilla/5.0"}, timeout=(2, 4))
    response.raise_for_status()
    response.encoding = "gbk"
    match = re.search(r'v_hint\s*=\s*("(?:\\.|[^"\\])*")', response.text)
    if match is None:
        raise ValueError("股票搜索返回格式无效")
    content = json.loads(match.group(1))
    if content in {"", "N"}:
        return []
    results = []
    seen = set()
    for entry in content.split("^"):
        fields = entry.split("~")
        if len(fields) < 5:
            continue
        exchange, code, name, _pinyin, kind = fields[:5]
        market = "HK" if exchange == "hk" else "A" if exchange in {"sh", "sz", "bj"} else None
        if market is None or not kind.startswith("GP") or not name.strip():
            continue
        if market == "A" and kind != "GP-A":
            continue
        if re.fullmatch(r"[0-9]{5}" if market == "HK" else r"[0-9]{6}", code) is None:
            continue
        identity = (market, code)
        if identity in seen:
            continue
        seen.add(identity)
        results.append({"name": name.strip(), "code": code, "market": market})
        if len(results) == 10:
            break
    return results


def symbol_for(stock):
    if stock["market"] == "HK":
        return "hk" + stock["code"]
    first = stock["code"][0]
    prefix = "sh" if first == "6" else "bj" if first in "489" else "sz"
    return prefix + stock["code"]


def quote_date(value):
    digits = re.sub(r"\D", "", value)
    if len(digits) < 8:
        return None
    try:
        return dt.datetime.strptime(digits[:8], "%Y%m%d").date().isoformat()
    except ValueError:
        return None


def fetch_quotes(stocks):
    expected = {symbol_for(stock): stock["id"] for stock in stocks}
    if not expected:
        return {}, []
    response = requests.get("https://qt.gtimg.cn/q=" + ",".join(expected),
                            headers={"User-Agent": "Mozilla/5.0"}, timeout=(4, 8))
    response.raise_for_status()
    response.encoding = "gbk"
    quotes = {}
    for symbol, content in re.findall(r'v_([a-z]+\d+)="([^"\r\n]*)"', response.text):
        if symbol not in expected:
            continue
        fields = content.split("~")
        if len(fields) < 33:
            continue
        try:
            price = number(float(fields[3]))
            change = number(float(fields[32]))
        except (ValueError, TypeError):
            continue
        day = quote_date(fields[30])
        if price is None or price <= 0 or day is None:
            continue
        quotes[expected[symbol]] = {"price": price, "change_pct": change / 100 if change is not None else None,
                                     "quote_date": day}
    errors = [f"{symbol}：腾讯报价或交易日期缺失，保留原值" for symbol, stock_id in expected.items() if stock_id not in quotes]
    return quotes, errors


def fetch_fx():
    response = requests.get("https://api.exchangerate-api.com/v4/latest/HKD", timeout=(4, 8))
    response.raise_for_status()
    value = number(response.json().get("rates", {}).get("CNY"))
    if value is None or not 0 < value < 10:
        raise ValueError("HKD/CNY 汇率缺失或无效")
    return value


def fetch_kline(stock, period):
    """Fetch one native timeframe; HK requires its own adjustment endpoint."""
    if period not in {"day", "week", "month"}:
        raise ValueError("无效 K 线周期")
    symbol = symbol_for(stock)
    endpoint = "hkfqkline" if stock["market"] == "HK" else "fqkline"
    response = requests.get(f"https://web.ifzq.gtimg.cn/appstock/app/{endpoint}/get",
                            params={"param": f"{symbol},{period},,,30,qfq"},
                            headers={"User-Agent": "Mozilla/5.0"}, timeout=(3, 6))
    response.raise_for_status()
    payload = response.json()
    if payload.get("code", 0) != 0:
        raise ValueError("K 线接口返回错误")
    data = payload.get("data", {}).get(symbol, {})
    adjusted = "qfq" + period
    # Tencent can return bare candles when no adjustment data is available.
    # Keep that fact visible instead of labelling unadjusted prices as qfq.
    adjustment = "qfq" if adjusted in data else "none"
    rows = data.get(adjusted) if adjusted in data else data.get(period)
    if not isinstance(rows, list):
        raise ValueError("K 线数据缺失")
    bars = {}
    for row in rows:
        if not isinstance(row, list) or len(row) < 3:
            raise ValueError("K 线格式无效")
        day = dt.date.fromisoformat(row[0]).isoformat()
        close = number(float(row[2]))
        if close is None:
            raise ValueError("K 线收盘价无效")
        if day in bars and bars[day] != close:
            raise ValueError("K 线日期重复且价格不一致")
        bars[day] = close
    quote = data.get("qt", {}).get(symbol, [])
    live_quote = None
    if len(quote) > 30:
        try:
            price = number(float(quote[3]))
            day = quote_date(quote[30])
            if price is not None and price > 0 and day:
                live_quote = {"price": price, "quote_date": day}
        except (TypeError, ValueError):
            pass
    return {"bars": [{"date": day, "close": close} for day, close in sorted(bars.items())],
            "adjustment": adjustment, "quote": live_quote}
