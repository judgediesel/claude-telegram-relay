#!/usr/bin/env bun
/**
 * Publishes unpublished articles (11-20) to WordPress, generates featured images, and attaches them.
 */

const WP_URL = "https://blog.grantsforme.net/wp-json/wp/v2";
const WP_USER = "mark";
const WP_APP_PASS = process.env.WP_APP_PASSWORD!;
const AUTH = "Basic " + btoa(`${WP_USER}:${WP_APP_PASS}`);
const GOOGLE_KEY = process.env.GOOGLE_API_KEY!;

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
  "government benefits": 19,
};

// Only publish articles that aren't already live
const ARTICLES_TO_PUBLISH = [
  "11-veterans-grants-and-benefits.md",
  "12-grants-for-college-students.md",
  "13-improve-credit-score-fast.md",
  "15-save-money-on-groceries.md",
  "16-make-money-from-home.md",
  "17-grants-for-women.md",
  "18-debt-consolidation-guide.md",
  "19-free-healthcare-programs.md",
  "20-build-emergency-fund.md",
];

function parseArticle(markdown: string) {
  const lines = markdown.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? titleLine.replace(/^#\s+/, "") : "Untitled";

  const seoTitleMatch = markdown.match(/\*\*SEO Title Tag:\*\*\s*(.+)/);
  const metaDescMatch = markdown.match(/\*\*Meta Description:\*\*\s*(.+)/);
  const categoryMatch = markdown.match(/\*\*Category:\*\*\s*(.+)/);

  const seoTitle = seoTitleMatch?.[1]?.trim() || title;
  const metaDescription = metaDescMatch?.[1]?.trim() || "";
  const category = categoryMatch?.[1]?.trim().toLowerCase() || "grants & free money";
  const categoryId = CATEGORIES[category] || 19;

  const firstSeparator = markdown.indexOf("---");
  let content = "";
  if (firstSeparator !== -1) {
    content = markdown.substring(firstSeparator + 3).trim();
  } else {
    const titleIdx = markdown.indexOf("\n", markdown.indexOf("# "));
    content = markdown.substring(titleIdx).trim();
  }

  content = content.replace(/---\s*\n\s*##\s*Recommended Images[\s\S]*?(?=\n---|\n## (?!Recommended)|$)/gi, "");
  content = content.replace(/---\s*\n\s*##\s*Internal Linking[\s\S]*?(?=\n---|\n## (?!Internal)|$)/gi, "");
  content = content.replace(/---\s*\n\s*##\s*Schema Markup[\s\S]*$/gi, "");
  content = content.replace(/\*\*Schema Markup:\*\*[^\n]*/g, "");

  content = markdownToHtml(content);
  return { title, content, seoTitle, metaDescription, categoryId };
}

function markdownToHtml(md: string): string {
  let html = md;

  html = html.replace(/^\*\*SEO Title Tag:\*\*.*\n?/gm, "");
  html = html.replace(/^\*\*Meta Description:\*\*.*\n?/gm, "");
  html = html.replace(/^\*\*Primary Keyword:\*\*.*\n?/gm, "");
  html = html.replace(/^\*\*Secondary Keywords:\*\*.*\n?/gm, "");
  html = html.replace(/^\*\*Category:\*\*.*\n?/gm, "");
  html = html.replace(/^\*\*Schema Markup:\*\*.*\n?/gm, "");

  html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/^>\s*(.+)$/gm, "<blockquote><p>$1</p></blockquote>");
  html = html.replace(/^---+$/gm, "<hr>");

  // Unordered lists
  const listLines = html.split("\n");
  let inList = false;
  const processed: string[] = [];
  for (const line of listLines) {
    const listMatch = line.match(/^[-*]\s+(.+)/);
    if (listMatch) {
      if (!inList) { processed.push("<ul>"); inList = true; }
      processed.push(`<li>${listMatch[1]}</li>`);
    } else {
      if (inList) { processed.push("</ul>"); inList = false; }
      processed.push(line);
    }
  }
  if (inList) processed.push("</ul>");
  html = processed.join("\n");

  // Ordered lists
  const lines2 = html.split("\n");
  let inOl = false;
  const processed2: string[] = [];
  for (const line of lines2) {
    const olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inOl) { processed2.push("<ol>"); inOl = true; }
      processed2.push(`<li>${olMatch[1]}</li>`);
    } else {
      if (inOl) { processed2.push("</ol>"); inOl = false; }
      processed2.push(line);
    }
  }
  if (inOl) processed2.push("</ol>");
  html = processed2.join("\n");

  // Tables
  html = html.replace(/\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)*)/g, (match, header, body) => {
    const headers = header.split("|").map((h: string) => h.trim()).filter(Boolean);
    const headerHtml = headers.map((h: string) => `<th>${h}</th>`).join("");
    const rows = body.trim().split("\n").map((row: string) => {
      const cells = row.split("|").map((c: string) => c.trim()).filter(Boolean);
      return `<tr>${cells.map((c: string) => `<td>${c}</td>`).join("")}</tr>`;
    }).join("\n");
    return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  // Paragraphs
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

async function wpPost(endpoint: string, data: any) {
  const res = await fetch(`${WP_URL}${endpoint}`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WP API error ${res.status}: ${err}`);
  }
  return res.json();
}

async function generateImage(prompt: string): Promise<Buffer> {
  const model = "imagen-4.0-fast-generate-001";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${GOOGLE_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1, aspectRatio: "16:9" },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Imagen error: ${data.error.message}`);
  const b64 = data.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error("No image data returned");
  return Buffer.from(b64, "base64");
}

async function uploadMedia(imageBuffer: Buffer, filename: string, title: string): Promise<number> {
  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer], { type: "image/png" }), filename);
  formData.append("title", title);
  formData.append("alt_text", title);

  const res = await fetch(`${WP_URL}/media`, {
    method: "POST",
    headers: { Authorization: AUTH },
    body: formData,
  });
  if (!res.ok) throw new Error(`Upload error ${res.status}: ${await res.text()}`);
  return (await res.json()).id;
}

