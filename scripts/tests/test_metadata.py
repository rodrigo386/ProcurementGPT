from datetime import date
from pathlib import Path

from scripts.ingest import extract_metadata, elements_to_markdown


def _partition(p: Path):
    from unstructured.partition.auto import partition
    return partition(filename=str(p))


FIXTURES = Path(__file__).parent / "fixtures"


def test_pt_markdown_metadata_basic() -> None:
    p = FIXTURES / "sample_pt.md"
    elements = _partition(p)
    md = elements_to_markdown(elements)
    meta = extract_metadata(elements, p, raw_md=md)
    assert meta["title"] == "A Matriz de Kraljic"
    assert meta["language"] == "pt"
    assert meta["author"] == "João Silva"
    assert meta["published_at"] == date(2024, 3, 15)
    assert meta["metadata"]["source_file"] == "sample_pt.md"
    assert "parsed_at" in meta["metadata"]


def test_en_markdown_metadata() -> None:
    p = FIXTURES / "sample_en.md"
    elements = _partition(p)
    md = elements_to_markdown(elements)
    meta = extract_metadata(elements, p, raw_md=md)
    assert meta["title"] == "Strategic Sourcing Fundamentals"
    assert meta["language"] == "en"
    assert meta["author"] == "Mary Roberts"
    assert meta["published_at"] is None  # no explicit date in fixture


def test_html_metadata() -> None:
    p = FIXTURES / "sample.html"
    elements = _partition(p)
    md = elements_to_markdown(elements)
    meta = extract_metadata(elements, p, raw_md=md)
    assert "Porter" in meta["title"]
    assert meta["language"] == "en"
    assert meta["published_at"] == date(2023, 9, 1)


def test_filename_fallback_when_no_title(tmp_path: Path) -> None:
    p = tmp_path / "kraljic_matrix.txt"
    p.write_text("Apenas texto corrido sem título visível.")
    elements = _partition(p)
    md = elements_to_markdown(elements)
    meta = extract_metadata(elements, p, raw_md=md)
    assert meta["title"] == "kraljic matrix"


def test_elements_to_markdown_preserves_order() -> None:
    p = FIXTURES / "sample_pt.md"
    elements = _partition(p)
    md = elements_to_markdown(elements)
    assert "Kraljic" in md
    assert md.index("Kraljic") < md.index("Aplicação")
