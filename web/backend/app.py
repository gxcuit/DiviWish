"""Flask JSON API backed by a private, local SQLite database."""

import csv
from io import StringIO
import json
import os
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlparse

from flask import Flask, Response, g, jsonify, request
from werkzeug.exceptions import HTTPException

from .calculations import GRID_DEFAULTS, YIELD_DEFAULTS, derive, grid_levels, number, yield_grid
from .importer import date_string, timestamp
from . import providers
from .bollinger import BollingerService

ROOT = Path(__file__).resolve().parent
EDITABLE = {"code", "name", "sector", "market", "price", "annual_dividend", "rolling_dividend", "target_yield",
            "confirmed", "ex_dividend_date", "watched", "a_code", "year_start_price", *GRID_DEFAULTS, *YIELD_DEFAULTS}
DEFAULT_STOCK = {
    **GRID_DEFAULTS,
    **YIELD_DEFAULTS,
    "price": None, "change_pct": None, "annual_dividend": None, "rolling_dividend": None,
    "target_yield": None, "confirmed": False, "ex_dividend_date": None, "quote_date": None,
    "updated_at": None, "annual_year": None, "year_start_price": None, "percentile_start": None,
    "percentile_end": None, "a_code": None, "source": "手动录入", "verification_note": None,
    "dividends": [], "history": [], "connect_factor": None,
}


