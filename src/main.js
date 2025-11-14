// Client-side using Agents Realtime SDK (dynamic import)
// Set DEBUG to false: SDK will use correct endpoints directly
const DEBUG = false;

const connectBtn = document.getElementById('connect');
const disconnectBtn = document.getElementById('disconnect');
const logDiv = document.getElementById('log');
const imageUpload = document.getElementById('imageUpload');

let client = null; // will hold the RealtimeSession from the SDK
let inFlightResponse = false;
const queuedResponseInputs = [];
let autoCreateResponses = true; // mirrors session.turn_detection.create_response
let baseInstructions = '';
let transportConnected = false;
let pendingResponseTimer = null; // fallback timer after creating a user item
let userDocContext = '';
let kbContext = '';
let suppressKBNextTurn = false;
const EXPECTED_GREETING = 'Hi, my name is Ash with STEVE-FI. I am here to help you with financial resources and guidance. May I ask who I am speaking with?';
let EXPECTED_GREETING_NORM = '';
let greetingGuardActive = false;
let greetingAccum = '';
let greetingRetries = 0;
const GREETING_MAX_RETRIES = 2;
let greetingRestorePending = false;
let greetingPrevInstructions = '';
// First-greeting flags are not required anymore; rely on deterministic assistant message

function buildInstructions() {
  let instr = baseInstructions || '';
  if (kbContext && kbContext.trim()) {
    instr += `\n\n[Knowledge Base Context]\nUse the following general references to supplement your answer. Do not treat them as the user's documents.\n${kbContext}`;
  }
  if (userDocContext && userDocContext.trim()) {
    instr += `\n\n[User Documents]\nThe following come from this caller's own financial documents. Treat these as primary for this caller.\n${userDocContext}`;
  }
  return instr.trim();
}

function sendEventSafe(evt) {
  try {
    if (!client || !client.transport) {
      log('sendEvent aborted: no client/transport.');
      return false;
    }
    client.transport.sendEvent(evt);
    return true;
  } catch (e) {
    // console.warn('sendEvent failed:', e); // Silenced for cleaner UI
    log('sendEvent failed: ' + (e?.message || e));
    setStatus('disconnected');
    return false;
  }
}

function queueOrTriggerResponse() {
  try {
    if (inFlightResponse) {
      queuedResponseInputs.push(true);
      //log('Queued response until current speech finishes.');
      return;
    }
    client?.transport?.sendEvent({
      type: 'response.create',
      response: {
        output_modalities: ['audio']
      },
    });
    //log('Response requested from agent.');
  } catch (e) {
    // console.warn('Failed to trigger response', e); // Silenced for cleaner UI
    log('Error triggering response: ' + (e?.message || e));
  }
}

function processQueuedResponses() {
  try {
    if (inFlightResponse) return;
    const next = queuedResponseInputs.shift();
    if (next) queueOrTriggerResponse();
  } catch (e) {
    // console.warn('Error processing queued responses', e); // Silenced for cleaner UI
  }
}

function scheduleResponseFallback(delayMs = 350) {
  try {
    if (pendingResponseTimer) { clearTimeout(pendingResponseTimer); pendingResponseTimer = null; }
    // If the server doesn't start a response shortly, request one
    pendingResponseTimer = setTimeout(() => {
      pendingResponseTimer = null;
      if (!inFlightResponse) {
        queueOrTriggerResponse();
      }
    }, delayMs);
  } catch (e) {
    // console.debug('scheduleResponseFallback error', e); // Silenced for cleaner UI
  }
}

