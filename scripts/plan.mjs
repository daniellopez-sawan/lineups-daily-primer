#!/usr/bin/env node
/**
 * Send plan: the shared, editable schedule the routine reads.
 *
 * MULTIPLE SENDS IN ONE DAY: allowed, but they must be built SEQUENTIALLY. The
 * template stores snippet *references* resolved at send time, so two pending
 * broadcasts would both render whatever the snippets hold last. `today` therefore
 * returns only entries that are confirmed, not yet built, and still in the future;
 * the routine builds one, marks it built, and the next run picks up the next one
 * after the earlier send has gone out.
 *
 * Lives in Customer.io as snippet `{prefix}plan` (JSON string). Anyone with the
 * skill edits it; one routine executes it. Pure: JSON in on stdin, JSON out.
 *
 * stdin: { "plan": <current plan or null>, "op": "show"|"set"|"remove"|"today"|"confirm"|"mark_built",
 *          "entry"?: {...}, "date"?: "YYYY-MM-DD", "name"?: "...", "now"?: ISO,
 *          "actor"?: "email", "vocabulary"?: {group: {tagName: id|null}} }
 * stdout: { ok, plan, matches?, warnings[], problems[] }
 *
 * Entry shape:
 *   { date: "2026-09-24", send_at: "17:00", name: "TNF",
 *     mode: "tags" (default) | "latest",   // latest = newest posts, optionally within `categories` (ids); tags ignored
 *     tags: ["NFL Week 4","TNF"], match: "all"|"any", categories: [42], exclude_tags: ["Promos"],
 *     min_articles: 2, max_articles: 4, include_hub_pages: false,
 *     status: "draft"|"confirmed", notes: "", allow_repeats: false,
 *     built: { broadcast_id: "123", at: ISO, subject: "...", sent_at?: ISO } | absent }
 * ops also: "mark_sent" (records built.sent_at once Customer.io reports send_state "sent"),
 *   "set_owner" { owner: email | "" } — plan.owner is the person building the sends this week (a signal, not a lock).
 * mark_built records built.by = actor.
 * Optimistic check: pass "expect_updated_at" on any write op; refused if the plan changed since.
 * The routine executes only status === "confirmed". Everything else is visible but inert.
 */
const TZ = "America/New_York";
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const emptyPlan = () => ({ version: 1, timezone: TZ, owner: "", updated_by: "", updated_at: "", sends: [] });

function validateEntry(e, vocab) {
  const p = [], w = [];
  if (!DATE.test(e.date ?? "")) p.push(`date must be YYYY-MM-DD, got ${JSON.stringify(e.date)}`);
  if (!TIME.test(e.send_at ?? "")) p.push(`send_at must be HH:MM (24h, ${TZ}), got ${JSON.stringify(e.send_at)}`);
  if (!e.name) p.push("name is required (e.g. TNF, MNF, CFB Saturday)");
  const mode = e.mode ?? "tags";
  if (!["tags", "latest"].includes(mode)) p.push(`mode must be "tags" (default) or "latest", got ${JSON.stringify(e.mode)}`);
  if (mode === "tags" && (!Array.isArray(e.tags) || !e.tags.length)) p.push("tags must be a non-empty list of exact WordPress tag names (or set mode: \"latest\" for the newest articles)");
  if (mode === "latest" && e.categories !== undefined && !(Array.isArray(e.categories) && e.categories.every((c) => Number.isInteger(c)))) p.push("categories must be a list of WordPress category ids");
  if (!["all", "any"].includes(e.match ?? "any")) p.push(`match must be "all" or "any"`);
  const min = e.min_articles ?? 2, max = e.max_articles ?? 4;
  if (!(min >= 2 && max >= min && max <= 4)) p.push(`articles range invalid: min ${min}, max ${max} (must be 2–4: the subject/preheader need two articles and the template has 4 blocks)`);
  if (!["draft", "confirmed"].includes(e.status ?? "draft")) p.push(`status must be "draft" or "confirmed"`);
  if (vocab && Array.isArray(e.tags)) {
    const known = new Set(Object.values(vocab).flatMap((g) => Object.keys(g).filter((k) => !k.startsWith("_"))));
    for (const t of e.tags) if (!known.has(t)) w.push(`tag "${t}" is not in the vocabulary — check spelling with Thom (lookup is by exact name)`);
  }
  return { problems: p, warnings: w };
}

