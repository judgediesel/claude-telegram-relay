/**
 * Voice — ElevenLabs TTS and Gemini audio transcription
 */

import { spawn } from "bun";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import {
  GEMINI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  VOICE_REPLIES_ENABLED,
  TEMP_DIR,
} from "./config";

export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const base64Audio = audioBuffer.toString("base64");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: "audio/ogg",
                  data: base64Audio,
                },
              },
              {
                text: "Transcribe this audio exactly as spoken. Return only the transcription text, nothing else.",
              },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Gemini API error:", response.status, errorText);
    throw new Error(`Gemini transcription failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    throw new Error("Gemini returned empty transcription");
  }

  return text;
}

export async function textToVoice(text: string): Promise<string | null> {
  if (!VOICE_REPLIES_ENABLED) return null;

  try {
    // Truncate for reasonable TTS length
    const ttsText = text.length > 2000 ? text.substring(0, 2000) + "..." : text;

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: ttsText,
          model_id: "eleven_turbo_v2_5",
        }),
      }
    );

    if (!response.ok) {
      console.error("ElevenLabs API error:", response.status);
      return null;
    }

    const timestamp = Date.now();
    const mp3Path = join(TEMP_DIR, `voice_${timestamp}.mp3`);
    const oggPath = join(TEMP_DIR, `voice_${timestamp}.ogg`);

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    await writeFile(mp3Path, audioBuffer);

    // Convert MP3 to OGG Opus (required by Telegram for voice messages)
    const ffmpeg = spawn(
      ["ffmpeg", "-i", mp3Path, "-c:a", "libopus", "-b:a", "64k", "-y", oggPath],
      { stdout: "pipe", stderr: "pipe" }
    );
    await ffmpeg.exited;

    // Cleanup MP3
    await unlink(mp3Path).catch(() => {});

    // Verify OGG was created
    try {
      await readFile(oggPath);
      return oggPath;
    } catch {
      console.error("ffmpeg conversion failed — is ffmpeg installed?");
      return null;
    }
  } catch (error) {
    console.error("TTS error:", error);
    return null;
  }
}
