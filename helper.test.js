const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "helper.user.js"), "utf8");
const TEST_API_KEY = "test-api-key";

async function runScript({
  data,
  status = 200,
  quiz = {},
  apiKey = TEST_API_KEY,
  provider = "gemini",
  bridgeError = false,
  timeout = false,
  invalidJson = false,
}) {
  const requests = [];
  const errors = [];
  const logs = [];
  const options = ["4", "3", "2", "1"].map((innerText) => ({
    innerText,
    style: {},
  }));
  const loadHandlers = [];
  const timers = [];
  const timeouts = [];
  let now = Date.now();
  const context = {
    console: {
      log: (...args) => logs.push(args.join(" ")),
      error: (...args) => errors.push(args.join(" ")),
    },
    document: {
      body: {},
      querySelector: () => ({ innerText: "Test question" }),
      querySelectorAll: () => options,
    },
    window: {
      addEventListener: (event, handler) => loadHandlers.push(handler),
    },
    MutationObserver: class {
      observe() {}
    },
    unsafeWindow: {},
    quiz,
    Date: { now: () => now },
    AbortSignal: {
      timeout: (duration) => {
        timeouts.push(duration);
        return AbortSignal.timeout(duration);
      },
    },
    setTimeout: (callback) => timers.push(callback),
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: status < 400, status, json: async () => data };
    },
    GM_xmlhttpRequest: (init) => {
      requests.push({ url: init.url, init });
      if (bridgeError) return init.onerror();
      if (timeout) return init.ontimeout();
      init.onload({
        status,
        responseText: invalidJson ? "not json" : JSON.stringify(data),
      });
    },
  };
  const configuredSource = source
    .replace('"MY_API_KEY"', JSON.stringify(apiKey))
    .replace(
      'const AI_PROVIDER = "gemini"',
      `const AI_PROVIDER = "${provider}"`,
    )
    .replace('const COPILOT_MODEL = ""', 'const COPILOT_MODEL = "test-model"')
    .replace(
      'const COPILOT_BRIDGE_TOKEN = ""',
      'const COPILOT_BRIDGE_TOKEN = "local-token"',
    );
  vm.runInNewContext(configuredSource, context);
  loadHandlers.forEach((handler) => handler());
  for (const callback of timers) await callback();
  return {
    requests,
    errors,
    logs,
    options,
    timeouts,
    advanceTime: (milliseconds) => {
      now += milliseconds;
    },
    runAgain: () => timers[0](),
  };
}

function answerData(parts = [{ text: "4\n1" }]) {
  return { candidates: [{ content: { parts } }] };
}

test("fallback requests the supported Gemini model", async () => {
  const { requests } = await runScript({ data: answerData() });
  assert.equal(
    requests[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
  );
});

test("API key is sent in a header, not the request URL", async () => {
  const { requests } = await runScript({ data: answerData() });
  assert.equal(requests[0].init.headers["x-goog-api-key"], TEST_API_KEY);
  assert.equal(requests[0].url.includes(TEST_API_KEY), false);
});

test("generation settings are included in the JSON body", async () => {
  const { requests } = await runScript({ data: answerData() });
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.generationConfig.temperature, 0);
  assert.match(body.contents[0].parts[0].text, /Test question/);
  assert.match(body.contents[0].parts[0].text, /4\n3\n2\n1/);
});

test("Gemini request has a bounded timeout", async () => {
  const { requests, timeouts } = await runScript({ data: answerData() });
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.deepEqual(timeouts, [30000]);
});

test("AI answers still highlight exact matching options", async () => {
  const { options } = await runScript({ data: answerData() });
  assert.deepEqual(
    options.map((option) => option.style.backgroundColor),
    ["#00ff00", undefined, undefined, "#00ff00"],
  );
});

test("response text parts are combined and thought parts are excluded", async () => {
  const { options } = await runScript({
    data: answerData([
      { thought: true, text: "3\n" },
      { text: "4\n" },
      { text: "1" },
    ]),
  });
  assert.deepEqual(
    options.map((option) => option.style.backgroundColor),
    ["#00ff00", undefined, undefined, "#00ff00"],
  );
});

