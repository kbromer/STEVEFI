import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import { ingestPdfs, loadIndex, saveIndex, searchIndex, buildContext } from './server/context.js';

// Load environment from .env.local if present
dotenv.config({ path: '.env.local' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const embeddingsModel = process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small';
const dataDir = path.join(__dirname, 'data');
const pdfsDir = path.join(dataDir, 'pdfs');
const indexPath = path.join(dataDir, 'index.json');
const autoIngestOnStart = (process.env.AUTO_INGEST_ON_START || 'true').toLowerCase() === 'true';

// Read canonical prompt at startup (synchronous for simplicity)
let canonicalPrompt = '';
try {
  const promptPath = path.join(__dirname, 'prompts', 'default.txt');
  canonicalPrompt = fs.readFileSync(promptPath, { encoding: 'utf8' }).trim();
} catch (e) {
  console.warn('Could not read prompts/default.txt:', e && e.message ? e.message : e);
}

app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Create an ephemeral client secret and return it to the client with instructions.
app.post('/session', express.json(), async (req, res) => {
  const serverKey = process.env.OPENAI_API_KEY || '';
  if (!serverKey) return res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });

  const model = process.env.REALTIME_MODEL || 'gpt-realtime';
  try {
    // Use /v1/realtime/client_secrets (not /sessions) to create ephemeral key
    const resp = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serverKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model
        }
      })
    });

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = text; }

    if (!resp.ok) {
      console.error('/client_secrets creation failed:', resp.status, text);
      return res.status(502).json({ error: 'client_secrets_failed', status: resp.status, body: data });
    }

    const ephemeralKey = data.value || null;
    if (!ephemeralKey) {
      console.error('No ephemeral key in response:', data);
      return res.status(502).json({ error: 'no_ephemeral_key_in_response', body: data });
    }

    // Return ephemeral key and instructions for client to use in RealtimeSession.connect()
    return res.status(200).json({
      apiKey: ephemeralKey,
      instructions: canonicalPrompt,
      model
    });
  } catch (err) {
    console.error('Error creating ephemeral client secret in /session:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Admin: ingest PDFs in data/pdfs into data/index.json
app.post('/admin/ingest', async (req, res) => {
  const serverKey = process.env.OPENAI_API_KEY || '';
  if (!serverKey) return res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });
  try {
    const index = await ingestPdfs({ pdfDir: pdfsDir, indexPath, apiKey: serverKey, model: embeddingsModel });
    return res.json({ ok: true, files: index.meta.files, items: index.items.length });
  } catch (e) {
    console.error('Ingest error:', e);
    return res.status(500).json({ error: 'ingest_failed', message: e?.message || String(e) });
  }
});

// Search index for top-k chunks
app.get('/context/search', async (req, res) => {
  const serverKey = process.env.OPENAI_API_KEY || '';
  if (!serverKey) return res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });
  const q = req.query.q || req.query.query || '';
  const k = Math.max(1, Math.min(50, parseInt(req.query.k || '5', 10)));
  const index = loadIndex(indexPath);
  if (!q) return res.status(400).json({ error: 'missing_query' });
  if (!index || !index.items?.length) return res.status(404).json({ error: 'index_empty' });
  try {
    const results = await searchIndex({ index, apiKey: serverKey, model: embeddingsModel, query: q, k });
    return res.json({ query: q, k, results });
  } catch (e) {
    console.error('Search error:', e);
    return res.status(500).json({ error: 'search_failed', message: e?.message || String(e) });
  }
});

// Build a context block from top-k search results
app.post('/context/augment', express.json(), async (req, res) => {
  const serverKey = process.env.OPENAI_API_KEY || '';
  if (!serverKey) return res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });
  const { query, k = 5, maxChars = 8000 } = req.body || {};
  if (!query) return res.status(400).json({ error: 'missing_query' });
  const index = loadIndex(indexPath);
  if (!index || !index.items?.length) return res.status(404).json({ error: 'index_empty' });
  try {
    const results = await searchIndex({ index, apiKey: serverKey, model: embeddingsModel, query, k });
    const context = buildContext(results, maxChars);
    return res.json({ query, k, maxChars, context, results });
  } catch (e) {
    console.error('Augment error:', e);
    return res.status(500).json({ error: 'augment_failed', message: e?.message || String(e) });
  }
});