// Instrument RTCPeerConnection.setRemoteDescription to capture SDK internal failures.
try {
  const _origSetRemoteDescription = RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription = async function (desc) {
    try {
      return await _origSetRemoteDescription.apply(this, arguments);
    } catch (err) {
      try {
        console.error('RTCPeerConnection.setRemoteDescription failed. desc=', desc, 'err=', err && err.message ? err.message : err);
        try { log('setRemoteDescription failed: ' + (err && err.message ? err.message : String(err))); } catch (e) {}
          // If the description has an `sdp` property, log that (SessionDescription object)
          if (desc && typeof desc === 'object' && 'sdp' in desc) {
            // Silenced for cleaner UI
          } else if (desc && typeof desc !== 'string') {
            // Silenced for cleaner UI
          } else if (desc && typeof desc === 'string') {
            // Silenced for cleaner UI
          }
      } catch (loggingErr) {
        // Silenced for cleaner UI
      }
      throw err;
    }
  };
} catch (e) {
  // console.warn('Could not instrument RTCPeerConnection.setRemoteDescription', e); // Silenced for cleaner UI
}

function log(message) {
  if (logDiv) {
    logDiv.textContent += message + '\n';
    logDiv.scrollTop = logDiv.scrollHeight;
  }
  // console.log(message); // Silenced for cleaner UI
}

function setStatus(text) {
  try {
    const el = document.getElementById('statusText');
    if (el) el.textContent = text;
  } catch (e) {
    // console.debug('setStatus error', e); // Silenced for cleaner UI
  }
}

// Optional debug fetch wrapper — enabled only when `DEBUG` is truthy.
if (DEBUG) {
  (function () {
    if (typeof window === 'undefined' || !window.fetch) return;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('api.openai.com/v1/realtime/calls') !== -1) {
        const proxyUrl = '/webrtc/call';
        try {
          const proxyInit = Object.assign({}, init || {}, { headers: (init && init.headers) || {} });
          if (proxyInit.headers && proxyInit.headers.Authorization) delete proxyInit.headers.Authorization;
          const proxyResp = await originalFetch(proxyUrl, proxyInit);
          return proxyResp;
        } catch (err) {
          // console.debug('[fetch-proxy] error forwarding to /webrtc/call:', err); // Silenced for cleaner UI
        }
      }

      const method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET';
      const reqBody = init && init.body ? String(init.body).slice(0, 2000) : undefined;
      try {
        if (url.indexOf('/v1/realtime/calls') !== -1 || url.indexOf('/v1/realtime/sessions') !== -1) {
          // const outMsg = `[fetch-debug-req] ${method} ${url} body: ${reqBody || '<no-body>'}`;
          try { log(outMsg); } catch (e) {}
        }
      } catch (e) {
        // console.debug('[fetch-debug] error reading request data:', e); // Silenced for cleaner UI
      }

      const resp = await originalFetch(input, init);
      try {
        if (url.indexOf('/v1/realtime/calls') !== -1 || url.indexOf('/v1/realtime/sessions') !== -1) {
          const cloned = resp.clone();
          const text = await cloned.text();
          const msg = `[fetch-debug-resp] ${url} status: ${resp.status} body: ${text}`;
          // console.debug(msg); // Silenced for cleaner UI
          try { log(msg); } catch (e) {}
        }
      } catch (e) {
        // console.debug('[fetch-debug] error reading response:', e); // Silenced for cleaner UI
        try { log('[fetch-debug] error reading response: ' + String(e)); } catch (e2) {}
      }
      return resp;
    };
  })();
}

async function getEphemeralSession() {
  const resp = await fetch('/session', { method: 'POST' });
  if (!resp.ok) throw new Error('Failed to get ephemeral session');
  const data = await resp.json();
  return data;
}

