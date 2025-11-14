// Client-side using Agents Realtime SDK (dynamic import)
// Set DEBUG to false: SDK will use correct endpoints directly
const DEBUG = false;

const connectBtn = document.getElementById('connect');
const disconnectBtn = document.getElementById('disconnect');
const logDiv = document.getElementById('log');
const imageUpload = document.getElementById('imageUpload');

let client = null; // will hold the RealtimeSession from the SDK

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
            try { console.error('SessionDescription.sdp preview:\n', String(desc.sdp).slice(0, 2000)); } catch (e) { console.error('Unable to read desc.sdp'); }
          } else if (desc && typeof desc !== 'string') {
            try { console.error('Description preview (stringified):', JSON.stringify(desc).slice(0, 2000)); } catch (e) { console.error('Unable to serialize desc for logging'); }
          } else if (desc && typeof desc === 'string') {
            console.error('SDP preview:\n', String(desc).slice(0, 2000));
          }
      } catch (loggingErr) {
        console.error('Error while logging setRemoteDescription failure', loggingErr);
      }
      throw err;
    }
  };
} catch (e) {
  console.warn('Could not instrument RTCPeerConnection.setRemoteDescription', e);
}

function log(message) {
  if (logDiv) {
    logDiv.textContent += message + '\n';
    logDiv.scrollTop = logDiv.scrollHeight;
  }
  console.log(message);
}

