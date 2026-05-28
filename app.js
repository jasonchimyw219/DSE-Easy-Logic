/* =========================================================
   Easy Logic — Frontend Controller
   Vanilla JS. No frameworks.
   ========================================================= */

const WORKER_URL = (window.WORKER_URL || "https://easy-logic-worker.jasonchimyw.workers.dev")
  .replace(/\/+$/, "");

const CHAIN_LENGTH = 5;
const DAILY_LIMIT = 3;

/* ---------- Daily quota (localStorage, per device) ---------- */
function quotaKey() {
  const d = new Date();
  return `el-quota-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function getQuotaUsed() {
  try { return parseInt(localStorage.getItem(quotaKey()) || "0", 10) || 0; }
  catch { return 0; }
}
function getQuotaRemaining() { return Math.max(0, DAILY_LIMIT - getQuotaUsed()); }
function consumeQuota() {
  try {
    const k = quotaKey();
    localStorage.setItem(k, String(getQuotaUsed() + 1));
    // sweep yesterday's keys
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith("el-quota-") && key !== k) localStorage.removeItem(key);
    }
  } catch {}
}
function updateQuotaDisplay() {
  const el = document.getElementById("quota-remaining");
  if (el) el.textContent = String(getQuotaRemaining());
  const btn = document.getElementById("btn-generate-question");
  if (btn && getQuotaRemaining() === 0) {
    btn.disabled = true;
    btn.textContent = "Daily limit reached · 今日次數已用盡";
  }
}

/* ---------- Used-topics memory (per device) ---------- */
const USED_TOPICS_KEY = "el-used-topics";
const USED_TOPICS_CAP = 15;
function getUsedTopics() {
  try {
    const raw = localStorage.getItem(USED_TOPICS_KEY);
    return raw ? (JSON.parse(raw) || []) : [];
  } catch { return []; }
}
function addUsedTopic(topic) {
  if (!topic || typeof topic !== "string") return;
  try {
    const list = getUsedTopics();
    list.push(topic);
    while (list.length > USED_TOPICS_CAP) list.shift();
    localStorage.setItem(USED_TOPICS_KEY, JSON.stringify(list));
  } catch {}
}

/* ---------- State ---------- */
const state = {
  axis: null,
  stance: null,
  question: null,
  chain: [],
  hints: [],            // hints shown so far (parallel to chain)
  plannedHints: [],     // cached coherent chain from /plan-chain
  topicSentence: null,  // Step II first-box topic sentence from /plan-chain
  planInFlight: null,   // in-flight /plan-chain promise (race-condition guard)
  feedback: null,
  samples: null,
};

/* ---------- DOM helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------- Step navigation ---------- */
function gotoStep(n) {
  $$(".step-panel").forEach((p) => p.classList.remove("active"));
  $(`#step-${n}`).classList.add("active");
  $$(".steps .step").forEach((s) => {
    const num = parseInt(s.dataset.step, 10);
    s.classList.remove("active", "done");
    if (num < n) s.classList.add("done");
    else if (num === n) s.classList.add("active");
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- Chip selection ---------- */
function wireChipGroup(groupId, onSelect) {
  const chips = $$(`#${groupId} .chip`);
  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      chips.forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      onSelect(chip.dataset.value);
    });
  });
}
wireChipGroup("axis-group", (v) => { state.axis = v; refreshGenerateButton(); });
wireChipGroup("stance-group", (v) => { state.stance = v; refreshGenerateButton(); });

function refreshGenerateButton() {
  const btn = $("#btn-generate-question");
  if (getQuotaRemaining() === 0) {
    btn.disabled = true;
    btn.textContent = "Daily limit reached · 今日次數已用盡";
    return;
  }
  btn.disabled = !(state.axis && state.stance);
}

/* Initialise quota display on load */
updateQuotaDisplay();

/* ------------------------------------------------------------------
 * Step 1 — Generate Question
 * ------------------------------------------------------------------ */
