/**
 * Memory — Supabase-backed persistent memory, conversation buffer, todos, habits,
 *           vector search (OpenAI embeddings), contacts/CRM
 */

import { supabase, MEMORY_ENABLED, CONTEXT_MESSAGE_COUNT, GEMINI_API_KEY, OPENAI_API_KEY } from "./config";
import type { ConversationMessage } from "./types";

// ============================================================
// VECTOR EMBEDDINGS (OpenAI text-embedding-3-small)
// ============================================================

// In-memory cache: fact ID → embedding vector
const embeddingCache = new Map<string, { content: string; vector: number[] }>();

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536; // Match Supabase pgvector column

async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY) return null;

  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!res.ok) {
      console.error("Embedding API error:", await res.text());
      return null;
    }

    const data = await res.json();
    return data?.data?.[0]?.embedding ?? null;
  } catch (error) {
    console.error("generateEmbedding error:", error);
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Load all fact embeddings into memory and backfill any missing ones.
 *  On first run after model switch (Gemini → OpenAI), re-embeds all facts. */
export async function initEmbeddings(): Promise<void> {
  if (!supabase || !OPENAI_API_KEY) return;

  try {
    // Check if we need to re-embed due to model switch
    const FLAG_CONTENT = `[SYSTEM] embedding_model:${EMBEDDING_MODEL}`;
    const { data: modelFlag } = await supabase
      .from("memory")
      .select("id, content")
      .eq("type", "fact")
      .eq("content", FLAG_CONTENT)
      .limit(1);

    const needsReEmbed = !modelFlag || modelFlag.length === 0;

    const { data: facts } = await supabase
      .from("memory")
      .select("id, content, embedding")
      .eq("type", "fact");

    if (!facts || facts.length === 0) return;

    if (needsReEmbed) {
      // One-time re-embed: clear old Gemini embeddings, regenerate with OpenAI
      console.log(`Re-embedding ${facts.length} facts with OpenAI ${EMBEDDING_MODEL}...`);
      let done = 0;
      for (const fact of facts) {
        const vector = await generateEmbedding(fact.content);
        if (vector) {
          embeddingCache.set(fact.id, { content: fact.content, vector });
          await supabase
            .from("memory")
            .update({ embedding: vector })
            .eq("id", fact.id)
            .then(() => {})
            .catch(() => {});
          done++;
        }
        // Brief pause every 50 to avoid rate limits
        if (done % 50 === 0 && done > 0) {
          console.log(`  Re-embedded ${done}/${facts.length}...`);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      console.log(`Re-embedding complete: ${done}/${facts.length} facts`);

      // Store model flag so we don't re-embed on next restart
      const { error: flagErr } = await supabase.from("memory").insert({
        type: "fact",
        content: FLAG_CONTENT,
      });
      if (flagErr) {
        console.error("Failed to store embedding model flag:", flagErr.message);
      } else {
        console.log("Stored embedding model flag — won't re-embed on next restart");
      }
    } else {
      // Normal startup: load cached embeddings, backfill missing
      const needsBackfill: typeof facts = [];

      for (const fact of facts) {
        let vector: number[] | null = null;
        if (fact.embedding) {
          if (Array.isArray(fact.embedding)) {
            vector = fact.embedding;
          } else if (typeof fact.embedding === "string") {
            try {
              vector = JSON.parse(fact.embedding);
            } catch { /* not parseable */ }
          }
        }

        if (vector && vector.length > 0) {
          embeddingCache.set(fact.id, { content: fact.content, vector });
        } else {
          needsBackfill.push(fact);
        }
      }

      if (needsBackfill.length > 0) {
        console.log(`Backfilling embeddings for ${needsBackfill.length} facts...`);
        for (const fact of needsBackfill) {
          const vector = await generateEmbedding(fact.content);
          if (vector) {
            embeddingCache.set(fact.id, { content: fact.content, vector });
            await supabase
              .from("memory")
              .update({ embedding: vector })
              .eq("id", fact.id)
              .then(() => {})
              .catch(() => {});
          }
        }
        console.log("Embedding backfill complete");
      }
    }

    console.log(`Vector search: ${embeddingCache.size} facts indexed`);
  } catch (error) {
    console.error("initEmbeddings error:", error);
  }
}

/** Find facts most relevant to a query using cosine similarity */
export async function searchMemory(query: string, topK = 10): Promise<Array<{ content: string; score: number }>> {
  if (embeddingCache.size === 0 || !OPENAI_API_KEY) return [];

  const queryVector = await generateEmbedding(query);
  if (!queryVector) return [];

  const scored: Array<{ content: string; score: number }> = [];

  for (const [, entry] of embeddingCache) {
    const score = cosineSimilarity(queryVector, entry.vector);
    if (score > 0.25) scored.push({ content: entry.content, score: Math.round(score * 100) / 100 });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

async function getRelevantFacts(query: string, topK = 10): Promise<string[]> {
  if (embeddingCache.size === 0) return [];

  const queryVector = await generateEmbedding(query);
  if (!queryVector) return [];

  const scored: Array<{ content: string; score: number }> = [];

  for (const [, entry] of embeddingCache) {
    // Skip contacts — they have their own context section
    if (entry.content.startsWith(CONTACT_PREFIX)) continue;
    const score = cosineSimilarity(queryVector, entry.vector);
    scored.push({ content: entry.content, score });
  }

  scored.sort((a, b) => b.score - a.score);

  // Return top K facts with similarity > 0.3 (filter out noise)
  return scored
    .filter((s) => s.score > 0.3)
    .slice(0, topK)
    .map((s) => s.content);
}

// ============================================================
// CONVERSATION BUFFER (in-memory for active session)
// ============================================================

const conversationBuffer: ConversationMessage[] = [];
const MAX_CONV_BUFFER = 10;

function addToConversationBuffer(role: "user" | "assistant", content: string) {
  conversationBuffer.push({ role, content, timestamp: new Date() });
  if (conversationBuffer.length > MAX_CONV_BUFFER) {
    conversationBuffer.shift();
  }
}

export function getConversationContext(): string {
  if (conversationBuffer.length === 0) return "";

  const lines = conversationBuffer.map((m) => {
    const truncated = m.content.length > 800
      ? m.content.substring(0, 800) + "..."
      : m.content;
    return `[${m.role}]: ${truncated}`;
  });

  return `\nACTIVE CONVERSATION (current session):\n${lines.join("\n")}`;
}

// ============================================================
// MEMORY (Supabase)
// ============================================================

export async function storeMessage(
  role: "user" | "assistant",
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  // Always add to in-memory conversation buffer
  addToConversationBuffer(role, content);

  if (!supabase) return;
  try {
    const truncated = content.length > 10000 ? content.substring(0, 10000) : content;
    await supabase.from("messages").insert({
      role,
      content: truncated,
      channel: "telegram",
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("storeMessage error:", error);
  }
}

export async function storeFact(content: string): Promise<void> {
  if (!supabase) return;
  try {
    // Deduplicate exact matches
    const { data: existing } = await supabase
      .from("memory")
      .select("id")
      .eq("type", "fact")
      .eq("content", content)
      .limit(1);

    if (existing && existing.length > 0) return;

    // Generate embedding for vector search
    const vector = await generateEmbedding(content);

    const row: Record<string, unknown> = { type: "fact", content };
    if (vector) row.embedding = vector;

    let { data: inserted, error } = await supabase
      .from("memory")
      .insert(row)
      .select("id")
      .single();

    // Retry without embedding if it caused the error
    if (error && vector) {
      console.error("storeFact insert error (retrying without embedding):", error.message);
      delete row.embedding;
      const retry = await supabase.from("memory").insert(row).select("id").single();
      inserted = retry.data;
      error = retry.error;
    }

    if (inserted && vector) {
      embeddingCache.set(inserted.id, { content, vector });
      // Store embedding separately if insert didn't include it
      await supabase.from("memory").update({ embedding: vector }).eq("id", inserted.id);
    }

    console.log(`Stored fact: ${content.substring(0, 60)}${vector ? " (with embedding)" : ""}`);
  } catch (error) {
    console.error("storeFact error:", error);
  }
}

export async function storeGoal(content: string, deadline?: string): Promise<void> {
  if (!supabase) return;
  try {
    const row: Record<string, unknown> = { type: "goal", content };
    if (deadline) row.deadline = deadline;
    await supabase.from("memory").insert(row);
    console.log(`Stored goal: ${content.substring(0, 60)}`);
  } catch (error) {
    console.error("storeGoal error:", error);
  }
}

export async function completeGoal(searchText: string): Promise<void> {
  if (!supabase) return;
  try {
    const { data: goals } = await supabase
      .from("memory")
      .select("id, content")
      .eq("type", "goal")
      .ilike("content", `%${searchText}%`)
      .limit(1);

    if (!goals || goals.length === 0) {
      console.log(`No goal found matching: ${searchText}`);
      return;
    }

    await supabase
      .from("memory")
      .update({
        type: "completed_goal",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", goals[0].id);

    console.log(`Completed goal: ${goals[0].content.substring(0, 60)}`);
  } catch (error) {
    console.error("completeGoal error:", error);
  }
}

export async function getMemoryContext(query?: string): Promise<string> {
  if (!supabase) return "";

  try {
    // Only fetch Supabase messages if conversation buffer is empty (fresh restart)
    const needsHistory = conversationBuffer.length === 0;

    const [relevantFacts, goalsRes, messagesRes] = await Promise.all([
      // Use vector search if we have a query and embeddings, otherwise fall back to recent
      query && embeddingCache.size > 0
        ? getRelevantFacts(query, 15)
        : supabase
            .from("memory")
            .select("content")
            .eq("type", "fact")
            .order("created_at", { ascending: false })
            .limit(20)
            .then((res) => (res.data || []).map((f) => f.content)),
      supabase
        .from("memory")
        .select("content, deadline")
        .eq("type", "goal")
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false }),
      needsHistory
        ? supabase
            .from("messages")
            .select("role, content, created_at")
            .order("created_at", { ascending: false })
            .limit(CONTEXT_MESSAGE_COUNT)
        : Promise.resolve({ data: [] as Array<{ role: string; content: string; created_at: string }> }),
    ]);

    let context = "";

    if (relevantFacts.length > 0) {
      const label = query && embeddingCache.size > 0
        ? "RELEVANT MEMORY (facts most related to this conversation)"
        : "PERSISTENT MEMORY (facts you know about the user)";
      context += `\n${label}:\n`;
      context += relevantFacts.map((f) => `- ${f}`).join("\n");
    }

    const goals = goalsRes.data || [];
    if (goals.length > 0) {
      context += "\n\nACTIVE GOALS:\n";
      context += goals
        .map((g) => {
          const dl = g.deadline ? ` (by ${g.deadline})` : "";
          return `- ${g.content}${dl}`;
        })
        .join("\n");
    }

    // Only include Supabase history if no in-memory buffer
    const messages = messagesRes.data || [];
    if (messages.length > 0) {
      context += "\n\nRECENT CONVERSATION HISTORY (newest first):\n";
      context += messages
        .map((m) => {
          const truncated =
            m.content.length > 300
              ? m.content.substring(0, 300) + "..."
              : m.content;
          return `[${m.role}]: ${truncated}`;
        })
        .join("\n");
    }

    return context;
  } catch (error) {
    console.error("getMemoryContext error:", error);
    return "";
  }
}

// ============================================================
// TODOS (stored in memory table with type="todo")
// ============================================================

export async function storeTodo(content: string, dueDate?: string): Promise<void> {
  if (!supabase) return;
  try {
    const row: Record<string, unknown> = { type: "todo", content };
    if (dueDate) row.deadline = dueDate;
    await supabase.from("memory").insert(row);
    console.log(`Stored todo: ${content.substring(0, 60)}`);
  } catch (error) {
    console.error("storeTodo error:", error);
  }
}

export async function completeTodo(searchText: string): Promise<void> {
  if (!supabase) return;
  try {
    const { data: todos } = await supabase
      .from("memory")
      .select("id, content")
      .eq("type", "todo")
      .ilike("content", `%${searchText}%`)
      .limit(1);

    if (!todos || todos.length === 0) {
      console.log(`No todo found matching: ${searchText}`);
      return;
    }

    await supabase
      .from("memory")
      .update({
        type: "completed_todo",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", todos[0].id);

    console.log(`Completed todo: ${todos[0].content.substring(0, 60)}`);
  } catch (error) {
    console.error("completeTodo error:", error);
  }
}

export async function getTodoContext(): Promise<string> {
  if (!supabase) return "";

  try {
    const { data: todos } = await supabase
      .from("memory")
      .select("content, deadline")
      .eq("type", "todo")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false });

    if (!todos || todos.length === 0) return "";

    let context = "\nACTIVE TODOS:\n";
    context += todos
      .map((t) => {
        const due = t.deadline ? ` (due ${t.deadline})` : "";
        return `- ${t.content}${due}`;
      })
      .join("\n");

    return context;
  } catch (error) {
    console.error("getTodoContext error:", error);
    return "";
  }
}

// ============================================================
// HABITS (stored in memory table with type="habit")
// Uses: content=description, deadline=frequency, priority=streak, updated_at=last completion
// ============================================================

export async function storeHabit(description: string, frequency = "daily"): Promise<void> {
  if (!supabase) return;
  try {
    // Deduplicate
    const { data: existing } = await supabase
      .from("memory")
      .select("id")
      .eq("type", "habit")
      .ilike("content", `%${description}%`)
      .limit(1);

    if (existing && existing.length > 0) return;

    await supabase.from("memory").insert({
      type: "habit",
      content: description,
      deadline: frequency, // "daily" or "weekly"
      priority: 0, // streak count
    });
    console.log(`Stored habit: ${description} (${frequency})`);
  } catch (error) {
    console.error("storeHabit error:", error);
  }
}

export async function completeHabit(searchText: string): Promise<void> {
  if (!supabase) return;
  try {
    const { data: habits } = await supabase
      .from("memory")
      .select("id, content, priority, updated_at, metadata")
      .eq("type", "habit")
      .ilike("content", `%${searchText}%`)
      .limit(1);

    if (!habits || habits.length === 0) {
      console.log(`No habit found matching: ${searchText}`);
      return;
    }

    const habit = habits[0];
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = now.toLocaleDateString("en-US", { timeZone: tz });

    // Check if already done today
    if (habit.updated_at) {
      const lastDone = new Date(habit.updated_at).toLocaleDateString("en-US", { timeZone: tz });
      if (lastDone === todayStr) {
        console.log(`Habit already done today: ${habit.content}`);
        return;
      }
    }

    // Calculate streak with 1-day grace period
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const dayBefore = new Date(now);
    dayBefore.setDate(dayBefore.getDate() - 2);
    const yesterdayStr = yesterday.toLocaleDateString("en-US", { timeZone: tz });
    const dayBeforeStr = dayBefore.toLocaleDateString("en-US", { timeZone: tz });
    const lastDoneStr = habit.updated_at
      ? new Date(habit.updated_at).toLocaleDateString("en-US", { timeZone: tz })
      : "";

    let newStreak: number;
    if (lastDoneStr === yesterdayStr) {
      // Done yesterday — continue streak
      newStreak = (habit.priority || 0) + 1;
    } else if (lastDoneStr === dayBeforeStr) {
      // Missed 1 day (grace period) — keep streak, don't increment
      newStreak = Math.max(habit.priority || 1, 1);
    } else {
      // Missed 2+ days — reset
      newStreak = 1;
    }

    // Track best streak in metadata
    const meta = (habit.metadata && typeof habit.metadata === "object") ? { ...habit.metadata as Record<string, unknown> } : {};
    const bestStreak = Math.max(newStreak, (meta.bestStreak as number) || 0);
    meta.bestStreak = bestStreak;

    await supabase
      .from("memory")
      .update({
        priority: newStreak,
        updated_at: now.toISOString(),
        metadata: meta,
      })
      .eq("id", habit.id);

    // Log individual completion for analytics
    await supabase.from("logs").insert({
      event: "habit_complete",
      message: habit.content,
      metadata: {
        habit_id: habit.id,
        streak: newStreak,
        bestStreak,
        hour: now.getHours(),
        dayOfWeek: now.getDay(),
      },
    }).catch(() => {});

    const bestStr = bestStreak > newStreak ? ` (best: ${bestStreak})` : "";
    console.log(`Habit done: ${habit.content} (streak: ${newStreak}${bestStr})`);
  } catch (error) {
    console.error("completeHabit error:", error);
  }
}

export async function removeHabit(searchText: string): Promise<void> {
  if (!supabase) return;
  try {
    const { data: habits } = await supabase
      .from("memory")
      .select("id, content")
      .eq("type", "habit")
      .ilike("content", `%${searchText}%`)
      .limit(1);

    if (!habits || habits.length === 0) return;

    await supabase.from("memory").delete().eq("id", habits[0].id);
    console.log(`Removed habit: ${habits[0].content}`);
  } catch (error) {
    console.error("removeHabit error:", error);
  }
}

export async function getHabitContext(): Promise<string> {
  if (!supabase) return "";

  try {
    const { data: habits } = await supabase
      .from("memory")
      .select("id, content, deadline, priority, updated_at, metadata")
      .eq("type", "habit")
      .order("created_at", { ascending: true });

    if (!habits || habits.length === 0) return "";

    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = now.toLocaleDateString("en-US", { timeZone: tz });
    const hour = now.getHours();

    // Get recent completion logs for time-of-day insights
    const { data: recentLogs } = await supabase
      .from("logs")
      .select("metadata, created_at")
      .eq("event", "habit_complete")
      .order("created_at", { ascending: false })
      .limit(200);

    // Build per-habit insights from logs
    const habitLogs = new Map<string, { hours: number[]; completions7d: number }>();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    for (const log of recentLogs || []) {
      const meta = log.metadata as Record<string, unknown> | null;
      const habitId = meta?.habit_id as string;
      if (!habitId) continue;

      const entry = habitLogs.get(habitId) || { hours: [], completions7d: 0 };
      entry.hours.push((meta?.hour as number) || 0);
      if (new Date(log.created_at) > sevenDaysAgo) {
        entry.completions7d++;
      }
      habitLogs.set(habitId, entry);
    }

    let context = "\nHABITS:\n";
    context += habits
      .map((h) => {
        const streak = h.priority || 0;
        const meta = (h.metadata && typeof h.metadata === "object") ? h.metadata as Record<string, unknown> : {};
        const bestStreak = (meta.bestStreak as number) || streak;
        const lastDone = h.updated_at
          ? new Date(h.updated_at).toLocaleDateString("en-US", { timeZone: tz })
          : "";
        const doneToday = lastDone === todayStr;
        const status = doneToday ? "DONE" : "NOT YET";

        // Streak info
        let streakStr = "";
        if (streak > 0) {
          streakStr = ` (${streak}-day streak`;
          if (bestStreak > streak) streakStr += `, best: ${bestStreak}`;
          streakStr += ")";
        } else if (bestStreak > 0) {
          streakStr = ` (best streak was ${bestStreak} days)`;
        }

        // Completion rate (7 days)
        const logs = habitLogs.get(h.id);
        const rate7d = logs ? Math.round((logs.completions7d / 7) * 100) : 0;
        const rateStr = logs && logs.completions7d > 0 ? ` — ${rate7d}% this week` : "";

        // Optimal time hint (only if not done today and we have data)
        let timeHint = "";
        if (!doneToday && logs && logs.hours.length >= 3) {
          const avgHour = Math.round(logs.hours.reduce((s, h) => s + h, 0) / logs.hours.length);
          if (hour >= avgHour && hour <= avgHour + 2) {
            timeHint = " ⏰ Usually done around now";
          } else if (hour > avgHour + 2) {
            timeHint = " ⚠️ Usually done earlier";
          }
        }

        return `- [${status}] ${h.content} — ${h.deadline}${streakStr}${rateStr}${timeHint}`;
      })
      .join("\n");

    return context;
  } catch (error) {
    console.error("getHabitContext error:", error);
    return "";
  }
}

// ============================================================
// HABIT ANALYTICS (for dashboard and reports)
// ============================================================

export interface HabitAnalytics {
  id: string;
  content: string;
  frequency: string;
  currentStreak: number;
  bestStreak: number;
  doneToday: boolean;
  completionRate7d: number;
  completionRate30d: number;
  optimalHour: number | null;
  weekHistory: boolean[]; // last 7 days, most recent first
  lastDone: string | null;
}

export async function getHabitAnalytics(): Promise<HabitAnalytics[]> {
  if (!supabase) return [];

  try {
    const { data: habits } = await supabase
      .from("memory")
      .select("id, content, deadline, priority, updated_at, metadata")
      .eq("type", "habit")
      .order("created_at", { ascending: true });

    if (!habits || habits.length === 0) return [];

    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = now.toLocaleDateString("en-US", { timeZone: tz });

    // Get all habit completion logs
    const { data: allLogs } = await supabase
      .from("logs")
      .select("metadata, created_at")
      .eq("event", "habit_complete")
      .order("created_at", { ascending: false })
      .limit(1000);

    // Index logs by habit ID
    const logsByHabit = new Map<string, Array<{ date: string; hour: number; created_at: string }>>();
    for (const log of allLogs || []) {
      const meta = log.metadata as Record<string, unknown> | null;
      const habitId = meta?.habit_id as string;
      if (!habitId) continue;

      const entries = logsByHabit.get(habitId) || [];
      entries.push({
        date: new Date(log.created_at).toLocaleDateString("en-US", { timeZone: tz }),
        hour: (meta?.hour as number) || 0,
        created_at: log.created_at,
      });
      logsByHabit.set(habitId, entries);
    }

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    return habits.map((h) => {
      const meta = (h.metadata && typeof h.metadata === "object") ? h.metadata as Record<string, unknown> : {};
      const logs = logsByHabit.get(h.id) || [];
      const lastDone = h.updated_at
        ? new Date(h.updated_at).toLocaleDateString("en-US", { timeZone: tz })
        : null;

      // Completion counts
      const completions7d = logs.filter((l) => new Date(l.created_at) > sevenDaysAgo).length;
      const completions30d = logs.filter((l) => new Date(l.created_at) > thirtyDaysAgo).length;

      // Optimal hour
      const hours = logs.map((l) => l.hour);
      const optimalHour = hours.length >= 3
        ? Math.round(hours.reduce((s, h) => s + h, 0) / hours.length)
        : null;

      // 7-day history (was it done each day?)
      const weekHistory: boolean[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dayStr = d.toLocaleDateString("en-US", { timeZone: tz });
        weekHistory.push(logs.some((l) => l.date === dayStr));
      }

      return {
        id: h.id,
        content: h.content,
        frequency: h.deadline || "daily",
        currentStreak: h.priority || 0,
        bestStreak: Math.max((meta.bestStreak as number) || 0, h.priority || 0),
        doneToday: lastDone === todayStr,
        completionRate7d: Math.round((completions7d / 7) * 100),
        completionRate30d: Math.round((completions30d / 30) * 100),
        optimalHour,
        weekHistory,
        lastDone: h.updated_at || null,
      };
    });
  } catch (error) {
    console.error("getHabitAnalytics error:", error);
    return [];
  }
}

// ============================================================
// AUTO-LEARNING (extract facts from conversations via Gemini)
// ============================================================

export async function autoExtractFacts(userMessage: string, assistantResponse: string): Promise<void> {
  if (!supabase || !GEMINI_API_KEY) return;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Analyze this conversation and extract any facts worth remembering long-term about the user. Only extract GENUINELY useful facts — things like preferences, personal details, relationships, decisions, plans, health info, business details, or recurring topics. Do NOT extract transient things like "user asked about the weather" or "user said hi."

If there are contacts mentioned (people with names, relationships, emails, phones), format them as: CONTACT: Name | relationship | email | phone | notes

USER: ${userMessage}

ASSISTANT: ${assistantResponse}

Respond with ONLY a JSON array of strings. Each string is one fact. If there are no facts worth remembering, respond with [].
Example: ["Prefers morning meetings", "CONTACT: Sarah Chen | business partner | sarah@example.com"]`
            }]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 500,
          },
        }),
      }
    );

    if (!res.ok) return;

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]";

    // Parse JSON array — handle markdown code blocks
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    let facts: string[];
    try {
      facts = JSON.parse(cleaned);
    } catch {
      return; // Not valid JSON, skip
    }

    if (!Array.isArray(facts) || facts.length === 0) return;

    for (const fact of facts) {
      if (typeof fact !== "string" || fact.length < 5) continue;

      if (fact.startsWith("CONTACT:")) {
        // Parse contact format: CONTACT: Name | relationship | email | phone | notes
        const parts = fact.replace("CONTACT:", "").trim().split("|").map(s => s.trim());
        if (parts.length >= 1 && parts[0]) {
          await storeContact(parts[0], parts[1], parts[2], parts[3], parts[4]);
        }
      } else {
        await storeFact(fact);
      }
    }

    if (facts.length > 0) {
      console.log(`Auto-learned ${facts.length} fact(s) from conversation`);
    }
  } catch (error) {
    console.error("autoExtractFacts error:", error);
  }
}

// ============================================================
// VOICE MEMO ACTION ITEM EXTRACTION
// ============================================================

export async function autoExtractTodos(
  transcription: string
): Promise<string[]> {
  if (!supabase || !GEMINI_API_KEY) return [];

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Analyze this voice memo transcription and extract any action items, tasks, reminders, or follow-ups. Only extract CLEAR, ACTIONABLE items — not vague thoughts or observations.

For each item, include a due date if one is mentioned or clearly implied (e.g., "tomorrow", "next week", "by Friday"). Format dates as YYYY-MM-DD.

TRANSCRIPTION:
${transcription}

Respond with ONLY a JSON array of objects. Each object has:
- "task": the action item (imperative form, concise)
- "due": date string or null if no date mentioned

Example: [{"task": "Call Dave about the contract", "due": "2025-02-10"}, {"task": "Order new supplements", "due": null}]

If there are no action items, respond with [].`
            }]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
        }),
      }
    );

    if (!res.ok) return [];

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]";

    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    let items: Array<{ task: string; due?: string | null }>;
    try {
      items = JSON.parse(cleaned);
    } catch {
      return [];
    }

    if (!Array.isArray(items) || items.length === 0) return [];

    const extracted: string[] = [];

    for (const item of items) {
      if (!item.task || typeof item.task !== "string" || item.task.length < 5) continue;

      await storeTodo(item.task, item.due || undefined);
      const dueStr = item.due ? ` (due ${item.due})` : "";
      extracted.push(`${item.task}${dueStr}`);
    }

    if (extracted.length > 0) {
      console.log(`Voice memo: extracted ${extracted.length} action item(s)`);
    }

    return extracted;
  } catch (error) {
    console.error("autoExtractTodos error:", error);
    return [];
  }
}