test("model rejection logs HTTP status and API explanation without highlighting", async () => {
  const { errors, options } = await runScript({
    status: 404,
    data: { error: { message: "Model no longer available." } },
  });
  assert.match(errors.join("\n"), /404.*Model no longer available/);
  assert.ok(options.every((option) => !option.style.backgroundColor));
});

test("blocked responses give an explicit error instead of a TypeError", async () => {
  const { errors } = await runScript({
    data: { promptFeedback: { blockReason: "SAFETY" } },
  });
  assert.match(errors.join("\n"), /no answer text.*SAFETY/);
  assert.doesNotMatch(errors.join("\n"), /TypeError/);
});

test("missing API key does not make a network request", async () => {
  const { requests, errors } = await runScript({ apiKey: "MY_API_KEY" });
  assert.equal(requests.length, 0);
  assert.match(errors.join("\n"), /API Key/);
});

test("database matches keep working without Gemini", async () => {
  const { requests, options } = await runScript({
    quiz: { "Test question": ["2"] },
  });
  assert.equal(requests.length, 0);
  assert.equal(options[2].style.backgroundColor, "#00ff00");
});

test("Copilot provider uses the authenticated local bridge and configured model", async () => {
  const { requests, options } = await runScript({
    provider: "copilot",
    data: { answers: ["4", "1"] },
  });
  assert.equal(requests[0].url, "http://127.0.0.1:37371/answer");
  assert.equal(requests[0].init.headers.Authorization, "Bearer local-token");
  assert.equal(JSON.parse(requests[0].init.data).model, "test-model");
  assert.equal(options[0].style.backgroundColor, "#00ff00");
  assert.equal(options[3].style.backgroundColor, "#00ff00");
});

for (const [scenario, settings, message] of [
  ["offline", { bridgeError: true }, /Cannot reach Copilot bridge/],
  ["timeout", { timeout: true }, /timed out/],
  ["invalid JSON", { invalidJson: true }, /invalid JSON/],
  [
    "quota rejection",
    { status: 429, data: { error: "Plan limit reached." } },
    /429.*Plan limit/,
  ],
  ["invalid answers", { data: { answers: [123] } }, /invalid answer options/],
]) {
  test(`Copilot ${scenario} is reported without silently switching providers`, async () => {
    const { requests, errors, options } = await runScript({
      provider: "copilot",
      data: { answers: ["4"] },
      ...settings,
    });
    assert.match(errors.join("\n"), message);
    assert.equal(requests.length, 1);
    assert.ok(options.every((option) => !option.style.backgroundColor));
  });
}

test("successful AI answers are reused without spending more quota", async () => {
  const result = await runScript({ data: answerData() });
  await result.runAgain();
  assert.equal(result.requests.length, 1);
});

test("concurrent question events do not send duplicate AI requests", async () => {
  const result = await runScript({ data: answerData() });
  // Use a new question so this exercises in-flight deduplication, not the cache.
  result.options[0].innerText = "5";
  await Promise.all([result.runAgain(), result.runAgain()]);
  assert.equal(result.requests.length, 2);
});

test("a duplicate question event waits for the shared answer instead of reporting no answer", async () => {
  const result = await runScript({ data: answerData() });
  result.options[0].innerText = "5";
  result.logs.length = 0;
  await Promise.all([result.runAgain(), result.runAgain()]);
  assert.doesNotMatch(result.logs.join("\n"), /no answer from ai/);
});

test("Gemini quota errors pause further requests instead of retrying immediately", async () => {
  const result = await runScript({
    status: 429,
    data: { error: { message: "Quota exceeded." } },
  });
  await result.runAgain();
  assert.equal(result.requests.length, 1);
  assert.match(result.errors.join("\n"), /quota cooldown/);
  result.advanceTime(59999);
  await result.runAgain();
  assert.equal(result.requests.length, 1);
  result.advanceTime(1);
  await result.runAgain();
  assert.equal(result.requests.length, 2);
});
