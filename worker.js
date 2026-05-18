/**
 * Easy Logic — Cloudflare Worker (AI proxy)
 *
 * Four POST endpoints:
 *   POST /generate-question
 *   POST /get-hint
 *   POST /check-logic
 *   POST /generate-samples
 *
 * Uses the Workers AI binding (env.AI.run).  Free-tier safe:
 * each call is capped at ~600 tokens.
 *
 * CORS: open ("*") so it can be called from a Pages site on a
 * different subdomain.  Tighten ALLOWED_ORIGIN in production.
 */

const MODEL = "@cf/meta/llama-3-8b-instruct";
// Fallback if the above isn't available on your account:
// const MODEL = "@cf/mistral/mistral-7b-instruct-v0.1";

const ALLOWED_ORIGIN = "*"; // tighten in production
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    try {
      let body = {};
      if (request.method === "POST") {
        body = await request.json().catch(() => ({}));
      }

      let result;
      switch (path) {
        case "/generate-question":
          result = await generateQuestion(env, body);
          break;
        case "/get-hint":
          result = await getHint(env, body);
          break;
        case "/check-logic":
          result = await checkLogic(env, body);
          break;
        case "/generate-samples":
          result = await generateSamples(env, body);
          break;
        case "":
        case "/":
          result = { ok: true, service: "easy-logic-worker" };
          break;
        default:
          return json({ error: "Not found" }, 404);
      }
      return json(result);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  },
};

/* ------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------ */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

async function runAI(env, systemPrompt, userPrompt, maxTokens = 500) {
  const res = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature: 0.7,
  });
  // env.AI.run returns { response: "..." } for llama / mistral chat
  return (res && (res.response || res.output || "")).toString().trim();
}

