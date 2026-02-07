/**
 * Telegram API helpers — sending messages, files, response splitting
 */

import { Context, InputFile } from "grammy";
import { readFile, stat } from "fs/promises";
import { extname } from "path";
import {
  BOT_TOKEN,
  ALLOWED_USER_ID,
  IMAGE_EXTS,
  VIDEO_EXTS,
  MAX_FILE_SIZE,
} from "./config";

// ============================================================
// TELEGRAM API HELPER (for sending without Grammy ctx)
// ============================================================

export async function sendTelegram(
  method: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data;
}

export async function sendTelegramFile(filePath: string): Promise<void> {
  const ext = extname(filePath).toLowerCase();
  let method: string;
  let field: string;

  if (IMAGE_EXTS.has(ext)) {
    method = "sendPhoto";
    field = "photo";
  } else if (VIDEO_EXTS.has(ext)) {
    method = "sendVideo";
    field = "video";
  } else {
    method = "sendDocument";
    field = "document";
  }

  const form = new FormData();
  form.append("chat_id", ALLOWED_USER_ID);

  const fileData = await readFile(filePath);
  const fileName = filePath.split("/").pop() || "file";
  form.append(field, new Blob([fileData]), fileName);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram file upload error: ${JSON.stringify(data)}`);
}

export async function sendTelegramText(text: string): Promise<void> {
  const MAX_LENGTH = 4000;

  if (text.length <= MAX_LENGTH) {
    await sendTelegram("sendMessage", { chat_id: ALLOWED_USER_ID, text });
    return;
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      await sendTelegram("sendMessage", { chat_id: ALLOWED_USER_ID, text: remaining });
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    await sendTelegram("sendMessage", {
      chat_id: ALLOWED_USER_ID,
      text: remaining.substring(0, splitIndex),
    });
    remaining = remaining.substring(splitIndex).trim();
  }
}

// ============================================================
// FILE EXTRACTION & SENDING
// ============================================================

export async function extractFiles(text: string): Promise<{ text: string; files: string[] }> {
  // Match absolute file paths — /path/to/file.ext
  const pathRegex = /(?:^|\s)(\/[\w./-]+\.\w+)/g;
  const files: string[] = [];
  let cleaned = text;

  for (const match of text.matchAll(pathRegex)) {
    const filePath = match[1];
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      if (info.size > MAX_FILE_SIZE) {
        console.log(`File too large for Telegram (${info.size} bytes): ${filePath}`);
        continue;
      }
      files.push(filePath);
      // Remove the file path from the text
      cleaned = cleaned.replace(filePath, "").replace(/\n{3,}/g, "\n\n");
    } catch {
      // Path doesn't exist on disk — leave text as-is
    }
  }

  return { text: cleaned.trim(), files };
}

export async function sendFile(ctx: Context, filePath: string): Promise<void> {
  const ext = extname(filePath).toLowerCase();

  try {
    if (IMAGE_EXTS.has(ext)) {
      await ctx.replyWithPhoto(new InputFile(filePath));
    } else if (VIDEO_EXTS.has(ext)) {
      await ctx.replyWithVideo(new InputFile(filePath));
    } else {
      await ctx.replyWithDocument(new InputFile(filePath));
    }
  } catch (error) {
    console.error(`Failed to send file ${filePath}:`, error);
  }
}

export async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Extract and send any file attachments first
  const { text: cleanedText, files } = await extractFiles(response);

  for (const filePath of files) {
    await sendFile(ctx, filePath);
  }

  // Send text response (skip if empty after file extraction)
  if (!cleanedText) return;

  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (cleanedText.length <= MAX_LENGTH) {
    await ctx.reply(cleanedText);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = cleanedText;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

export async function sendTelegramResponse(text: string): Promise<void> {
  const { text: cleaned, files } = await extractFiles(text);

  for (const filePath of files) {
    await sendTelegramFile(filePath);
  }

  if (cleaned) {
    await sendTelegramText(cleaned);
  }
}
