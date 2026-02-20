#!/usr/bin/env bun
const WP_URL = "https://blog.grantsforme.net/wp-json/wp/v2";
const AUTH = "Basic " + btoa("mark:SRht Rv6J nCfM rqzi fdwG wlLv");

const res = await fetch(`${WP_URL}/posts?per_page=20&orderby=id&order=asc`, {
  headers: { Authorization: AUTH },
});
const posts = await res.json();
for (const p of posts) {
  console.log(`ID: ${p.id} | ${p.title.rendered} | Featured Media: ${p.featured_media}`);
}