function setStatus(text) {
  try {
    const el = document.getElementById('statusText');
    if (el) el.textContent = text;
  } catch (e) {
    console.debug('setStatus error', e);
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
          console.debug('[fetch-proxy] error forwarding to /webrtc/call:', err);
        }
      }

      const method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET';
      const reqBody = init && init.body ? String(init.body).slice(0, 2000) : undefined;
      try {
        if (url.indexOf('/v1/realtime/calls') !== -1 || url.indexOf('/v1/realtime/sessions') !== -1) {
          const outMsg = `[fetch-debug-req] ${method} ${url} body: ${reqBody || '<no-body>'}`;
          console.debug(outMsg);
          try { log(outMsg); } catch (e) {}
        }
      } catch (e) {
        console.debug('[fetch-debug] error reading request data:', e);
      }

      const resp = await originalFetch(input, init);
      try {
        if (url.indexOf('/v1/realtime/calls') !== -1 || url.indexOf('/v1/realtime/sessions') !== -1) {
          const cloned = resp.clone();
          const text = await cloned.text();
          const msg = `[fetch-debug-resp] ${url} status: ${resp.status} body: ${text}`;
          console.debug(msg);
          try { log(msg); } catch (e) {}
        }
      } catch (e) {
        console.debug('[fetch-debug] error reading response:', e);
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
  setStatus('creating ephemeral session…');
  const sessionResp = await getEphemeralSession();
  const ephemeralKey = sessionResp.apiKey || null;
  const instructions = sessionResp.instructions || 'You are a helpful assistant.';
  if (!ephemeralKey) throw new Error('No ephemeral key returned from /session');

  try {
    setStatus('loading SDK…');
    const sdk = await import('@openai/agents-realtime');
    const { RealtimeAgent, RealtimeSession } = sdk;

    const agent = new RealtimeAgent({ name: 'Assistant', instructions });
    const sdkSession = new RealtimeSession(agent);

    setStatus('connecting via SDK…');
    // Pass apiKey (ephemeral key) to connect; SDK handles WebRTC internally
    await sdkSession.connect({ apiKey: ephemeralKey });

    client = sdkSession;
    log('Connected via Agents SDK.');
    setStatus('connected');
    if (connectBtn) connectBtn.disabled = true;
    if (disconnectBtn) disconnectBtn.disabled = false;

    // Listen for transport events to monitor document processing
    sdkSession.transport.on('server.response.created', (event) => {
      console.debug('Response created:', event);
    });
    
    sdkSession.transport.on('server.response.done', (event) => {
      console.debug('Response completed:', event);
      // If we were waiting for a document response, update status
      const currentStatus = document.getElementById('statusText')?.textContent || '';
      if (currentStatus.includes('waiting for agent')) {
        setStatus('connected');
      }
    });
    
    sdkSession.transport.on('server.error', (event) => {
      console.error('Server error:', event);
      log('Error from server: ' + JSON.stringify(event));
    });

    // Send auto-greeting message after successful connection
    try {
      setStatus('sending greeting…');
      sdkSession.transport.sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'input_text',
              text: 'Hi, my name is Ash with STEVE-FI. I am here to help you with financial resources and guidance. May I ask who I am speaking with?',
            },
          ],
        },
      });

      // Trigger response creation to ensure the agent speaks the greeting
      sdkSession.transport.sendEvent({
        type: 'response.create',
      });

      log('Greeting message sent.');
      setStatus('connected');
    } catch (greetErr) {
      console.warn('Error sending greeting:', greetErr);
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
            log('Disconnected via SDK.');
          } catch (e) { 
            console.warn('Error calling disconnect():', e); 
            log('Warning: error during disconnect: ' + (e && e.message ? e.message : e));
          }
        } else if (typeof client.close === 'function') {
          // Fallback: try close() if disconnect doesn't exist
          try { 
            await client.close(); 
            log('Closed via SDK.');
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

if (imageUpload) {
  imageUpload.onchange = async (e) => {
    if (!client) {
      log('Connect first, then upload a document.');
      imageUpload.value = '';
      return;
    }
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      // Check if it's a PDF
      if (file.type === 'application/pdf') {
        setStatus('Converting PDF...');
        log('Converting PDF to images...');
        
        const images = await convertPdfToImages(file);
        log(`PDF converted: ${images.length} page(s)`);
        
        // Send all pages in a single message with multiple image content items
        const content = [];
        
        // Add text introduction
        content.push({
          type: 'input_text',
          text: `I have uploaded a PDF document with ${images.length} page(s) for you to analyze. Please review it and provide insights.`
        });
        
        // Add all images with proper data URL format via image_url
        for (let i = 0; i < images.length; i++) {
          const { base64 } = images[i];
          content.push({
            type: 'input_image',
            image_url: `data:image/png;base64,${base64}`
          });
        }

        // Build a single message item to reuse for response input to avoid race conditions
        const pdfMessageItem = {
          type: 'message',
          role: 'user',
          content
        };

        // Send single message with all content for history, then trigger response with the same input
        try {
          client.transport.sendEvent({
            type: 'conversation.item.create',
            item: pdfMessageItem
          });

          log('PDF pages sent to assistant for analysis.');

          // Trigger a response using the same message as input to avoid timing issues
          client.transport.sendEvent({
            type: 'response.create',
            response: {
              conversation: 'none',
              output_modalities: ['audio'],
              input: [ pdfMessageItem ]
            }
          });
          log('Response requested from agent.');
          setStatus('PDF sent - agent should respond');

        } catch (sendErr) {
          console.error('Error sending PDF:', sendErr);
          log('Error sending PDF: ' + (sendErr?.message || sendErr));
          setStatus('error sending document');
        }
      } else {
        // Handle regular images
        setStatus('Analyzing image...');
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result; // Already in the format: data:image/...;base64,...
          if (!dataUrl) { log('Could not read image data.'); return; }
          try {
            const imageMessageItem = {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'I have uploaded a document for you to analyze. Please review it and provide insights.' },
                { type: 'input_image', image_url: String(dataUrl) }
              ]
            };

            // Add to conversation history
            client.transport.sendEvent({
              type: 'conversation.item.create',
              item: imageMessageItem
            });

            log('Document sent to assistant for analysis.');

            // Trigger a response using the same message as input (out-of-band)
            client.transport.sendEvent({
              type: 'response.create',
              response: {
                conversation: 'none',
                output_modalities: ['audio'],
                input: [ imageMessageItem ]
              }
            });
            log('Response requested from agent.');
            setStatus('Image sent - agent should respond');

          } catch (e) {
            console.warn('Error sending image to SDK session', e);
            log('Error: ' + (e?.message || e));
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
  if (DEBUG) console.warn('No element with id "imageUpload" found in DOM.');
}