/** Try hard to extract a JSON object from a model reply that may be wrapped in prose / code fences. */
function extractJSON(text) {
  if (!text) return null;
  // strip code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced) text = fenced[1];
  // find first { ... } block
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

/* ------------------------------------------------------------------
 * 1. /generate-question
 * ------------------------------------------------------------------ */
async function generateQuestion(env, { axis, stance }) {
  if (!axis || !stance) throw new Error("axis and stance are required");

  const SEED_HINTS = {
    "Education & School Policy":
      "four-day school week; abolishing class positions; removing PE lessons; adding drama to curriculum; school lockers",
    "Urban Development":
      "people occupying coffee shops for long activities; dog-friendly city trend; developing harbourfront; filming in city centre; public use of school sports facilities",
    "Technology & Society":
      "monitoring apps on children's phones; computer-generated songs in competitions; social media and public debate; TV and intelligence; influencer advertising",
    "Public Health & Safety":
      "food warning labels; health literacy campaigns; preventive health habits; smoking bans; mental-health awareness",
    "Economic & Employment Issues":
      "encouraging graduates to work overseas; attitudes of HK fresh graduates; youth employment policies; gig economy; minimum wage",
  };

  const seeds = SEED_HINTS[axis] || "";
  const stanceText = stance === "pro" ? "positive (PRO)" : "negative (CON)";

  const system = `You are a DSE English exam question generator for Hong Kong secondary students. Generate a realistic one-sided argumentative writing prompt in the axis of ${axis}.

Return JSON with EXACTLY these fields and nothing else:
{
  "cause": "A 1-2 sentence description of the given cause or phenomenon",
  "task": "A one-sentence instruction telling the student what to argue",
  "final_result": "A 3-5 word label for the expected final outcome (e.g. Academic Performance, Social Harmony, Economic Vitality)",
  "stance": "${stance}"
}

The cause should reflect real Hong Kong social issues. The stance is ${stanceText}. Be specific, not generic. Output JSON only — no prose, no code fence.`;

  const user = `Generate one question. Use any of these example causes as inspiration (vary them — do not copy verbatim): ${seeds}.`;

  const raw = await runAI(env, system, user, 400);
  const parsed = extractJSON(raw);

  if (!parsed || !parsed.cause || !parsed.task || !parsed.final_result) {
    // Fallback: best-effort plain text shape so the UI does not break.
    return {
      cause: parsed?.cause || raw.split("\n")[0] || "A new policy is being considered in Hong Kong.",
      task: parsed?.task || `Write a one-sided argument explaining why this leads to ${stance === "pro" ? "positive" : "negative"} outcomes.`,
      final_result: parsed?.final_result || (axis.includes("Education") ? "Academic Performance" : "Social Harmony"),
      stance,
    };
  }
  parsed.stance = stance;
  return parsed;
}

/* ------------------------------------------------------------------
 * 2. /get-hint  →  Cantonese (Traditional Chinese) hint
 * ------------------------------------------------------------------ */
async function getHint(env, { cause, final_result, step_number, total_steps, previous_step }) {
  if (!cause || !final_result || !step_number) {
    throw new Error("cause, final_result and step_number are required");
  }

  const system = `You are a DSE writing tutor helping a Hong Kong student build a logical deduction chain.

Give a short hint in Traditional Chinese (繁體中文) of 8 to 18 characters describing what logically happens at this step in the chain. Do NOT write a full sentence. Do NOT use English. Do NOT add quotation marks or any explanation. Output ONLY the short phrase.

Reference mechanism patterns you may draw from:
- Academic Performance: 減少學習疲勞、增加溫習時間、提升課堂投入感
- Well-being: 減低壓力、改善睡眠、減少比較壓力
- Social Harmony: 減少滋擾、建立公共規範、加強社區凝聚力
- Economic Vitality: 增加人流、嚇退潛在顧客、小商戶難以經營
- Employability: 擴闊見識、培養可轉移技能
- Public Health: 提升風險認識、減少有害攝取`;

  const user = `Topic / cause: ${cause}
Final result to reach: ${final_result}
This is step ${step_number} of ${total_steps}.
Previous step was: ${previous_step}

Give the next step as a short 繁體中文 phrase (8–18 characters). Output only the phrase.`;

  let raw = await runAI(env, system, user, 80);
  // sanitise: take first line, trim quotes / punctuation
  let hint = raw.split(/\r?\n/)[0].trim().replace(/^["「『]+|["」』]+$/g, "");
  // clamp length to keep it short
  if (hint.length > 30) hint = hint.slice(0, 30);
  return { hint };
}

/* ------------------------------------------------------------------
 * 3. /check-logic
 * ------------------------------------------------------------------ */
async function checkLogic(env, { cause, final_result, stance, chain }) {
  if (!cause || !final_result || !Array.isArray(chain)) {
    throw new Error("cause, final_result and chain are required");
  }
  const chainText = chain
    .map((s, i) => `[${i + 1}] ${s || "(empty)"}`)
    .join(" → ");

  const system = `You are a DSE English writing examiner. A student has written a logical deduction chain for a one-sided argumentative essay.

Evaluate the chain in EXACTLY three labelled sections. Use plain text (no Markdown headers, no asterisks). Each section starts on a new line with its label in CAPS followed by a colon. Keep each section concise (3–6 lines). Use simple English a secondary student can understand.

Sections (in this order):
LOGIC: Is each step causally connected? Flag leaps or overgeneralisations. Suggest a corrected chain.
LANGUAGE: List specific grammar errors with corrections in the form "❌ wrong → ✅ right". Suggest better vocabulary.
TOPIC: One polished English topic sentence using the formula: [Cause] → [mechanism] → [Final Result]. Example shape: "By [cause], students are able to [mechanism], which ultimately [Final Result]."`;

  const user = `Cause: ${cause}
Stance: ${stance}
Final Result target: ${final_result}
Student's chain: ${chainText}`;

  const raw = await runAI(env, system, user, 600);

  // Split the three sections
  const logic = pickSection(raw, "LOGIC");
  const language = pickSection(raw, "LANGUAGE");
  const topic = pickSection(raw, "TOPIC");

  return {
    logic_check: logic || raw,
    language_check: language || "(No language notes returned.)",
    topic_sentence: topic || "(No topic sentence returned.)",
    _raw: raw,
  };
}

function pickSection(text, label) {
  if (!text) return "";
  const labels = ["LOGIC", "LANGUAGE", "TOPIC"];
  const re = new RegExp(
    `${label}\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:${labels.join("|")})\\s*[:：]|$)`,
    "i"
  );
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

/* ------------------------------------------------------------------
 * 4. /generate-samples
 * ------------------------------------------------------------------ */
async function generateSamples(env, { cause, final_result, stance, chain }) {
  if (!cause || !final_result) throw new Error("cause and final_result are required");

  const chainText = Array.isArray(chain)
    ? chain.filter(Boolean).join(" → ")
    : "";

  const system = `You are a DSE English writing expert. Generate TWO model paragraphs for a Hong Kong DSE student. Both paragraphs are letters to the editor and MUST start with "Dear Editor,".

Output format — produce EXACTLY this structure, with these literal markers and nothing else outside them:
===LV3===
(paragraph ~80 words, simple vocabulary, 2–3 step logic, one example, minor grammar errors typical of a HK student, mechanical transitions such as "The first reason is...", "In conclusion...")
===LV5===
(paragraph ~150 words, sophisticated vocabulary — naturally include words like "exacerbate", "inherently", "detrimental" where they fit, 4–5 step deduction chain, one counter-argument with a rebuttal offering a concrete alternative, one statistic, formal tone, varied sentence structures, strong conclusion ending with reflection or a call to ponder.)`;

  const user = `Cause: ${cause}
Stance: ${stance}
Final Result: ${final_result}
Student's logical chain (use as scaffold, improve as needed): ${chainText}

Write both paragraphs now.`;

  const raw = await runAI(env, system, user, 600);

  const lv3 = pickBetween(raw, "===LV3===", "===LV5===") || "";
  const lv5 = pickAfter(raw, "===LV5===") || "";

  return {
    lv3: lv3.trim() || "(Lv3 sample could not be parsed.)\n\n" + raw,
    lv5: lv5.trim() || "(Lv5** sample could not be parsed.)",
  };
}

function pickBetween(text, start, end) {
  const s = text.indexOf(start);
  if (s === -1) return "";
  const e = text.indexOf(end, s + start.length);
  if (e === -1) return text.slice(s + start.length).trim();
  return text.slice(s + start.length, e).trim();
}
function pickAfter(text, marker) {
  const i = text.indexOf(marker);
  if (i === -1) return "";
  return text.slice(i + marker.length).trim();
}
