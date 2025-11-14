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

if (imageUpload) {
  imageUpload.onchange = (e) => {
    if (!client) {
      log('Connect first, then upload an image.');
      imageUpload.value = '';
      return;
    }
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const parts = String(dataUrl).split(',');
      if (parts.length !== 2) { log('Could not read image data.'); return; }
      const base64 = parts[1];
      const format = (file.type || 'image/png').split('/')[1];
      try {
        client.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [ { type: 'input_text', text: 'Here is an image. If it contains a table or spreadsheet, extract it as CSV and summarize it. Otherwise just describe what\'s in the image.' }, { type: 'input_image', image: { base64: base64, format: format } } ] } });
        client.send({ type: 'response.create' });
        log('Image sent to assistant for analysis.');
      } catch (e) {
        console.warn('Error sending image to SDK session', e);
      }
      imageUpload.value = '';
    };
    reader.onerror = () => log('Error reading image file.');
    reader.readAsDataURL(file);
  };
} else {
  if (DEBUG) console.warn('No element with id "imageUpload" found in DOM.');
}
