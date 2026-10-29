"""Dividend calculations ported from the user's daily dividend scripts."""

import bisect
import math
from decimal import Decimal

MIN_HISTORY_SAMPLES = 60
GRID_DEFAULTS = {"grid_start": 0.03, "grid_end": 0.08, "grid_step": 0.005}
YIELD_DEFAULTS = {"yield_basis": "annual", "custom_yield": None}


def selected_basis(stock, fx_rate):
    price = number(stock.get("price"))
    basis = stock.get("yield_basis", "annual")
    if basis == "custom":
        rate = number(stock.get("custom_yield"))
        cash = price * rate if price and price > 0 and rate is not None else None
        return rate, cash
    dividend = number(stock.get("rolling_dividend" if basis == "rolling" else "annual_dividend"))
    conversion = number(fx_rate) if stock.get("market") == "HK" else 1
    cash = dividend / conversion if dividend is not None and conversion and conversion > 0 else None
    rate = cash / price if cash is not None and price and price > 0 else None
    return rate, cash


def grid_levels(stock):
    settings = {key: number(stock.get(key, default)) for key, default in GRID_DEFAULTS.items()}
    if any(value is None or not 0 < value <= 1 for value in settings.values()):
        raise ValueError("网格起止股息率和步长须为 (0,100%] 内的有效数字")
    start, end, step = (Decimal(str(settings[key])) for key in ("grid_start", "grid_end", "grid_step"))
    if start > end:
        raise ValueError("网格起始股息率不能大于结束股息率")
    count = int((end - start) / step) + 1
    if count > 201:
        raise ValueError("网格最多 201 档，请增大每格步长或缩小范围")
    return [float(start + step * index) for index in range(count)]


def yield_grid(stock, fx_rate):
    _rate, dividend = selected_basis(stock, fx_rate)
    price = number(stock.get("price"))
    rows = []
    for target in grid_levels(stock):
        target_price = dividend / target if dividend is not None else None
        rows.append({"yield": target, "price": target_price,
                     "reached": price <= target_price if price is not None and target_price is not None else None})
    return rows


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def yield_status(gap):
    if gap is None:
        return "neutral"
    if gap >= -1e-12:
        return "green"
    if gap >= -0.0025 - 1e-12:
        return "blue"
    if gap >= -0.003 - 1e-12:
        return "orange"
    return "neutral"


def derive(stock, fx_rate, a_prices=None):
    result = dict(stock)
    price = number(stock.get("price"))
    annual = number(stock.get("annual_dividend"))
    rolling = number(stock.get("rolling_dividend"))
    target = number(stock.get("target_yield"))
    fx_rate = number(fx_rate)
    is_hk = stock.get("market") == "HK"
    connect_factor = number(stock.get("connect_factor"))
    denominator = price if not is_hk else price * fx_rate if price and fx_rate else None
    valid = denominator is not None and denominator > 0
    annual_yield = annual / denominator if valid and annual is not None else None
    rolling_yield = rolling / denominator if valid and rolling is not None else None
    selected_yield, basis_dividend = selected_basis(stock, fx_rate)
    target_price = basis_dividend / target if basis_dividend is not None and target and target > 0 else None
    gap = selected_yield - target if selected_yield is not None and target is not None else None
    start_price = number(stock.get("year_start_price"))
    samples = stock.get("history") or []
    values = sorted(value for row in samples if (value := number(row.get("yield"))) is not None and value >= 0)
    valid_history = len(values) >= MIN_HISTORY_SAMPLES
    percentile = bisect.bisect_right(values, annual_yield + 1e-12) / len(values) if valid_history and annual_yield is not None else None
    result.update({
        "yield_basis": stock.get("yield_basis", "annual"),
        "custom_yield": stock.get("custom_yield"),
        "selected_yield": selected_yield,
        "basis_dividend": basis_dividend,
        "dividend_yield": annual_yield,
        "rolling_yield": rolling_yield,
        "target_price": target_price,
        "yield_gap": gap,
        "status": yield_status(gap),
        "year_change": price / start_price - 1 if price and start_price and start_price > 0 else None,
        "percentile": percentile,
        "percentile_count": len(values),
        "percentile_start": stock.get("percentile_start"),
        "percentile_end": stock.get("percentile_end"),
        "ah_premium": None,
        "hk_net_yield": annual_yield * 0.9 if is_hk and annual_yield is not None else None,
        "connect_yield": annual_yield * connect_factor if is_hk and annual_yield is not None and connect_factor is not None else None,
    })
    a_price = (a_prices or {}).get(stock.get("a_code")) or stock.get("a_price")
    if is_hk and a_price and valid:
        result["ah_premium"] = a_price / denominator - 1
    for probability in (60, 90):
        quantile = values[math.ceil(probability / 100 * len(values)) - 1] if valid_history else None
        quantile_price = annual / quantile if annual is not None and quantile and quantile > 0 else None
        if is_hk:
            quantile_price = quantile_price / fx_rate if quantile_price is not None and fx_rate else None
        result[f"quantile_{probability}_yield"] = quantile
        result[f"quantile_{probability}_price"] = quantile_price
    return result
