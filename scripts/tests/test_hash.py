from pathlib import Path

import pytest

from scripts.ingest import content_hash, discover_files, SUPPORTED_EXTS


def test_content_hash_is_sha256_hex(tmp_path: Path) -> None:
    p = tmp_path / "x.txt"
    p.write_bytes(b"hello world")
    h = content_hash(p)
    assert isinstance(h, str)
    assert len(h) == 64
    assert all(c in "0123456789abcdef" for c in h)


def test_content_hash_is_stable(tmp_path: Path) -> None:
    p = tmp_path / "x.txt"
    p.write_bytes(b"hello world")
    assert content_hash(p) == content_hash(p)


def test_content_hash_differs_for_different_content(tmp_path: Path) -> None:
    a = tmp_path / "a.txt"
    a.write_bytes(b"alpha")
    b = tmp_path / "b.txt"
    b.write_bytes(b"beta")
    assert content_hash(a) != content_hash(b)


def test_discover_files_filters_by_extension(tmp_path: Path) -> None:
    (tmp_path / "a.pdf").write_bytes(b"%PDF")
    (tmp_path / "b.md").write_text("# x")
    (tmp_path / "c.txt").write_text("x")
    (tmp_path / "d.html").write_text("<p>x</p>")
    (tmp_path / "ignored.docx").write_bytes(b"ignored")
    (tmp_path / "ignored.png").write_bytes(b"ignored")
    found = discover_files(tmp_path)
    names = sorted(p.name for p in found)
    assert names == sorted(["a.pdf", "b.md", "c.txt", "d.html"])


def test_discover_files_recurses(tmp_path: Path) -> None:
    sub = tmp_path / "nested"
    sub.mkdir()
    (sub / "deep.md").write_text("# x")
    found = discover_files(tmp_path)
    assert any(p.name == "deep.md" for p in found)


def test_discover_files_returns_empty_for_empty_dir(tmp_path: Path) -> None:
    assert discover_files(tmp_path) == []


def test_supported_exts_set() -> None:
    assert SUPPORTED_EXTS == {".pdf", ".md", ".txt", ".html"}
