// Voice I/O — Deepgram (STT) and ElevenLabs (TTS). Exposed as two
// Express route registrars so dash-agent.js can mount them onto its
// existing server. Audio output is streamed directly back to the
// browser so we don't need to persist files on Railway.
//
// Latency shape for a full voice round-trip:
//   STT ~1s + intent LLM ~1s + agent work + format LLM ~1s + TTS ~2s
// i.e. expect 5-8s end-to-end. Typing bypasses STT/TTS.

import express from "express";

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen?model=nova-2&language=en-GB&smart_format=true&punctuate=true";
const ELEVEN_MODEL = "eleven_turbo_v2_5";

export function registerVoiceRoutes(app) {
  // ── STT ───────────────────────────────────────────────────────────
  // Accepts a raw webm/opus audio body. Frontend sends the blob from
  // MediaRecorder directly (don't use JSON — the binary should be the
  // request body). Use the raw() middleware with a generous cap.
  app.post(
    "/api/voice/transcribe",
    express.raw({ type: ["audio/*", "application/octet-stream"], limit: "20mb" }),
    async (req, res) => {
      if (!DEEPGRAM_API_KEY) return res.status(500).json({ error: "DEEPGRAM_API_KEY not set" });
      if (!req.body || req.body.length === 0) return res.status(400).json({ error: "no audio body" });

      try {
        const contentType = req.headers["content-type"] || "audio/webm";
        const resp = await fetch(DEEPGRAM_URL, {
          method: "POST",
          headers: {
            Authorization: `Token ${DEEPGRAM_API_KEY}`,
            "Content-Type": contentType,
          },
          body: req.body,
          signal: AbortSignal.timeout(30_000),
        });
        if (!resp.ok) {
          const txt = await resp.text();
          console.error(`[VOICE] Deepgram ${resp.status}: ${txt.substring(0, 200)}`);
          return res.status(502).json({ error: `Deepgram ${resp.status}`, detail: txt.substring(0, 200) });
        }
        const data = await resp.json();
        const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        return res.json({
          transcript,
          confidence: data?.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0,
        });
      } catch (e) {
        console.error("[VOICE] transcribe error:", e.message);
        return res.status(500).json({ error: e.message });
      }
    },
  );

  // ── TTS ───────────────────────────────────────────────────────────
  // Streams MP3 bytes from ElevenLabs straight to the client. The
  // frontend should use <audio src="..."> or decode into an
  // AudioBuffer so the particle visualiser can sync to amplitude.
  app.post("/api/voice/speak", express.json(), async (req, res) => {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
      return res.status(500).json({ error: "ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID not set" });
    }
    const text = (req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "no text" });

    try {
      const ttsRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: ELEVEN_MODEL,
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 },
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );

      if (!ttsRes.ok) {
        const txt = await ttsRes.text();
        console.error(`[VOICE] ElevenLabs ${ttsRes.status}: ${txt.substring(0, 200)}`);
        return res.status(502).json({ error: `ElevenLabs ${ttsRes.status}`, detail: txt.substring(0, 200) });
      }

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");

      // Pipe the body stream through to the response.
      if (ttsRes.body?.pipe) {
        ttsRes.body.pipe(res);
      } else if (ttsRes.body?.getReader) {
        const reader = ttsRes.body.getReader();
        const pump = async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          res.end();
        };
        pump().catch((e) => { console.error("[VOICE] TTS pump error:", e.message); res.end(); });
      } else {
        const buf = Buffer.from(await ttsRes.arrayBuffer());
        res.end(buf);
      }
    } catch (e) {
      console.error("[VOICE] speak error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Health ─────────────────────────────────────────────────────────
  app.get("/api/voice/health", (req, res) => res.json({
    deepgram: DEEPGRAM_API_KEY ? "✓" : "✗",
    elevenlabs: ELEVENLABS_API_KEY ? "✓" : "✗",
    voiceId: ELEVENLABS_VOICE_ID ? "✓" : "✗",
  }));
}

// A function suitable for Jarvis' in-process speakFn — returns a
// playable URL. We don't host audio files; instead we return a POST
// target the frontend can fetch directly, so Jarvis just tells the
// client "speak this text" and the audio is fetched on demand.
// Shape: { speakUrl, text } so the browser can pipeline STT→LLM→TTS
// without waiting for the server to buffer audio in memory.
export function jarvisSpeakResolver(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return null;
  return { speakUrl: "/api/voice/speak", text };
}
