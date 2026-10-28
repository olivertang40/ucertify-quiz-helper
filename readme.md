# ucertify-quiz-helper

Tampermonkey userscript for saved quiz answers, optional AI explanations, and Java compiler-error hints. AI suggestions may be incorrect. Only use content you are permitted to share.

## Install

Install [Tampermonkey](https://www.tampermonkey.net/), then the [userscript](https://github.com/olivertang40/ucertify-quiz-helper/raw/refs/heads/main/helper.user.js). Configure credentials only in your local Tampermonkey copy, never in the repository copy.

## Copilot Setup

1. Install Node.js 22.12+ and [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started). Sign in locally with `copilot login`.
2. Run `npm ci`, then `npm run bridge`. Keep the bridge running.
3. Copy the generated `.copilot-bridge.json` token into `COPILOT_BRIDGE_TOKEN` in your Tampermonkey copy. This is a local bridge secret, not a GitHub credential.
4. Keep `AI_PROVIDER = "copilot"`. Run `npm run models` to check available model IDs and set `COPILOT_MODEL` accordingly. Model access and usage limits depend on your account.
5. Save the script, allow its connection to `127.0.0.1`, and reload the quiz page.

The bridge is local-only at `127.0.0.1:37371`. If the port is occupied, set `QUIZ_HELPER_PORT` and update `COPILOT_BRIDGE_URL` to match. Do not expose it on your network. Restart the bridge after code updates.

## Gemini Setup

In your Tampermonkey copy, set `AI_PROVIDER = "gemini"`, enter your [API key](https://aistudio.google.com/app/apikey) in `GEMINI_API_KEY`, and choose a `GEMINI_MODEL` available to your API project. No bridge is needed. Quota errors pause requests; failures never switch providers automatically.

## Answers And Hints

The script checks [db.js](./db.js) before requesting AI answers. Successful AI replies are reused in memory until the page reloads. New questions and choices are sent to the configured provider.

AI explanations appear below the question. On Java lab pages, compiler-error hints appear in a separate panel. Compiler output may contain source lines or file paths; only share content you are permitted to send to your provider. Set `LAB_HINTS = false` to disable hints.

Console messages omit question text, answer choices, and raw provider error messages.

## Tests

```sh
npm ci
npm test
```

Tests use simulated providers and local HTTP; no credentials or live AI requests are required.

## Privacy

Never commit API keys, GitHub credentials, local bridge configuration, or personal question banks. Review questions, choices, compiler output, and any screenshots for personal information before sharing. If a credential was exposed, revoke or rotate it; deleting it from the latest commit does not erase Git history or existing copies.
