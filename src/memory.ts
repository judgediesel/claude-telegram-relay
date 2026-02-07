/**
 * Memory — Supabase-backed persistent memory, conversation buffer, todos, habits
 */

import { supabase, MEMORY_ENABLED, CONTEXT_MESSAGE_COUNT } from "./config";
import type { ConversationMessage } from "./types";

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

    await supabase.from("memory").insert({ type: "fact", content });
    console.log(`Stored fact: ${content.substring(0, 60)}`);
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

export async function getMemoryContext(): Promise<string> {
  if (!supabase) return "";

  try {
    // Only fetch Supabase messages if conversation buffer is empty (fresh restart)
    const needsHistory = conversationBuffer.length === 0;

    const [factsRes, goalsRes, messagesRes] = await Promise.all([
      supabase
        .from("memory")
        .select("content")
        .eq("type", "fact")
        .order("created_at", { ascending: false })
        .limit(20), // Limit to 20 most recent facts instead of ALL
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

    const facts = factsRes.data || [];
    if (facts.length > 0) {
      context += "\nPERSISTENT MEMORY (facts you know about the user):\n";
      context += facts.map((f) => `- ${f.content}`).join("\n");
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
      .select("id, content, priority, updated_at")
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

    // Calculate streak: was it done yesterday?
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toLocaleDateString("en-US", { timeZone: tz });
    const lastDoneStr = habit.updated_at
      ? new Date(habit.updated_at).toLocaleDateString("en-US", { timeZone: tz })
      : "";

    const newStreak = lastDoneStr === yesterdayStr ? (habit.priority || 0) + 1 : 1;

    await supabase
      .from("memory")
      .update({
        priority: newStreak,
        updated_at: now.toISOString(),
      })
      .eq("id", habit.id);

    console.log(`Habit done: ${habit.content} (streak: ${newStreak})`);
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
      .select("content, deadline, priority, updated_at")
      .eq("type", "habit")
      .order("created_at", { ascending: true });

    if (!habits || habits.length === 0) return "";

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = new Date().toLocaleDateString("en-US", { timeZone: tz });

    let context = "\nHABITS:\n";
    context += habits
      .map((h) => {
        const streak = h.priority || 0;
        const lastDone = h.updated_at
          ? new Date(h.updated_at).toLocaleDateString("en-US", { timeZone: tz })
          : "";
        const doneToday = lastDone === todayStr;
        const status = doneToday ? "DONE" : "NOT YET";
        const streakStr = streak > 0 ? ` (${streak}-day streak)` : "";
        return `- [${status}] ${h.content} — ${h.deadline}${streakStr}`;
      })
      .join("\n");

    return context;
  } catch (error) {
    console.error("getHabitContext error:", error);
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