def create_app(config=None):
    app = Flask(__name__)
    bollinger = BollingerService()
    app.config.update(
        DATABASE=os.environ.get("DIVIDEND_DATABASE", str(ROOT / "data" / "dividends.sqlite3")),
        SEED_PATH=str(ROOT / "data" / "seed.json"),
        MAX_CONTENT_LENGTH=128 * 1024,
        JSON_SORT_KEYS=False,
    )
    if config:
        app.config.update(config)
    app.json.ensure_ascii = False

    def database():
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DATABASE"], timeout=15)
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys=ON")
            g.db.execute("PRAGMA busy_timeout=15000")
        return g.db

    @app.teardown_appcontext
    def close_database(_error=None):
        connection = g.pop("db", None)
        if connection is not None:
            connection.close()

    def metadata():
        return {row["key"]: json.loads(row["value"]) for row in database().execute("SELECT key,value FROM metadata")}

    def set_meta(key, value):
        database().execute("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                           (key, json.dumps(value, ensure_ascii=False, allow_nan=False)))

    def read_row(row):
        document = {**DEFAULT_STOCK, **json.loads(row["document"])}
        return {**document, "id": row["id"], "code": row["code"], "market": row["market"],
                "name": row["name"], "sector": row["sector"], "watched": bool(row["watched"])}

    def raw_stocks():
        return [read_row(row) for row in database().execute("SELECT * FROM stocks ORDER BY id")]

    def get_stock(stock_id):
        row = database().execute("SELECT * FROM stocks WHERE id=?", (stock_id,)).fetchone()
        if row is None:
            return None
        return read_row(row)

    def sector_name(value):
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 30:
            raise ValueError("板块名称须为 1 至 30 个字符")
        value = value.strip()
        if value == "全部":
            raise ValueError("“全部”为筛选入口，不能用作板块名称")
        return value

    def ensure_sector(name):
        database().execute("INSERT OR IGNORE INTO sectors(name) VALUES(?)", (sector_name(name),))

    def sector_records():
        return [dict(row) for row in database().execute(
            "SELECT sectors.id,sectors.name,count(stocks.id) AS stock_count FROM sectors "
            "LEFT JOIN stocks ON stocks.sector=sectors.name GROUP BY sectors.id ORDER BY sectors.id")]

    def save_stock(stock, imported=False):
        ensure_sector(stock["sector"])
        document = {key: value for key, value in stock.items() if key not in {"id", "code", "market", "name", "sector", "watched"}}
        serialized = json.dumps(document, ensure_ascii=False, allow_nan=False)
        if "id" in stock:
            database().execute("UPDATE stocks SET code=?,market=?,name=?,sector=?,watched=?,document=? WHERE id=?",
                               (stock["code"], stock["market"], stock["name"], stock["sector"], int(stock.get("watched", False)), serialized, stock["id"]))
            return stock["id"]
        cursor = database().execute("INSERT INTO stocks(code,market,name,sector,watched,document,imported) VALUES(?,?,?,?,?,?,?)",
                                    (stock["code"], stock["market"], stock["name"], stock["sector"], int(stock.get("watched", False)), serialized, int(imported)))
        return cursor.lastrowid

    def import_seed(seed):
        if not isinstance(seed, dict) or not isinstance(seed.get("stocks"), list) or not seed["stocks"]:
            raise ValueError("导入数据为空或格式无效")
        for incoming in seed["stocks"]:
            if incoming.get("market") not in {"A", "HK"} or not incoming.get("code") or not incoming.get("name"):
                raise ValueError("导入数据缺少市场、股票代码或名称")
        with database():
            for incoming in seed["stocks"]:
                existing = database().execute("SELECT * FROM stocks WHERE code=? AND market=?", (incoming["code"], incoming["market"])).fetchone()
                if existing and not existing["imported"]:
                    continue
                stock = {**DEFAULT_STOCK, **incoming}
                if existing:
                    previous_stock = read_row(existing)
                    stock.update(id=existing["id"], watched=bool(existing["watched"]), sector=existing["sector"])
                    stock.update({key: previous_stock[key] for key in (*GRID_DEFAULTS, *YIELD_DEFAULTS)})
                save_stock(stock, imported=True)
            previous = metadata()
            for key, value in (seed.get("meta") or {}).items():
                if key != "last_refresh":
                    set_meta(key, value)
            if "last_refresh" not in previous:
                set_meta("last_refresh", None)
        return len(seed["stocks"])

    def rendered(stock, include_detail=False):
        stocks = raw_stocks()
        a_prices = {row["code"]: row["price"] for row in stocks if row["market"] == "A" and row.get("price")}
        result = derive(stock, metadata().get("fx_rate"), a_prices)
        result.pop("connect_factor", None)
        result.pop("a_price", None)
        if include_detail:
            result["yield_grid"] = yield_grid(stock, metadata().get("fx_rate"))
        if not include_detail:
            result.pop("dividends", None)
            result.pop("history", None)
        return result

    @app.before_request
    def protect_local_writes():
        if request.method not in {"POST", "PATCH", "DELETE", "PUT"}:
            return None
        origin = request.headers.get("Origin")
        if origin and urlparse(origin).hostname not in {"localhost", "127.0.0.1", "::1"}:
            return jsonify(error="仅允许本机页面修改数据"), 403
        if request.headers.get("Sec-Fetch-Site") == "cross-site":
            return jsonify(error="不接受跨站写入请求"), 403
        if request.method != "DELETE" and not request.is_json:
            return jsonify(error="请使用 application/json 请求"), 415
        return None

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error=error.description), error.code

    @app.errorhandler(sqlite3.IntegrityError)
    def duplicate_error(_error):
        database().rollback()
        return jsonify(error="该市场和股票代码已存在"), 409

    @app.errorhandler(ValueError)
    def value_error(error):
        database().rollback()
        return jsonify(error=str(error)), 400

    @app.errorhandler(Exception)
    def unexpected_error(error):
        database().rollback()
        app.logger.exception("API request failed", exc_info=error)
        return jsonify(error="服务器处理失败，已有数据已保留；请查看本机后端日志"), 500

    def validate(data, existing=None):
        if not isinstance(data, dict) or not data:
            raise ValueError("请填写股票资料")
        unknown = set(data) - EDITABLE
        if unknown:
            raise ValueError("不支持的字段：" + "、".join(sorted(unknown)))
        stock = {**DEFAULT_STOCK, **(existing or {}), **data}
        for field in ("name", "sector", "code"):
            value = stock.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > 80:
                raise ValueError(f"{field} 必须为 1 至 80 个字符")
            stock[field] = value.strip()
        stock["sector"] = sector_name(stock["sector"])
        grid_levels(stock)
        if not isinstance(stock["yield_basis"], str) or stock["yield_basis"] not in {"annual", "rolling", "custom"}:
            raise ValueError("股息率口径只能为年度、滚动年度或自定义")
        custom = stock.get("custom_yield")
        if custom is not None:
            custom = number(custom)
            if custom is None or not 0 <= custom <= 1:
                raise ValueError("自定义股息率须为 0% 至 100% 的有效数字")
            stock["custom_yield"] = custom
        if stock["yield_basis"] == "custom" and custom is None:
            raise ValueError("选择自定义口径时，请填写自定义股息率")
        market = stock.get("market")
        if market not in {"A", "HK"}:
            raise ValueError("市场只能为 A 或 HK")
        length = 6 if market == "A" else 5
        if re.fullmatch(rf"\d{{{length}}}", stock["code"]) is None:
            raise ValueError(f"股票代码需要 {length} 位数字")
        for field in ("price", "annual_dividend", "rolling_dividend", "target_yield", "year_start_price"):
            value = stock.get(field)
            if value is None:
                continue
            parsed = number(value)
            if parsed is None or parsed < 0:
                raise ValueError(f"{field} 需要有效的非负数字")
            if field in {"price", "year_start_price", "target_yield"} and parsed <= 0:
                raise ValueError(f"{field} 必须大于 0")
            if field == "target_yield" and parsed > 1:
                raise ValueError("目标股息率须为 (0,1] 之间的小数，例如 0.05")
            stock[field] = parsed
        for field in ("confirmed", "watched"):
            if field in data and not isinstance(data[field], bool):
                raise ValueError(f"{field} 必须为布尔值")
        ex_date = stock.get("ex_dividend_date")
        if ex_date is not None and (not isinstance(ex_date, str) or date_string(ex_date) != ex_date):
            raise ValueError("除息日格式须为 YYYY-MM-DD")
        if stock.get("a_code") is not None and (not isinstance(stock["a_code"], str) or re.fullmatch(r"\d{6}", stock["a_code"]) is None):
            raise ValueError("对应 A 股代码需要 6 位数字")
        if existing and any(field in data and data[field] != existing.get(field) for field in ("annual_dividend", "code", "market")):
            stock.update(dividends=[], history=[], percentile_start=None, percentile_end=None, annual_year=None,
                         source="手动编辑（分红或证券身份已变更，历史对比已清除）", verification_note="手动分红需自行核实；相关历史对比已清除。")
            if "rolling_dividend" not in data:
                stock["rolling_dividend"] = None
            if "confirmed" not in data:
                stock["confirmed"] = False
            identity_changed = any(field in data and data[field] != existing.get(field) for field in ("code", "market"))
            if identity_changed:
                for field in ("price", "annual_dividend", "ex_dividend_date", "year_start_price", "a_code"):
                    if field not in data:
                        stock[field] = None
                stock.update(quote_date=None, change_pct=None)
                if "yield_basis" not in data:
                    stock.update(**YIELD_DEFAULTS)
        if "price" in data and (not existing or data["price"] != existing.get("price")):
            stock.update(quote_date=None, change_pct=None, source="手动报价；交易日期待核实")
        if set(data) - {"watched"}:
            stock["updated_at"] = timestamp()
        return stock

    @app.get("/api/health")
    def health():
        return jsonify(status="ok", database="sqlite", count=database().execute("SELECT count(*) FROM stocks").fetchone()[0])

    @app.get("/api/stocks")
    def stocks_list():
        records = raw_stocks()
        meta = metadata()
        a_prices = {row["code"]: row["price"] for row in records if row["market"] == "A" and row.get("price")}
        results = []
        for stock in records:
            result = derive(stock, meta.get("fx_rate"), a_prices)
            for key in ("history", "dividends", "connect_factor", "a_price"):
                result.pop(key, None)
            results.append(result)
        return jsonify(stocks=results, sectors=[sector["name"] for sector in sector_records()],
                       meta={"quote_date": meta.get("quote_date"), "imported_at": meta.get("imported_at"),
                             "last_refresh": meta.get("last_refresh"), "fx_rate": meta.get("fx_rate"),
                             "source": meta.get("source", "本地 SQLite")})

    @app.get("/api/stocks/<int:stock_id>")
    def stock_detail(stock_id):
        stock = get_stock(stock_id)
        if stock is None:
            return jsonify(error="股票不存在"), 404
        return jsonify(rendered(stock, include_detail=True))

    @app.get("/api/stocks/<int:stock_id>/boll")
    def stock_boll(stock_id):
        stock = get_stock(stock_id)
        if stock is None:
            return jsonify(error="股票不存在"), 404
        return jsonify(bollinger.get(stock, force=request.args.get("refresh") == "1"))

    @app.get("/api/sectors")
    def list_sectors():
        return jsonify(sectors=[{**sector, "protected": sector["name"] == "未分类"} for sector in sector_records()])

    @app.post("/api/sectors")
    def add_sector():
        data = request.get_json()
        name = sector_name(data.get("name") if isinstance(data, dict) else None)
        if database().execute("SELECT 1 FROM sectors WHERE name=?", (name,)).fetchone():
            return jsonify(error="该板块已存在"), 409
        with database():
            cursor = database().execute("INSERT INTO sectors(name) VALUES(?)", (name,))
        return jsonify(id=cursor.lastrowid, name=name, stock_count=0, protected=False), 201

    @app.patch("/api/sectors/<int:sector_id>")
    def rename_sector(sector_id):
        existing = database().execute("SELECT * FROM sectors WHERE id=?", (sector_id,)).fetchone()
        if existing is None:
            return jsonify(error="板块不存在"), 404
        if existing["name"] == "未分类":
            return jsonify(error="“未分类”用于保留移出板块的股票，不能重命名"), 400
        data = request.get_json()
        name = sector_name(data.get("name") if isinstance(data, dict) else None)
        if database().execute("SELECT 1 FROM sectors WHERE name=? AND id<>?", (name, sector_id)).fetchone():
            return jsonify(error="该板块已存在"), 409
        with database():
            database().execute("UPDATE sectors SET name=? WHERE id=?", (name, sector_id))
            database().execute("UPDATE stocks SET sector=? WHERE sector=?", (name, existing["name"]))
        return jsonify(message="板块已重命名", name=name)

    @app.delete("/api/sectors/<int:sector_id>")
    def delete_sector(sector_id):
        existing = database().execute("SELECT * FROM sectors WHERE id=?", (sector_id,)).fetchone()
        if existing is None:
            return jsonify(error="板块不存在"), 404
        if existing["name"] == "未分类":
            return jsonify(error="“未分类”不能删除"), 400
        with database():
            ensure_sector("未分类")
            moved = database().execute("UPDATE stocks SET sector='未分类' WHERE sector=?", (existing["name"],)).rowcount
            database().execute("DELETE FROM sectors WHERE id=?", (sector_id,))
        return jsonify(message=f"板块已删除，{moved} 支股票已保留到未分类", moved=moved)

    @app.get("/api/stocks/search")
    def stock_search():
        query = request.args.get("q", "").strip()
        if not query:
            return jsonify(suggestions=[], message=None)
        if len(query) > 40:
            return jsonify(error="股票搜索最多输入 40 个字符"), 400
        records = raw_stocks()
        local = {(stock["market"], stock["code"]): stock for stock in records}
        suggestions = []
        seen = set()

        def add_suggestion(stock):
            identity = (stock["market"], stock["code"])
            if identity in seen:
                return
            existing = local.get(identity)
            suggestions.append({"name": stock["name"], "code": stock["code"], "market": stock["market"],
                                "sector": existing["sector"] if existing else None,
                                "existing": existing is not None})
            seen.add(identity)

        for stock in records:
            if query.casefold() in stock["name"].casefold() or query in stock["code"]:
                add_suggestion(stock)
        message = None
        try:
            for stock in providers.search_stocks(query):
                add_suggestion(stock)
        except (providers.requests.RequestException, ValueError):
            message = "联网搜索暂不可用，仅显示本机匹配结果；也可手动填写。"
        return jsonify(suggestions=suggestions[:10], message=message)

    @app.post("/api/stocks")
    def add_stock():
        stock = validate(request.get_json())
        with database():
            stock_id = save_stock(stock)
        return jsonify(rendered(get_stock(stock_id))), 201

    @app.patch("/api/stocks/<int:stock_id>")
    def edit_stock(stock_id):
        existing = get_stock(stock_id)
        if existing is None:
            return jsonify(error="股票不存在"), 404
        stock = validate(request.get_json(), existing)
        with database():
            save_stock(stock)
        return jsonify(rendered(get_stock(stock_id)))

    @app.delete("/api/stocks/<int:stock_id>")
    def delete_stock(stock_id):
        if get_stock(stock_id) is None:
            return jsonify(error="股票不存在"), 404
        with database():
            database().execute("DELETE FROM stocks WHERE id=?", (stock_id,))
        return jsonify(message="已删除")

    @app.post("/api/refresh")
    def refresh():
        records = raw_stocks()
        if not records:
            return jsonify(message="没有可刷新的股票", updated=0, errors=["请先添加股票"]), 400
        errors = []
        try:
            quotes, quote_errors = providers.fetch_quotes(records)
            errors.extend(quote_errors)
        except (providers.requests.RequestException, ValueError) as error:
            quotes = {}
            errors.append("腾讯行情请求失败，保留旧报价：" + str(error))
        fx_rate = None
        if quotes and any(stock["market"] == "HK" for stock in records):
            try:
                fx_rate = providers.fetch_fx()
            except (providers.requests.RequestException, ValueError) as error:
                errors.append("汇率请求失败，沿用原汇率：" + str(error))
        if not quotes:
            return jsonify(message="刷新失败，报价和更新时间保持不变", updated=0, errors=errors or ["没有收到有效行情"]), 502
        now = timestamp()
        updated = 0
        days = []
        with database():
            for stock in records:
                if stock["id"] not in quotes:
                    continue
                current = get_stock(stock["id"])
                if current is None or current["code"] != stock["code"] or current["market"] != stock["market"]:
                    errors.append(f"{stock['code']}：刷新期间股票已修改或删除，跳过旧报价")
                    continue
                current.update(quotes[stock["id"]], updated_at=now)
                current["source"] = "腾讯实时行情；分红及历史样本来自本地导入数据"
                save_stock(current)
                updated += 1
                if current.get("quote_date"):
                    days.append(current["quote_date"])
            if not updated:
                return jsonify(message="刷新期间标的已变更，没有应用旧报价", updated=0, errors=errors), 502
            if fx_rate is not None:
                set_meta("fx_rate", fx_rate)
            if days:
                set_meta("quote_date", max(days))
            set_meta("last_refresh", now)
        return jsonify(message=f"已更新 {updated} 支股票行情" + ("，部分数据未更新" if errors else ""), updated=updated, errors=errors)

    @app.get("/api/export")
    def export_csv():
        output = StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(["市场", "股票代码", "股票名", "板块", "价格", "报价日期", "年度每股股息RMB", "年度股息率", "滚动股息率", "目标股息率", "目标价格", "近5年历史百分位", "历史截至", "除息日", "自选", "选用股息率口径", "选用股息率", "自定义股息率"])
        for stock in stocks_list().get_json()["stocks"]:
            values = [stock[key] for key in ("market", "code", "name", "sector", "price", "quote_date", "annual_dividend", "dividend_yield", "rolling_yield", "target_yield", "target_price", "percentile", "percentile_end", "ex_dividend_date", "watched", "yield_basis", "selected_yield", "custom_yield")]
            writer.writerow(["'" + value if isinstance(value, str) and value.startswith(("=", "+", "-", "@")) else value for value in values])
        return Response("\ufeff" + output.getvalue(), mimetype="text/csv; charset=utf-8",
                        headers={"Content-Disposition": 'attachment; filename="dividends.csv"'})

    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    with app.app_context():
        connection = database()
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS stocks (
                id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, market TEXT NOT NULL,
                name TEXT NOT NULL, sector TEXT NOT NULL, watched INTEGER NOT NULL DEFAULT 0,
                imported INTEGER NOT NULL DEFAULT 0, document TEXT NOT NULL, UNIQUE(market,code)
            );
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sectors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
        """)
        connection.execute("INSERT OR IGNORE INTO sectors(name) SELECT sector FROM stocks GROUP BY sector ORDER BY MIN(id)")
        connection.commit()
        if not connection.execute("SELECT 1 FROM metadata WHERE key='initialized'").fetchone():
            seed_path = Path(app.config["SEED_PATH"])
            if seed_path.is_file():
                import_seed(json.loads(seed_path.read_text(encoding="utf-8")))
            with connection:
                set_meta("initialized", True)
        with connection:
            ensure_sector("未分类")
    return app


if __name__ == "__main__":
    from waitress import serve
    serve(create_app(), host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), threads=4)
