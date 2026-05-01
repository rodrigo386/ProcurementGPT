"""ProcurementGPT — Pipeline de Ingestão (sub-projeto 2).

CLI: python scripts/ingest.py --path ./artigos/ [--force] [--dry-run] [--cache] [--file PATH]
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Tunables
MAX_CHUNK_TOKENS = 800
OVERLAP_TOKENS = 100
CHARS_PER_TOKEN = 4  # rough heuristic; sufficient for chunk sizing
EMBED_BATCH_SIZE = 128
HTTP_TIMEOUT_SECONDS = 60
RETRY_BACKOFFS = (2, 4, 8)
SUPPORTED_EXTS = {".pdf", ".md", ".txt", ".html"}


def content_hash(path: Path) -> str:
    """SHA-256 hex of raw file bytes."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def discover_files(root: Path) -> list[Path]:
    """Recursively list files under root with supported extensions."""
    if not root.exists():
        return []
    out: list[Path] = []
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS:
            out.append(p)
    return out


@dataclass
class ChunkInput:
    content: str
    ord: int
    metadata: dict[str, Any] = field(default_factory=dict)


def _max_chars() -> int:
    return MAX_CHUNK_TOKENS * CHARS_PER_TOKEN


def _overlap_chars() -> int:
    return OVERLAP_TOKENS * CHARS_PER_TOKEN


def _split_with_overlap(text: str) -> list[str]:
    """Sliding window split for a single oversize block."""
    max_chars = _max_chars()
    overlap = _overlap_chars()
    parts: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + max_chars, n)
        parts.append(text[start:end])
        if end == n:
            break
        start = end - overlap
    return parts


def chunk_hybrid(elements: Sequence[Any]) -> list[ChunkInput]:
    """Group elements into chunks. Title elements open new sections.
    Within a section, accumulate up to MAX_CHUNK_TOKENS chars; if a single
    block exceeds the limit, sliding-window split with OVERLAP_TOKENS overlap.
    """
    chunks: list[ChunkInput] = []
    section_title: str | None = None
    buffer: list[str] = []
    max_chars = _max_chars()
    ord_counter = 0

    def flush() -> None:
        nonlocal buffer, ord_counter
        joined = "\n\n".join(s for s in buffer if s).strip()
        if not joined:
            buffer = []
            return
        if len(joined) <= max_chars:
            chunks.append(
                ChunkInput(
                    content=joined,
                    ord=ord_counter,
                    metadata={"section_title": section_title},
                )
            )
            ord_counter += 1
        else:
            for part in _split_with_overlap(joined):
                if part.strip():
                    chunks.append(
                        ChunkInput(
                            content=part,
                            ord=ord_counter,
                            metadata={"section_title": section_title},
                        )
                    )
                    ord_counter += 1
        buffer = []

    for el in elements:
        category = getattr(el, "category", None)
        text_value = (getattr(el, "text", "") or "").strip()
        if not text_value:
            continue
        if category == "Title":
            flush()
            section_title = text_value
            continue
        # Adding this element would overflow → flush first
        prospective = sum(len(s) for s in buffer) + len(text_value) + 2 * len(buffer)
        if buffer and prospective > max_chars:
            flush()
        buffer.append(text_value)
    flush()
    return chunks


_DATE_PATTERNS = [
    re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"),
    re.compile(r"\b(\d{2})/(\d{2})/(\d{4})\b"),
]
_AUTHOR_PATTERN = re.compile(
    r"(?:Author|Autor|By|Por)[:\s]+([A-ZÀ-Ú][\w\.\-]+(?:[ \t]+[A-ZÀ-Ú][\w\.\-]+)*)",
    re.MULTILINE,
)


def elements_to_markdown(elements: Iterable[Any]) -> str:
    """Concatenate element texts in order with double-newline separators."""
    parts: list[str] = []
    for el in elements:
        t = (getattr(el, "text", "") or "").strip()
        if t:
            parts.append(t)
    return "\n\n".join(parts)


