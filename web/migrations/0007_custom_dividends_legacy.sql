-- Anchor legacy percentages ONCE at the saved quote. Preserve all original keys and snapshots.
-- Explicit NULL marks missing data; future quote changes must never re-derive the amount.
UPDATE stocks SET document=json_set(document,
  '$.custom_dividend', CASE
    WHEN json_extract(document,'$.yield_basis')='forecast' THEN CASE WHEN json_type(document,'$.forecast_manual.dividend') IN ('integer','real')
      AND json_extract(document,'$.forecast_manual.dividend') BETWEEN 0 AND 1000000000
      AND json_extract(document,'$.forecast_manual.kind') IN ('per_share','yield')
      AND json_extract(document,'$.forecast_manual.currency') IN ('CNY','HKD')
      AND json_extract(document,'$.forecast_manual.year')=CAST(strftime('%Y','now','+8 hours') AS INTEGER)
      THEN json_extract(document,'$.forecast_manual.dividend') ELSE NULL END
    WHEN json_type(document,'$.custom_yield') IN ('integer','real')
      AND json_extract(document,'$.custom_yield') BETWEEN 0 AND 1 THEN CASE WHEN json_extract(document,'$.custom_yield')=0 THEN 0
      WHEN json_type(document,'$.price') IN ('integer','real') AND json_extract(document,'$.price')>0
      AND json_extract(document,'$.price')*json_extract(document,'$.custom_yield')<=1000000000 THEN json_extract(document,'$.price')*json_extract(document,'$.custom_yield') ELSE NULL END
    ELSE NULL END,
  '$.custom_dividend_currency', CASE WHEN json_extract(document,'$.yield_basis')='forecast' AND json_type(document,'$.forecast_manual.dividend') IN ('integer','real')
      AND json_extract(document,'$.forecast_manual.dividend') BETWEEN 0 AND 1000000000
      AND json_extract(document,'$.forecast_manual.kind') IN ('per_share','yield')
      AND json_extract(document,'$.forecast_manual.currency') IN ('CNY','HKD')
      AND json_extract(document,'$.forecast_manual.year')=CAST(strftime('%Y','now','+8 hours') AS INTEGER)
    THEN json_extract(document,'$.forecast_manual.currency') ELSE CASE WHEN market='HK' THEN 'HKD' ELSE 'CNY' END END,
  '$.custom_dividend_note', CASE
    WHEN json_extract(document,'$.yield_basis')='forecast' THEN CASE WHEN json_type(document,'$.forecast_manual.dividend') IN ('integer','real')
      AND json_extract(document,'$.forecast_manual.dividend') BETWEEN 0 AND 1000000000
      AND json_extract(document,'$.forecast_manual.kind') IN ('per_share','yield')
      AND json_extract(document,'$.forecast_manual.currency') IN ('CNY','HKD')
      AND json_extract(document,'$.forecast_manual.year')=CAST(strftime('%Y','now','+8 hours') AS INTEGER)
      THEN COALESCE(json_extract(document,'$.forecast_manual.note'),'') ELSE '原手动预估资料不完整或非当前财年，请重新填写每股股息。' END
    WHEN json_type(document,'$.custom_yield') IN ('integer','real')
      AND json_extract(document,'$.custom_yield') BETWEEN 0 AND 1 THEN '由旧自定义股息率按升级时已保存的股价折算，请核对金额。'
    ELSE '' END)
WHERE json_type(document,'$.custom_dividend') IS NULL;
UPDATE stocks SET document=json_set(document,'$.yield_basis','custom') WHERE json_extract(document,'$.yield_basis')='forecast';
