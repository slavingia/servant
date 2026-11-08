"""Unit tests for run keys. No Hermes needed: python3 -m unittest server/test_servant_run_keys.py"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from servant_run_keys import RunKeys, describe, valid_key  # noqa: E402


class RunKeyTests(unittest.TestCase):
    def test_keys_are_checked(self):
        self.assertTrue(valid_key("servant_turn_abc-123"))
        for bad in ("", "turn_1", "servant_", "servant_a/b", "servant_" + "x" * 121, None, 7):
            self.assertFalse(valid_key(bad), bad)

    def test_a_stop_before_the_start_arrives_refuses_the_start(self):
        # The lost-reply case where the start request itself is late.
        keys = RunKeys()
        self.assertEqual(keys.cancel("servant_k"), ("refused", None))
        ok, entry = keys.begin("servant_k")
        self.assertFalse(ok)
        self.assertEqual(entry["state"], "refused")
        self.assertTrue(describe("servant_k", keys.get("servant_k"))["stopped"])

    def test_a_stop_during_the_start_stops_the_run_when_its_id_arrives(self):
        keys = RunKeys()
        self.assertEqual(keys.begin("servant_k"), (True, None))
        self.assertEqual(keys.cancel("servant_k"), ("pending", None))
        self.assertFalse(describe("servant_k", keys.get("servant_k"))["stopped"], "not confirmed until the run is stopped")
        self.assertTrue(keys.started("servant_k", "run_1"), "the caller must stop run_1 now")
        self.assertEqual(describe("servant_k", keys.get("servant_k"), "running")["stopped"], False)
        self.assertEqual(describe("servant_k", keys.get("servant_k"), "cancelled")["state"], "ended")
        self.assertTrue(describe("servant_k", keys.get("servant_k"), "cancelled")["stopped"])

    def test_a_stop_after_the_start_stops_that_run(self):
        # The lost-reply case where the start's reply never reached Servant.
        keys = RunKeys()
        keys.begin("servant_k")
        self.assertFalse(keys.started("servant_k", "run_1"))
        self.assertEqual(keys.cancel("servant_k"), ("stop", "run_1"))
        self.assertTrue(describe("servant_k", keys.get("servant_k"), "gone")["stopped"])

    def test_a_running_key_reports_its_run_so_servant_can_adopt_it(self):
        keys = RunKeys()
        keys.begin("servant_k")
        keys.started("servant_k", "run_1")
        ok, entry = keys.begin("servant_k")
        self.assertFalse(ok)
        self.assertEqual((entry["state"], entry["run_id"]), ("running", "run_1"))

    def test_a_failed_start_can_be_retried_unless_it_was_stopped(self):
        keys = RunKeys()
        keys.begin("servant_k")
        keys.failed("servant_k")
        self.assertEqual(keys.begin("servant_k"), (True, None))
        keys.cancel("servant_k")
        keys.failed("servant_k")
        self.assertEqual(keys.begin("servant_k")[0], False)
        self.assertEqual(keys.get("servant_k")["state"], "refused")

    def test_bounded_and_never_drops_a_start_in_progress(self):
        keys = RunKeys(limit=3)
        keys.begin("servant_live")
        for i in range(10):
            keys.cancel(f"servant_{i}")
        self.assertEqual(keys.get("servant_live")["state"], "starting")
        self.assertEqual(len(keys._entries), 3)

    def test_running_keys_outlive_refused_ones(self):
        # Keys that hold no run are forgotten first, so a running run stays findable by key.
        keys = RunKeys(limit=3)
        keys.begin("servant_run")
        keys.started("servant_run", "run_1")
        for i in range(10):
            keys.cancel(f"servant_{i}")
        self.assertEqual(keys.get("servant_run")["run_id"], "run_1")
        self.assertEqual(len(keys._entries), 3)

    def test_a_stop_for_a_key_never_seen_says_so(self):
        keys = RunKeys()
        keys.cancel("servant_unknown")
        reply = describe("servant_unknown", keys.get("servant_unknown"))
        self.assertEqual((reply["stopped"], reply["unknown_before_stop"]), (True, True))
        keys.begin("servant_known")
        keys.cancel("servant_known")
        self.assertFalse(describe("servant_known", keys.get("servant_known"))["unknown_before_stop"])

    def test_interrupted_runs_count_as_ended(self):
        keys = RunKeys()
        keys.begin("servant_k")
        keys.started("servant_k", "run_1")
        self.assertTrue(describe("servant_k", keys.get("servant_k"), "interrupted")["stopped"])


if __name__ == "__main__":
    unittest.main()
