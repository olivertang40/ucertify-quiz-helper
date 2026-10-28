# [gemini](https://gemini.google/overview/gemini-in-chrome/)

![gemini](./pic/gemini.png)

# [dead] ucertify-quiz-helper

[ucertify](https://docs.google.com/document/d/1EChf2k3wRUR1emCSNFwIyPv4wkFgdsQQMx4_BbEeIe8/edit?usp=sharing)
![demo](./pic/demo.png)

## run

- install [tampermonkey](https://www.tampermonkey.net/)
- install [script](https://github.com/olivertang40/ucertify-quiz-helper/raw/refs/heads/main/helper.user.js)
- set [gemini api key](https://aistudio.google.com/app/apikey) in script
  ![dashboard](./pic/dashboard.png)
  ![edit](./pic/edit.png)
  ![key](./pic/key.png)
- check browser console
  ![console](./pic/console.png)

### Gemini troubleshooting

- Version 3.2.0 uses `gemini-3.8-flash` instead of `gemini-2.5-flash`, which is unavailable to new users.
- For an existing installation, replace the script in the Tampermonkey editor with the updated [helper.user.js](./helper.user.js), re-enter your API key, save, and reload the quiz tab. Installing an older upstream copy will not include this fix.
- The model is configured by `GEMINI_MODEL` near the top of the script. Use a model available to your API project that supports `generateContent`.
- Requests time out after 30 seconds. API failures log the model, HTTP status, and server explanation; blocked or empty responses log a reason and do not highlight answers.
- API keys are sent in the `x-goog-api-key` header rather than the URL. If you shared console logs containing a key, revoke or rotate it in [AI Studio](https://aistudio.google.com/app/apikey) and update the script. Do not share keys or commit them.

### Use your Copilot subscription instead

GitHub Copilot is not a browser API that accepts a GitHub auth code. This script uses the official Copilot SDK through a local service; GitHub credentials stay in the CLI's authentication store, not in Chrome.

1. Install Node.js 22.12 or newer and [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started). Sign in locally with `copilot login`. Never paste a GitHub token or device authorization code into the userscript or a chat.
2. In this repository, run `npm ci`, then `npm run bridge`. Keep that terminal running while you use the script.
3. In another terminal, run `npm run models`. This lists the models enabled for your signed-in account and their billing multipliers when reported by Copilot. Choose an exact model ID from that list. A lower multiplier is cheaper relative to the base rate; it is not a promise of unlimited or free usage. Model access and quotas depend on your plan and organization policy.
4. Open the generated local [.copilot-bridge.json](./.copilot-bridge.json) and copy its `token` value into `COPILOT_BRIDGE_TOKEN` in your Tampermonkey copy of [helper.user.js](./helper.user.js). This is a separate, local bridge secret, not a GitHub credential. The generated file is ignored by Git; do not share or commit it.
5. The script defaults to `AI_PROVIDER = "copilot"` and `COPILOT_MODEL = "auto"`, which lets Copilot pick an available model. Replace `"auto"` with an exact ID if you prefer a specific model. Leaving `COPILOT_MODEL` blank disables Copilot requests. Save the script, accept Tampermonkey's permission to connect to `127.0.0.1`, and reload the quiz tab. Install the complete updated script so its new `@grant` and `@connect` metadata are included.

If model discovery reports no enabled models, run `copilot login` locally and check your Copilot subscription and organization policy, then restart the bridge. A successful GitHub CLI sign-in alone does not establish that Copilot inference or a particular model is available. The bridge will not invent model IDs or silently choose a billed model.

The bridge listens only on `127.0.0.1:37371`, requires the local secret, rejects browser origins, limits payload size, and allows one answer request at a time. Quiz sessions have tools, skills, repository configuration discovery, file hooks, and shared session-store access disabled. Temporary Copilot sessions are deleted after each answer attempt. Question text and options are sent to the selected provider; only use this with content you are permitted to share.

If that port is in use, set `QUIZ_HELPER_PORT` to a free port before starting the bridge and running `npm run models`, and update `COPILOT_BRIDGE_URL` in the userscript to match. Do not expose the bridge on your network. Stop it with Ctrl+C when finished.

### Quotas and provider selection

- Copilot is the default provider. Set `AI_PROVIDER = "gemini"` to use Gemini instead; failures never silently switch providers or spend another provider's quota.
- The database is checked first. Successful AI answers are cached in memory for up to 100 question/option combinations until the page reloads, and duplicate concurrent requests for the same question are suppressed.
- Gemini HTTP 429 responses trigger a 60-second cooldown without automatic retries. If the daily free-tier quota is exhausted, wait for the provider's quota reset or manually switch to Copilot. This does not bypass billing or rate limits.
- Copilot requests use your subscription's applicable allowances. There is no assumption that a model visible in VS Code is also enabled for the CLI; use `npm run models` to check.
- [GitHub Models was retired on July 30, 2026](https://docs.github.com/en/github-models). It is not a substitute inference API for your Copilot subscription.

### Explanations

AI answers (Gemini or Copilot) include a short explanation of why the highlighted options are correct, shown in a blue panel below the question. Database matches have no explanation. The panel is cleared when the question changes, and an answer that arrives after you've moved on is discarded. After updating, restart the bridge (`npm run bridge`) so it returns explanations.

### Lab hints

On Java lab pages, when **Run Code** prints `javac` errors, an orange panel in the bottom-right corner explains what each error means and which concept to review. It never writes the fix or the solution: the AI is instructed not to, and any code blocks in its reply are removed. Only the compiler output (which quotes the offending lines) is sent, not your whole program. Close the panel with `×`; it reappears only when the compiler output changes.

Set `LAB_HINTS = false` in the userscript to turn this off (useful with Gemini's free-tier quota). After updating, restart the bridge (`npm run bridge`) so it serves the new `/hint` endpoint.

### tests

With Node.js 22.12 or newer, run `npm ci`, then `npm test`. Tests exercise the userscript with simulated browser elements and provider responses, and the bridge over local HTTP. No credentials or live inference requests are needed.

### chrome

turn on developer mode

go to [chrome://extensions/](chrome://extensions/)
![chrome](./pic/chrome.png)

### help

thx jackwww232-hash for db patch pipeline

to help patch db, in result

```
getAll()
```

![help-0](./pic/help-0.png)

```
console.log(JSON.stringify(patch, null, 2))
```

![help-1](./pic/help-1.png)
