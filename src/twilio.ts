/**
 * Twilio — SMS, voice calls, conversation calls, XML escaping
 */

import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  TWILIO_USER_PHONE,
  TWILIO_PUBLIC_URL,
  TWILIO_ENABLED,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  TEMP_DIR,
} from "./config";

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function makeCall(message: string, to?: string): Promise<void> {
  if (!TWILIO_ENABLED) return;

  const recipient = to || TWILIO_USER_PHONE;
  let twiml: string;

  // Try ElevenLabs voice -> temp-hosted audio -> Twilio <Play>
  if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
    try {
      const audioRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: message,
            model_id: "eleven_monolingual_v1",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        }
      );

      if (audioRes.ok) {
        const audioBuffer = await audioRes.arrayBuffer();
        const tempPath = join(TEMP_DIR, `call-${Date.now()}.mp3`);
        await writeFile(tempPath, Buffer.from(audioBuffer));

        // Upload to temp host for a public URL
        const formData = new FormData();
        formData.append("reqtype", "fileupload");
        formData.append("time", "1h");
        formData.append("fileToUpload", new Blob([audioBuffer], { type: "audio/mpeg" }), "call.mp3");

        const uploadRes = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
          method: "POST",
          body: formData,
        });

        if (uploadRes.ok) {
          const audioUrl = (await uploadRes.text()).trim();
          twiml = `<Response><Play>${escapeXml(audioUrl)}</Play><Pause length="1"/><Play>${escapeXml(audioUrl)}</Play></Response>`;
          console.log(`Call using ElevenLabs voice: ${audioUrl}`);
        } else {
          console.error("Audio upload error:", uploadRes.status);
          twiml = `<Response><Say voice="Polly.Matthew">${escapeXml(message)}</Say><Pause length="1"/><Say voice="Polly.Matthew">${escapeXml(message)}</Say></Response>`;
        }

        // Clean up local temp file
        unlink(tempPath).catch(() => {});
      } else {
        console.error("ElevenLabs TTS error:", audioRes.status);
        twiml = `<Response><Say voice="Polly.Matthew">${escapeXml(message)}</Say><Pause length="1"/><Say voice="Polly.Matthew">${escapeXml(message)}</Say></Response>`;
      }
    } catch (error) {
      console.error("ElevenLabs call error:", error);
      twiml = `<Response><Say voice="Polly.Matthew">${escapeXml(message)}</Say><Pause length="1"/><Say voice="Polly.Matthew">${escapeXml(message)}</Say></Response>`;
    }
  } else {
    twiml = `<Response><Say voice="Polly.Matthew">${escapeXml(message)}</Say><Pause length="1"/><Say voice="Polly.Matthew">${escapeXml(message)}</Say></Response>`;
  }

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: TWILIO_PHONE_NUMBER,
          To: recipient,
          Twiml: twiml,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error("Twilio Call error:", err);
      return;
    }

    console.log(`Call initiated to ${recipient}: ${message.substring(0, 60)}`);
  } catch (error) {
    console.error("makeCall error:", error);
  }
}

// SMS is blocked until toll-free verification is approved.
// Route all SMS through voice call for now.
// TODO: Re-enable SMS once toll-free number is verified on Twilio.
export async function sendSMS(body: string, to?: string): Promise<void> {
  if (!TWILIO_ENABLED) return;
  console.log("SMS unavailable (toll-free unverified), routing to voice call");
  await makeCall(body, to);
}

export async function startConversationCall(to?: string): Promise<void> {
  if (!TWILIO_ENABLED || !TWILIO_PUBLIC_URL) {
    console.error("Conversation call requires TWILIO_PUBLIC_URL");
    return;
  }

  const recipient = to || TWILIO_USER_PHONE;
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: TWILIO_PHONE_NUMBER,
          To: recipient,
          Url: `${TWILIO_PUBLIC_URL}/twilio/voice`,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error("Conversation call error:", err);
      return;
    }

    console.log(`Conversation call initiated to ${recipient}`);
  } catch (error) {
    console.error("startConversationCall error:", error);
  }
}
