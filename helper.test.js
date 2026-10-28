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
  beforeResponse = () => {},
  compilerOutput = "",
  optionTexts = ["4", "3", "2", "1"],
}) {
  const requests = [];
  const errors = [];
  const logs = [];
  const page = { panel: null, position: null, hint: null };
  const questionElement = {
    innerText: "Test question",
    insertAdjacentElement: (position, element) => {
      page.position = position;
      page.panel = element;
    },
  };
  const output = { tagName: "DIV", innerText: compilerOutput };
  const body = {
    children: [output],
    append(element) {
      this.children.push(element);
      page.hint = element;
    },
  };
  const createElement = (tagName) => ({
    tagName: tagName.toUpperCase(),
    style: {},
    textContent: "",
    children: [],
    listeners: {},
    append(...children) {
      this.children.push(...children);
    },
    setAttribute() {},
    addEventListener(event, handler) {
      this.listeners[event] = handler;
    },
    remove() {
      if (page.panel === this) page.panel = null;
      if (page.hint === this) page.hint = null;
      body.children = body.children.filter((child) => child !== this);
    },
  });
  const options = optionTexts.map((innerText) => ({
    innerText,
    style: {},
  }));
  const loadHandlers = [];
  const observers = [];
  const timers = [];
  const timeouts = [];
  let now = Date.now();
  const context = {
    console: {
      log: (...args) => logs.push(args.join(" ")),
      error: (...args) => errors.push(args.join(" ")),
    },
    document: {
      body,
      querySelector: () => questionElement,
      querySelectorAll: () => options,
      getElementById: (id) =>
        [page.panel, page.hint].find((element) => element?.id === id) ?? null,
      createElement,
    },
    window: {
      addEventListener: (event, handler) => loadHandlers.push(handler),
    },
    MutationObserver: class {
      constructor(callback) {
        observers.push(callback);
      }
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
    clearTimeout: () => {},
    fetch: async (url, init) => {
      requests.push({ url, init });
      beforeResponse({ questionElement, output });
      return { ok: status < 400, status, json: async () => data };
    },
    GM_xmlhttpRequest: (init) => {
      requests.push({ url: init.url, init });
      beforeResponse({ questionElement, output });
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
      'const AI_PROVIDER = "copilot"',
      `const AI_PROVIDER = "${provider}"`,
    )
    .replace(
      'const COPILOT_MODEL = "auto"',
      'const COPILOT_MODEL = "test-model"',
    )
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
    page,
    questionElement,
    output,
    timeouts,
    advanceTime: (milliseconds) => {
      now += milliseconds;
    },
    runAgain: () => timers[0](),
    // Simulates a DOM change, then runs the debounced work it scheduled.
    mutate: async () => {
      const scheduled = timers.length;
      observers[0]([]);
      for (const callback of timers.slice(scheduled)) await callback();
    },
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

test("model rejection logs HTTP status without echoing provider content", async () => {
  const providerMessage = "Private request detail: " + TEST_API_KEY;
  const { errors, options } = await runScript({
    status: 404,
    data: { error: { message: providerMessage } },
  });
  assert.match(errors.join("\n"), /HTTP 404/);
  assert.equal(errors.join("\n").includes(providerMessage), false);
  assert.equal(errors.join("\n").includes(TEST_API_KEY), false);
  assert.ok(options.every((option) => !option.style.backgroundColor));
});

test("question text and answer choices are not written to the console", async () => {
  const optionTexts = ["Private choice one", "Private choice two"];
  const result = await runScript({
    optionTexts,
    data: answerData([{ text: optionTexts[0] }]),
  });
  const output = [...result.logs, ...result.errors].join("\n");
  assert.equal(output.includes(result.questionElement.innerText), false);
  for (const option of optionTexts)
    assert.equal(output.includes(option), false);
  assert.equal(result.options[0].style.backgroundColor, "#00ff00");
});

test("bridge error content is not written to the console", async () => {
  const privateMessage = "Private bridge request detail";
  const { errors } = await runScript({
    provider: "copilot",
    status: 502,
    data: { error: privateMessage },
  });
  assert.match(errors.join("\n"), /HTTP 502/);
  assert.equal(errors.join("\n").includes(privateMessage), false);
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
    /HTTP 429/,
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

function explanationText(panel) {
  return panel?.children[1]?.textContent;
}

test("prompt asks for an explanation after the answer lines", async () => {
  const { requests } = await runScript({ data: answerData() });
  const body = JSON.parse(requests[0].init.body);
  assert.match(body.contents[0].parts[0].text, /EXPLANATION:/);
});

test("Gemini explanation is shown below the question, not used as an answer", async () => {
  const { options, page } = await runScript({
    data: answerData([{ text: "4\nEXPLANATION:\nb++ prints 4 first." }]),
  });
  assert.equal(options[0].style.backgroundColor, "#00ff00");
  assert.equal(page.position, "afterend");
  assert.equal(explanationText(page.panel), "b++ prints 4 first.");
});

test("Copilot explanation is shown as plain text", async () => {
  const { page } = await runScript({
    provider: "copilot",
    data: { answers: ["4"], explanation: "<b>4</b> is printed first." },
  });
  assert.equal(explanationText(page.panel), "<b>4</b> is printed first.");
});

test("answers without an explanation show no panel", async () => {
  const { page } = await runScript({ data: answerData() });
  assert.equal(page.panel, null);
});

test("the previous explanation is removed when the next question has none", async () => {
  const quiz = {};
  const result = await runScript({
    data: answerData([{ text: "4\nEXPLANATION: first question." }]),
    quiz,
  });
  assert.ok(result.page.panel);
  quiz["Second question"] = ["2"];
  result.questionElement.innerText = "Second question";
  await result.runAgain();
  assert.equal(result.page.panel, null);
});

test("a late answer for a previous question is not shown on the new question", async () => {
  const { options, page, logs } = await runScript({
    data: answerData([{ text: "4\nEXPLANATION: stale." }]),
    beforeResponse: ({ questionElement }) => {
      questionElement.innerText = "A different question";
    },
  });
  assert.ok(options.every((option) => !option.style.backgroundColor));
  assert.equal(page.panel, null);
  assert.match(logs.join("\n"), /question changed/);
});

const LAB_ERRORS =
  "user_workspace/Opr.java:7: error: ';' expected\n        int d  a % b;\n             ^\n1 error";
// A database match keeps quiz answering from making requests in lab tests.
const LAB = { quiz: { "Test question": ["2"] }, compilerOutput: LAB_ERRORS };

function hintText(panel) {
  return panel?.children[2]?.textContent;
}

test("lab compiler errors ask the Copilot bridge for a hint with only the compiler output", async () => {
  const result = await runScript({
    ...LAB,
    provider: "copilot",
    data: { hint: "Line 7 declares d but never assigns a value." },
  });
  await result.mutate();
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].url, "http://127.0.0.1:37371/hint");
  assert.deepEqual(JSON.parse(result.requests[0].init.data), {
    errors: LAB_ERRORS,
    model: "test-model",
  });
  assert.equal(
    hintText(result.page.hint),
    "Line 7 declares d but never assigns a value.",
  );
});

test("Gemini lab hints use tutor instructions and never show code blocks", async () => {
  const result = await runScript({
    ...LAB,
    data: answerData([
      { text: "Line 7 is missing an operator.\n```java\nint d = a % b;\n```" },
    ]),
  });
  await result.mutate();
  const prompt = JSON.parse(result.requests[0].init.body).contents[0].parts[0]
    .text;
  assert.match(prompt, /do not write corrected code/);
  assert.match(prompt, /Opr\.java:7: error/);
  assert.equal(hintText(result.page.hint), "Line 7 is missing an operator.");
});

test("lab pages without compiler errors make no hint request", async () => {
  const result = await runScript({
    ...LAB,
    compilerOutput: "Quotient: 1\nRemainder: 3",
    provider: "copilot",
    data: { hint: "unused" },
  });
  await result.mutate();
  assert.equal(result.requests.length, 0);
  assert.equal(result.page.hint, null);
});

test("repeated DOM changes with the same errors request one hint", async () => {
  const result = await runScript({
    ...LAB,
    provider: "copilot",
    data: { hint: "Check line 7." },
  });
  await result.mutate();
  await result.mutate();
  assert.equal(result.requests.length, 1);
  assert.ok(result.page.hint);
});

test("a successful run clears the hint, even if the hint quotes compiler text", async () => {
  const result = await runScript({
    ...LAB,
    provider: "copilot",
    data: { hint: "Opr.java:7: error: means a token is missing.\n1 error" },
  });
  await result.mutate();
  assert.ok(result.page.hint);
  result.output.innerText = "Quotient: 1\nRemainder: 3";
  await result.mutate();
  assert.equal(result.page.hint, null);
});

test("a hint for compiler output that has since changed is discarded", async () => {
  const result = await runScript({
    ...LAB,
    provider: "copilot",
    data: { hint: "stale" },
    beforeResponse: ({ output }) => {
      output.innerText = "Quotient: 1";
    },
  });
  await result.mutate();
  assert.equal(result.page.hint, null);
  assert.match(result.logs.join("\n"), /compiler output changed/);
});

test("the hint panel can be closed", async () => {
  const result = await runScript({
    ...LAB,
    provider: "copilot",
    data: { hint: "Check line 7." },
  });
  await result.mutate();
  result.page.hint.children[0].listeners.click();
  assert.equal(result.page.hint, null);
});

test("question pages without answer options do not spend AI quota", async () => {
  const { requests } = await runScript({ data: answerData(), optionTexts: [] });
  assert.equal(requests.length, 0);
});
