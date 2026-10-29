# DiviWish API · Flask + SQLite

Run all commands from `web/` (the web application root):

```sh
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
.venv/Scripts/python.exe -m backend.app
```

On Linux/macOS replace `Scripts/python.exe` with `bin/python`. The service binds only `127.0.0.1:5000` using Waitress. The Next.js frontend proxies `/api/*`, so CORS configuration is unnecessary. Requests that mutate state require JSON; refresh accepts `{}`. The stock DELETE endpoint accepts an empty body.

SQLite is created at `backend/data/dividends.sqlite3`. Its first initialization loads `backend/data/seed.json`, a standalone snapshot containing only the workbook's stock fields and historical dividend samples, never holdings or unrelated workbook sheets. SQLite databases, WAL files and local virtual environments should be ignored by Git. Back up the SQLite file when the service is stopped.

Prepare the initial snapshot for a new database from the parent project's workbook and reports (read only):

```sh
python -X utf8 -m backend.importer --source .. --output backend/data/seed.json
```

The initial-snapshot tool inherits A-share sectors, reads stored formula values (`data_only=True`), includes pending data explicitly, and uses the latest dated `dividend_percentiles.json` report. Missing historical samples or dividend amounts remain unavailable. The source workbook and scripts are never executed or changed. Existing SQLite data is retained; replacing the seed does not overwrite an initialized database. Workbook reimport is no longer available through the UI or API.

Environment variables:

- `DIVIDEND_DATABASE`: alternate SQLite database path.
- `PORT`: backend listening port, default `5000`; update the frontend proxy origin to match if changed.

## Calculation and freshness

Annual dividend yield uses the latest disclosed full fiscal-year sum, not a single installment. Rolling annual dividend comes from the source report's strict `(latest period − 1 year, latest period]` calculation. Both are divided by the current price; for H shares the HKD price is converted to RMB with the imported or fetched HKD/CNY rate. A/H premium is `A price / (H price × FX) − 1`. HK net yield applies the workbook's 90% factor; Connect yield uses that security's saved coefficient (e.g. 80% or 72%), not a claim about a universal tax rate.

Target status thresholds follow the Excel workflow in `../scripts/update_dy.py`: green when selected-yield gap ≥ 0, blue when ≥ −0.25 percentage points, orange when ≥ −0.30 percentage points. Without a target, status is neutral. Target price uses the selected per-share cash basis / target yield; the default basis is annual dividend. HK target price is displayed in HKD.

Historical percentile is the empirical fraction of imported historical daily yields ≤ current annual yield; at least 60 valid daily samples are required. The inverse CDF uses rank `ceil(p × N)`. Imported historical yields retain the original script's announcement-date rule: a disclosed plan becomes effective from the next trading day, with the latest disclosed full fiscal year used on each day. The historical endpoint is never advanced by a live quote refresh. Samples are reconstructed from currently available dividend records, not historical plan-version snapshots; share-capital changes can affect nominal per-share comparisons. Editing annual dividend or security identity clears the associated historical comparison.

“刷新行情” only refreshes quotes via Tencent and HKD/CNY via exchangerate-api; each network operation has bounded connect/read timeouts. Quote dates come from the provider, never from the computer's current date. The old H-share cache only stores retrieval timestamps, so imported H-share quote dates remain unavailable until a successful live refresh; the retrieval date is recorded in the verification note. An A-share cached trade date is attached only if its cached price matches the workbook value. Missing or failed quotes preserve prior values and dates; a completely failed request returns 502 without advancing freshness metadata. Dividend announcements and historical samples remain the saved snapshot; live refresh does not extend them. The backend does not silently execute the original `run.cmd` or modify its workbook. Newly added symbols need manually verified dividend amounts.

## API

- `GET /api/health`
- `GET /api/stocks`: stocks, sector names and source metadata; no heavy historical arrays.
- `GET /api/stocks/<id>`: stock plus dividend installments and full historical samples.
- `GET /api/stocks/<id>/boll`: independent daily/weekly/monthly BOLL(20, 2), native Tencent candles with per-period availability, adjustment basis, dates and a quoted current price. Population standard deviation (ddof=0), including the latest potentially incomplete candle. A and HK use separate adjustment endpoints. No changes to stock documents. Complete successes use a bounded 5-minute memory cache; `?refresh=1` bypasses it. Failed/short histories are retryable and remain explicitly unavailable.
- PATCH `yield_basis` (`annual`, `rolling`, `custom`) and `custom_yield` (fraction in [0,1], required for custom). Defaults are annual and null. `selected_yield` is the chosen rate; `basis_dividend` is its implied cash amount in the stock's trading currency. Target prices, yield-gap status and yield grids use that basis. Custom yield remains the literal user percentage and implies `current quote × custom_yield` per-share cash; a quote refresh changes that implied cash and the resulting target prices. Missing rolling values do not fall back to annual. Annual historical percentiles, historical quantile prices and HK tax comparisons retain their annual basis.
- Stock detail includes `yield_grid` rows (`yield`, `price`, `reached`). PATCH `grid_start`, `grid_end`, `grid_step` as decimal fractions; defaults are 0.03, 0.08, 0.005. Parameters are stored independently per stock. Positive finite rates, ordered bounds and a maximum of 201 levels are enforced; an unaligned upper bound stops at the last full increment. HK grid prices are in HKD after FX conversion.
- `POST /api/stocks`: create; `PATCH /api/stocks/<id>`: update editable fields or watched state.
- `DELETE /api/stocks/<id>`: delete local record.
- `POST /api/refresh`: quote refresh; returns `message`, `updated`, `errors`.
- `GET /api/sectors`: persistent category records with stock counts and protected status. `POST /api/sectors` creates an empty category; `PATCH /api/sectors/<id>` renames the category and all stock assignments; `DELETE /api/sectors/<id>` moves assigned stocks to protected `未分类` without deleting stock records, watchlists or grid settings.

Existing databases acquire the `sectors` table from their current stock assignments on startup. Empty categories are retained, and manually entering a new category when saving a stock creates it. Category assignments, grid settings and watchlist state are stored in the local database.

Yield-basis selections and custom yields are stored per stock. New stocks start with annual yield. Changing a stock's security code or market resets the basis to annual unless a basis is explicitly supplied, to avoid carrying an old security's custom estimate to another one.

Run meaningful API/calculation regressions from the root: `python -m unittest discover -s backend/tests -v`.
