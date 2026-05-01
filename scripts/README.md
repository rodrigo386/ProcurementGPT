# scripts/ — Pipeline de Ingestão (Python)

CLI que ingere artigos de `./artigos/` para Supabase (`articles` + `chunks`).

## Setup (1x)

```bash
python -m venv scripts/.venv
# Windows PowerShell:
scripts\.venv\Scripts\Activate.ps1
# bash/zsh:
source scripts/.venv/bin/activate

pip install -r scripts/requirements.txt
```

Pré-requisitos opcionais:
- **Tesseract OCR** para PDFs scaneados (`unstructured` faz fallback gracioso se ausente)
- **Poppler** para PDFs (incluído via `unstructured[pdf]` em algumas plataformas)

## Comandos

```bash
python scripts/ingest.py --path ./artigos/             # ingestão padrão (skip se hash existe)
python scripts/ingest.py --path ./artigos/ --force     # reprocessa todos
python scripts/ingest.py --file ./artigos/x.pdf        # ingere 1 arquivo
python scripts/ingest.py --dry-run --path ./artigos/   # parse + chunk, sem DB nem embed
python scripts/ingest.py --cache --path ./artigos/     # usa cache local de embeddings

pytest scripts/tests/                                   # testes unitários
```

Lê `.env.local` da raiz do projeto.
