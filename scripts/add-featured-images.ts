#!/usr/bin/env bun
/**
 * Generates featured images with Imagen 4.0 and uploads them to WordPress.
 * Bun auto-loads .env from the project root.
 */

// Load env vars — Bun reads .env automatically
const googleKey = process.env.GOOGLE_API_KEY!;
const wpBase = process.env.WP_SITE_URL!;
const wpEndpoint = `${wpBase}/wp-json/wp/v2`;
const wpUser = "mark"; // App password is tied to the 'mark' WP account
const wpPass = process.env.WP_APP_PASSWORD!;
const wpAuth = "Basic " + btoa(`${wpUser}:${wpPass}`);

interface PostInfo {
  id: number;
  title: string;
  prompt: string;
}

const posts: PostInfo[] = [
  {
    id: 258,
    title: "How to Apply for Government Grants",
    prompt: "Professional blog header: person filling out a government grant application on a laptop, documents and paperwork on desk, warm natural lighting, clean modern style, blue and green accents, photorealistic",
  },
  {
    id: 259,
    title: "10 Free Government Grants",
    prompt: "Professional blog header: stack of approved government grant documents with a golden seal, American flag subtly in background, warm lighting, clean modern editorial style, photorealistic",
  },
  {
    id: 260,
    title: "Government Grants for Single Mothers",
    prompt: "Professional blog header: confident mother working at her desk with laptop, warm home office setting, natural light through window, empowering and hopeful mood, clean modern editorial style, photorealistic",
  },
  {
    id: 261,
    title: "First-Time Home Buyer Grants",
    prompt: "Professional blog header: couple holding house keys in front of their new home, bright sunny day, welcoming suburban house, warm and exciting mood, clean modern editorial style, photorealistic",
  },
  {
    id: 262,
    title: "Small Business Grants",
    prompt: "Professional blog header: entrepreneur in a modern small business workspace, coffee shop or boutique setting, natural lighting, optimistic mood, clean modern editorial style, photorealistic",
  },
  {
    id: 263,
    title: "How to Get Out of Debt",
    prompt: "Professional blog header: person cutting up credit cards with scissors, financial documents on desk showing declining debt chart, relieved expression, clean modern editorial style, blue tones, photorealistic",
  },
  {
    id: 264,
    title: "FAFSA Guide",
    prompt: "Professional blog header: college student with laptop and textbooks, campus setting visible through window, financial aid forms on desk, hopeful academic mood, clean modern editorial style, photorealistic",
  },
  {
    id: 265,
    title: "How to Spot Grant Scams",
    prompt: "Professional blog header: magnifying glass examining a suspicious document, red warning signs, protective shield icon, cautionary but empowering mood, clean modern editorial style, red and blue accents, photorealistic",
  },
  {
    id: 266,
    title: "Government Benefits Checklist",
    prompt: "Professional blog header: organized checklist on clipboard with green checkmarks, pen beside it, clean desk with American flag pin, organized and helpful mood, clean modern editorial style, photorealistic",
  },
  {
    id: 267,
    title: "Emergency Grants and Assistance",
    prompt: "Professional blog header: helping hands reaching out, community support concept, warm golden lighting, compassionate and urgent mood, clean modern editorial style, warm tones, photorealistic",
  },
];

async function generateImage(prompt: string): Promise<Buffer> {
  const model = "imagen-4.0-fast-generate-001";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${googleKey}`;
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

async function uploadMedia(
  imageBuffer: Buffer,
  filename: string,
  title: string
): Promise<number> {
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: "image/png" });
  formData.append("file", blob, filename);
  formData.append("title", title);
  formData.append("alt_text", title);

  const res = await fetch(`${wpEndpoint}/media`, {
    method: "POST",
    headers: { Authorization: wpAuth },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Upload error ${res.status}: ${err}`);
  }

  const media = await res.json();
  return media.id;
}

async function setFeaturedImage(
  postId: number,
  mediaId: number
): Promise<void> {
  const res = await fetch(`${wpEndpoint}/posts/${postId}`, {
    method: "POST",
    headers: {
      Authorization: wpAuth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ featured_media: mediaId }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Update error ${res.status}: ${err}`);
  }
}

// Main
console.log(`Generating featured images for ${posts.length} posts...\n`);

for (const post of posts) {
  try {
    console.log(`[${posts.indexOf(post) + 1}/${posts.length}] ${post.title}`);
    console.log(`  Generating image...`);
    const imageBuffer = await generateImage(post.prompt);
    console.log(
      `  Generated (${(imageBuffer.length / 1024).toFixed(0)} KB)`
    );

    const filename = `featured-${post.id}.png`;
    console.log(`  Uploading to WordPress...`);
    const mediaId = await uploadMedia(imageBuffer, filename, post.title);
    console.log(`  Uploaded (media ID: ${mediaId})`);

    console.log(`  Setting featured image...`);
    await setFeaturedImage(post.id, mediaId);
    console.log(`  Done!\n`);
  } catch (err) {
    console.error(`  FAILED: ${err}\n`);
  }
}

console.log("All done!");