$("#btn-generate-question").addEventListener("click", async () => {
  // Daily quota check (each device gets DAILY_LIMIT generations per day)
  if (getQuotaRemaining() <= 0) {
    alert(`您今日的免費試用次數已用盡（每日 ${DAILY_LIMIT} 次）。請明天再試。\n\nYou've used today's free quota (${DAILY_LIMIT}/day). Please try again tomorrow.`);
    updateQuotaDisplay();
    return;
  }

  const btn = $("#btn-generate-question");
  btn.disabled = true;
  btn.textContent = "Generating…";
  try {
    const res = await api("/generate-question", {
      axis: state.axis,
      stance: state.stance,
      avoid: getUsedTopics(),    // ← tell AI what NOT to reuse
    });
    state.question = res;
    if (res && res.topic) addUsedTopic(res.topic);
    consumeQuota();              // ← only count successful generations
    updateQuotaDisplay();
    $("#q-cause").textContent = res.cause;
    $("#q-task").textContent = res.task;
    $("#q-final-result").textContent = res.final_result;
    $("#question-output").classList.remove("hidden");
  } catch (err) {
    alert("Could not generate a question: " + err.message);
  } finally {
    if (getQuotaRemaining() > 0) {
      btn.disabled = false;
      btn.textContent = "Generate Question";
    }
  }
});

$("#btn-to-step-2").addEventListener("click", () => {
  buildChainUI();
  gotoStep(2);
  // Fire /plan-chain now so the topic sentence (Step II's first box)
  // is generated up-front instead of lazily on first Hint click.
  ensurePlannedChain();
});

/* ------------------------------------------------------------------
 * Step 2 — Build the Chain
 * ------------------------------------------------------------------ */
function buildChainUI() {
  const container = $("#chain-container");
  container.innerHTML = "";

  const q = state.question;
  const total = CHAIN_LENGTH;
  state.chain = new Array(total).fill("");
  state.hints = new Array(total).fill(null);
  state.plannedHints = [];     // fresh question → re-plan
  state.topicSentence = null;  // ditto
  state.planInFlight = null;   // drop any stale in-flight plan
  // chain[0] will be filled by ensurePlannedChain (topic sentence).
  // Until then the first box shows a loading placeholder.
  state.chain[total - 1] = q.final_result;

  for (let i = 0; i < total; i++) {
    const box = document.createElement("div");
    box.className = "chain-box";
    if (i === 0) box.classList.add("given");
    if (i === total - 1) box.classList.add("final");

    const header = document.createElement("div");
    header.className = "box-header";
    const numEl = document.createElement("span");
    numEl.className = "box-num";
    numEl.textContent = `Step ${i + 1}` + (i === 0 ? " · Topic Sentence" : i === total - 1 ? " · Final Result" : "");
    header.appendChild(numEl);
    box.appendChild(header);

    if (i === 0) {
      const text = document.createElement("div");
      text.className = "given-text";
      text.id = "topic-sentence-text";
      text.textContent = state.topicSentence || "Generating topic sentence… 正在生成主題句…";
      box.appendChild(text);
    } else if (i === total - 1) {
      const text = document.createElement("div");
      text.className = "final-text"; text.textContent = q.final_result;
      box.appendChild(text);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = `Write step ${i + 1} of the deduction chain in English…`;
      input.dataset.index = String(i);
      input.addEventListener("input", (e) => { state.chain[i] = e.target.value; });
      box.appendChild(input);

      const hintBtn = document.createElement("button");
      hintBtn.className = "hint-btn"; hintBtn.type = "button";
      hintBtn.textContent = "Hint 提示";
      hintBtn.addEventListener("click", () => requestHint(i, hintBtn, bubble));
      box.appendChild(hintBtn);

      const bubble = document.createElement("div");
      bubble.className = "hint-bubble";
      box.appendChild(bubble);
    }

    container.appendChild(box);
    // No directional arrow between boxes — vertical stacking already
    // implies flow, and a literal "↓" can be misread as "decreases".
  }
}

/* ensurePlannedChain — fire /plan-chain once and cache:
   - topic_sentence (Step II first box)
   - hints[]       (used by Hint buttons in middle boxes)
   Race-guarded so concurrent calls share one promise. */
