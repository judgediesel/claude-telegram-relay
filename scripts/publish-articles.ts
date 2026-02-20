#!/usr/bin/env bun
/**
 * Publishes markdown articles to WordPress via REST API
 */

const WP_URL = "https://blog.grantsforme.net/wp-json/wp/v2";
const WP_USER = "mark";
const WP_APP_PASS = "SRht Rv6J nCfM rqzi fdwG wlLv";
const AUTH = "Basic " + btoa(`${WP_USER}:${WP_APP_PASS}`);

// Category slug -> ID mapping
const CATEGORIES: Record<string, number> = {
  "grants & free money": 19,
  "grants and free money": 19,
  "debt help": 20,
  "small business funding": 21,
  "save money & smart spending": 23,
  "save money and smart spending": 23,
  "make money": 25,
  "credit & financial health": 26,
  "credit and financial health": 26,
  "government benefits": 0, // will create if needed
};

interface ArticleData {
  title: string;
  content: string;
  seoTitle: string;
  metaDescription: string;
  category: string;
  categoryId: number;
}

function parseArticle(markdown: string): ArticleData {
  const lines = markdown.split("\n");

  // Extract title from first H1
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? titleLine.replace(/^#\s+/, "") : "Untitled";

  // Extract SEO metadata
  const seoTitleMatch = markdown.match(
    /\*\*SEO Title Tag:\*\*\s*(.+)/
  );
  const metaDescMatch = markdown.match(
    /\*\*Meta Description:\*\*\s*(.+)/
  );
  const categoryMatch = markdown.match(/\*\*Category:\*\*\s*(.+)/);

  const seoTitle = seoTitleMatch?.[1]?.trim() || title;
  const metaDescription = metaDescMatch?.[1]?.trim() || "";
  const category = categoryMatch?.[1]?.trim().toLowerCase() || "grants & free money";

  // Find category ID
  const categoryId = CATEGORIES[category] || 19; // default to Grants & Free Money

  // Extract content (everything after the first --- separator following metadata)
  const firstSeparator = markdown.indexOf("---");
  let content = "";
  if (firstSeparator !== -1) {
    // Find content after the metadata block
    const afterMeta = markdown.substring(firstSeparator + 3);
    content = afterMeta.trim();
  } else {
    // No separator, use everything after the title
    const titleIdx = markdown.indexOf("\n", markdown.indexOf("# "));
    content = markdown.substring(titleIdx).trim();
  }

  // Remove image suggestion sections and schema markup notes
  content = content.replace(
    /---\s*\n\s*##\s*Recommended Images[\s\S]*?(?=\n---|\n## (?!Recommended)|$)/gi,
    ""
  );
  content = content.replace(
    /---\s*\n\s*##\s*Internal Linking[\s\S]*?(?=\n---|\n## (?!Internal)|$)/gi,
    ""
  );
  content = content.replace(
    /---\s*\n\s*##\s*Schema Markup[\s\S]*$/gi,
    ""
  );
  content = content.replace(
    /\*\*Schema Markup:\*\*[^\n]*/g,
    ""
  );

  // Convert markdown to HTML
  content = markdownToHtml(content);

  return { title, content, seoTitle, metaDescription, category, categoryId };
}

function markdownToHtml(md: string): string {
  let html = md;

  // Remove remaining metadata lines at the top
  html = html.replace(/^\*\*SEO Title Tag:\*\*.*\n?/gm, "");
  html = html.replace(/^\*\*Meta Description:\*\*.*\n?/gm, "");
  html = html.replace(/^\*\*Primary Keyword:\*\*.*\n?/gm, "");
  html = html.replace(/^\*\*Secondary Keywords:\*\*.*\n?/gm, "");
  html = html.replace(/^\*\*Category:\*\*.*\n?/gm, "");
  html = html.replace(/^\*\*Schema Markup:\*\*.*\n?/gm, "");

  // Convert headers
  html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Convert bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Convert links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Convert blockquotes
  html = html.replace(/^>\s*(.+)$/gm, "<blockquote><p>$1</p></blockquote>");

  // Convert horizontal rules
  html = html.replace(/^---+$/gm, "<hr>");

  // Convert unordered lists
  const listLines = html.split("\n");
  let inList = false;
  const processed: string[] = [];
  for (const line of listLines) {
    const listMatch = line.match(/^[-*]\s+(.+)/);
    if (listMatch) {
      if (!inList) {
        processed.push("<ul>");
        inList = true;
      }
      processed.push(`<li>${listMatch[1]}</li>`);
    } else {
      if (inList) {
        processed.push("</ul>");
        inList = false;
      }
      processed.push(line);
    }
  }
  if (inList) processed.push("</ul>");
  html = processed.join("\n");

  // Convert ordered lists
  const lines2 = html.split("\n");
  let inOl = false;
  const processed2: string[] = [];
  for (const line of lines2) {
    const olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inOl) {
        processed2.push("<ol>");
        inOl = true;
      }
      processed2.push(`<li>${olMatch[1]}</li>`);
    } else {
      if (inOl) {
        processed2.push("</ol>");
        inOl = false;
      }
      processed2.push(line);
    }
  }
  if (inOl) processed2.push("</ol>");
  html = processed2.join("\n");

  // Convert tables
  html = html.replace(/\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)*)/g, (match, header, body) => {
    const headers = header.split("|").map((h: string) => h.trim()).filter(Boolean);
    const headerHtml = headers.map((h: string) => `<th>${h}</th>`).join("");
    const rows = body.trim().split("\n").map((row: string) => {
      const cells = row.split("|").map((c: string) => c.trim()).filter(Boolean);
      return `<tr>${cells.map((c: string) => `<td>${c}</td>`).join("")}</tr>`;
    }).join("\n");
    return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  // Wrap paragraphs (lines not already wrapped in tags)
  const finalLines = html.split("\n\n");
  html = finalLines
    .map((block) => {
      block = block.trim();
      if (!block) return "";
      if (block.startsWith("<")) return block;
      return `<p>${block.replace(/\n/g, "<br>")}</p>`;
    })
    .filter(Boolean)
    .join("\n\n");

  return html;
}

async function wpPost(endpoint: string, data: any): Promise<any> {
  const res = await fetch(`${WP_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: AUTH,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WP API error ${res.status}: ${err}`);
  }
  return res.json();
}

async function publishArticle(filePath: string): Promise<{ id: number; link: string; title: string }> {
  const markdown = await Bun.file(filePath).text();
  const article = parseArticle(markdown);

  const postData = {
    title: article.title,
    content: article.content,
    status: "publish",
    categories: [article.categoryId],
    meta: {
      _yoast_wpseo_title: article.seoTitle,
      _yoast_wpseo_metadesc: article.metaDescription,
    },
  };

  const result = await wpPost("/posts", postData);
  return {
    id: result.id,
    link: result.link,
    title: result.title.rendered,
  };
}

// Main
const articlesDir = "/Users/markphaneuf/claude-telegram-relay/articles";
const files = (await Array.fromAsync(new Bun.Glob("*.md").scan(articlesDir))).sort();

console.log(`Found ${files.length} articles to publish\n`);

for (const file of files) {
  const filePath = `${articlesDir}/${file}`;
  try {
    const result = await publishArticle(filePath);
    console.log(`Published: ${result.title}`);
    console.log(`  URL: ${result.link}`);
    console.log(`  ID: ${result.id}\n`);
  } catch (err) {
    console.error(`FAILED: ${file}`);
    console.error(`  Error: ${err}\n`);
  }
}

console.log("Done!");
