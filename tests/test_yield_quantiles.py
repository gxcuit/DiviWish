import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from yield_quantiles import thresholds


class YieldQuantilesTest(unittest.TestCase):
    def test_inverse_empirical_cdf_uses_ceiling_not_interpolation(self):
        samples=[{'yield':y} for y in [.10,.03,.07,.01,.04,.09,.02,.08,.06,.05,.11]]
        result=thresholds(samples,2.7)
        self.assertEqual(result['60']['rank'],7)
        self.assertEqual(result['60']['yield'],.07)
        self.assertEqual(result['90']['rank'],10)
        self.assertEqual(result['90']['yield'],.10)
        self.assertAlmostEqual(result['60']['price'],2.7/.07)
        self.assertEqual(samples[0]['yield'],.10)

    def test_duplicate_yields_and_zero_quantile(self):
        result=thresholds([{'yield':y} for y in [0,0,0,0,.1]],1)
        self.assertEqual(result['60']['yield'],0)
        self.assertIsNone(result['60']['price'])
        self.assertEqual(result['90']['yield'],.1)
        self.assertEqual(result['90']['price'],10)

    def test_current_annual_dividend_only_changes_reference_price(self):
        samples=[{'yield':.04},{'yield':.06}]
        first=thresholds(samples,2)
        second=thresholds(samples,3)
        self.assertEqual(first['60']['yield'],second['60']['yield'])
        self.assertAlmostEqual(second['60']['price']/first['60']['price'],1.5)

    def test_invalid_history_is_exposed(self):
        for samples in [[],[{'yield':math.nan}],[{'yield':-.01}],[{'yield':True}]]:
            with self.subTest(samples=samples),self.assertRaises(ValueError):thresholds(samples,1)

    def test_invalid_parameters_are_exposed(self):
        for probability in [0,-.1,1.1,math.nan]:
            with self.subTest(probability=probability),self.assertRaises(ValueError):
                thresholds([{'yield':.1}],1,[probability])
        with self.assertRaises(ValueError):thresholds([{'yield':.1}],None)
