/**
 * Web search via Gemini with Google Search grounding, plus weather
 */

import { GEMINI_API_KEY } from "./config";

export async function searchWeb(query: string): Promise<string> {
  if (!GEMINI_API_KEY) return "";

  try {
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
                  text: `Search the web and provide a concise, factual summary for: ${query}`,
                },
              ],
            },
          ],
          tools: [{ google_search: {} }],
        }),
      }
    );

    if (!response.ok) {
      console.error("Gemini search error:", response.status);
      return "";
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  } catch (error) {
    console.error("searchWeb error:", error);
    return "";
  }
}

export async function getWeatherContext(): Promise<string> {
  if (!GEMINI_API_KEY) return "";

  try {
    const result = await searchWeb("current weather in Bradenton FL today");
    if (!result) return "";

    // Extract just the key info
    const lines = result.split("\n").filter(l => l.trim()).slice(0, 3);
    return `\nWEATHER (Bradenton, FL):\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}