async function startSdkSession() {
  setStatus('Connecting you to a financial inclusion specialist…');

  // Simulate a short delay for "finding a specialist"
  await new Promise(res => setTimeout(res, 1200));
  setStatus('Locating an available specialist…');
  await new Promise(res => setTimeout(res, 1200));

  const sessionResp = await getEphemeralSession();
  const ephemeralKey = sessionResp.apiKey || null;
  const instructions = sessionResp.instructions || 'You are a helpful assistant.';
  baseInstructions = instructions;
  if (!ephemeralKey) throw new Error('No ephemeral key returned from /session');

  try {
    setStatus('Connecting you now…');
    const sdk = await import('@openai/agents-realtime');
    const { RealtimeAgent, RealtimeSession } = sdk;

    const agent = new RealtimeAgent({ name: 'Ash', instructions });
    const sdkSession = new RealtimeSession(agent);

    setStatus('Establishing secure connection…');
    await sdkSession.connect({ apiKey: ephemeralKey });

    client = sdkSession;
    setStatus('You are now connected to Ash, your STEVE-FI financial inclusion specialist.');
    if (connectBtn) connectBtn.disabled = true;
    if (disconnectBtn) disconnectBtn.disabled = false;

    // Configure session to avoid interruptions and auto-responses from VAD
    try {
      sdkSession.transport.sendEvent({
        type: 'session.update',
        session: {
          type: 'realtime',
          audio: {
            input: {
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 300,
                create_response: false,
                interrupt_response: false,
              },
            },
            output: {},
          },
          output_modalities: ['audio'],
        },
      });
      autoCreateResponses = false;
      setStatus('Session active');
    } catch (e) {
      // Silenced for cleaner UI
    }


    // Restore event-driven context and response flow
    const markInFlight = (label, evt) => {
      inFlightResponse = true;
      // Silenced: log(label);
    };
    const clearInFlight = (label, evt) => {
      inFlightResponse = false;
      // Silenced: log(label);
      const currentStatus = document.getElementById('statusText')?.textContent || '';
      if (currentStatus.includes('waiting for agent')) setStatus('connected');
      processQueuedResponses();
    };

    // Response lifecycle
    sdkSession.transport.on('response.created', (e) => { if (pendingResponseTimer) { clearTimeout(pendingResponseTimer); pendingResponseTimer = null; } markInFlight('response.created', e); });
    sdkSession.transport.on('response.in_progress', (e) => markInFlight('response.in_progress', e));
    sdkSession.transport.on('response.completed', (e) => clearInFlight('response.completed', e));
    sdkSession.transport.on('response.done', (e) => {
      clearInFlight('response.done', e);
      // After the first strict greeting finishes, restore normal instructions
      if (greetingRestorePending) {
        greetingRestorePending = false;
        const instr = buildInstructions();
        sendEventSafe({ type: 'session.update', session: { type: 'realtime', instructions: instr } });
      }
    });
    sdkSession.transport.on('response.failed', (e) => clearInFlight('response.failed', e));
    // Server-prefixed fallbacks (some SDKs use these)
    sdkSession.transport.on('server.response.created', (e) => { if (pendingResponseTimer) { clearTimeout(pendingResponseTimer); pendingResponseTimer = null; } markInFlight('server.response.created', e); });
    sdkSession.transport.on('server.response.done', (e) => clearInFlight('server.response.done', e));

    // Transcript guard helpers for first greeting
    function normalizeText(s) {
      try {
        return String(s)
          .toLowerCase()
          .replace(/[\-_/]/g, ' ')
          .replace(/[^a-z0-9 ]+/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      } catch { return ''; }
    }
    function sendFixedGreeting() {
      try {
        sdkSession.transport.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'assistant',
            content: [ { type: 'output_text', text: EXPECTED_GREETING } ],
          },
        });
        sdkSession.transport.sendEvent({ type: 'response.create', response: { output_modalities: ['audio'] } });
      } catch {}
    }

    sdkSession.transport.on('response.output_audio_transcript.delta', (e) => {
      try {
        if (!e || !e.delta) return;
        if (!greetingGuardActive) return;
        greetingAccum += String(e.delta);
        const normAccum = normalizeText(greetingAccum);
        if (!EXPECTED_GREETING_NORM) EXPECTED_GREETING_NORM = normalizeText(EXPECTED_GREETING);
        const expectedPrefix = EXPECTED_GREETING_NORM.slice(0, normAccum.length);
        if (normAccum && normAccum !== expectedPrefix) {
          if (greetingRetries < GREETING_MAX_RETRIES) {
            greetingRetries++;
            sendEventSafe({ type: 'response.cancel' });
            greetingAccum = '';
            sendFixedGreeting();
            return;
          } else {
            greetingGuardActive = false;
          }
        }
      } catch {}
    });
    sdkSession.transport.on('response.output_audio_transcript.done', (e) => { try { if (greetingGuardActive) greetingGuardActive = false; } catch {} });

    // Additional helpful events
    sdkSession.transport.on('conversation.item.added', (e) => { try { /* log('conversation.item.added'); */ } catch {} });
    sdkSession.transport.on('conversation.item.created', async (e) => {
      try {
        // log('conversation.item.created');
        // Intentionally do not trigger response here; wait for item.done
      } catch {}
    });
    sdkSession.transport.on('server.conversation.item.created', (e) => {
      try {
        const item = e && (e.item || e.data || e.payload || e);
        if (!autoCreateResponses && item && item.type === 'message' && item.role === 'user') {
          // log('Server user turn detected; requesting response…');
          queueOrTriggerResponse();
        }
      } catch {}
    });
    sdkSession.transport.on('conversation.item.done', async (e) => {
      try {
        // log('conversation.item.done');
        const item = e && (e.item || e.data || e.payload || e);
        if (item && item.type === 'message' && item.role === 'user') {
          if (!suppressKBNextTurn) {
            try {
              const parts = Array.isArray(item.content) ? item.content : [];
              const textParts = parts.filter(p => p && p.type === 'input_text' && p.text).map(p => p.text.trim());
              const query = (textParts.join(' ').trim() || '').slice(0, 800);
              if (query.length >= 8) {
                setStatus('Retrieving KB context…');
                const resp = await fetch('/context/augment', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ query, k: 6, maxChars: 4000 })
                });
                if (resp.ok) {
                  const data = await resp.json();
                  kbContext = data?.context || '';
                  if (kbContext) {
                    const instr = buildInstructions();
                    sendEventSafe({ type: 'session.update', session: { type: 'realtime', instructions: instr } });
                    // log(`KB context applied (${kbContext.length} chars).`);
                  }
                } else {
                  try { /* log('KB retrieval failed: ' + await resp.text()); */ } catch {}
                }
              }
            } catch (kbErr) {
              // console.debug('KB retrieval error', kbErr);
            }
          } else {
            suppressKBNextTurn = false;
          }

          if (!autoCreateResponses) {
            // log('User turn done; requesting response…');
            queueOrTriggerResponse();
          }
        }
      } catch {}
    });
    sdkSession.transport.on('error', (e) => {
      inFlightResponse = false;
      console.error('error:', e);
      setStatus('Session error');
      processQueuedResponses();
    });
    // Connection state hints (best-effort)
    sdkSession.transport.on('open', () => { 
      transportConnected = true; 
      try { 
        setStatus('connected');
        if (connectBtn) connectBtn.disabled = true;
        if (disconnectBtn) connectBtn.disabled = false;
      } catch {}
    });
    sdkSession.transport.on('close', () => { 
      transportConnected = false; 
      try { 
        setStatus('disconnected');
        if (connectBtn) connectBtn.disabled = false;
        if (disconnectBtn) connectBtn.disabled = true;
      } catch {}
    });

    // Send staged greeting after connection as an assistant message, then create audio response
    try {
      setStatus('Ash is joining the call…');
      await new Promise(res => setTimeout(res, 1200));
      // Temporarily tighten instructions for the first spoken response only
      greetingPrevInstructions = baseInstructions;
      const strictGreeting = `${baseInstructions}\n\nFor your next response only, speak exactly this sentence and nothing else. Do not infer or use a caller name. Do not add any extra words before or after.\n\n"${EXPECTED_GREETING}"`;
      sendEventSafe({ type: 'session.update', session: { type: 'realtime', instructions: strictGreeting } });
      greetingRestorePending = true;
      // Create a response without adding a conversation item so the model reads exactly the instruction
      sdkSession.transport.sendEvent({ type: 'response.create', response: { output_modalities: ['audio'] } });
      setStatus('connected');
    } catch (greetErr) {
      // Silenced for cleaner UI
      log('Note: Greeting could not be sent, but session is connected.');
    }
  } catch (err) {
    console.error('SDK connection failed:', err);
    setStatus('error');
    throw err;
  }
}

