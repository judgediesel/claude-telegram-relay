const envFile = await Bun.file(".env").text();
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const WP_SITE_URL = env.WP_SITE_URL;
const WP_APP_PASSWORD = env.WP_APP_PASSWORD;
// Use "mark" as the username — the admin user that has delete permissions
const WP_USER = "mark";
const AUTH = "Basic " + btoa(`${WP_USER}:${WP_APP_PASSWORD}`);

const duplicatePostIds = [319, 322, 325, 328, 331, 334, 337, 340, 343];

async function deletePost(id: number): Promise<void> {
  const url = `${WP_SITE_URL}/wp-json/wp/v2/posts/${id}?force=true`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: AUTH,
        "Content-Type": "application/json",
      },
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`[OK] Deleted post ${id}: "${data.title?.rendered ?? "unknown title"}"`);
    } else {
      const text = await res.text();
      console.error(`[FAIL] Post ${id} - ${res.status} ${res.statusText}: ${text}`);
    }
  } catch (err) {
    console.error(`[ERROR] Post ${id} - ${err}`);
  }
}

console.log(`Deleting ${duplicatePostIds.length} duplicate posts from ${WP_SITE_URL}...\n`);

for (const id of duplicatePostIds) {
  await deletePost(id);
}

console.log("\nDone.");
