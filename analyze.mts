// Deep Analyzer — share any link, an AI reads the content and writes a full
// breakdown (summary, key facts, insights, next steps, verdict, effort) into
// the Notion "Analyzed" database.
//
// Bring your own AI key — the first one found wins:
//   AI_BASE_URL + AI_API_KEY (+ AI_MODEL)  any OpenAI-compatible provider
//                                          (Groq, OpenRouter, Mistral, DeepSeek…,
//                                           base URL ending in /v1)
//   ANTHROPIC_API_KEY (+ AI_MODEL)         Claude (default claude-haiku-4-5)
//   OPENAI_API_KEY (+ AI_MODEL)            OpenAI (default gpt-4o-mini)
//   GEMINI_API_KEY (+ AI_MODEL)            Google (default gemini-2.0-flash)
// Also uses: NOTION_TOKEN, CATCHER_KEY, optional YT_API_KEY.

const DS_ID = "1a20c5e7-6f00-4989-9d45-51acbe24cfff";
const NOTION_VERSION = "2025-09-03";

const KINDS = ["Video", "Article", "Product", "Tool", "Repo", "Business", "Post", "Paper", "Other"];
const VERDICTS = ["Worth it", "Maybe", "Skip"];
const EFFORTS = ["5 min", "30 min", "Hours"];

async function tfetch(url: string, ms: number, headers: Record<string, string> = {}, cap = 300000): Promise<string> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh) LinkCatcher/1.0", "Accept-Language": "de,en;q=0.8", ...headers },
    });
    const t = (await r.text()).slice(0, cap);
    clearTimeout(timer);
    return t;
  } catch { return ""; }
}

