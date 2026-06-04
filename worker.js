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

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
// Fallback if the above isn't available on your account:
// const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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
        case "/plan-chain":
          result = await planChain(env, body);
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

  // Switched from JSON output to labelled lines — the JSON path was failing
  // intermittently (the model emits `{\n"cause": ...}`, JSON.parse fails on
  // some quoting/comma quirk, and the old fallback grabbed `raw.split("\n")[0]`
  // which is just "{"). Labelled output + an anti-junk filter kills that bug.
  const system = `You are a DSE English exam question generator for Hong Kong secondary students. Generate a realistic one-sided argumentative writing prompt in the axis of ${axis}.

The cause should reflect real Hong Kong social issues. The stance is ${stanceText}. Be specific, not generic.

OUTPUT FORMAT — exactly these three labelled lines, nothing else, no JSON, no markdown, no code fence, no quotation marks around the values:
CAUSE: <a 1–2 sentence description of the given cause or phenomenon>
TASK: <a one-sentence instruction telling the student what to argue>
FINAL_RESULT: <a 2–5 word noun phrase naming the expected final outcome, e.g. Academic Performance, Social Harmony, Economic Vitality>`;

  const user = `Generate one question. Use any of these example causes as inspiration (vary them — do not copy verbatim): ${seeds}.`;

  const raw = await runAI(env, system, user, 500);

  // Primary parser: labelled lines (handles both `LABEL:` and `"LABEL":` forms).
  const pickLineLocal = (label) => {
    const re = new RegExp(`^\\s*"?${label}"?\\s*[:：]\\s*(.+?)\\s*$`, "im");
    const m = raw.match(re);
    if (!m) return "";
    return m[1].trim().replace(/^["「『]+|["」』,]+$/g, "").trim();
  };

  let causeOut = pickLineLocal("CAUSE");
  let taskOut  = pickLineLocal("TASK");
  let finalOut = pickLineLocal("FINAL_RESULT") || pickLineLocal("FINAL RESULT") || pickLineLocal("final_result");

  // Backward-compat: if the model ignored the labelled instruction and
  // returned JSON, recover from that too.
  if (!causeOut || !taskOut || !finalOut) {
    const parsed = extractJSON(raw);
    if (parsed) {
      if (!causeOut && parsed.cause)        causeOut = String(parsed.cause);
      if (!taskOut  && parsed.task)         taskOut  = String(parsed.task);
      if (!finalOut && parsed.final_result) finalOut = String(parsed.final_result);
    }
  }

  // Anti-junk filter — never let "{", "}", or other structural fragments
  // through to the UI. This is the specific guard that kills "Cause = {".
  const isJunk = (s) => !s || /^[{}\[\]",:;\s`']+$/.test(s) || s.length < 5;
  if (isJunk(causeOut)) {
    causeOut = `A new proposal in the area of ${axis} is currently being discussed in Hong Kong.`;
  }
  if (isJunk(taskOut)) {
    taskOut = `Write a one-sided argument explaining why this leads to ${stance === "pro" ? "positive" : "negative"} outcomes.`;
  }
  if (isJunk(finalOut)) {
    finalOut = axis.includes("Education") ? "Academic Performance" : "Social Harmony";
  }

  return { cause: causeOut, task: taskOut, final_result: finalOut, stance };
}

/* ------------------------------------------------------------------
 * 1b. /plan-chain
 *     ONE AI call that plans the ENTIRE chain so:
 *      - Step II's first box is a proper TOPIC SENTENCE (not the raw
 *        question stimulus)
 *      - Each Cantonese hint is a complete short sentence
 *      - No two hints repeat the same idea
 *     Returns: { topic_sentence, hints: [string, ...] }
 *     length of hints == total_steps - 2  (middle boxes only)
 * ------------------------------------------------------------------ */