def _detect_language(text: str) -> str:
    from langdetect import detect, DetectorFactory
    DetectorFactory.seed = 0
    sample = text[:1000]
    if not sample.strip():
        return "pt"
    try:
        lang = detect(sample)
    except Exception:
        return "pt"
    return lang if lang in {"pt", "en"} else "pt"


def _detect_author(text: str) -> str | None:
    head = text[:500]
    m = _AUTHOR_PATTERN.search(head)
    if not m:
        return None
    return m.group(1).strip()


def _detect_date(text: str) -> date | None:
    head = text[:500]
    for pat in _DATE_PATTERNS:
        m = pat.search(head)
        if not m:
            continue
        groups = m.groups()
        try:
            if len(groups) == 3 and len(groups[0]) == 4:
                return date(int(groups[0]), int(groups[1]), int(groups[2]))
            if len(groups) == 3 and len(groups[2]) == 4:
                return date(int(groups[2]), int(groups[1]), int(groups[0]))
        except ValueError:
            continue
    return None


def _title_from_filename(p: Path) -> str:
    stem = p.stem
    return re.sub(r"[_\-]+", " ", stem).strip()


def _first_title(elements: Iterable[Any]) -> str | None:
    """Return text of first Title element, but only if there's also non-Title content.
    A document with only Title elements is likely all-text-no-heading (degenerate
    unstructured output) — fall back to filename in that case.
    """
    first_title: str | None = None
    has_other_content = False
    for el in elements:
        cat = getattr(el, "category", None)
        text_value = (getattr(el, "text", "") or "").strip()
        if not text_value:
            continue
        if cat == "Title" and first_title is None:
            first_title = text_value
        elif cat != "Title":
            has_other_content = True
    return first_title if has_other_content else None


def extract_metadata(
    elements: Sequence[Any],
    path: Path,
    raw_md: str,
) -> dict[str, Any]:
    """Return article fields plus a `metadata` jsonb dict."""
    title = _first_title(elements) or _title_from_filename(path)
    language = _detect_language(raw_md)
    author = _detect_author(raw_md)
    published_at = _detect_date(raw_md)
    pages = None
    for el in elements:
        meta = getattr(el, "metadata", None)
        page_no = getattr(meta, "page_number", None) if meta else None
        if page_no:
            pages = max(pages or 0, int(page_no))
    return {
        "title": title,
        "language": language,
        "author": author,
        "published_at": published_at,
        "metadata": {
            "source_file": path.name,
            "pages": pages,
            "parsed_at": datetime.utcnow().isoformat() + "Z",
        },
    }


class IngestDecision(Enum):
    PROCESS = "process"
    SKIP = "skip"
    REPLACE = "replace"


def decide_action(
    hash_: str,
    force: bool,
    lookup_by_hash: Callable[[str], str | None],
) -> IngestDecision:
    existing = lookup_by_hash(hash_)
    if existing is None:
        return IngestDecision.PROCESS
    return IngestDecision.REPLACE if force else IngestDecision.SKIP


def load_env() -> None:
    """Load .env.local from the project root. Fail fast if missing required vars."""
    env_file = PROJECT_ROOT / ".env.local"
    if env_file.exists():
        load_dotenv(env_file)
    required = [
        "VOYAGE_API_KEY",
        "VOYAGE_MODEL",
        "NEXT_PUBLIC_SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
    ]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        sys.stderr.write(
            f"Missing required env vars: {', '.join(missing)}. "
            f"See {PROJECT_ROOT / '.env.local.example'}.\n"
        )
        sys.exit(2)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="ProcurementGPT ingestion pipeline.")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--path", type=Path, help="Directory to ingest.")
    src.add_argument("--file", type=Path, help="Single file to ingest.")
    p.add_argument("--force", action="store_true", help="Reprocess even if hash exists.")
    p.add_argument("--dry-run", action="store_true", help="Parse and chunk only.")
    p.add_argument("--cache", action="store_true", help="Use local embedding cache.")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if not args.dry_run:
        load_env()
    # Pipeline body lands in later tasks.
    print(f"args={args}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
