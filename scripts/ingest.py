"""ProcurementGPT — Pipeline de Ingestão (sub-projeto 2).

CLI: python scripts/ingest.py --path ./artigos/ [--force] [--dry-run] [--cache] [--file PATH]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

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