// Image prompts for each article
const IMAGE_PROMPTS: Record<string, string> = {
  "11-veterans-grants-and-benefits.md":
    "Professional blog header: American veteran in civilian clothes reviewing benefits paperwork at home desk, American flag folded on shelf, warm patriotic mood, clean modern editorial style, photorealistic",
  "12-grants-for-college-students.md":
    "Professional blog header: diverse college students studying together in modern library, laptops and textbooks, bright natural lighting, hopeful academic mood, clean modern editorial style, photorealistic",
  "13-improve-credit-score-fast.md":
    "Professional blog header: credit score gauge showing improvement from fair to excellent, smartphone with banking app, upward trending graph, optimistic mood, clean modern editorial style, green accents, photorealistic",
  "15-save-money-on-groceries.md":
    "Professional blog header: smart shopper comparing prices at grocery store, fresh produce in cart, phone with coupons, bright supermarket lighting, practical and helpful mood, clean modern editorial style, photorealistic",
  "16-make-money-from-home.md":
    "Professional blog header: person working productively at comfortable home office setup, laptop and coffee, morning sunlight through window, motivated and empowering mood, clean modern editorial style, photorealistic",
  "17-grants-for-women.md":
    "Professional blog header: confident professional woman at modern desk reviewing grant documents, bright empowering mood, warm natural lighting, clean modern editorial style, purple and gold accents, photorealistic",
  "18-debt-consolidation-guide.md":
    "Professional blog header: multiple bills being organized into one neat stack, calculator and pen on desk, relieved expression, simplifying chaos concept, clean modern editorial style, blue tones, photorealistic",
  "19-free-healthcare-programs.md":
    "Professional blog header: friendly doctor consulting with patient in modern clinic, warm caring atmosphere, medical setting with stethoscope, compassionate mood, clean modern editorial style, teal accents, photorealistic",
  "20-build-emergency-fund.md":
    "Professional blog header: glass jar filling with coins and bills labeled emergency fund, growing savings concept, warm golden lighting, secure and hopeful mood, clean modern editorial style, photorealistic",
};

// Main
const articlesDir = "/Users/markphaneuf/claude-telegram-relay/articles";

console.log(`Publishing ${ARTICLES_TO_PUBLISH.length} new articles with featured images...\n`);

for (let i = 0; i < ARTICLES_TO_PUBLISH.length; i++) {
  const file = ARTICLES_TO_PUBLISH[i];
  const filePath = `${articlesDir}/${file}`;

  try {
    console.log(`[${i + 1}/${ARTICLES_TO_PUBLISH.length}] Publishing: ${file}`);

    // 1. Parse and publish article
    const markdown = await Bun.file(filePath).text();
    const article = parseArticle(markdown);
    const postResult = await wpPost("/posts", {
      title: article.title,
      content: article.content,
      status: "publish",
      categories: [article.categoryId],
      meta: {
        _yoast_wpseo_title: article.seoTitle,
        _yoast_wpseo_metadesc: article.metaDescription,
      },
    });
    console.log(`  Published (ID: ${postResult.id})`);

    // 2. Generate featured image
    const prompt = IMAGE_PROMPTS[file];
    if (prompt) {
      console.log(`  Generating featured image...`);
      const imageBuffer = await generateImage(prompt);
      console.log(`  Generated (${(imageBuffer.length / 1024).toFixed(0)} KB)`);

      // 3. Upload to WordPress
      const filename = `featured-${postResult.id}.png`;
      const mediaId = await uploadMedia(imageBuffer, filename, article.title);
      console.log(`  Uploaded image (media ID: ${mediaId})`);

      // 4. Set as featured image
      await wpPost(`/posts/${postResult.id}`, { featured_media: mediaId });
      console.log(`  Featured image set!`);
    }

    console.log(`  URL: ${postResult.link}\n`);
  } catch (err) {
    console.error(`  FAILED: ${err}\n`);
  }
}

console.log("All done!");