if (connectBtn) {
  connectBtn.onclick = async () => {
    try {
      connectBtn.disabled = true;
      setStatus('connecting…');
      await startSdkSession();
    } catch (err) {
      console.error(err);
      log('Error connecting: ' + (err && err.message ? err.message : err));
      if (connectBtn) connectBtn.disabled = false;
      if (disconnectBtn) disconnectBtn.disabled = true;
    }
  };
} else {
  console.warn('No element with id "connect" found in DOM. Connection button disabled.');
}

if (disconnectBtn) {
  disconnectBtn.onclick = async () => {
    try {
      if (client) {
        // Try to disconnect the SDK session
        if (typeof client.disconnect === 'function') {
          try { 
            await client.disconnect(); 
            log('Phone call disconnected...');
          } catch (e) { 
            console.warn('Error calling disconnect():', e); 
            log('Warning: error during disconnect: ' + (e && e.message ? e.message : e));
          }
        } else if (typeof client.close === 'function') {
          // Fallback: try close() if disconnect doesn't exist
          try { 
            await client.close(); 
            log('Phone call disconnected..');
          } catch (e) { 
            console.warn('Error calling close():', e); 
          }
        } else {
          log('Client has no disconnect/close method. Clearing local reference.');
        }
        client = null;
        setStatus('idle');
        if (connectBtn) connectBtn.disabled = false;
        if (disconnectBtn) disconnectBtn.disabled = true;
      } else {
        log('No active session to disconnect.');
        setStatus('idle');
        if (connectBtn) connectBtn.disabled = false;
        if (disconnectBtn) disconnectBtn.disabled = true;
      }
    } catch (err) {
      console.error(err);
      log('Error disconnecting: ' + (err && err.message ? err.message : err));
      setStatus('error');
    }
  };
} else {
  console.warn('No element with id "disconnect" found in DOM.');
}

