#!/usr/bin/env node
/**
 * Pure transformation: WordPress API payloads -> Customer.io snippet writes.
 *
 * NO NETWORK. Reads one JSON object on stdin, writes one on stdout. The
 * network fetch is done by the agent with WebFetch, deliberately: Catena
 * properties 403 scripted clients from a laptop, so a script that fetched for
 * itself would work in the cloud and fail on a teammate's machine. Keeping
 * this pure means it behaves identically wherever it runs.
 *
 * stdin:  { "posts": [...], "media": {id: {...}}, "users": {id: {...}},
 *           "config": { prefix, headerText, minSlots?, maxSlots?, slots?,
 *                       subjectMode?, preheaderMode?, subjectLines?, preheader?, alreadySent? } }
 *
 * subjectMode   "fromArticles" (default) -> subjectline1 = "<headerText>: <article 1 headline>",
 *                                            subjectline2 = subjectLines[1] if given, else headerText
 *               "fixed"                  -> subjectline1/2 = subjectLines verbatim
 * preheaderMode "secondHeadline" (default) -> preheader1 = article 2 headline
 *               "date"                     -> "<headerText>: Wednesday, September 16, 2026"
 *               "fixed"                    -> config.preheader verbatim
 * Everything here is composed from the editors' own headlines — nothing is written by a model.
 *
 * Slots are a RANGE (default 2..4), not a fixed count. The template has maxSlots
 * article blocks, each with a show-if-not-empty display condition. We fill as
 * many as we have good articles for and write the rest as EMPTY_SLOT (see
 * below — Customer.io won't accept "") so the condition hides them. Fewer than minSlots good articles is a refusal. `slots: N` is
 * still accepted as shorthand for minSlots = maxSlots = N.
 * stdout: { "ok": bool, "articles": [...], "writes": [...], "problems": [...] }
 *
 * Exit 1 on any refusal, so a caller that ignores the JSON still fails loudly.
 */

const RESERVED_PREFIXES = ["newsletterarticle", "newsletterheader", "newsletter_", "newsletter2", "newsletter3", "dfs_"];
const IMAGE_SIZE_PREFERENCE = ["large", "medium_large", "medium", "full"];

/**
 * Sentinel for an unused slot. Customer.io rejects "" and whitespace-only
 * snippet values (HTTP 422 "value cannot be blank"), so a slot can't simply be
 * emptied. An HTML comment renders to nothing if it ever leaks into a text
 * field, and it is a literal the template's display condition can compare
 * against: show the block only when `articleN_title != "<!-- empty -->"`.
 */
export const EMPTY_SLOT = "<!-- empty -->";
const ENTITIES = { "&lt;":"<", "&gt;":">", "&quot;":'"', "&apos;":"'", "&#039;":"'", "&nbsp;":" ",
  "&hellip;":"…", "&ndash;":"–", "&mdash;":"—", "&rsquo;":"’", "&lsquo;":"‘", "&ldquo;":"“", "&rdquo;":"”" };

