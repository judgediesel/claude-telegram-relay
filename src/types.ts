/**
 * Shared TypeScript types and interfaces
 */

export interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export interface GmailClient {
  label: string;
  client: ReturnType<typeof import("googleapis").google.gmail>;
}
