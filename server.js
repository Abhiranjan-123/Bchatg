// backend/se// backend/server.js
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

/* -----------------------------
   1️⃣ Load dataset
----------------------------- */
const dataPath = path.join(__dirname, "data.json");
let qaData = [];
function loadData() {
  try {
    qaData = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    console.log(`📗 Loaded data.json (${qaData.length} entries)`);
  } catch {
    console.error("❌ Could not read data.json.");
    qaData = [];
  }
}
loadData();

/* -----------------------------
   2️⃣ Text helpers
----------------------------- */
const STOPWORDS = new Set([
  "the","is","in","at","which","on","a","an","and","of","for","to","from","by",
  "what","who","when","where","why","how","about","tell","me"
]);
function normalize(s) {
  return (s || "").toLowerCase().replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim();
}
function keywords(text) {
  return normalize(text).split(" ").filter(w => w && !STOPWORDS.has(w));
}
function keywordScore(a, b) {
  const A = new Set(keywords(a));
  const B = new Set(keywords(b));
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter(x => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  let score = inter / union;
  if (normalize(a).includes(normalize(b)) || normalize(b).includes(normalize(a)))
    score = Math.max(score, 0.8);
  return score;
}
function findBestAnswer(message) {
  let best = null, bestScore = 0;
  for (const item of qaData) {
    const s = keywordScore(message, item.question || "");
    if (s > bestScore) { bestScore = s; best = item; }
  }
  if (best && bestScore >= 0.55) {
    console.log(`✅ Dataset match (score=${bestScore.toFixed(2)}): ${best.question}`);
    return best.answer;
  }
  console.log(`⚠️ No dataset match (best=${bestScore.toFixed(2)})`);
  return null;
}

/* -----------------------------
   3️⃣ Groq (LLaMA-3 lightning-fast)
----------------------------- */
async function askGroq(prompt) {
  if (!process.env.GROQ_API_KEY) {
    console.error("❌ Missing GROQ_API_KEY in .env");
    return null;
  }

  try {
    console.log("⚡ Asking Groq LLaMA 3 for:", prompt);

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: process.env.GROQ_MODEL || "llama3-8b-8192",
        messages: [
          { role: "system", content: "You are a helpful assistant that answers clearly and concisely." },
          { role: "user", content: prompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );

    if (!response.data || !response.data.choices?.length) {
      console.error("⚠️ Groq returned empty response:", response.data);
      return null;
    }

    const text = response.data.choices[0].message.content;
    console.log("🤖 Groq replied:", text.slice(0, 120));
    return text?.trim() || null;

  } catch (err) {
    console.error("❌ Groq error:", err.response?.data || err.message);
    return null;
  }
}

/* -----------------------------
   4️⃣ Web + Code Fallbacks
----------------------------- */
function looksEnglish(s) {
  if (!s) return false;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  const nonAscii = (s.match(/[^\x00-\x7F]/g) || []).length;
  return letters > 5 && nonAscii / s.length < 0.15;
}

// detect code-related queries
function isCodingQuestion(msg) {
  return /\b(code|program|algorithm|sort|sorting|implement|c program|c code|cpp|c\+\+|java|python|javascript|function|snippet)\b/i.test(msg);
}

// Scrape StackOverflow / GitHub for code blocks
async function searchCodeOnline(query) {
  try {
    console.log("🔎 Searching StackOverflow/GitHub code for:", query);
    const q = `${query} site:stackoverflow.com OR site:github.com`;
    const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en`;
    const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 12000 });
    const $ = cheerio.load(data);

    const links = [];
    $("a").each((i, el) => {
      const href = $(el).attr("href") || "";
      const m = href.match(/\/url\?q=([^&]+)/);
      if (m && m[1]) {
        const link = decodeURIComponent(m[1]);
        if ((link.includes("stackoverflow.com/questions") || link.includes("github.com/")) && !links.includes(link))
          links.push(link);
      }
    });

    for (const l of links.slice(0, 5)) {
      try {
        const page = await axios.get(l, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 });
        const $$ = cheerio.load(page.data);
        const blocks = [];
        $$("pre, code").each((i, el) => {
          const t = $$(el).text().trim();
          if (t.length > 20 && t.split("\n").length > 2) blocks.push(t);
        });
        if (blocks.length) {
          const best = blocks.sort((a, b) => b.length - a.length)[0];
          const lang = /\b(c|cpp|java|python|javascript|js)\b/i.exec(query)?.[1] || "txt";
          return "```" + lang + "\n" + best + "\n```";
        }
      } catch {}
    }
    return null;
  } catch (err) {
    console.warn("searchCodeOnline failed:", err.message);
    return null;
  }
}

/* ----- Normal text search fallbacks ----- */
async function googleSearch(query) {
  try {
    console.log("🌐 Searching Google:", query);
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
    const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 12000 });
    const $ = cheerio.load(data);
    const texts = [];
    $("div.BNeawe.s3v9rd.AP7Wnd, div.IsZvec").each((_, el) => {
      const t = $(el).text().trim();
      if (t.length > 40 && looksEnglish(t)) texts.push(t);
    });
    const uniq = [...new Set(texts)].slice(0, 5);
    const combined = uniq.join(" ");
    const sents = combined.split(/(?<=[.?!])\s+/).filter(s => s.length > 20);
    return sents.slice(0, 3).join(" ") || null;
  } catch (err) {
    console.warn("googleSearch failed:", err.message);
    return null;
  }
}
async function duckDuckGoSearch(query) {
  try {
    console.log("🦆 Searching DuckDuckGo:", query);
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
    const { data } = await axios.get(url, { timeout: 10000 });
    if (data?.AbstractText && looksEnglish(data.AbstractText)) return data.AbstractText;
    const rel = data?.RelatedTopics?.[0]?.Text;
    if (rel && looksEnglish(rel)) return rel;
    return null;
  } catch (err) {
    console.warn("duckDuckGoSearch failed:", err.message);
    return null;
  }
}
async function wikipediaSearch(query) {
  try {
    console.log("📚 Searching Wikipedia:", query);
    const sUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json&srlimit=2`;
    const sRes = await axios.get(sUrl, { timeout: 10000 });
    const pages = sRes.data?.query?.search || [];
    for (const p of pages) {
      const title = p.title;
      const eUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&titles=${encodeURIComponent(title)}`;
      const eRes = await axios.get(eUrl, { timeout: 10000 });
      const pageData = eRes.data?.query?.pages;
      const extract = Object.values(pageData || {})[0]?.extract;
      if (extract && looksEnglish(extract))
        return extract.split(/(?<=[.?!])\s+/).slice(0, 3).join(" ");
    }
    return null;
  } catch (err) {
    console.warn("wikipediaSearch failed:", err.message);
    return null;
  }
}
async function webFallback(query) {
  const g = await googleSearch(query);
  if (g) return `From Google: ${g}`;
  const d = await duckDuckGoSearch(query);
  if (d) return `From DuckDuckGo: ${d}`;
  const w = await wikipediaSearch(query);
  if (w) return `From Wikipedia: ${w}`;
  return `I couldn't find a clear English answer for “${query}”.`;
}

/* -----------------------------
   💬 Smart generic name responder
----------------------------- */
let lastAskedPerson = null;

function detectGenericName(message) {
  const lower = message.toLowerCase();
  const match = lower.match(/\b(do you know|tell me about|who is|what about)\s+([a-z]+)\b/i);
  if (match) {
    const name = match[2];
    const gender = name.endsWith("a") || name.endsWith("i") ? "female" : "male";
    lastAskedPerson = { name, gender };
    return gender === "female"
      ? `Is she from RRSDEC Begusarai?`
      : `Is he from RRSDEC Begusarai?`;
  }
  return null;
}

function respondGenericName(message) {
  const m = message.toLowerCase();
  if (!lastAskedPerson) return null;
  if (!["yes", "yaa", "ha", "haan", "yup"].includes(m)) return null;

  const { name, gender } = lastAskedPerson;
  lastAskedPerson = null;

  if (gender === "female") {
    return (
      `Aree ${name.charAt(0).toUpperCase() + name.slice(1)} is a really sweet and confident girl from RRSDEC! 🌸 ` +
      `Always active in events and known for her smile that can fix a whole bad day 😄. ` +
      `Fun fact: College ke canteen wale bhi uska naam leke discount de dete hain — bas naam ka jaadu hi aisa hai! 😂`
    );
  } else {
    return (
      `${name.charAt(0).toUpperCase() + name.slice(1)} bhai is a proper RRSDEC legend 😎. ` +
      `Coding me tez, attendance me kam, par style me full marks! 💪 ` +
      `Fun fact: Teachers bhi kehte hain “iska confidence alag level pe hai” — par result ke time silent mode on kar deta hai 😅`
    );
  }
}

/* -----------------------------
   6️⃣ Chat endpoint
----------------------------- */
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ reply: "No message received." });

    console.log(`💭 User asked: "${message}"`);
    let reply = null;

    // 🌟 Generic person-name detection
    const nameCheck = detectGenericName(message);
    if (nameCheck) return res.json({ reply: nameCheck });

    const followUp = respondGenericName(message);
    if (followUp) return res.json({ reply: followUp });

    // 1️⃣ Personality
    reply = personalityReply(message);
    if (reply) return res.json({ reply });

    // 2️⃣ Dataset
    reply = findBestAnswer(message);
    if (reply) return res.json({ reply });

    // 3️⃣ Groq
    reply = await askGroq(message);
    if (reply) {
      if (reply.toLowerCase().includes("meta") && message.toLowerCase().includes("who created")) {
        reply = "My creator is Abhiranjan Singh — smart, funny, and a bit pagal 😜";
      }
      return res.json({ reply });
    }

    // 4️⃣ Web Search
    reply = await webFallback(message);
    if (!reply) reply = "😕 Sorry, I couldn’t find a clear answer.";

    console.log("✅ Final reply ready:", reply.slice(0, 120));
    return res.json({ reply });
  } catch (err) {
    console.error("Server error:", err.message);
    return res.status(500).json({ reply: "Internal server error." });
  }
});

/* -----------------------------
   7️⃣ Admin + Frontend serve
----------------------------- */
app.get("/reload", (req, res) => {
  loadData();
  res.json({ message: "Dataset reloaded successfully ✅" });
});

const frontendPath = path.join(__dirname, "frontend");
app.use(express.static(frontendPath));
app.use((req, res) => res.sendFile(path.join(frontendPath, "index.html")));

app.listen(PORT, () =>
  console.log(`✅ Server running at http://localhost:${PORT}`)
);