function meta(html: string, key: string): string {
  const re1 = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]+content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${key}["']`, "i");
  return (html.match(re1) || html.match(re2) || [, ""])[1].trim();
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- gather as much real content about the URL as we can (no AI yet) ------
async function gatherContent(rawUrl: string): Promise<{ title: string; body: string }> {
  const parsed = new URL(rawUrl.includes("://") ? rawUrl : "https://" + rawUrl);
  const domain = parsed.hostname.toLowerCase().replace(/^www\./, "");
  let title = "", body = "";

  if (["youtube.com", "youtu.be", "m.youtube.com"].includes(domain)) {
    try {
      const o = JSON.parse(await tfetch(
        "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(parsed.href), 3500) || "{}");
      if (o.title) { title = o.title; body += `YouTube video "${o.title}" by channel ${o.author_name}. `; }
    } catch { /* ok */ }
    const ytKey = Netlify.env.get("YT_API_KEY") || "";
    const vid = (parsed.href.match(/[?&]v=([\w-]{6,})/) || parsed.href.match(/youtu\.be\/([\w-]{6,})/)
      || parsed.href.match(/shorts\/([\w-]{6,})/) || [])[1] || "";
    if (ytKey && vid) {
      try {
        const d = JSON.parse(await tfetch(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${vid}&key=${ytKey}`, 3500) || "{}");
        const it = d.items?.[0];
        if (it) {
          body += `Duration: ${it.contentDetails?.duration}. Views: ${it.statistics?.viewCount}. `
            + `Description: ${(it.snippet?.description || "").slice(0, 2500)} `
            + (it.snippet?.tags ? `Tags: ${it.snippet.tags.slice(0, 15).join(", ")}. ` : "");
        }
      } catch { /* ok */ }
    }
  } else if (domain === "tiktok.com") {
    try {
      const o = JSON.parse(await tfetch(
        "https://www.tiktok.com/oembed?url=" + encodeURIComponent(parsed.href), 3500) || "{}");
      if (o.title) { title = o.title.slice(0, 90); body += `TikTok by ${o.author_name}. Caption: ${o.title} `; }
    } catch { /* ok */ }
  }

  const html = await tfetch(parsed.href, 4500);
  if (html) {
    if (!title) title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].trim().slice(0, 120);
    const desc = meta(html, "description") || meta(html, "og:description");
    if (desc) body += `Meta description: ${desc} `;
    body += "Page text: " + stripHtml(html).slice(0, 9000);
  }
  if (!body) body = "(The page could not be fetched — analyze from the URL structure alone.)";
  return { title: title || parsed.hostname, body };
}

// ------------------------------------------------- bring-your-own-key AI ---
async function callAI(prompt: string): Promise<{ text: string; model: string }> {
  const env = (k: string) => Netlify.env.get(k) || "";
  const modelOverride = env("AI_MODEL");

  const post = async (url: string, headers: Record<string, string>, payload: unknown) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 9000);
    const r = await fetch(url, {
      method: "POST", signal: ac.signal,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`AI provider ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  if (env("AI_BASE_URL")) {
    const model = modelOverride || "gpt-4o-mini";
    const d = await post(env("AI_BASE_URL").replace(/\/$/, "") + "/chat/completions",
      { "Authorization": "Bearer " + (env("AI_API_KEY") || env("OPENAI_API_KEY")) },
      { model, messages: [{ role: "user", content: prompt }], max_tokens: 1200, temperature: 0.4 });
    return { text: d.choices[0].message.content, model };
  }
  if (env("ANTHROPIC_API_KEY")) {
    const model = modelOverride || "claude-haiku-4-5";
    const d = await post("https://api.anthropic.com/v1/messages",
      { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
      { model, max_tokens: 1200, messages: [{ role: "user", content: prompt }] });
    return { text: d.content[0].text, model };
  }
  if (env("OPENAI_API_KEY")) {
    const model = modelOverride || "gpt-4o-mini";
    const d = await post("https://api.openai.com/v1/chat/completions",
      { "Authorization": "Bearer " + env("OPENAI_API_KEY") },
      { model, messages: [{ role: "user", content: prompt }], max_tokens: 1200, temperature: 0.4 });
    return { text: d.choices[0].message.content, model };
  }
  if (env("GEMINI_API_KEY")) {
    const model = modelOverride || "gemini-2.0-flash";
    const d = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env("GEMINI_API_KEY")}`,
      {}, { contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 1200, temperature: 0.4, responseMimeType: "application/json" } });
    return { text: d.candidates[0].content.parts[0].text, model };
  }
  throw new Error("No AI key configured. In Netlify env vars set ONE of: GEMINI_API_KEY (free), "
    + "ANTHROPIC_API_KEY, OPENAI_API_KEY, or AI_BASE_URL + AI_API_KEY for any OpenAI-compatible provider.");
}

function parseAiJson(text: string): any {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "");
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI returned no JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

const clamp = (v: string, allowed: string[], fallback: string) =>
  allowed.includes(v) ? v : fallback;
const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 6) : [];

// ------------------------------------------------------------- notion ------
async function notion(path: string, payload: unknown, token: string, method = "POST") {
  const r = await fetch("https://api.notion.com/v1/" + path, {
    method,
    headers: { "Authorization": "Bearer " + token, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Notion ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const sel = (v: string) => ({ select: { name: v } });
const txt = (v: string) => ({ rich_text: v ? [{ text: { content: v.slice(0, 1900) } }] : [] });

function formPage(key: string, msg = "") {
  return new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Deep Analyzer</title><body style="font-family:-apple-system,sans-serif;background:#191919;color:#eee;padding:24px;max-width:520px;margin:auto">
<h2>🧠 Deep Analyzer</h2>
<form method=post action=/analyze>
<input type=hidden name=key value="${key}"><input type=hidden name=ui value=1>
<input name=url placeholder="Paste a link…" autofocus required style="width:100%;padding:14px;font-size:16px;border-radius:10px;border:1px solid #444;background:#252525;color:#eee;box-sizing:border-box">
<button style="margin-top:12px;width:100%;padding:14px;border-radius:10px;border:0;background:#0ea5a4;color:#fff;font-size:16px">Analyze it</button>
</form><p style="color:#9a9">${msg}</p></body>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// One-click bookmarklet mode (pop=1): a self-closing confirmation popup, like /park.
function esc(s: string) { return (s || "").replace(/[<>&"]/g, c => (({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" } as Record<string, string>)[c])); }
function popup(ok: boolean, head: string, line: string, autoMs = 2600) {
  const bg = ok ? "#0f172a" : "#7f1d1d";
  const auto = ok ? `<scr` + `ipt>setTimeout(function(){try{window.close()}catch(e){}},${autoMs})</scr` + `ipt>` : "";
  return new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Deep Analyzer</title><body style="margin:0;font-family:-apple-system,sans-serif;background:${bg};color:#eee;display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;text-align:center;padding:16px">
<div style="font-size:20px;margin-bottom:8px">${head}</div>
<div style="font-size:14px;opacity:.9;max-width:360px">${esc(line)}</div>
<div style="font-size:12px;opacity:.5;margin-top:10px">${ok ? "closes itself — full breakdown is in your Deep Analyzer page" : "close this and try again"}</div>
${auto}</body>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export default async (req: Request) => {
  const u = new URL(req.url);
  const params: Record<string, string> = Object.fromEntries(u.searchParams);
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") || "";
    try {
      if (ct.includes("json")) Object.assign(params, await req.json());
      else if (ct.includes("form")) for (const [k, v] of await req.formData()) params[k] = String(v);
    } catch { /* ignore */ }
  }

  const KEY = Netlify.env.get("CATCHER_KEY") || "";
  if (!KEY || params.key !== KEY) return new Response("Unauthorized — missing or wrong key", { status: 401 });
  if (!params.url) return formPage(params.key);

  const TOKEN = Netlify.env.get("NOTION_TOKEN") || "";
  const wantsUi = params.ui === "1";
  const wantsPop = params.pop === "1";
  const reply = (ok: boolean, message: string) =>
    wantsPop ? popup(ok, ok ? "🧠 Added to Deep Analyzer" : "❌ Couldn’t analyze", message, 2600)
    : wantsUi ? formPage(params.key, (ok ? "✅ " : "❌ ") + message)
    : Response.json({ ok, message }, { status: ok ? 200 : 500 });

  if (!TOKEN) return reply(false, "NOTION_TOKEN env var is not set.");

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url.includes("://") ? params.url : "https://" + params.url);
  } catch {
    return reply(false, "That doesn't look like a valid link.");
  }

  try {
    // duplicate check first (cheap, avoids wasting an AI call)
    const dup = await notion(`data_sources/${DS_ID}/query`, {
      filter: { property: "URL", url: { equals: parsedUrl.href } }, page_size: 1,
    }, TOKEN);
    if (dup.results?.length) {
      const t = dup.results[0].properties?.Name?.title?.map((x: any) => x.plain_text).join("") || "an existing item";
      return reply(true, `Already analyzed as “${t}” — skipped.`);
    }

    const { title, body } = await gatherContent(params.url);

    const prompt = `You are a sharp research analyst working for Afnan — a freelance web developer and AI builder in Cottbus, Germany. He redesigns websites for local businesses (dentists, restaurants, studios, lawyers) and builds AI side-projects to grow his portfolio and future agency.

Analyze the following web content thoroughly. Be concrete, skeptical, and useful — no filler.

Return ONLY valid JSON, no markdown fences, exactly this shape:
{
  "name": "short clear title (max 10 words)",
  "kind": "one of: ${KINDS.join(" | ")}",
  "summary": "2 sentences: what this actually is",
  "key_facts": ["3-6 concrete facts — numbers, names, features, prices"],
  "insights": ["2-4 non-obvious observations or implications"],
  "next_steps": ["2-4 specific actions for Afnan, most valuable first"],
  "conclusion": "1-2 sentence bottom line",
  "verdict": "one of: ${VERDICTS.join(" | ")}",
  "effort": "how long acting on it takes, one of: ${EFFORTS.join(" | ")}",
  "relevance": "1 sentence: why this matters (or doesn't) for Afnan's work"
}

URL: ${parsedUrl.href}
TITLE: ${title}
CONTENT:
${body}`;

    const { text, model } = await callAI(prompt);
    const a = parseAiJson(text);

    const name = String(a.name || title).slice(0, 120);
    const kind = clamp(String(a.kind), KINDS, "Other");
    const verdict = clamp(String(a.verdict), VERDICTS, "Maybe");
    const effort = clamp(String(a.effort), EFFORTS, "30 min");
    const keyFacts = arr(a.key_facts), insights = arr(a.insights), nextSteps = arr(a.next_steps);

    const userNote = (params.note || "").trim();
    const page = await notion("pages", {
      parent: { type: "data_source_id", data_source_id: DS_ID },
      properties: {
        Name: { title: [{ text: { content: name } }] },
        Kind: sel(kind), Verdict: sel(verdict), Effort: sel(effort),
        Summary: txt(String(a.summary || "")),
        "Next Step": txt(nextSteps[0] || ""),
        Relevance: txt(String(a.relevance || "")),
        Notes: txt(userNote),
        Status: sel("New"),
        URL: { url: parsedUrl.href },
      },
    }, TOKEN);

    const bullet = (t: string) => ({
      object: "block", type: "bulleted_list_item",
      bulleted_list_item: { rich_text: [{ text: { content: t.slice(0, 1900) } }] },
    });
    const todo = (t: string) => ({
      object: "block", type: "to_do",
      to_do: { rich_text: [{ text: { content: t.slice(0, 1900) } }], checked: false },
    });
    const h3 = (t: string) => ({
      object: "block", type: "heading_3", heading_3: { rich_text: [{ text: { content: t } }] },
    });
    const para = (t: string) => ({
      object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: t.slice(0, 1900) } }] },
    });

    try {
      await notion(`blocks/${page.id}/children`, {
        children: [
          para(String(a.summary || "")),
          h3("📌 Key facts"), ...keyFacts.map(bullet),
          h3("💡 Insights"), ...insights.map(bullet),
          h3("👉 Next steps"), ...nextSteps.map(todo),
          h3("🎯 Conclusion"),
          para(`${String(a.conclusion || "")} — Verdict: ${verdict} · Effort: ${effort}`),
          para(`Analyzed by ${model}`),
        ],
      }, TOKEN, "PATCH");
    } catch { /* body is a bonus */ }

    try {
      await notion("comments", {
        parent: { page_id: page.id },
        rich_text: [{ text: { content: `🧠 ${verdict} (${effort}) — ${nextSteps[0] || String(a.conclusion || "")}`.slice(0, 1800) } }],
      }, TOKEN);
    } catch { /* comments capability optional */ }

    return reply(true, `${name} — ${verdict} (${effort}). ${nextSteps[0] || ""}`);
  } catch (e: any) {
    return reply(false, String(e.message || e).slice(0, 300));
  }
};

export const config = { path: "/analyze" };
