Place your PDF files in the ./data/pdfs directory.

Then trigger ingestion:
- Local (PowerShell):
  curl -X POST http://localhost:3000/admin/ingest

Endpoints provided by the server:
- POST /admin/ingest            -> scans data/pdfs, extracts text, embeds, writes data/index.json
- GET  /context/search?q=...&k=5 -> searches vector index; returns top-k chunks
- POST /context/augment         -> { query, maxChars } => returns a trimmed context block from top-k chunks

Notes:
- Requires OPENAI_API_KEY on the server.
- Default embeddings model: text-embedding-3-small (configurable via EMBEDDINGS_MODEL).
- Index stored at ./data/index.json. Re-run ingestion after changing PDFs.
 - Automatic ingestion on server start is enabled by default. Disable with AUTO_INGEST_ON_START=false.