// ============================================================
// CONTACTS / CRM
// ============================================================

const CONTACT_PREFIX = "[CONTACT] ";

export async function storeContact(
  name: string,
  relationship?: string,
  email?: string,
  phone?: string,
  notes?: string
): Promise<void> {
  if (!supabase) return;
  try {
    // Build structured content string with prefix
    const parts = [name];
    if (relationship) parts.push(`relationship: ${relationship}`);
    if (email) parts.push(`email: ${email}`);
    if (phone) parts.push(`phone: ${phone}`);
    if (notes) parts.push(`notes: ${notes}`);
    const content = CONTACT_PREFIX + parts.join(" | ");

    // Check if contact already exists (by name in contact-prefixed facts)
    const { data: existing } = await supabase
      .from("memory")
      .select("id, content")
      .eq("type", "fact")
      .ilike("content", `${CONTACT_PREFIX}${name}%`)
      .limit(1);

    if (existing && existing.length > 0) {
      // Update existing contact
      const vector = await generateEmbedding(content);
      const update: Record<string, unknown> = { content, updated_at: new Date().toISOString() };
      if (vector) update.embedding = vector;
      await supabase.from("memory").update(update).eq("id", existing[0].id);
      if (vector) embeddingCache.set(existing[0].id, { content, vector });
      console.log(`Updated contact: ${name}`);
    } else {
      // Create new contact — stored as fact type with [CONTACT] prefix
      const vector = await generateEmbedding(content);
      const row: Record<string, unknown> = { type: "fact", content };
      if (vector) row.embedding = vector;

      let { data: inserted, error } = await supabase
        .from("memory")
        .insert(row)
        .select("id")
        .single();

      if (error && vector) {
        delete row.embedding;
        const retry = await supabase.from("memory").insert(row).select("id").single();
        inserted = retry.data;
        if (inserted) {
          await supabase.from("memory").update({ embedding: vector }).eq("id", inserted.id);
        }
      }

      if (inserted && vector) {
        embeddingCache.set(inserted.id, { content, vector });
      }
      console.log(`Stored contact: ${name}`);
    }
  } catch (error) {
    console.error("storeContact error:", error);
  }
}

