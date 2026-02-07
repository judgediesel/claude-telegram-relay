/**
 * Webhook HTTP server — dashboard, API endpoints, Twilio webhooks
 */

import { readFile, writeFile, stat, unlink } from "fs/promises";
import { join } from "path";
import {
  WEBHOOK_PORT,
  WEBHOOK_SECRET,
  TWILIO_ENABLED,
  TWILIO_USER_PHONE,
  TWILIO_PUBLIC_URL,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  CALENDAR_ENABLED,
  supabase,
  TEMP_DIR,
  MAX_FILE_SIZE,
} from "./config";
import { storeMessage, storeTodo, storeHabit, completeTodo, completeHabit, searchMemory, autoExtractFacts, getHabitAnalytics } from "./memory";
import { callClaude, callClaudeWithSearch, buildPrompt } from "./claude";
import { processIntents } from "./intents";
import { sendTelegramText, sendTelegramFile, sendTelegramResponse } from "./telegram";
import { sendSMS, escapeXml } from "./twilio";
import { getAdsData, ADS_ENABLED } from "./ads";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function startWebhookServer(): void {
  if (!WEBHOOK_SECRET) return;

  Bun.serve({
    port: WEBHOOK_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      // Health check — no auth required
      if (req.method === "GET" && url.pathname === "/health") {
        const mem = process.memoryUsage();
        return jsonResponse({
          ok: true,
          uptime: Math.round(process.uptime()),
          memory: {
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
            rss: Math.round(mem.rss / 1024 / 1024),
          },
          version: "2.0.0",
        });
      }

      // Twilio incoming SMS webhook — no bearer auth (Twilio POSTs form data)
      if (req.method === "POST" && url.pathname === "/twilio/sms" && TWILIO_ENABLED) {
        try {
          const formData = await req.formData();
          const from = formData.get("From")?.toString() || "";
          const body = formData.get("Body")?.toString() || "";

          // Only accept messages from the authorized user's phone
          if (from !== TWILIO_USER_PHONE) {
            console.log(`Twilio SMS from unknown number: ${from}`);
            return new Response("<Response/>", { headers: { "Content-Type": "text/xml" } });
          }

          console.log(`Incoming SMS from ${from}: ${body.substring(0, 60)}`);

          // Process through Claude (async — respond to Twilio immediately)
          (async () => {
            try {
              await storeMessage("user", body, { source: "sms" });
              const enrichedPrompt = await buildPrompt(body);
              const response = await callClaudeWithSearch(enrichedPrompt, { resume: true });
              const { cleaned, intents } = processIntents(response);
              await Promise.all(intents);
              await storeMessage("assistant", cleaned, { source: "sms" });

              // Reply via SMS (truncate to 1600 chars — SMS limit)
              const smsReply = cleaned.length > 1500
                ? cleaned.substring(0, 1500) + "..."
                : cleaned;
              await sendSMS(smsReply);

              // Also forward to Telegram for visibility
              await sendTelegramText(`[via SMS] ${from}: ${body}\n\nRaya: ${cleaned}`);
            } catch (error) {
              console.error("Incoming SMS processing error:", error);
            }
          })();

          // Respond to Twilio immediately with empty TwiML (we send reply via API)
          return new Response("<Response/>", { headers: { "Content-Type": "text/xml" } });
        } catch (error) {
          console.error("Twilio webhook error:", error);
          return new Response("<Response/>", { headers: { "Content-Type": "text/xml" } });
        }
      }

      // Twilio voice conversation — answer and start listening
      if (req.method === "POST" && url.pathname === "/twilio/voice" && TWILIO_ENABLED) {
        try {
          const formData = await req.formData();
          const from = formData.get("From")?.toString() || "";
          const to = formData.get("To")?.toString() || "";

          // Outbound calls: From=Twilio, To=user. Inbound: From=user, To=Twilio.
          const isAuthorizedCall = from === TWILIO_USER_PHONE || to === TWILIO_USER_PHONE;
          if (!isAuthorizedCall) {
            return new Response("<Response><Say>Sorry, this number is not authorized.</Say><Hangup/></Response>", {
              headers: { "Content-Type": "text/xml" },
            });
          }

          console.log(`Voice call started from ${from}`);

          // Generate greeting with ElevenLabs voice
          let greetingTwiml: string;
          if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && TWILIO_PUBLIC_URL) {
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
                    text: "Hey Mark, what's up?",
                    model_id: "eleven_monolingual_v1",
                    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
                  }),
                }
              );

              if (audioRes.ok) {
                const audioBuffer = await audioRes.arrayBuffer();
                const fileName = `greet-${Date.now()}.mp3`;
                await writeFile(join(TEMP_DIR, fileName), Buffer.from(audioBuffer));
                const audioUrl = `${TWILIO_PUBLIC_URL}/voice/${fileName}`;
                greetingTwiml = `<Response>
                  <Play>${escapeXml(audioUrl)}</Play>
                  <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
                  <Say voice="Polly.Matthew">I didn't hear anything. Goodbye!</Say>
                </Response>`;
                setTimeout(() => unlink(join(TEMP_DIR, fileName)).catch(() => {}), 2 * 60 * 1000);
              } else {
                greetingTwiml = `<Response>
                  <Say voice="Polly.Matthew">Hey Mark, what's up?</Say>
                  <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
                </Response>`;
              }
            } catch {
              greetingTwiml = `<Response>
                <Say voice="Polly.Matthew">Hey Mark, what's up?</Say>
                <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
              </Response>`;
            }
          } else {
            greetingTwiml = `<Response>
              <Say voice="Polly.Matthew">Hey Mark, what's up?</Say>
              <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
              <Say voice="Polly.Matthew">I didn't hear anything. Goodbye!</Say>
            </Response>`;
          }
          const twiml = greetingTwiml;

          return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
        } catch (error) {
          console.error("Twilio voice error:", error);
          return new Response("<Response><Say>Something went wrong.</Say></Response>", {
            headers: { "Content-Type": "text/xml" },
          });
        }
      }

      // Serve voice audio files (no auth — Twilio needs direct access)
      if (req.method === "GET" && url.pathname.startsWith("/voice/") && url.pathname.endsWith(".mp3")) {
        try {
          const fileName = url.pathname.split("/").pop()!;
          const filePath = join(TEMP_DIR, fileName);
          const file = Bun.file(filePath);
          if (await file.exists()) {
            return new Response(file, { headers: { "Content-Type": "audio/mpeg" } });
          }
        } catch {}
        return new Response("Not found", { status: 404 });
      }

      // Twilio gather — process speech, respond, loop
      if (req.method === "POST" && url.pathname === "/twilio/gather" && TWILIO_ENABLED) {
        try {
          const formData = await req.formData();
          const speechResult = formData.get("SpeechResult")?.toString() || "";

          if (!speechResult) {
            return new Response(`<Response>
              <Say voice="Polly.Matthew">I didn't catch that. Try again.</Say>
              <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
              <Say voice="Polly.Matthew">Still nothing. Goodbye!</Say>
            </Response>`, { headers: { "Content-Type": "text/xml" } });
          }

          console.log(`Voice input: ${speechResult}`);

          // Store message (don't await — not needed for response)
          storeMessage("user", speechResult, { source: "phone" }).catch(() => {});

          // Process through Claude
          const enrichedPrompt = await buildPrompt(speechResult);
          const response = await callClaude(enrichedPrompt, { resume: true });
          const { cleaned, intents } = processIntents(response);

          // Fire-and-forget: intents, storage, telegram forwarding
          Promise.all(intents).catch(() => {});
          storeMessage("assistant", cleaned, { source: "phone" }).catch(() => {});
          sendTelegramText(`[Phone call]\nMark: ${speechResult}\nRaya: ${cleaned}`).catch(() => {});

          // Generate ElevenLabs audio and serve locally via ngrok (no catbox upload)
          let twiml: string;
          if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && TWILIO_PUBLIC_URL) {
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
                    text: cleaned,
                    model_id: "eleven_monolingual_v1",
                    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
                  }),
                }
              );

              if (audioRes.ok) {
                const audioBuffer = await audioRes.arrayBuffer();
                const fileName = `reply-${Date.now()}.mp3`;
                await writeFile(join(TEMP_DIR, fileName), Buffer.from(audioBuffer));
                const audioUrl = `${TWILIO_PUBLIC_URL}/voice/${fileName}`;

                twiml = `<Response>
                  <Play>${escapeXml(audioUrl)}</Play>
                  <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
                  <Say voice="Polly.Matthew">Are you still there?</Say>
                  <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
                  <Say voice="Polly.Matthew">Okay, goodbye!</Say>
                </Response>`;

                // Clean up after 2 minutes
                setTimeout(() => unlink(join(TEMP_DIR, fileName)).catch(() => {}), 2 * 60 * 1000);
              } else {
                twiml = `<Response>
                  <Say voice="Polly.Matthew">${escapeXml(cleaned)}</Say>
                  <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
                </Response>`;
              }
            } catch {
              twiml = `<Response>
                <Say voice="Polly.Matthew">${escapeXml(cleaned)}</Say>
                <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
              </Response>`;
            }
          } else {
            twiml = `<Response>
              <Say voice="Polly.Matthew">${escapeXml(cleaned)}</Say>
              <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
            </Response>`;
          }

          console.log(`Voice reply: ${cleaned.substring(0, 60)}`);
          return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
        } catch (error) {
          console.error("Twilio gather error:", error);
          return new Response(`<Response>
            <Say voice="Polly.Matthew">Sorry, I had an error. Let me try again.</Say>
            <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
          </Response>`, { headers: { "Content-Type": "text/xml" } });
        }
      }

      // Auth: Bearer token in header OR ?token= query param (for browser dashboard)
      const authHeader = req.headers.get("authorization");
      const tokenParam = url.searchParams.get("token");
      const isAuthed =
        authHeader === `Bearer ${WEBHOOK_SECRET}` ||
        tokenParam === WEBHOOK_SECRET;

      if (!isAuthed) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }

      // ---- Dashboard routes (GET) ----
      if (req.method === "GET") {
        if (url.pathname === "/dashboard") {
          try {
            const html = await readFile(join(import.meta.dir, "dashboard.html"), "utf-8");
            return new Response(html.replace("__TOKEN__", WEBHOOK_SECRET), {
              headers: { "Content-Type": "text/html" },
            });
          } catch {
            return new Response("Dashboard file not found", { status: 404 });
          }
        }

        if (url.pathname === "/api/memory" && supabase) {
          const [facts, goals, completedGoals] = await Promise.all([
            supabase.from("memory").select("*").eq("type", "fact").order("created_at", { ascending: false }),
            supabase.from("memory").select("*").eq("type", "goal").order("created_at", { ascending: false }),
            supabase.from("memory").select("*").eq("type", "completed_goal").order("completed_at", { ascending: false }).limit(10),
          ]);
          return jsonResponse({ facts: facts.data, goals: goals.data, completedGoals: completedGoals.data });
        }

        if (url.pathname === "/api/todos" && supabase) {
          const [active, completed] = await Promise.all([
            supabase.from("memory").select("*").eq("type", "todo").order("created_at", { ascending: false }),
            supabase.from("memory").select("*").eq("type", "completed_todo").order("completed_at", { ascending: false }).limit(10),
          ]);
          return jsonResponse({ active: active.data, completed: completed.data });
        }

        if (url.pathname === "/api/habits" && supabase) {
          const { data } = await supabase.from("memory").select("*").eq("type", "habit").order("created_at", { ascending: true });
          return jsonResponse({ habits: data });
        }

        if (url.pathname === "/api/habits/analytics" && supabase) {
          const analytics = await getHabitAnalytics();
          return jsonResponse({ analytics });
        }

        if (url.pathname === "/api/logs" && supabase) {
          const { data } = await supabase.from("logs").select("*").order("created_at", { ascending: false }).limit(50);
          return jsonResponse({ logs: data });
        }

        if (url.pathname === "/api/messages" && supabase) {
          const { data } = await supabase.from("messages").select("*").order("created_at", { ascending: false }).limit(30);
          return jsonResponse({ messages: data });
        }

        if (url.pathname === "/api/stats" && supabase) {
          const [facts, goals, todos, habits, messages] = await Promise.all([
            supabase.from("memory").select("id", { count: "exact" }).eq("type", "fact"),
            supabase.from("memory").select("id", { count: "exact" }).eq("type", "goal"),
            supabase.from("memory").select("id", { count: "exact" }).eq("type", "todo"),
            supabase.from("memory").select("id", { count: "exact" }).eq("type", "habit"),
            supabase.from("messages").select("id", { count: "exact" }),
          ]);
          return jsonResponse({
            facts: facts.count,
            goals: goals.count,
            todos: todos.count,
            habits: habits.count,
            messages: messages.count,
            calendar: CALENDAR_ENABLED,
            ads: ADS_ENABLED,
            uptime: Math.round(process.uptime()),
          });
        }

        // Contacts list
        if (url.pathname === "/api/contacts" && supabase) {
          const { data } = await supabase
            .from("memory")
            .select("id, content, updated_at, created_at")
            .eq("type", "fact")
            .ilike("content", "[CONTACT]%")
            .order("updated_at", { ascending: false });

          const contacts = (data || []).map(c => ({
            ...c,
            content: c.content.replace("[CONTACT] ", ""),
          }));
          return jsonResponse({ contacts });
        }

        // Ads data
        if (url.pathname === "/api/ads") {
          return jsonResponse(getAdsData());
        }

        // Memory search (semantic)
        if (url.pathname === "/api/memory-search" && supabase) {
          const q = url.searchParams.get("q");
          if (!q) return jsonResponse({ results: [] });

          const results = await searchMemory(q, 20);
          return jsonResponse({ results, query: q });
        }

        return jsonResponse({ ok: false, error: "Not found" }, 404);
      }

      // ---- Dashboard mutation routes (POST, authed) ----
      if (req.method === "POST" && url.pathname === "/api/habits/complete" && isAuthed) {
        try {
          const body = (await req.json()) as { id?: string; searchText?: string };
          if (body.id && supabase) {
            // Look up habit content to use completeHabit (which handles streak, grace days, logging)
            const { data: habits } = await supabase
              .from("memory")
              .select("content")
              .eq("id", body.id)
              .limit(1);

            if (habits && habits.length > 0) {
              await completeHabit(habits[0].content);
            }
          } else if (body.searchText) {
            await completeHabit(body.searchText);
          }
          return jsonResponse({ ok: true });
        } catch (error) {
          console.error("Habit complete error:", error);
          return jsonResponse({ ok: false, error: "Failed" }, 500);
        }
      }

      if (req.method === "POST" && url.pathname === "/api/habits/remove" && isAuthed) {
        try {
          const body = (await req.json()) as { id: string };
          if (body.id && supabase) {
            await supabase.from("memory").delete().eq("id", body.id);
          }
          return jsonResponse({ ok: true });
        } catch (error) {
          console.error("Habit remove error:", error);
          return jsonResponse({ ok: false, error: "Failed" }, 500);
        }
      }

      if (req.method === "POST" && url.pathname === "/api/habits/create" && isAuthed) {
        try {
          const body = (await req.json()) as { description: string; frequency?: string };
          if (body.description) {
            await storeHabit(body.description, body.frequency || "daily");
          }
          return jsonResponse({ ok: true });
        } catch (error) {
          console.error("Habit create error:", error);
          return jsonResponse({ ok: false, error: "Failed" }, 500);
        }
      }

      if (req.method === "POST" && url.pathname === "/api/todos/complete" && isAuthed) {
        try {
          const body = (await req.json()) as { id?: string; searchText?: string };
          if (body.id && supabase) {
            await supabase
              .from("memory")
              .update({
                type: "completed_todo",
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("id", body.id);
          } else if (body.searchText) {
            await completeTodo(body.searchText);
          }
          return jsonResponse({ ok: true });
        } catch (error) {
          console.error("Todo complete error:", error);
          return jsonResponse({ ok: false, error: "Failed" }, 500);
        }
      }

      if (req.method === "POST" && url.pathname === "/api/todos/create" && isAuthed) {
        try {
          const body = (await req.json()) as { content: string; dueDate?: string };
          if (body.content) {
            await storeTodo(body.content, body.dueDate);
          }
          return jsonResponse({ ok: true });
        } catch (error) {
          console.error("Todo create error:", error);
          return jsonResponse({ ok: false, error: "Failed" }, 500);
        }
      }

      if (req.method === "POST" && url.pathname === "/api/send-message" && isAuthed) {
        try {
          const body = (await req.json()) as { message: string };
          if (!body.message) {
            return jsonResponse({ ok: false, error: "Provide a message" }, 400);
          }

          // Process through Raya like a Telegram message
          await storeMessage("user", body.message, { source: "dashboard" });
          const enrichedPrompt = await buildPrompt(body.message);
          const response = await callClaudeWithSearch(enrichedPrompt, { resume: true });
          const { cleaned, intents } = processIntents(response);
          await Promise.all(intents);
          await storeMessage("assistant", cleaned, { source: "dashboard" });

          // Also forward to Telegram + auto-learn
          sendTelegramText(`[via Dashboard] ${body.message}\n\nRaya: ${cleaned}`).catch(() => {});
          autoExtractFacts(body.message, cleaned).catch(() => {});

          return jsonResponse({ ok: true, response: cleaned });
        } catch (error) {
          console.error("Send message error:", error);
          return jsonResponse({ ok: false, error: "Failed" }, 500);
        }
      }

      if (req.method !== "POST") {
        return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
      }

      let json: unknown;
      try {
        json = await req.json();
      } catch {
        return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
      }

      try {
        // POST /send — forward a message (and optional files) to Telegram
        if (url.pathname === "/send") {
          const body = json as { text?: string; files?: string[] };

          if (!body.text && (!body.files || body.files.length === 0)) {
            return jsonResponse({ ok: false, error: "Provide text and/or files" }, 400);
          }

          if (body.files) {
            for (const filePath of body.files) {
              try {
                const info = await stat(filePath);
                if (!info.isFile()) continue;
                if (info.size > MAX_FILE_SIZE) {
                  console.log(`Webhook: file too large: ${filePath}`);
                  continue;
                }
                await sendTelegramFile(filePath);
              } catch (err) {
                console.error(`Webhook: could not send file ${filePath}:`, err);
              }
            }
          }

          if (body.text) {
            await sendTelegramText(body.text);
          }

          return jsonResponse({ ok: true });
        }

        // POST /ask — run prompt through Claude, send response to Telegram
        if (url.pathname === "/ask") {
          const body = json as { prompt?: string };

          if (!body.prompt) {
            return jsonResponse({ ok: false, error: "Provide a prompt" }, 400);
          }

          storeMessage("user", body.prompt, { source: "webhook" });
          const enrichedPrompt = await buildPrompt(body.prompt);
          const response = await callClaudeWithSearch(enrichedPrompt, { resume: true });

          const { cleaned: cleanedAsk, intents: askIntents } = processIntents(response);
          storeMessage("assistant", cleanedAsk, { source: "webhook" });
          await Promise.all(askIntents);

          await sendTelegramResponse(cleanedAsk);

          return jsonResponse({ ok: true });
        }

        return jsonResponse({ ok: false, error: "Not found" }, 404);
      } catch (err) {
        console.error("Webhook error:", err);
        return jsonResponse({ ok: false, error: "Internal server error" }, 500);
      }
    },
  });

  console.log(`Webhook server running on port ${WEBHOOK_PORT}`);
}
