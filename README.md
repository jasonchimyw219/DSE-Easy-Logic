# Easy Logic 易邏輯

A **free** web platform that helps Hong Kong DSE students practise the logical
deduction chain (因 → 果) used in one-sided argumentative essays.

- **Frontend:** plain HTML / CSS / vanilla JS — no build step.
- **AI:** Cloudflare Workers AI (free tier, ~10,000 neurons/day).
- **Backend:** a single Cloudflare Worker that proxies four endpoints to the AI.
- **Hosting:** Cloudflare Pages (frontend) + Cloudflare Workers (AI proxy).
- **No database. No user accounts. Fully stateless.**

---

## What the platform does

1. **Step I — Generate a Question.** Student picks one of 5 DSE axes and a
   stance (PRO / CON). The Worker calls the AI to generate a realistic DSE
   prompt (cause + task + final-result label).
2. **Step II — Build the Logic Chain.** Five linked boxes (given cause → 3
   editable middle steps → final result). A **Hint 提示** button on each
   blank box returns a short Cantonese phrase the student must translate
   into English.
3. **Step III — AI Check.** The Worker evaluates the full chain in three
   sections: logic check, language & grammar, and an improved topic
   sentence using the formula *[Cause] → [mechanism] → [Final Result]*.
4. **Step IV — Model Answers.** Two AI-generated paragraphs, both written
   as letters to the editor: a **Lv 3** (competent but limited) and a
   **Lv 5\*\*** (sophisticated, 4–5 step chain, counter-argument + rebuttal,
   formal tone).

---

## File structure

```
.
├── index.html        # Main UI — all four steps
├── style.css         # Minimal navy / white styling
├── app.js            # Frontend logic + fetch calls
├── worker.js         # Cloudflare Worker (AI proxy, 4 endpoints)
├── wrangler.toml     # Cloudflare Workers config (AI binding)
└── README.md         # This file
```

---

## 1. Deploy the Worker (one-time)

```bash
# 1. Install Wrangler CLI globally
npm install -g wrangler

# 2. Authenticate with your Cloudflare account
wrangler login

# 3. Deploy the worker (wrangler.toml is already configured)
wrangler deploy
```

After deploy, Wrangler prints the Worker URL, e.g.

```
https://easy-logic-worker.<your-subdomain>.workers.dev
```

Copy it — you'll need it in step 3.

**Sanity check:** open the Worker URL in a browser. You should see:

```json
{ "ok": true, "service": "easy-logic-worker" }
```

---

## 2. Push the frontend to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/easy-logic.git
git push -u origin main
```

---

## 3. Wire the frontend to the Worker

Open `app.js` and replace the placeholder at the top:

```js
const WORKER_URL = window.WORKER_URL || "https://easy-logic-worker.YOUR-SUBDOMAIN.workers.dev";
```

Replace `YOUR-SUBDOMAIN` with the value Wrangler gave you, then commit & push.

> 💡 If you'd rather inject it at deploy time, add a small `<script>` tag to
> `index.html` before `app.js` that defines `window.WORKER_URL`, and set the
> value via a Cloudflare Pages environment variable + a build step.

---

## 4. Deploy the frontend to Cloudflare Pages

1. Go to **Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect
   to Git** and pick your `easy-logic` repo.
2. **Framework preset:** *None*.
3. **Build command:** *(leave empty)*.
4. **Build output directory:** `/` (the repo root).
5. Click **Save and Deploy**.

Cloudflare Pages will publish at:

```
https://easy-logic.pages.dev
```

That's it — the site is live, free, and uses zero paid APIs.

---

## Free-tier limits

| Service             | Free-tier limit                       |
|---------------------|---------------------------------------|
| Cloudflare Pages    | 500 builds / month, unlimited requests |
| Cloudflare Workers  | 100,000 requests / day                |
| Workers AI          | ~10,000 neurons / day                 |

Each user session uses roughly **4–8 AI calls** (1 question + a few hints + 1
logic check + 1 sample-pair). The `max_tokens` cap of 400–600 in `worker.js`
keeps neuron usage low.

---

## Customising the model

`worker.js` defaults to:

```js
const MODEL = "@cf/meta/llama-3-8b-instruct";
```

If that isn't available on your account, switch to the Mistral fallback that's
already commented in the file:

```js
const MODEL = "@cf/mistral/mistral-7b-instruct-v0.1";
```

---

## Security notes

- The Cloudflare account / API token is **never** exposed to the browser —
  the Worker uses the AI binding, which authenticates itself.
- `ALLOWED_ORIGIN` in `worker.js` is set to `"*"` for convenience. Tighten
  it to your Pages URL before going to production.

---

## Licence

MIT. Free for DSE students, teachers, and tutors to use, fork, and modify.