function ensurePlannedChain() {
  if (state.topicSentence && state.plannedHints && state.plannedHints.length > 0) {
    return Promise.resolve();
  }
  if (state.planInFlight) return state.planInFlight;

  state.planInFlight = api("/plan-chain", {
    cause: state.question.cause,
    final_result: state.question.final_result,
    total_steps: CHAIN_LENGTH,
  }).then((res) => {
    state.plannedHints = Array.isArray(res.hints) ? res.hints : [];
    state.topicSentence = (res && res.topic_sentence) ? res.topic_sentence : state.question.cause;
    state.chain[0] = state.topicSentence;
    paintTopicSentence(state.topicSentence);
    state.planInFlight = null;
  }).catch(() => {
    // Fallback: use the raw question cause so the user can still proceed.
    state.topicSentence = state.question.cause;
    state.chain[0] = state.topicSentence;
    paintTopicSentence(state.topicSentence);
    state.planInFlight = null;
  });
  return state.planInFlight;
}

function paintTopicSentence(text) {
  const el = document.getElementById("topic-sentence-text");
  if (el) el.textContent = text;
}

async function requestHint(idx, btn, bubble) {
  btn.disabled = true; btn.textContent = "Loading…";
  try {
    // Wait for (or trigger) the shared plan call.
    await ensurePlannedChain();

    // hints[0] = step 2, hints[1] = step 3, hints[2] = step 4 (for CHAIN_LENGTH=5)
    let hint = state.plannedHints[idx - 1];

    // Fallback: per-step call if the planner didn't fill this slot
    if (!hint) {
      const priorContext = [];
      for (let i = 1; i < idx; i++) {
        const typed = (state.chain[i] || "").trim();
        if (typed) priorContext.push(typed);
        else if (state.hints[i]) priorContext.push(state.hints[i]);
      }
      const res = await api("/get-hint", {
        cause: state.question.cause,
        final_result: state.question.final_result,
        step_number: idx + 1,
        total_steps: CHAIN_LENGTH,
        previous_steps: priorContext,
      });
      hint = res.hint;
    }

    if (hint) {
      state.hints[idx] = hint;
      bubble.textContent = hint;
    } else {
      bubble.textContent = "（無法生成提示，請重試）";
    }
    bubble.classList.add("visible");
  } catch (err) {
    bubble.textContent = "（提示載入失敗，請稍後再試）";
    bubble.classList.add("visible");
  } finally {
    btn.disabled = false; btn.textContent = "Hint 提示";
  }
}

/* ------------------------------------------------------------------
 * Step 3 — Check Logic  (now also passes hints; renders flowchart)
 * ------------------------------------------------------------------ */
$("#btn-check-logic").addEventListener("click", async () => {
  const middleFilled = state.chain.slice(1, -1).every((s) => s && s.trim().length > 0);
  if (!middleFilled) {
    if (!confirm("Some steps are empty. Submit anyway?")) return;
  }

  gotoStep(3);
  $("#feedback-loading").classList.remove("hidden");
  $("#feedback-output").classList.add("hidden");

  try {
    const res = await api("/check-logic", {
      cause: state.question.cause,
      final_result: state.question.final_result,
      stance: state.question.stance,
      chain: state.chain,
      hints: state.hints,        // ← lets the AI know which Cantonese hints guided the student
    });
    state.feedback = res;

    $("#fb-logic").textContent = (res.logic_check || "").trim();
    $("#fb-language").textContent = (res.language_check || "").trim();
    renderFlowchart(res.corrected_chain);

    $("#feedback-loading").classList.add("hidden");
    $("#feedback-output").classList.remove("hidden");
  } catch (err) {
    $("#feedback-loading").classList.add("hidden");
    alert("Could not get feedback: " + err.message);
  }
});

function renderFlowchart(steps) {
  const container = $("#fb-flowchart");
  container.innerHTML = "";
  const list = Array.isArray(steps) && steps.length
    ? steps
    : [state.question.cause, "(no improved chain returned)", state.question.final_result];
  list.forEach((step, i) => {
    const box = document.createElement("div");
    box.className = "flow-box";
    if (i === 0) box.classList.add("is-cause");
    if (i === list.length - 1) box.classList.add("is-result");

    const num = document.createElement("span");
    num.className = "flow-num"; num.textContent = i + 1;
    box.appendChild(num);

    const txt = document.createElement("span");
    txt.className = "flow-text"; txt.textContent = step;
    box.appendChild(txt);

    container.appendChild(box);
    // No directional arrow — same rationale as the Step II chain.
  });
}

