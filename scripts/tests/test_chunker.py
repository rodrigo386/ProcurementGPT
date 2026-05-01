from dataclasses import dataclass

from scripts.ingest import ChunkInput, chunk_hybrid


@dataclass
class FakeElement:
    """Stand-in for unstructured Element. Has `text` and `category`."""
    text: str
    category: str  # 'Title' | 'NarrativeText' | 'ListItem' | etc.

    @property
    def metadata(self):  # unstructured Element exposes a metadata object
        class M:
            page_number = None
        return M()


def title(t: str) -> FakeElement:
    return FakeElement(text=t, category="Title")


def text(t: str) -> FakeElement:
    return FakeElement(text=t, category="NarrativeText")


def test_single_section_under_limit_returns_one_chunk() -> None:
    elements = [title("Introdução"), text("Texto curto sobre Kraljic.")]
    chunks = chunk_hybrid(elements)
    assert len(chunks) == 1
    assert chunks[0].ord == 0
    assert chunks[0].metadata.get("section_title") == "Introdução"
    assert "Kraljic" in chunks[0].content


def test_multiple_sections_yield_multiple_chunks() -> None:
    elements = [
        title("Seção A"),
        text("Conteúdo da seção A."),
        title("Seção B"),
        text("Conteúdo da seção B."),
        title("Seção C"),
        text("Conteúdo da seção C."),
    ]
    chunks = chunk_hybrid(elements)
    assert len(chunks) == 3
    assert [c.ord for c in chunks] == [0, 1, 2]
    assert chunks[0].metadata["section_title"] == "Seção A"
    assert chunks[1].metadata["section_title"] == "Seção B"
    assert chunks[2].metadata["section_title"] == "Seção C"


def test_section_exceeding_limit_is_split_with_overlap() -> None:
    # Build text well above MAX_CHUNK_TOKENS (800 tokens ≈ 3200 chars).
    long_paragraph = "frase. " * 1000  # ~7000 chars
    elements = [title("Big Section"), text(long_paragraph)]
    chunks = chunk_hybrid(elements)
    assert len(chunks) >= 2
    assert all(c.metadata["section_title"] == "Big Section" for c in chunks)
    # Sequential ord
    assert [c.ord for c in chunks] == list(range(len(chunks)))
    # Verify overlap: end of chunk[0] should appear at start of chunk[1]
    overlap_chars = 100 * 4  # OVERLAP_TOKENS * CHARS_PER_TOKEN
    tail = chunks[0].content[-overlap_chars:]
    head = chunks[1].content[: len(tail)]
    assert tail == head


def test_no_title_falls_back_to_implicit_section() -> None:
    elements = [text("Apenas texto sem título.")]
    chunks = chunk_hybrid(elements)
    assert len(chunks) == 1
    assert chunks[0].metadata["section_title"] is None


def test_empty_input_returns_empty_list() -> None:
    assert chunk_hybrid([]) == []


def test_chunk_input_has_expected_fields() -> None:
    elements = [title("X"), text("y")]
    chunks = chunk_hybrid(elements)
    c = chunks[0]
    assert isinstance(c, ChunkInput)
    assert isinstance(c.content, str)
    assert isinstance(c.ord, int)
    assert isinstance(c.metadata, dict)


def test_no_chunk_is_empty_or_whitespace() -> None:
    elements = [title("S"), text("a"), title("T"), text("b")]
    chunks = chunk_hybrid(elements)
    assert all(c.content.strip() for c in chunks)