// Decode in this order: tags → hex → decimal → named → &amp; LAST (so "&amp;lt;" never becomes "<").
const decodeHtml = (v) => String(v ?? "")
  .replace(/<[^>]*>/g, "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
  .replace(/&[a-z]+;/gi, (e) => ENTITIES[e] ?? e)
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

function pickImageUrl(media) {
  const sizes = media?.media_details?.sizes ?? {};
  for (const name of IMAGE_SIZE_PREFERENCE) if (sizes[name]?.source_url) return sizes[name].source_url;
  return media?.source_url ?? "";
}

function assertSafePrefix(prefix) {
  if (!prefix || !/^[a-z][a-z0-9_]*_$/.test(prefix))
    throw new Error(`snippet prefix must be lowercase and end with "_", got ${JSON.stringify(prefix)}`);
  for (const r of RESERVED_PREFIXES)
    if (prefix.startsWith(r))
      throw new Error(`snippet prefix "${prefix}" collides with the shared "${r}" family used by hand-built newsletters — refusing`);
}

function normalise(post, media, user) {
  return {
    id: post.id,
    title: decodeHtml(post.title?.rendered),
    url: post.link,
    publishedAt: post.date,
    summary: decodeHtml(post.excerpt?.rendered),
    imageUrl: pickImageUrl(media),
    author: decodeHtml(user?.name),
    categories: post.categories ?? [],
  };
}

function validate(a) {
  const p = [];
  if (!a.title) p.push("missing title");
  if (!a.url) p.push("missing url");
  if (!a.summary) p.push("missing summary — the post has an empty excerpt, an editor needs to add one");
  if (!a.imageUrl) p.push("missing image");
  if (!a.author || /^unknown/i.test(a.author)) p.push("missing author (not in the author cache and not fetched)");
  return p;
}

function resolveSlots(config) {
  if (config.slots != null) return { min: Number(config.slots), max: Number(config.slots) };
  const min = Number(config.minSlots ?? 2), max = Number(config.maxSlots ?? 4);
  if (!(min >= 2 && max >= min && max <= 4)) throw new Error(`invalid slot range ${min}..${max} (must be 2–4)`);
  return { min, max };
}

function main(input) {
  const { posts = [], media = {}, users = {}, config = {} } = input;
  const { prefix, headerText, subjectLines = [], preheader, alreadySent = [],
          subjectMode = "fromArticles", preheaderMode = "secondHeadline", sendDate,
          requireTagIds = [], allowRepeats = false } = config;

  assertSafePrefix(prefix);
  if (!headerText) throw new Error("config.headerText is required (the newsletter's header snippet)");
  if (subjectMode === "fixed" && !(subjectLines[0] ?? "").trim()) throw new Error(`subjectMode "fixed" needs subjectLines[0] — otherwise the previous send's subject would stay in place`);
  if (preheaderMode === "fixed" && !(preheader ?? "").trim()) throw new Error(`preheaderMode "fixed" needs a non-empty preheader`);
  const { min, max } = resolveSlots(config);

  // Tag filter lives here, not in the agent's head: with match "all" every required tag id must be on the post.
  const required = requireTagIds.map(Number);
  const tagged = required.length ? posts.filter((p) => required.every((t) => (p.tags ?? []).map(Number).includes(t))) : posts;
  const droppedByTag = posts.length - tagged.length;
  const sentIds = new Set(allowRepeats ? [] : alreadySent.map(Number));
  const fresh = tagged.filter((p) => !sentIds.has(Number(p.id)));
  const repeats = tagged.length - fresh.length;

  // Validate every fresh candidate; keep the good ones in publish order.
  const problems = [];
  const good = [], rejected = [];
  for (const p of fresh) {
    const a = normalise(p, media[p.featured_media], users[p.author]);
    const v = validate(a);
    if (v.length) rejected.push(`"${a.title || a.url}": ${v.join(", ")}`);
    else good.push(a);
  }
  const chosen = good.slice(0, max);

  if (droppedByTag) problems.push(`${droppedByTag} of the ${posts.length} articles fetched don't carry every required tag (skipped)`);
  if (repeats) problems.push(`${repeats} article(s) already went out in a previous send (skipped — set allow_repeats on the plan entry to include them)`);
  if (rejected.length) problems.push(`skipped ${rejected.length} incomplete article(s): ` + rejected.join(" | "));

  if (chosen.length < min) {
    problems.push(`only ${chosen.length} usable article(s) but the newsletter needs at least ${min}`);
    return { ok: false, articles: chosen, writes: [], problems, filledSlots: chosen.length, maxSlots: max };
  }

  const writes = [{ name: `${prefix}header1_text`, value: headerText }];

  // Subject lines. The A/B pair is subjectline1 (A) and subjectline2 (B).
  if (subjectMode === "fromArticles") {
    writes.push({ name: `${prefix}subjectline1`, value: `${headerText}: ${chosen[0].title}` });
    writes.push({ name: `${prefix}subjectline2`, value: subjectLines[1] ?? headerText });
  } else {
    subjectLines.forEach((line, i) => writes.push({ name: `${prefix}subjectline${i + 1}`, value: line }));
  }

  // Preheader: the inbox already shows the date, so the default spends the slot on a second hook.
  // A bare "YYYY-MM-DD" is UTC midnight = the evening before in New York; pin it to noon ET.
  const sd = typeof sendDate === "string" && sendDate.length === 10 ? `${sendDate}T12:00:00-04:00` : sendDate;
  const longDate = new Date(sd ?? Date.now()).toLocaleDateString("en-US",
    { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" });
  const preheaderValue =
    preheaderMode === "secondHeadline" ? chosen[1].title :
    preheaderMode === "date"           ? `${headerText}: ${longDate}` :
    preheader;
  // Only written when there is something to write, so a run never blanks the current value.
  if (preheaderValue) writes.push({ name: `${prefix}preheader1`, value: preheaderValue });
  for (let i = 0; i < max; i++) {
    const n = i + 1, a = chosen[i];
    // Unused slots get the sentinel on purpose: the block's display condition
    // hides them. Leaving a stale value there would show last week's article.
    writes.push(
      { name: `${prefix}article${n}_title`,  value: a ? a.title    : EMPTY_SLOT },
      { name: `${prefix}article${n}_page`,   value: a ? a.url      : EMPTY_SLOT },
      { name: `${prefix}article${n}_image`,  value: a ? a.imageUrl : EMPTY_SLOT },
      { name: `${prefix}article${n}_text`,   value: a ? a.summary  : EMPTY_SLOT },
      { name: `${prefix}article${n}_author`, value: a ? a.author   : EMPTY_SLOT },
    );
  }

  // Skipped repeats/incompletes are informational when we still have enough: report, don't refuse.
  return { ok: true, articles: chosen, writes, problems, filledSlots: chosen.length, maxSlots: max, chosenIds: chosen.map((a) => a.id) };
}

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let result;
  try {
    result = main(JSON.parse(raw));
  } catch (err) {
    result = { ok: false, articles: [], writes: [], problems: [err.message] };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
});
