"""Historical yield thresholds using the inverse empirical CDF."""
import math


def thresholds(samples, annual_dps, probabilities=(.6,.9)):
    if not isinstance(annual_dps,(int,float)) or isinstance(annual_dps,bool) or not math.isfinite(annual_dps) or annual_dps<0:
        raise ValueError('最新年度股息无效')
    values=[s['yield'] for s in samples]
    if not values or any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) or v<0 for v in values):
        raise ValueError('历史股息率样本无效')
    values.sort()
    result={}
    for p in probabilities:
        if not isinstance(p,(int,float)) or not math.isfinite(p) or not 0<p<=1:
            raise ValueError('分位概率须在(0,1]内')
        rank=math.ceil(p*len(values))
        value=values[rank-1]
        result[str(round(p*100))]={'yield':value,'rank':rank,'count':len(values),
                                 'price':annual_dps/value if value>0 else None}
    return result
