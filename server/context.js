import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simple whitespace-aware chunking
function chunkText(text, chunkSize = 1200, overlap = 200) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + chunkSize, text.length);
    const slice = text.slice(i, end);
    chunks.push(slice.trim());
    if (end === text.length) break;
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks.filter(Boolean);
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}

export async function extractPdfTextBuffer(buffer) {
  // Suppress noisy PDF font warnings during parse
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args) => {
    const s = args && args.length ? String(args[0]) : '';
    if (s && s.includes('TT: undefined function')) return; // drop known benign warning
    return origWarn.apply(console, args);
  };
  console.error = (...args) => {
    return origError.apply(console, args);
  };
  try {
    // Lazy import to avoid optional dep issues if not used
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    // Normalize whitespace
    return (data.text || '').replace(/\s+/g, ' ').trim();
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
}

export async function embedTexts({ apiKey, model, inputs }) {
  const url = 'https://api.openai.com/v1/embeddings';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: inputs })
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Embeddings error ${resp.status}: ${t}`);
  }
  const json = await resp.json();
  return json.data.map(d => d.embedding);
}

export function saveIndex(indexPath, index) {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8');
}

export function loadIndex(indexPath) {
  if (!fs.existsSync(indexPath)) return null;
  const raw = fs.readFileSync(indexPath, 'utf8');
  return JSON.parse(raw);
}

export async function ingestPdfs({ pdfDir, indexPath, apiKey, model = 'text-embedding-3-small', chunkSize = 1200, overlap = 200 }) {
  const files = fs.existsSync(pdfDir) ? fs.readdirSync(pdfDir).filter(f => f.toLowerCase().endsWith('.pdf')) : [];
  if (!files.length) {
    const emptyIndex = { meta: { model, createdAt: new Date().toISOString(), files: [] }, items: [] };
    saveIndex(indexPath, emptyIndex);
    return emptyIndex;
  }

  const items = [];
  for (const filename of files) {
    const full = path.join(pdfDir, filename);
    const buf = fs.readFileSync(full);
    const text = await extractPdfTextBuffer(buf);
    if (!text) continue;
    const chunks = chunkText(text, chunkSize, overlap);
    for (let i = 0; i < chunks.length; i++) {
      items.push({ id: `${filename}#${i}`, doc: filename, text: chunks[i] });
    }
  }

  // Batch embeddings to avoid large payloads
  const BATCH = 64;
  const vectors = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const embeds = await embedTexts({ apiKey, model, inputs: slice.map(s => s.text) });
    vectors.push(...embeds);
  }

  const withEmbeds = items.map((it, idx) => ({ ...it, embedding: vectors[idx] }));
  const index = {
    meta: { model, createdAt: new Date().toISOString(), files },
    items: withEmbeds
  };
  saveIndex(indexPath, index);
  return index;
}

export async function searchIndex({ index, apiKey, model = 'text-embedding-3-small', query, k = 5 }) {
  if (!index || !index.items || !index.items.length) return [];
  const [qv] = await embedTexts({ apiKey, model, inputs: [query] });
  const scored = index.items.map(it => ({ ...it, score: cosineSimilarity(qv, it.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export function buildContext(results, maxChars = 4000) {
  let out = 'Reference Context\n';
  for (const r of results) {
    const block = `\n[${r.doc}] (score=${r.score.toFixed(3)})\n${r.text}`;
    if ((out + block).length > maxChars) break;
    out += block;
  }
  return out.trim();
}
