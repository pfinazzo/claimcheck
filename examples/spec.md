# Acceptance criteria

Frozen with `claimcheck spec freeze`. Add nothing after the diff starts.

- [ ] 1. `add(a, b)` returns the integer sum for any two ints, including negatives.
- [ ] 2. `clamp(x, lo, hi)` returns `lo` when `x < lo`, `hi` when `x > hi`, and `x` otherwise; `x == lo` and `x == hi` return `x`.
- [ ] 3. `tests/test_calc.py` pins every branch of both functions and passes under `python -m pytest -q`.
