from unittest.mock import MagicMock

from scripts.ingest import IngestDecision, decide_action


def test_new_hash_no_force_returns_process() -> None:
    lookup = MagicMock(return_value=None)
    decision = decide_action("hash-a", force=False, lookup_by_hash=lookup)
    assert decision == IngestDecision.PROCESS
    lookup.assert_called_once_with("hash-a")


def test_existing_hash_no_force_returns_skip() -> None:
    lookup = MagicMock(return_value="article-uuid-1")
    decision = decide_action("hash-a", force=False, lookup_by_hash=lookup)
    assert decision == IngestDecision.SKIP


def test_existing_hash_with_force_returns_replace() -> None:
    lookup = MagicMock(return_value="article-uuid-1")
    decision = decide_action("hash-a", force=True, lookup_by_hash=lookup)
    assert decision == IngestDecision.REPLACE


def test_new_hash_with_force_returns_process() -> None:
    lookup = MagicMock(return_value=None)
    decision = decide_action("hash-a", force=True, lookup_by_hash=lookup)
    assert decision == IngestDecision.PROCESS