export async function getContactContext(query?: string): Promise<string> {
  if (!supabase) return "";

  try {
    // If we have a query and embeddings, use vector search to find relevant contacts
    if (query && embeddingCache.size > 0) {
      const queryVector = await generateEmbedding(query);
      if (queryVector) {
        const scored: Array<{ content: string; score: number }> = [];

        // Search only contact entries in embedding cache
        for (const [, entry] of embeddingCache) {
          if (!entry.content.startsWith(CONTACT_PREFIX)) continue;
          const score = cosineSimilarity(queryVector, entry.vector);
          if (score > 0.4) scored.push({ content: entry.content.replace(CONTACT_PREFIX, ""), score });
        }

        scored.sort((a, b) => b.score - a.score);
        const relevant = scored.slice(0, 5);

        if (relevant.length > 0) {
          return "\nRELEVANT CONTACTS:\n" + relevant.map((c) => `- ${c.content}`).join("\n");
        }
      }
    }

    // Fallback: return all contacts (for check-ins, briefings, etc.)
    const { data: contacts } = await supabase
      .from("memory")
      .select("content")
      .eq("type", "fact")
      .ilike("content", `${CONTACT_PREFIX}%`)
      .order("updated_at", { ascending: false })
      .limit(20);

    if (!contacts || contacts.length === 0) return "";

    return "\nCONTACTS:\n" + contacts.map((c) => `- ${c.content.replace(CONTACT_PREFIX, "")}`).join("\n");
  } catch (error) {
    console.error("getContactContext error:", error);
    return "";
  }
}

// ============================================================
// CHECK-IN HELPERS
// ============================================================

export async function logCheckin(
  decision: string,
  reason: string,
  message?: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("logs").insert({
      event: "checkin",
      level: "info",
      message: message || reason,
      metadata: { decision, reason },
    });
  } catch (error) {
    console.error("logCheckin error:", error);
  }
}

export async function getLastCheckinTime(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("logs")
      .select("created_at")
      .eq("event", "checkin")
      .contains("metadata", { decision: "YES" })
      .order("created_at", { ascending: false })
      .limit(1);

    return data?.[0]?.created_at ?? null;
  } catch (error) {
    console.error("getLastCheckinTime error:", error);
    return null;
  }
}