// Proxy flow: create an ephemeral realtime session (with server-side prompt)
// and then POST the raw SDP to the Realtime Calls endpoint using the ephemeral key.
app.post('/webrtc/call', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const serverKey = process.env.OPENAI_API_KEY || '';
  if (!serverKey) return res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });

  const sdp = req.body ? req.body.toString() : '';
  const model = process.env.REALTIME_MODEL || 'gpt-realtime';

  try {
    // 1) Create an ephemeral session that includes the server prompt as instructions
    const sessionResp = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serverKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        instructions: canonicalPrompt
      })
    });

    const sessionText = await sessionResp.text();
    let sessionData;
    try { sessionData = JSON.parse(sessionText); } catch (e) { sessionData = sessionText; }

    if (!sessionResp.ok) {
      console.error('/session creation failed. status=', sessionResp.status, 'body=', sessionText);
      let parsedBody = sessionText;
      try { parsedBody = JSON.parse(sessionText); } catch (e) { /* keep raw */ }
      return res.status(502).json({
        error: 'session_creation_failed',
        status: sessionResp.status,
        body: parsedBody
      });
    }

    const ephemeralKey = sessionData?.client_secret?.value || sessionData?.client_secret || null;
    if (!ephemeralKey) {
      console.error('No ephemeral client_secret returned by session creation. sessionData=', sessionData);
      return res.status(502).json({ error: 'no_ephemeral_key', details: sessionData });
    }

    const sanitizedSession = Object.assign({}, sessionData);
    if (sanitizedSession?.client_secret) sanitizedSession.client_secret = '[REDACTED]';
    console.log('/session created ok; ephemeral key present? ', !!ephemeralKey, 'session status=', sessionResp.status);
    console.log('/session data (sanitized):', sanitizedSession);

    // 2) Post the raw SDP to /v1/realtime/calls with the ephemeral key and application/sdp
    // Use the generic calls endpoint (with model query) — this is the expected URL for SDP POSTs
    // Some Realtime API variants accept session-scoped endpoints, but the generic calls endpoint
    // is the documented surface that receives `application/sdp` bodies.
    const sessionId = sessionData?.id || null;
    const callsUrl = `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`;

    // Log ephemeralKey metadata (masked) for debugging
    try {
      const keyPreview = ephemeralKey ? `${ephemeralKey.slice(0, 8)}...${ephemeralKey.slice(-4)}` : null;
      console.log('Using ephemeral key (masked):', keyPreview, 'length=', ephemeralKey ? ephemeralKey.length : 0);
    } catch (e) { /* ignore */ }
    console.log('Posting SDP to OpenAI endpoint:', callsUrl, '; sdp length=', sdp.length);
    if (sdp && sdp.length > 0) console.log('SDP preview:\n', sdp.slice(0, 200));

    const callResp = await fetch(callsUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        'Content-Type': 'application/sdp'
      },
      body: sdp
    });

    const callText = await callResp.text();
    const ct = callResp.headers.get('content-type') || 'application/sdp';

    if (!callResp.ok) {
      const hdrs = Array.from(callResp.headers.entries());
      console.error('/v1/realtime/calls returned error. status=', callResp.status, 'content-type=', ct, 'headers=', hdrs, 'body=', callText);
      let parsed = callText;
      try { parsed = JSON.parse(callText); } catch (e) { /* keep raw text */ }
      return res.status(502).json({ error: 'call_proxy_failed', status: callResp.status, contentType: ct, body: parsed });
    }

    // Success: forward the SDP/answer (may be application/sdp or JSON depending on API)
    return res.status(callResp.status).type(ct).send(callText);
  } catch (err) {
    console.error('Error in /webrtc/call proxy flow:', err);
    return res.status(500).json({ error: 'Error proxying call to OpenAI' });
  }
});

app.listen(port, () => console.log(`Server listening on port ${port}`));

// Optionally run ingestion on server start (non-blocking). Controlled by AUTO_INGEST_ON_START.
async function runAutoIngest() {
  const serverKey = process.env.OPENAI_API_KEY || '';
  if (!autoIngestOnStart) {
    console.log('AUTO_INGEST_ON_START=false; skipping startup ingestion.');
    return;
  }
  if (!serverKey) {
    console.warn('Skipping startup ingestion: OPENAI_API_KEY not set.');
    return;
  }
  try {
    if (!fs.existsSync(pdfsDir)) {
      console.log('Skipping startup ingestion: no data/pdfs directory.');
      return;
    }
    const files = fs.readdirSync(pdfsDir).filter(f => f.toLowerCase().endsWith('.pdf'));
    if (!files.length) {
      console.log('Skipping startup ingestion: no PDFs in data/pdfs.');
      return;
    }
    console.log('Running startup ingestion for PDFs:', files);
    const index = await ingestPdfs({ pdfDir: pdfsDir, indexPath, apiKey: serverKey, model: embeddingsModel });
    console.log(`Startup ingestion complete: files=${index.meta.files.length}, items=${index.items.length}`);
  } catch (e) {
    console.warn('Startup ingestion failed (continuing without index):', e && e.message ? e.message : e);
  }
}

// Kick off ingestion shortly after server starts, without blocking listen
setTimeout(() => { runAutoIngest(); }, 250);