"""Print raw dividend records for a focused audit; does not edit the workbook."""
import json
from pathlib import Path
import requests

params = dict(reportName="RPT_SHAREBONUS_DET", columns="ALL",
              filter='(SECURITY_CODE="600941")', pageNumber=1, pageSize=12,
              sortColumns="REPORT_DATE", sortTypes=-1)
response = requests.get("https://datacenter-web.eastmoney.com/api/data/v1/get",
                        params=params, timeout=30)
response.raise_for_status()
payload = response.json()
Path("pictures/20261018/china_mobile_raw.json").write_text(
    json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
for row in payload.get("result", {}).get("data", []):
    print(json.dumps({key: row.get(key) for key in (
        "REPORT_DATE", "ASSIGN_PROGRESS", "PRETAX_BONUS_RMB",
        "IMPL_PLAN_PROFILE", "EX_DIVIDEND_DATE")}, ensure_ascii=False))
