"""ProcurementGPT — Pipeline de Ingestão (sub-projeto 2).

CLI: python scripts/ingest.py --path ./artigos/ [--force] [--dry-run] [--cache] [--file PATH]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import httpx
import psycopg
from dotenv import load_dotenv
from pgvector.psycopg import register_vector
from urllib.parse import urlparse


PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Tunables
MAX_CHUNK_TOKENS = 800
OVERLAP_TOKENS = 100
CHARS_PER_TOKEN = 4  # rough heuristic; sufficient for chunk sizing
EMBED_BATCH_SIZE = 128
HTTP_TIMEOUT_SECONDS = 60
RETRY_BACKOFFS = (2, 4, 8)
SUPPORTED_EXTS = {".pdf", ".md", ".txt", ".html"}
EMBED_CACHE_DIR = PROJECT_ROOT / "scripts" / ".embed-cache"
VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings"


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


def _cache_key(model: str, text: str) -> str:
    h = hashlib.sha256()
    h.update(model.encode("utf-8"))
    h.update(b":")
    h.update(text.encode("utf-8"))
    return h.hexdigest()


def _cache_get(key: str) -> list[float] | None:
    p = EMBED_CACHE_DIR / f"{key}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def _cache_put(key: str, embedding: list[float]) -> None:
    EMBED_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    p = EMBED_CACHE_DIR / f"{key}.json"
    p.write_text(json.dumps(embedding))


def _voyage_post(texts: list[str], api_key: str, model: str) -> list[list[float]]:
    payload = {"model": model, "input": texts}
    last_err: Exception | None = None
    for attempt, delay in enumerate([0, *RETRY_BACKOFFS]):
        if delay:
            time.sleep(delay)
        try:
            with httpx.Client(timeout=HTTP_TIMEOUT_SECONDS) as client:
                resp = client.post(
                    VOYAGE_ENDPOINT,
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                )
            if resp.status_code in (429, 500, 502, 503, 504):
                last_err = RuntimeError(f"Voyage {resp.status_code}: {resp.text[:200]}")
                continue
            if not resp.is_success:
                raise RuntimeError(
                    f"Voyage error {resp.status_code}: {resp.text[:500]}"
                )
            data = resp.json()
            return [d["embedding"] for d in data["data"]]
        except (httpx.TimeoutException, httpx.NetworkError) as e:
            last_err = e
            continue
    raise RuntimeError(f"Voyage embed failed after retries: {last_err}")


def embed_batch(texts: list[str], use_cache: bool = False) -> list[list[float]]:
    """Embed a list of texts via Voyage in batches of EMBED_BATCH_SIZE."""
    if not texts:
        return []
    api_key = os.environ["VOYAGE_API_KEY"]
    model = os.environ["VOYAGE_MODEL"]

    out: list[list[float] | None] = [None] * len(texts)
    pending_indices: list[int] = []
    pending_texts: list[str] = []
    cache_keys: list[str] = []

    for i, t in enumerate(texts):
        if use_cache:
            key = _cache_key(model, t)
            cached = _cache_get(key)
            if cached is not None:
                out[i] = cached
                continue
            cache_keys.append(key)
        else:
            cache_keys.append("")
        pending_indices.append(i)
        pending_texts.append(t)

    for start in range(0, len(pending_texts), EMBED_BATCH_SIZE):
        batch = pending_texts[start : start + EMBED_BATCH_SIZE]
        batch_idx = pending_indices[start : start + EMBED_BATCH_SIZE]
        batch_keys = cache_keys[start : start + EMBED_BATCH_SIZE]
        embeddings = _voyage_post(batch, api_key=api_key, model=model)
        for i, emb, key in zip(batch_idx, embeddings, batch_keys):
            out[i] = emb
            if use_cache and key:
                _cache_put(key, emb)

    # Sanity: no Nones remain
    if any(e is None for e in out):
        missing = [i for i, e in enumerate(out) if e is None]
        raise RuntimeError(f"embed_batch produced None for indices {missing}")
    return out  # type: ignore[return-value]


def _db_dsn() -> str:
    """Build a Postgres DSN from Supabase env vars.

    Supabase Cloud exposes Postgres at db.<project-ref>.supabase.co:5432.
    The service-role key is NOT the DB password; users must set
    SUPABASE_DB_PASSWORD explicitly. We fail fast with a clear error if missing.
    """
    url = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    parsed = urlparse(url)
    host = parsed.hostname or ""
    if not host.endswith(".supabase.co"):
        raise RuntimeError(f"Unexpected Supabase URL host: {host}")
    project_ref = host.split(".")[0]
    password = os.environ.get("SUPABASE_DB_PASSWORD")
    if not password:
        raise RuntimeError(
            "SUPABASE_DB_PASSWORD not set. Get it from Supabase Dashboard → "
            "Project Settings → Database → Database password, then add to .env.local."
        )
    db_host = f"db.{project_ref}.supabase.co"
    return f"postgresql://postgres:{password}@{db_host}:5432/postgres?sslmode=require"


def connect_db():
    """Open a psycopg connection with pgvector type registered."""
    conn = psycopg.connect(_db_dsn())
    register_vector(conn)
    return conn


def lookup_by_hash(conn, hash_: str) -> str | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM articles WHERE metadata->>'content_hash' = %s LIMIT 1",
            (hash_,),
        )
        row = cur.fetchone()
        return str(row[0]) if row else None


def delete_article(conn, article_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM articles WHERE id = %s", (article_id,))


def insert_article(
    conn,
    *,
    title: str,
    author: str | None,
    language: str,
    published_at: date | None,
    raw_md: str,
    metadata: dict[str, Any],
) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO articles (title, author, language, published_at, raw_md, metadata)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (title, author, language, published_at, raw_md, json.dumps(metadata)),
        )
        return str(cur.fetchone()[0])


def insert_chunks(
    conn,
    article_id: str,
    chunks: list[ChunkInput],
    embeddings: list[list[float]],
) -> None:
    if len(chunks) != len(embeddings):
        raise ValueError(
            f"chunks/embeddings length mismatch: {len(chunks)} vs {len(embeddings)}"
        )
    rows = [
        (article_id, c.ord, c.content, emb, json.dumps(c.metadata))
        for c, emb in zip(chunks, embeddings)
    ]
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO chunks (article_id, ord, content, embedding, metadata)
            VALUES (%s, %s, %s, %s, %s)
            """,
            rows,
        )


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
        "SUPABASE_DB_PASSWORD",
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