async function planChain(env, { cause, final_result, total_steps }) {
  if (!cause || !final_result) throw new Error("cause and final_result are required");
  const total = Math.max(3, parseInt(total_steps, 10) || 5);
  const middleCount = total - 2;

  const hintLabels = Array.from({ length: middleCount }, (_, i) => `HINT_${i + 1}`);
  const formatBlock = ["TOPIC_SENTENCE: <one complete English sentence>"]
    .concat(hintLabels.map((l) => `${l}: <繁體中文，一句完整短句，必須以 「。」結尾>`))
    .join("\n");

  const system = `You are a DSE English writing tutor designing the deduction chain for a one-sided argumentative essay about a Hong Kong situation.

You are given:
- CAUSE: the question stimulus
- FINAL_RESULT: the outcome the essay must argue toward

Produce TWO things.

PART A — TOPIC_SENTENCE (in English)
ONE precise topic sentence (≤ 28 words) that:
  • names the proposal / phenomenon under discussion
  • names the MAIN MECHANISM the essay will defend
  • PREVIEWS how that mechanism leads to the FINAL_RESULT
Model example (for inspiration only, do NOT copy):
  "The most evident benefit of this policy lies in providing
   educational access for low-income families in Hong Kong,
   which drives learning motivation."

PART B — HINTS (in 繁體中文)
Produce EXACTLY ${middleCount} bridging step(s).
Each hint is ONE complete short sentence (約 16–26 個字, MUST end with 「。」, NEVER truncate mid-character).

CRITICAL RULES for the hint chain:
1. The full chain reads: TOPIC_SENTENCE → HINT_1 → HINT_2 → … → FINAL_RESULT.
2. Each hint MUST add a DISTINCT NEW causal link. It must answer "and therefore what?" of the PREVIOUS step — never restate it.
3. NO two hints may express the same idea even paraphrased. If HINT_1 says "students save money", HINT_2 must NOT say "less financial burden" — pick a DIFFERENT downstream consequence (e.g., "attendance becomes more regular", "dropout risk falls", "more energy for class").
4. Before writing, mentally check every adjacent pair is a tight cause→effect with no obvious missing intermediate.
5. Use ordinary modern Hong Kong 繁體中文.

OUTPUT FORMAT — exactly these labelled lines, nothing else, no JSON, no markdown:
${formatBlock}`;

  const user = `CAUSE:
${cause}

FINAL_RESULT:
${final_result}

Produce the topic sentence and exactly ${middleCount} distinct, complete hints now.`;

  // Generous max_tokens so 繁體中文 sentences never get cut.
  const raw = await runAI(env, system, user, 900);

  const pickLine = (label) => {
    const re = new RegExp(`^\\s*${label}\\s*[:：]\\s*(.+?)\\s*$`, "im");
    const m = raw.match(re);
    return m ? m[1].trim() : "";
  };

  let topic_sentence = pickLine("TOPIC_SENTENCE");
  const hints = [];
  for (let i = 1; i <= middleCount; i++) hints.push(pickLine(`HINT_${i}`));

  // Repair truncation: if a hint doesn't end with sentence-final
  // punctuation, trim back to the last clean phrase and close with 「。」.
  const SENTENCE_END = /[。！？!?.]$/;
  for (let i = 0; i < hints.length; i++) {
    if (hints[i] && !SENTENCE_END.test(hints[i])) {
      hints[i] = hints[i].replace(/[，、,；;：:]?\s*[一-鿿]{0,2}$/, "").trim();
      if (hints[i]) hints[i] += "。";
    }
  }
  // Semantic dedupe (adjacent): tag near-identical neighbours.
  const norm = (s) => (s || "").replace(/[\s，。、,.!?；;：:「」"'（）()]/g, "").toLowerCase();
  for (let i = 1; i < hints.length; i++) {
    if (hints[i] && hints[i - 1] && norm(hints[i]) === norm(hints[i - 1])) {
      hints[i] = hints[i].replace(/。$/, "") + "（請改寫此步以避免與上一步重覆）。";
    }
  }
  // Fill blanks
  for (let i = 0; i < middleCount; i++) {
    if (!hints[i]) hints[i] = "（請填寫此處的推論步驟）";
  }
  // Fallback topic sentence
  if (!topic_sentence) {
    topic_sentence = `This essay argues that the proposal described above will, through its main mechanism, ultimately deliver ${final_result}.`;
  }

  return { topic_sentence, hints };
}

/* ------------------------------------------------------------------
 * 2. /get-hint  →  Cantonese (Traditional Chinese) hint
 * ------------------------------------------------------------------ */
async function getHint(env, { cause, final_result, step_number, total_steps, previous_step, previous_steps }) {
  if (!cause || !final_result || !step_number) {
    throw new Error("cause, final_result and step_number are required");
  }

  // Backward-compat: accept either an array of prior steps, or a single one.
  let priors = [];
  if (Array.isArray(previous_steps)) priors = previous_steps.filter(Boolean);
  else if (previous_step) priors = [previous_step];
  const priorBlock = priors.length
    ? priors.map((p, i) => `- 第 ${i + 2} 步：${p}`).join("\n")
    : "（無）";

  const system = `You are a DSE writing tutor helping a Hong Kong student build a logical deduction chain.

Output ONE complete short sentence in Traditional Chinese (繁體中文), 16–26 個字, ending with 「。」. Do NOT use English. Do NOT use quotation marks. Output ONLY the sentence.

CRITICAL: the hint must be a NEW causal link that does NOT repeat any earlier step shown to you. It must answer "and therefore what?" of the previous step — not restate it. Use a fresh consequence (different verb, different noun) so each step adds something new to the chain.`;

  const user = `背景因 (CAUSE)：${cause}
最終果 (FINAL_RESULT)：${final_result}
這是第 ${step_number} 步（共 ${total_steps} 步）。

之前已經寫過的步驟（不要重覆它們的意思）：
${priorBlock}

請寫第 ${step_number} 步，一句完整的繁體中文短句，必須以 「。」結尾。`;

  // Bump max_tokens so a full 繁體中文 sentence isn't cut mid-character.
  let raw = await runAI(env, system, user, 220);
  let hint = raw.split(/\r?\n/)[0].trim().replace(/^["「『]+|["」』]+$/g, "");
  const SENTENCE_END = /[。！？!?.]$/;
  if (hint && !SENTENCE_END.test(hint)) {
    hint = hint.replace(/[，、,；;：:]?\s*[一-鿿]{0,2}$/, "").trim();
    if (hint) hint += "。";
  }
  return { hint };
}

/* ------------------------------------------------------------------
 * 3. /check-logic
 * ------------------------------------------------------------------ */
async function checkLogic(env, { cause, final_result, stance, chain, hints }) {
  if (!cause || !final_result || !Array.isArray(chain)) {
    throw new Error("cause, final_result and chain are required");
  }
  const numbered = chain.map((s, i) => `Step ${i + 1}: ${s || "(empty)"}`).join("\n");
  const hintLines = (Array.isArray(hints) ? hints : [])
    .map((h, i) => (h ? `Step ${i + 1} hint shown to student: ${h}` : null))
    .filter(Boolean)
    .join("\n");
  const givenStep1 = chain[0] || cause;

  const system = `You are a DSE English writing examiner. A student has written a logical deduction chain for a one-sided argumentative essay.

The student's chain has ${chain.length} steps. Step 1 is the GIVEN topic sentence and the LAST step is the GIVEN final result — both supplied by the platform. Do NOT mark those wrong; only the middle steps.

Evaluate in EXACTLY four labelled sections, in this order. Use plain text (no Markdown, no asterisks). Refer to steps as "Step 1", "Step 2" — NEVER use [1] or [2]. Use simple English a secondary student can understand.

LOGIC:
For EVERY adjacent pair (Step N → Step N+1) ask: "Does Step N+1 follow tightly from Step N, or is there an obvious INTERMEDIATE cause missing between them?"
For each gap you find, you MUST:
  (a) name the pair explicitly, e.g. "Step 3 → Step 4"
  (b) quote the jump in plain words
  (c) state the MISSING BRIDGING IDEA in ONE sentence
Worked example of a missing-link diagnosis:
  "Step 3 ('students reduce their transportation costs') jumps too quickly to Step 4 ('students focus more on their studies'). The missing link is: lower transport costs reduce the financial pressure that pushes low-income students to drop out, so attendance stabilises — and only THEN can they focus."
If a student's wording is a reasonable translation of the Cantonese hint they were shown, treat that step as LOGICALLY VALID even if the English is rough.
Keep this section to ≤ 7 short sentences.

CORRECTED_CHAIN:
A numbered list showing the IMPROVED chain that INCLUDES every bridging step you identified above.
- Step 1 MUST equal the given topic sentence.
- The LAST step MUST equal the given final result.
- You MAY (and should, where needed) include MORE steps than the student wrote — aim for 4 to 7 total steps depending on how many bridges are needed.
- Each step is ONE concise English sentence.

LANGUAGE:
List specific grammar errors with corrections in the form "❌ wrong → ✅ right". Suggest better vocabulary. ≤ 4 lines. If nothing major, say "No major language issues."

TOPIC:
One polished English topic sentence using the formula: [Cause] → [mechanism] → [Final Result]. Example shape: "By [cause], students are able to [mechanism], which ultimately [Final Result]."`;

  const user = `GIVEN TOPIC SENTENCE (Step 1, fixed): ${givenStep1}
GIVEN FINAL RESULT (last step, fixed): ${final_result}
STANCE: ${stance || "(unspecified)"}

STUDENT'S CHAIN:
${numbered}

${hintLines ? "HINTS THE STUDENT WAS SHOWN:\n" + hintLines : "(no hints recorded)"}

Evaluate now. Be ruthless about missing intermediate links — that is the WHOLE POINT of the exercise.`;

  const raw = await runAI(env, system, user, 1100);

  const logic = pickSection(raw, "LOGIC");
  const correctedRaw = pickSection(raw, "CORRECTED_CHAIN");
  const language = pickSection(raw, "LANGUAGE");
  const topic = pickSection(raw, "TOPIC");

  let corrected_chain = parseNumberedList(correctedRaw);
  if (!corrected_chain.length) {
    corrected_chain = [givenStep1, "(no bridging steps inferred — try again)", final_result];
  } else {
    corrected_chain[0] = givenStep1;
    corrected_chain[corrected_chain.length - 1] = final_result;
    if (corrected_chain.length < 3) corrected_chain.splice(1, 0, "(no bridging step inferred)");
  }

  return {
    logic_check: logic || raw,
    corrected_chain,
    language_check: language || "No major language issues.",
    topic_sentence: topic || "(No topic sentence returned.)",
    _raw: raw,
  };
}

function pickSection(text, label) {
  if (!text) return "";
  const labels = ["LOGIC", "CORRECTED_CHAIN", "LANGUAGE", "TOPIC"];
  const re = new RegExp(
    `${label}\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:${labels.join("|")})\\s*[:：]|$)`,
    "i"
  );
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

function parseNumberedList(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^(?:\d+\s*[\.\)]|[-•])\s*(.+)$/);
    if (m) steps.push(m[1].trim());
    else if (steps.length === 0) steps.push(line);
    else steps[steps.length - 1] += " " + line;
  }
  return steps;
}

