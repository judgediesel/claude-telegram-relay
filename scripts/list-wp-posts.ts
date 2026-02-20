const envFile = await Bun.file(".env").text();
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const { WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD } = env;
const auth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64");

const res = await fetch(`${WP_SITE_URL}/wp-json/wp/v2/posts?per_page=100&status=publish`, {
  headers: { Authorization: `Basic ${auth}` },
});

const posts = await res.json();
console.log(`Published: ${posts.length}`);
for (const p of posts) {
  console.log(`  - [${p.id}] ${p.title.rendered}`);
}