def _process_one(
    conn,
    path: Path,
    *,
    force: bool,
    dry_run: bool,
    use_cache: bool,
) -> str:
    """Returns one of: 'new', 'skipped', 'forced', 'failed'."""
    from unstructured.partition.auto import partition

    h = content_hash(path)
    decision = decide_action(
        h,
        force=force,
        lookup_by_hash=lambda x: None if dry_run else lookup_by_hash(conn, x),
    )
    if decision == IngestDecision.SKIP:
        return "skipped"

    elements = partition(filename=str(path))
    raw_md = elements_to_markdown(elements)
    meta = extract_metadata(elements, path, raw_md=raw_md)
    meta["metadata"]["content_hash"] = h
    chunks = chunk_hybrid(elements)

    if dry_run:
        sys.stdout.write(
            f"[dry-run] {path.name}: title={meta['title']!r} lang={meta['language']} "
            f"chunks={len(chunks)}\n"
        )
        return "new"

    embeddings = embed_batch([c.content for c in chunks], use_cache=use_cache)

    with conn.transaction():
        if decision == IngestDecision.REPLACE:
            existing_id = lookup_by_hash(conn, h)
            if existing_id:
                delete_article(conn, existing_id)
        article_id = insert_article(
            conn,
            title=meta["title"],
            author=meta["author"],
            language=meta["language"],
            published_at=meta["published_at"],
            raw_md=raw_md,
            metadata=meta["metadata"],
        )
        insert_chunks(conn, article_id, chunks, embeddings)

    return "forced" if decision == IngestDecision.REPLACE else "new"


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])

    if not args.dry_run:
        load_env()

    if args.file:
        if not args.file.exists():
            sys.stderr.write(f"File not found: {args.file}\n")
            return 1
        files = [args.file]
    else:
        files = discover_files(args.path)

    if not files:
        sys.stdout.write("No files to ingest.\n")
        return 0

    from tqdm import tqdm

    counters = {"new": 0, "skipped": 0, "forced": 0, "failed": 0}
    conn = None
    try:
        if not args.dry_run:
            conn = connect_db()
        for p in tqdm(files, desc="ingesting"):
            try:
                status = _process_one(
                    conn,
                    p,
                    force=args.force,
                    dry_run=args.dry_run,
                    use_cache=args.cache,
                )
                counters[status] += 1
            except Exception as e:
                sys.stderr.write(f"\n[error] {p.name}: {e}\n")
                counters["failed"] += 1
    finally:
        if conn is not None:
            conn.close()

    sys.stdout.write(
        f"Done. new={counters['new']} skipped={counters['skipped']} "
        f"forced={counters['forced']} failed={counters['failed']}\n"
    )
    return 1 if counters["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