/* ------------------------------------------------------------------
 * 4. /generate-samples
 * ------------------------------------------------------------------ */
async function generateSamples(env, { cause, final_result, stance, chain }) {
  if (!cause || !final_result) throw new Error("cause and final_result are required");

  const chainText = Array.isArray(chain)
    ? chain.filter(Boolean).join(" → ")
    : "";
  const stanceLabel = stance === "con" ? "argue AGAINST" : "argue IN FAVOUR of";

  const system = `You are a DSE English writing expert. Produce TWO model BODY PARAGRAPHS of the SAME body argument at two different proficiency levels for a Hong Kong DSE student:
- Lv 3  → competent (CEFR ~B2)
- Lv 5** → top band (CEFR C1–C2)

STRICT RULES (apply to BOTH paragraphs):
1. Each sample is ONE body paragraph that ${stanceLabel} the proposal.
2. Structure = TOPIC SENTENCE + tight cause→effect chain ending at the FINAL RESULT.
3. FORBIDDEN: NO "Dear Editor", NO greeting, NO introduction, NO rebuttal, NO counter-argument, NO conclusion, NO "Firstly/Secondly", NO "In conclusion", NO multiple ideas. ONE key idea, ONE chain.
4. Lv 5** must use noticeably more sophisticated vocabulary and sentence variety than Lv 3.
5. Each sample is 110–170 words.

ALSO produce a vocabulary glossary for EACH sample listing the C1 and C2 advanced words used in that sample, each with a short 繁體中文 translation.

OUTPUT FORMAT — exactly these labelled blocks, no JSON, no markdown:
===LV3===
<Lv 3 body paragraph>

===LV3_VOCAB===
- word :: 繁體中文 translation
- word :: 繁體中文 translation
...

===LV5===
<Lv 5** body paragraph>

===LV5_VOCAB===
- word :: 繁體中文 translation
- word :: 繁體中文 translation
...`;

  const user = `Cause: ${cause}
Stance: ${stance}
Final Result: ${final_result}
Student's logical chain (use as scaffold, improve as needed): ${chainText}

Write both body paragraphs and their vocab glossaries now.`;

  const raw = await runAI(env, system, user, 1400);

  const lv3      = pickBetween(raw, "===LV3===",      "===LV3_VOCAB===") || pickBetween(raw, "===LV3===", "===LV5===") || "";
  const lv3Vocab = pickBetween(raw, "===LV3_VOCAB===", "===LV5===") || "";
  const lv5      = pickBetween(raw, "===LV5===",      "===LV5_VOCAB===") || pickAfter(raw, "===LV5===") || "";
  const lv5Vocab = pickAfter(raw,  "===LV5_VOCAB===") || "";

  return {
    lv3: lv3.trim() || "(Lv3 sample could not be parsed.)\n\n" + raw,
    lv5: lv5.trim() || "(Lv5** sample could not be parsed.)",
    lv3_vocab: parseVocabLines(lv3Vocab),
    lv5_vocab: parseVocabLines(lv5Vocab),
  };
}

function parseVocabLines(text) {
  if (!text) return [];
  return text.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.startsWith("-") || l.startsWith("•"))
    .map((l) => l.replace(/^[-•]\s*/, ""))
    .map((l) => {
      const parts = l.split(/\s*::\s*|\s*—\s*|\s*-\s+(?=[一-鿿])/);
      return { word: (parts[0] || "").trim(), translation: (parts[1] || "").trim() };
    })
    .filter((v) => v.word);
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
