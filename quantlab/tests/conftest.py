"""Test fixtures. The synthetic price series here exist ONLY to test the maths
and plumbing with known answers; the application never uses them."""
import os, sys, datetime as dt
import numpy as np, pandas as pd, pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ["QL_NO_APP"] = "1"


def synth_panel(n=1500, seed=1, phi=0.9):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2020-01-01", periods=n)
    x = np.cumsum(rng.normal(0, 0.01, n)) + 4
    s = np.zeros(n)
    for t in range(1, n):
        s[t] = phi * s[t - 1] + rng.normal(0, 0.01)
    y = 1.2 * x + s - 0.8
    spy = np.cumsum(rng.normal(0.0003, 0.01, n)) + 6
    rw = np.cumsum(rng.normal(0, 0.012, n)) + 3.5
    rw2 = np.cumsum(rng.normal(0, 0.012, n)) + 3.2
    C = pd.DataFrame({"YYY": np.exp(y), "XXX": np.exp(x), "SPY": np.exp(spy), "RW": np.exp(rw), "RW2": np.exp(rw2)}, index=idx)
    O = C.shift(1).bfill() * (1 + rng.normal(0, 0.002, C.shape))
    return {"ok": True, "close": C, "open": O, "volume": C * 0 + 1e6, "warnings": [], "info": {}, "asof": str(idx[-1].date())}


@pytest.fixture
def panel():
    return synth_panel()


class FakeProvider:
    """Stands in for Nasdaq in tests; serves the synthetic panel as daily bars."""
    name = "Test provider"

    def __init__(self, p, fail=()):
        self.p, self.fail = p, set(fail)

    def history(self, symbol, start):
        if symbol in self.fail or symbol not in self.p["close"]:
            raise RuntimeError("not available")
        c, o = self.p["close"][symbol], self.p["open"][symbol]
        return pd.DataFrame({"d": [d.date().isoformat() for d in c.index], "o": o.values, "h": np.maximum(o, c).values, "l": np.minimum(o, c).values, "c": c.values, "v": 2e6})

    def dividends(self, symbol):
        return []

    def quote(self, symbol):
        raise RuntimeError("no quotes in tests")
