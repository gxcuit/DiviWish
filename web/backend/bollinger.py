"""BOLL(20, 2) from native daily/weekly/monthly closing prices."""

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import copy
import datetime as dt
import logging
import math
import statistics
import threading
import time

from . import providers
from .calculations import number

PERIODS = {"day": "日线", "week": "周线", "month": "月线"}
WINDOW = 20
MULTIPLIER = 2


def calculate_bands(bars):
    if len(bars) < WINDOW:
        return {"available": False, "count": len(bars), "error": f"仅有 {len(bars)} 根 K 线，需要至少 {WINDOW} 根"}
    samples = bars[-WINDOW:]
    closes = [number(bar.get("close")) for bar in samples]
    if any(close is None for close in closes):
        raise ValueError("K 线收盘价无效")
    middle = statistics.fmean(closes)
    deviation = statistics.pstdev(closes)
    lower, upper = middle - MULTIPLIER * deviation, middle + MULTIPLIER * deviation
    if not all(math.isfinite(value) for value in (lower, middle, upper)):
        raise ValueError("BOLL 计算结果无效")
    return {"available": True, "count": WINDOW, "start_date": samples[0]["date"],
            "last_date": samples[-1]["date"], "lower": lower, "middle": middle, "upper": upper}


def price_position(band, price):
    if price is None:
        return {"position": "unknown", "percent_b": None}
    lower, middle, upper = (band[key] for key in ("lower", "middle", "upper"))
    # A flat series has no width; %B is undefined, not zero or infinity.
    flat = math.isclose(lower, upper, rel_tol=1e-12, abs_tol=1e-12)
    if price < lower and not math.isclose(price, lower, rel_tol=1e-12):
        position = "below_lower"
    elif price > upper and not math.isclose(price, upper, rel_tol=1e-12):
        position = "above_upper"
    elif flat:
        position = "flat"
    elif math.isclose(price, lower, rel_tol=1e-12):
        position = "at_lower"
    elif math.isclose(price, upper, rel_tol=1e-12):
        position = "at_upper"
    elif math.isclose(price, middle, rel_tol=1e-12):
        position = "at_middle"
    else:
        position = "lower_half" if price < middle else "upper_half"
    return {"position": position, "percent_b": None if flat else (price - lower) / (upper - lower)}


class BollingerService:
    """Bounded in-memory cache, isolated from personal stock documents."""

    def __init__(self):
        self.cache = OrderedDict()
        self.lock = threading.Lock()

    def _load_period(self, stock, period):
        try:
            data = providers.fetch_kline(stock, period)
            band = {**calculate_bands(data["bars"]), "adjustment": data["adjustment"]}
            return {"period": period, "label": PERIODS[period], **band}, data.get("quote")
        except Exception:
            logging.getLogger(__name__).warning("BOLL K-line fetch failed: %s %s", providers.symbol_for(stock), period,
                                               exc_info=True)
            return {"period": period, "label": PERIODS[period], "available": False,
                    "error": "行情数据获取失败，请重试"}, None

    def get(self, stock, force=False):
        key = (stock["market"], stock["code"])
        with self.lock:
            entry = self.cache.get(key)
            cached = bool(not force and entry and time.monotonic() - entry[0] < 300)
            bundle = copy.deepcopy(entry[1]) if cached else None
        if bundle is None:
            with ThreadPoolExecutor(max_workers=3) as pool:
                results = list(pool.map(lambda period: self._load_period(stock, period), PERIODS))
            quotes = [quote for _band, quote in results if quote]
            bundle = {"bands": [band for band, _quote in results],
                      "quote": max(quotes, key=lambda quote: quote["quote_date"]) if quotes else None,
                      "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat()}
            # Failed/partial requests are retryable immediately; never hide them in the cache.
            if all(band["available"] for band in bundle["bands"]):
                with self.lock:
                    self.cache[key] = (time.monotonic(), copy.deepcopy(bundle))
                    self.cache.move_to_end(key)
                    while len(self.cache) > 128:
                        self.cache.popitem(last=False)
        quote = bundle["quote"]
        # Prefer a saved quote if it has a later trading date than a cached one.
        saved_price = number(stock.get("price"))
        if saved_price is not None and saved_price > 0 and (
                not quote or (stock.get("quote_date") or "") > quote["quote_date"]):
            quote = {"price": saved_price, "quote_date": stock.get("quote_date")}
            price_source = "本机保存报价"
        else:
            price_source = "腾讯报价" if quote else "暂无有效报价"
        price = quote["price"] if quote else None
        for band in bundle["bands"]:
            if band["available"]:
                band.update(price_position(band, price))
        return {"window": WINDOW, "multiplier": MULTIPLIER, "source": "腾讯证券",
                "price": price, "quote_date": quote["quote_date"] if quote else None,
                "price_source": price_source, "cached": cached,
                "fetched_at": bundle["fetched_at"], "bands": bundle["bands"]}
