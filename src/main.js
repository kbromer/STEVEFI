// src/main.js
import { OpenAIRealtimeWebRTC } from "@openai/agents-realtime";

const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const logDiv = document.getElementById("log");
const imageUpload = document.getElementById("imageUpload");

let client = null;

function log(message) {
  logDiv.textContent += message + "\n";
  logDiv.scrollTop = logDiv.scrollHeight;
}

// ⚠️ For demo only: keep the key here.
// For anything real, move this to a backend and mint short-lived tokens.
const OPENAI_API_KEY = "<YOUR_API_KEY_HERE>";

connectBtn.onclick = async () => {
  if (client) return;

  try {
    connectBtn.disabled = true;
    log("Requesting microphone permission…");

    client = new OpenAIRealtimeWebRTC();

    // Listen to all events; log a few useful ones.
    client.on("*", (event) => {
      // Uncomment for full event firehose:
      // console.log("Realtime event:", event);

      // When the assistant finishes a turn
      if (event.type === "response.completed") {
        log("Assistant finished a turn.");
      }

      // Partial assistant text output (streaming text)
      if (
        event.type === "response.output_text.delta" &&
        event.delta &&
        event.delta.text
      ) {
        log("Assistant (partial): " + event.delta.text);
      }

      // Simple logging of speech boundary events
      if (
        event.type === "input_audio_buffer.speech_started" ||
        event.type === "input_audio_buffer.speech_stopped"
      ) {
        log("Speech event: " + event.type);
      }
    });

    // Connect over WebRTC; this will request mic/speaker automatically.
    await client.connect({
      apiKey: OPENAI_API_KEY,
      model: "gpt-4o-mini-realtime-preview",
      initialSessionConfig: {
        // ⬇️ Paste your Custom GPT instructions here
        instructions: `
          You are Kevin's custom demo assistant in a philanthropy context.
          Speak clearly and concisely, as if you are in a board meeting with
          non-technical leaders. If the user uploads an image, describe it and,
          if it looks like a table or spreadsheet, extract the data in a
          structured way (like CSV or JSON) and summarize any key insights.
        `,
        voice: "ash", // or "alloy", "verse", etc. depending on what’s available
        modalities: ["text", "audio"],
        inputAudioFormat: "pcm16",
        outputAudioFormat: "pcm16",
        audio: {
          input: {
            // Let the model auto-detect when the user stops talking
            turnDetection: { type: "semantic_vad", interruptResponse: true }
          }
        }
      }
    });

    log("Connected. Start talking!");

    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
  } catch (err) {
    console.error(err);
    log("Error connecting: " + (err && err.message ? err.message : err));
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    client = null;
  }
};

disconnectBtn.onclick = async () => {
  if (!client) return;
  try {
    await client.close();
    log("Disconnected from Realtime API.");
  } catch (err) {
    console.error(err);
    log("Error disconnecting: " + (err && err.message ? err.message : err));
  } finally {
    client = null;
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  }
};

// --- Image upload → vision call via Realtime ---

imageUpload.onchange = (e) => {
  if (!client) {
    log("Connect first, then upload an image.");
    imageUpload.value = "";
    return;
  }

  const file = e.target.files[0];
  if (!file) return;

  // Use FileReader to get a base64 string from the image
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result; // e.g. "data:image/png;base64,AAAA..."
    const parts = String(dataUrl).split(",");
    if (parts.length !== 2) {
      log("Could not read image data.");
      return;
    }
    const base64 = parts[1];
    const format = (file.type || "image/png").split("/")[1]; // "png", "jpeg", etc.

    // Create a user message with text + image
    client.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Here is an image. " +
              "If it contains a table or spreadsheet, extract it as CSV and summarize it. " +
              "Otherwise just describe what's in the image."
          },
          {
            type: "input_image",
            image: {
              base64: base64,
              format: format
            }
          }
        ]
      }
    });

    // Ask the assistant to respond
    client.send({ type: "response.create" });

    log("Image sent to assistant for analysis.");
    imageUpload.value = "";
  };

  reader.onerror = () => {
    log("Error reading image file.");
  };

  reader.readAsDataURL(file);
};