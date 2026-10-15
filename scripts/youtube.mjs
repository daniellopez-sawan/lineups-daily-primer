#!/usr/bin/env node
/**
 * Pure transformation: a YouTube channel RSS feed (Atom XML) -> the same WordPress-shaped
 * payload map.mjs already understands, so videos fill the same template blocks as articles.
 *
 * NO NETWORK. stdin: { "xml": "<feed …>", "limit"?: 8, "includeShorts"?: true }
 * stdout: { ok, videos: [{ id, videoId, title, presenter, url, image, imageFallback, summary,
 *                          published, isShort }],
 *           posts: [...], media: {id: …}, users: {id: …} }     // feed straight into map.mjs
 *
 * - id is "yt:<videoId>" (a string, so it can live in dailyprimer_lastsent_ids next to post ids).
 * - Title "Headline | Lineups x Mark Gunnels" -> title "Headline", presenter "Mark Gunnels".
 * - Summary = the description's first paragraph only (the rest is timestamps, sportsbook promo
 *   links and hashtags), "(@handle on X)" asides removed, prefixed "▶ Video: ", cut at ~220 chars.
 * - Image = maxresdefault.jpg (16:9, no letterbox bars); imageFallback = hqdefault.jpg (always exists).
 * Nothing here is written by a model — every word comes from the channel's own titles/descriptions.
 */

const decode = (s) => String(s ?? "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, "&");

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]).trim() : "";
};
const attr = (block, name, a) => {
  const m = block.match(new RegExp(`<${name}\\b[^>]*\\b${a}="([^"]*)"`));
  return m ? decode(m[1]) : "";
};

function splitTitle(raw) {
  const i = raw.lastIndexOf(" | ");
  if (i < 0) return { title: raw.trim(), presenter: "Lineups" };
  const series = raw.slice(i + 3).trim();
  const presenter = series.replace(/^Lineups\s+x\s+/i, "").trim() || "Lineups";
  return { title: raw.slice(0, i).trim(), presenter };
}

function summarise(desc) {
  let first = desc.split(/\n\s*\n/)[0] ?? "";
  first = first.replace(/\s*\(@[^)]*\)/g, "").replace(/\s+/g, " ").trim();
  if (first.length > 220) {
    const cut = first.slice(0, 220);
    first = cut.slice(0, cut.lastIndexOf(" ") > 150 ? cut.lastIndexOf(" ") : 220).replace(/[,;:\s]+$/, "") + "…";
  }
  return first ? `▶ Video: ${first}` : "";
}

function main({ xml, limit = 8, includeShorts = true }) {
  if (typeof xml !== "string" || !xml.includes("<feed")) throw new Error("input.xml must be the YouTube RSS feed (Atom XML)");
  const channel = tag(xml.split("<entry>")[0], "title") || "YouTube";
  const entries = xml.split("<entry>").slice(1).map((e) => e.split("</entry>")[0]);
  const videos = [];
  for (const e of entries) {
    const videoId = tag(e, "yt:videoId");
    const url = attr(e, "link", "href");
    if (!videoId || !url) continue;
    const isShort = url.includes("/shorts/");
    if (isShort && !includeShorts) continue;
    const { title, presenter } = splitTitle(tag(e, "title"));
    videos.push({
      id: `yt:${videoId}`, videoId, title, presenter, url,
      image: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      imageFallback: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      summary: summarise(tag(e, "media:description")),
      published: tag(e, "published"), isShort,
    });
    if (videos.length >= limit) break;
  }
  const posts = [], media = {}, users = {};
  videos.forEach((v, i) => {
    const uid = `yt_${i}`;
    users[uid] = { id: uid, name: v.presenter };
    media[v.id] = { id: v.id, alt_text: v.title, source_url: v.image,
      media_details: { width: 1280, height: 720, sizes: { full: { source_url: v.image, width: 1280, height: 720 } } } };
    posts.push({ id: v.id, date: v.published, link: v.url, title: { rendered: v.title },
      excerpt: { rendered: v.summary }, author: uid, featured_media: v.id, categories: [], tags: [], kind: "video" });
  });
  return { ok: videos.length > 0, channel, videos, posts, media, users,
    problems: videos.length ? [] : ["the feed has no videos (or none left after excluding Shorts)"] };
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let out;
  try { out = main(JSON.parse(raw)); }
  catch (err) { out = { ok: false, videos: [], posts: [], media: {}, users: {}, problems: [String(err.message ?? err)] }; }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exit(out.ok ? 0 : 1);
});
