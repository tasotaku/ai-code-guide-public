import unittest


def normalize_score(score: int) -> int:
    if score < 0:
        raise ValueError("score must be non-negative")
    return min(score, 100)


class ScoreTests(unittest.TestCase):
    def test_assertion_trace(self):
        actual = normalize_score(120)
        self.assertEqual(actual, 100)
        with self.assertRaises(ValueError):
            normalize_score(-1)