/* ------------------------------------------------------------------
 * Step 4 — Samples + vocabulary
 * ------------------------------------------------------------------ */
$("#btn-to-step-4").addEventListener("click", async () => {
  gotoStep(4);
  $("#samples-loading").classList.remove("hidden");
  $("#samples-output").classList.add("hidden");

  try {
    const res = await api("/generate-samples", {
      cause: state.question.cause,
      final_result: state.question.final_result,
      stance: state.question.stance,
      chain: state.chain,
    });
    state.samples = res;

    renderSample("sample-lv3", "vocab-lv3", res.lv3, res.lv3_vocab);
    renderSample("sample-lv5", "vocab-lv5", res.lv5, res.lv5_vocab);

    $("#samples-loading").classList.add("hidden");
    $("#samples-output").classList.remove("hidden");
  } catch (err) {
    $("#samples-loading").classList.add("hidden");
    alert("Could not generate samples: " + err.message);
  }
});

function renderSample(sampleId, vocabId, paragraph, vocab) {
  const sampleEl = $("#" + sampleId);
  const safeText = paragraph || "";

  // Highlight C1/C2 words inline (case-insensitive, whole-word).
  // Build a single regex from the vocab words for one-pass replacement.
  const words = (Array.isArray(vocab) ? vocab : [])
    .map((v) => v && v.word)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length); // longest first to avoid sub-matches

  if (words.length) {
    const escaped = words.map(escapeRegex);
    const re = new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");
    const translations = {};
    vocab.forEach((v) => { if (v && v.word) translations[v.word.toLowerCase()] = v.translation || ""; });

    // Build DOM safely: split into nodes, never set innerHTML with user text.
    sampleEl.textContent = "";
    let lastIndex = 0;
    let m;
    while ((m = re.exec(safeText)) !== null) {
      if (m.index > lastIndex) {
        sampleEl.appendChild(document.createTextNode(safeText.slice(lastIndex, m.index)));
      }
      const mark = document.createElement("mark");
      mark.className = "c-word";
      mark.textContent = m[0];
      const tr = translations[m[0].toLowerCase()] || "";
      if (tr) mark.title = tr;
      sampleEl.appendChild(mark);
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < safeText.length) {
      sampleEl.appendChild(document.createTextNode(safeText.slice(lastIndex)));
    }
  } else {
    sampleEl.textContent = safeText;
  }

  // Render glossary list
  const ul = $("#" + vocabId);
  ul.innerHTML = "";
  if (!Array.isArray(vocab) || vocab.length === 0) {
    const li = document.createElement("li");
    li.className = "vocab-empty";
    li.textContent = "(No advanced vocabulary detected.)";
    ul.appendChild(li);
    return;
  }
  vocab.forEach((v) => {
    if (!v || !v.word) return;
    const li = document.createElement("li");
    const w = document.createElement("span"); w.className = "vw"; w.textContent = v.word;
    const t = document.createElement("span"); t.className = "vt"; t.textContent = v.translation || "";
    li.appendChild(w); li.appendChild(t);
    ul.appendChild(li);
  });
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/* ---------- Copy-to-clipboard ---------- */
document.addEventListener("click", (e) => {
  if (!e.target.matches(".copy-btn")) return;
  const targetId = e.target.dataset.target;
  const txt = $("#" + targetId).textContent;
  navigator.clipboard.writeText(txt).then(() => {
    const orig = e.target.textContent;
    e.target.textContent = "Copied ✓";
    setTimeout(() => (e.target.textContent = orig), 1500);
  });
});

/* ---------- Restart ---------- */
$("#btn-restart").addEventListener("click", () => {
  state.question = null;
  state.chain = []; state.hints = []; state.plannedHints = []; state.topicSentence = null; state.planInFlight = null;
  state.feedback = null; state.samples = null;
  $("#question-output").classList.add("hidden");
  $$("#axis-group .chip, #stance-group .chip").forEach((c) => c.classList.remove("selected"));
  state.axis = null; state.stance = null;
  refreshGenerateButton();
  gotoStep(1);
});

/* ------------------------------------------------------------------
 * API helper
 * ------------------------------------------------------------------ */
async function api(path, body) {
  const res = await fetch(WORKER_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${txt.slice(0, 120)}`);
  }
  return res.json();
}