function normalise(e) {
  return {
    date: e.date, send_at: e.send_at, name: e.name.trim(),
    mode: e.mode ?? "tags",
    tags: (e.tags ?? []).map((t) => String(t).trim()),
    categories: Array.isArray(e.categories) ? e.categories : [],
    exclude_tags: Array.isArray(e.exclude_tags) ? e.exclude_tags.map((x) => String(x).trim()) : [],
    match: e.match ?? "any",
    min_articles: e.min_articles ?? 2, max_articles: e.max_articles ?? 4,
    include_hub_pages: Boolean(e.include_hub_pages),
    status: e.status ?? "draft",
    notes: e.notes ?? "",
    allow_repeats: Boolean(e.allow_repeats),
  };
}

function main(input) {
  const { op, actor = "", now = new Date().toISOString(), vocabulary = null } = input;
  const plan = input.plan && typeof input.plan === "object" ? input.plan : emptyPlan();
  plan.sends ??= [];
  plan.owner ??= "";
  const warnings = [], problems = [];
  const key = (e) => `${e.date}|${e.name}`;
  const stamp = () => { plan.updated_by = actor; plan.updated_at = now; };
  const today0 = new Date(now).toLocaleDateString("en-CA", { timeZone: TZ });
  const seen = new Set();
  for (const e of plan.sends) { const k = key(e); if (seen.has(k)) warnings.push(`duplicate entry ${k} — only the first is acted on`); seen.add(k); }
  for (const e of plan.sends) if (e.status === "confirmed" && !e.built && e.date < today0) warnings.push(`missed: ${e.date} ${e.name} was confirmed but never built`);
  if (["set", "remove", "confirm", "mark_built", "mark_sent", "set_owner"].includes(op) && input.expect_updated_at && plan.updated_at && input.expect_updated_at !== plan.updated_at)
    return { ok: false, plan, warnings, problems: [`the plan changed since you last saw it (now ${plan.updated_at}, you expected ${input.expect_updated_at}) — show it again before writing`] };

  if (op === "show") {
    plan.sends.sort((a, b) => (a.date + a.send_at).localeCompare(b.date + b.send_at));
    return { ok: true, plan, warnings, problems };
  }
  if (op === "today") {
    const today = new Date(now).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
    // "HH:MM" right now in ET, so a send whose time has passed is never rebuilt.
    const nowHM = new Date(now).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
    const LEAD_MINUTES = 30; // a send needs building at least this long before it goes out
    const cutoff = (() => {
      const [h, m] = nowHM.split(":").map(Number);
      const t = Math.min(h * 60 + m + LEAD_MINUTES, 23 * 60 + 59);
      return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    })();

    const forToday = plan.sends.filter((e) => e.date === today);
    // A built broadcast that has not finished sending still reads the snippets. Build nothing until it has.
    const pending = plan.sends.filter((e) => e.built && !e.built.sent_at && e.built.broadcast_id !== "test");
    if (pending.length) {
      warnings.push(`waiting for ${pending.map((e) => `#${e.built.broadcast_id} (${e.date} ${e.name})`).join(", ")} to finish sending before building anything else — run "mark_sent" once Customer.io shows send_state "sent"`);
      return { ok: true, plan, today, now_et: nowHM, matches: [], warnings, problems };
    }
    const drafts = forToday.filter((e) => e.status !== "confirmed");
    const built = forToday.filter((e) => e.status === "confirmed" && e.built);
    const tooLate = forToday.filter((e) => e.status === "confirmed" && !e.built && e.send_at < cutoff);
    const matches = forToday
      .filter((e) => e.status === "confirmed" && !e.built && e.send_at >= cutoff)
      .sort((a, b) => a.send_at.localeCompare(b.send_at));

    if (drafts.length) warnings.push(`still draft, will not run: ${drafts.map((e) => e.name).join(", ")}`);
    if (built.length) warnings.push(`already built earlier today: ${built.map((e) => `${e.name} (#${e.built.broadcast_id}${e.built.by ? ` by ${e.built.by}` : ""})`).join(", ")}`);
    if (tooLate.length) warnings.push(`confirmed but their send time has passed or is under ${LEAD_MINUTES} min away, skipped: ${tooLate.map((e) => `${e.name} ${e.send_at}`).join(", ")}`);
    if (matches.length > 1) warnings.push(`${matches.length} sends still to build today — build "${matches[0].name}" now; the later one is built by a later run, once this one has gone out`);

    return { ok: true, plan, today, now_et: nowHM, matches, warnings, problems };
  }
  if (op === "mark_built") {
    const i = plan.sends.findIndex((x) => x.date === input.date && x.name === input.name);
    if (i < 0) return { ok: false, plan, warnings, problems: [`no entry for ${input.date} ${input.name}`] };
    if (plan.sends[i].built && !input.force)
      return { ok: false, plan, warnings, problems: [`${input.date} ${input.name} is already built as #${plan.sends[i].built.broadcast_id} — someone got there first. Do not schedule a second one.`] };
    plan.sends[i].built = { broadcast_id: String(input.broadcast_id ?? ""), at: now, by: actor, subject: input.subject ?? "" };
    stamp();
    return { ok: true, plan, warnings, problems };
  }
  if (op === "set_owner") {
    const owner = String(input.owner ?? "").trim().toLowerCase();
    if (owner && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) return { ok: false, plan, warnings, problems: [`owner must be an email address, got ${JSON.stringify(input.owner)}`] };
    const before = plan.owner ?? "";
    plan.owner = owner;
    stamp();
    warnings.push(owner ? `owner is now ${owner}${before && before !== owner ? ` (was ${before})` : ""}` : `owner cleared${before ? ` (was ${before})` : ""}`);
    return { ok: true, plan, warnings, problems };
  }
  if (op === "mark_sent") {
    const i = plan.sends.findIndex((x) => x.date === input.date && x.name === input.name);
    if (i < 0 || !plan.sends[i].built) return { ok: false, plan, warnings, problems: [`no built entry for ${input.date} ${input.name}`] };
    plan.sends[i].built.sent_at = now;
    stamp();
    return { ok: true, plan, warnings, problems };
  }
  if (op === "set") {
    const e = input.entry ?? {};
    const v = validateEntry(e, vocabulary);
    if (v.problems.length) return { ok: false, plan, warnings: v.warnings, problems: v.problems };
    const n = normalise(e);
    const i = plan.sends.findIndex((x) => key(x) === key(n));
    if (i >= 0) {
      if (plan.sends[i].built) {
        return { ok: false, plan, warnings, problems: [`${n.date} ${n.name} was already built as broadcast #${plan.sends[i].built.broadcast_id}. The plan can't change a built send — edit or cancel that broadcast in Customer.io. To rebuild from scratch, cancel it there and then "remove" this entry and "set" it again.`] };
      }
      warnings.push(`replaced existing entry ${n.date} ${n.name}`);
      plan.sends[i] = n;
    } else plan.sends.push(n);
    stamp();
    return { ok: true, plan, warnings: [...warnings, ...v.warnings], problems };
  }
  if (op === "confirm" || op === "remove") {
    const i = plan.sends.findIndex((x) => x.date === input.date && x.name === input.name);
    if (i < 0) return { ok: false, plan, warnings, problems: [`no entry for ${input.date} ${input.name}`] };
    if (op === "remove") plan.sends.splice(i, 1); else plan.sends[i].status = "confirmed";
    stamp();
    return { ok: true, plan, warnings, problems };
  }
  return { ok: false, plan, warnings, problems: [`unknown op ${JSON.stringify(op)}`] };
}

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let out;
  try { out = main(JSON.parse(raw)); } catch (err) { out = { ok: false, plan: null, warnings: [], problems: [err.message] }; }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exit(out.ok ? 0 : 1);
});
