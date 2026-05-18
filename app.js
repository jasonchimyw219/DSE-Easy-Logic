/* =========================================================
   Easy Logic — Frontend Controller
   Vanilla JS. No frameworks.
   ========================================================= */

const WORKER_URL = (window.WORKER_URL || "https://easy-logic-worker.jasonchimyw.workers.dev")
  .replace(/\/+$/, ""); // strip trailing slash defensively

const CHAIN_LENGTH = 5;   // total boxes including given cause and final result

/* ---------- State ---------- */
const state = {
  axis: null,
  stance: null,
  question: null,       // { cause, task, final_result, stance }
  chain: [],            // student-typed steps (strings)
  hints: [],            // hints already shown (so AI doesn't repeat them)
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
  $("#btn-generate-question").disabled = !(state.axis && state.stance);
}

/* ------------------------------------------------------------------
 * Step 1 — Generate Question
 * ------------------------------------------------------------------ */
$("#btn-generate-question").addEventListener("click", async () => {
  const btn = $("#btn-generate-question");
  btn.disabled = true;
  btn.textContent = "Generating…";

  try {
    const res = await api("/generate-question", {
      axis: state.axis,
      stance: state.stance,
    });
    state.question = res;

    $("#q-cause").textContent = res.cause;
    $("#q-task").textContent = res.task;
    $("#q-final-result").textContent = res.final_result;
    $("#question-output").classList.remove("hidden");
  } catch (err) {
    alert("Could not generate a question: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate Question";
  }
});

$("#btn-to-step-2").addEventListener("click", () => {
  buildChainUI();
  gotoStep(2);
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
  state.chain[0] = q.cause;
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
    numEl.textContent = `Step ${i + 1}` + (i === 0 ? " · Given Cause" : i === total - 1 ? " · Final Result" : "");
    header.appendChild(numEl);
    box.appendChild(header);

    if (i === 0) {
      const text = document.createElement("div");
      text.className = "given-text";
      text.textContent = q.cause;
      box.appendChild(text);
    } else if (i === total - 1) {
      const text = document.createElement("div");
      text.className = "final-text";
      text.textContent = `↓ ${q.final_result}`;
      box.appendChild(text);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = `Write step ${i + 1} of the deduction chain in English…`;
      input.dataset.index = String(i);
      input.addEventListener("input", (e) => {
        state.chain[i] = e.target.value;
      });
      box.appendChild(input);

      const hintBtn = document.createElement("button");
      hintBtn.className = "hint-btn";
      hintBtn.type = "button";
      hintBtn.textContent = "Hint 提示";
      hintBtn.addEventListener("click", () => requestHint(i, hintBtn, bubble));
      box.appendChild(hintBtn);

      const bubble = document.createElement("div");
      bubble.className = "hint-bubble";
      box.appendChild(bubble);
    }

    container.appendChild(box);

    if (i < total - 1) {
      const arrow = document.createElement("div");
      arrow.className = "chain-arrow";
      arrow.textContent = "↓";
      container.appendChild(arrow);
    }
  }
}

async function requestHint(idx, btn, bubble) {
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    // Build "previous_steps": prefer user-typed text; fall back to the hint
    // we showed them for that box (so the AI does not repeat itself).
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
    state.hints[idx] = res.hint;
    bubble.textContent = res.hint;
    bubble.classList.add("visible");
  } catch (err) {
    bubble.textContent = "（提示載入失敗，請稍後再試）";
    bubble.classList.add("visible");
  } finally {
    btn.disabled = false;
    btn.textContent = "Hint 提示";
  }
}

/* ------------------------------------------------------------------
 * Step 3 — Check Logic
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
    });
    state.feedback = res;

    renderFeedbackSection("#fb-logic", res.logic_check);
    renderFeedbackSection("#fb-language", res.language_check);
    renderFeedbackSection("#fb-topic", res.topic_sentence);

    $("#feedback-loading").classList.add("hidden");
    $("#feedback-output").classList.remove("hidden");
  } catch (err) {
    $("#feedback-loading").classList.add("hidden");
    alert("Could not get feedback: " + err.message);
  }
});

function renderFeedbackSection(selector, text) {
  $(selector).textContent = (text || "").trim();
}

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
    $("#sample-lv3").textContent = res.lv3;
    $("#sample-lv5").textContent = res.lv5;

    $("#samples-loading").classList.add("hidden");
    $("#samples-output").classList.remove("hidden");
  } catch (err) {
    $("#samples-loading").classList.add("hidden");
    alert("Could not generate samples: " + err.message);
  }
});

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
  state.chain = [];
  state.hints = [];
  state.feedback = null;
  state.samples = null;
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