// PDF to image conversion helper
async function convertPdfToImages(file) {
  const pdfjsLib = await import('pdfjs-dist');
  // Set worker source - use unpkg for reliable CDN delivery
  const pdfjsVersion = pdfjsLib.version || '4.0.379';
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsVersion}/build/pdf.worker.min.mjs`;
  
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const images = [];
  
  // Convert each page to an image (limit to first 5 pages for performance)
  const maxPages = Math.min(pdf.numPages, 5);
  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2.0 });
    
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    await page.render({ canvasContext: context, viewport }).promise;
    
    // Convert canvas to base64 PNG
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    images.push({ base64, format: 'png', pageNum });
  }
  
  return images;
}

// Extract text from a PDF for use as session context
async function extractPdfText(file) {
  const pdfjsLib = await import('pdfjs-dist');
  const pdfjsVersion = pdfjsLib.version || '4.0.379';
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsVersion}/build/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const maxPages = Math.min(pdf.numPages, 20);
  let text = '';
  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const strings = content.items.map(i => (i.str || ''));
    text += `\n\n--- Page ${pageNum} ---\n` + strings.join(' ');
  }
  // Normalize whitespace and trim
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

if (imageUpload) {
  imageUpload.onchange = async (e) => {
    if (!client) {
      log('Connect first, then upload a document.');
      imageUpload.value = '';
      return;
    }
    const file = e.target?.files && e.target.files[0];
    if (!file) return;
    try {
      if (file.type === 'application/pdf') {
        // Treat as user-provided financial document; do NOT use server KB retrieval here
        try {
          setStatus('Extracting PDF text...');
          const pdfText = await extractPdfText(file);
          const MAX_CHARS = 20000;
          const trimmed = pdfText.length > MAX_CHARS ? pdfText.slice(0, MAX_CHARS) + '…' : pdfText;
          const docBlock = `\n\n[User-Provided Financial Document]\nName: ${file.name}\nInstructions: Acknowledge receipt. Analyze and summarize key findings, issues, and recommended actions. Do not ask to re-upload unless you need additional pages or documents.\nText:\n${trimmed}`;
          userDocContext += docBlock;
          const newInstructions = `${baseInstructions}\n\n[User Documents]\nThe following content comes from the caller's own financial documents. Use it for analysis for this caller only. Do not confuse it with general reference materials.${userDocContext}`;
          const ok = sendEventSafe({ type: 'session.update', session: { type: 'realtime', instructions: newInstructions } });
          if (ok) log(`Document received and processed: (${Math.min(pdfText.length, MAX_CHARS)} chars).`);

          suppressKBNextTurn = true;
          const textOnly = {
            type: 'message',
            role: 'user',
            content: [ { type: 'input_text', text: `I just uploaded my financial document (${file.name}). Please acknowledge and begin your analysis using the provided context.` } ]
          };
          sendEventSafe({ type: 'conversation.item.create', item: textOnly });
          scheduleResponseFallback();
          setStatus('PDF context applied - agent should respond');
          return;
        } catch (e) {
          console.warn('PDF text extraction failed, falling back to preview:', e);
          // As a last resort, send a small preview image only
          try {
            const pdfjsLib = await import('pdfjs-dist');
            const pdfjsVersion = pdfjsLib.version || '4.0.379';
            pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsVersion}/build/pdf.worker.min.mjs`;
            const buf = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
            const page = await pdf.getPage(1);
            const viewport = page.getViewport({ scale: 1.0 });
            const canvas = document.createElement('canvas');
            const ctx2d = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: ctx2d, viewport }).promise;
            const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
            const content = [ { type: 'input_text', text: `Here is a preview of my financial document (${file.name}). Please analyze and advise.` } ];
            if (dataUrl) content.push({ type: 'input_image', image_url: String(dataUrl) });
            const previewMsg = { type: 'message', role: 'user', content };
            sendEventSafe({ type: 'conversation.item.create', item: previewMsg });
            scheduleResponseFallback();
            setStatus('PDF sent - agent should respond');
            return;
          } catch (previewErr) {
            console.warn('Preview generation failed:', previewErr);
            const textOnly = { type: 'message', role: 'user', content: [ { type: 'input_text', text: `I uploaded a financial PDF (${file.name}). Please analyze and advise.` } ] };
            sendEventSafe({ type: 'conversation.item.create', item: textOnly });
            scheduleResponseFallback();
            setStatus('PDF sent - agent should respond');
            return;
          }
        }
      } else {
        // Handle regular images
        setStatus('Analyzing image...');
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result; // Already in the format: data:image/...;base64,...
          if (!dataUrl) { log('Could not read image data.'); return; }
          try {
            suppressKBNextTurn = true;
            const imageMessageItem = {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'I have uploaded a document for you to analyze. Please review it and provide insights.' },
                { type: 'input_image', image_url: String(dataUrl) }
              ]
            };

            sendEventSafe({
              type: 'conversation.item.create',
              item: imageMessageItem
            });

            log('Document sent to assistant for analysis.');
            // Use fallback timer to avoid creating a response while one is active
            scheduleResponseFallback();
            setStatus('Image sent - agent should respond');
          } catch (e) {
            console.error('Error preparing/sending image message:', e);
            log('Error sending image: ' + (e?.message || e));
            setStatus('error sending document');
          }
        };
        reader.onerror = () => log('Error reading image file.');
        reader.readAsDataURL(file);
      }
    } catch (err) {
      console.error('Error processing file:', err);
      log('Error processing file: ' + (err?.message || err));
      setStatus('error');
    } finally {
      imageUpload.value = '';
    }
  };
} else {
  // if (DEBUG) console.warn('No element with id "imageUpload" found in DOM.'); // Silenced for cleaner UI
}
