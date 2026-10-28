const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const { test } = require("node:test");
const { createBridgeServer } = require("./bridge");

const TOKEN = "test-local-bridge-token";
const QUESTION = {
  model: "test-model",
  question: "Test question",
  options: ["4", "1"],
};

async function startBridge(
  t,
  { text = "4\n1", fail = false, models, wait } = {},
) {
  const sessions = [];
  const deleted = [];
  const logs = [];
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const client = {
    listModels: async () =>
      models || [
        { id: "test-model", name: "Test", billing: { multiplier: 1 } },
      ],
    createSession: async (config) => {
      sessions.push(config);
      markStarted();
      return {
        sessionId: "test-session",
        sendAndWait: async () => {
          if (wait) await wait;
          if (fail) throw new Error("SDK failure");
          return { data: { content: text } };
        },
      };
    },
    deleteSession: async (id) => deleted.push(id),
  };
  const server = createBridgeServer(client, TOKEN, {
    logger: { error: (message) => logs.push(message) },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (body = QUESTION, headers = {}, path = "/answer") =>
    new Promise((resolve, reject) => {
      const request = http.request(
        url + path,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            ...headers,
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode,
              }),
            ),
          );
        },
      );
      request.on("error", reject);
      request.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  return { url, send, sessions, deleted, logs, started };
}

test("bridge returns exact answer options and deletes the session", async (t) => {
  const { send, deleted } = await startBridge(t);
  const response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    answers: ["4", "1"],
    explanation: "",
  });
  assert.deepEqual(deleted, ["test-session"]);
});

test("bridge separates the explanation from the answer options", async (t) => {
  const { send } = await startBridge(t, {
    text: "4\nEXPLANATION: b++ returns 4 first.\nThen the last line prints 1.",
  });
  assert.deepEqual(await (await send()).json(), {
    answers: ["4"],
    explanation: "b++ returns 4 first.\nThen the last line prints 1.",
  });
});

test("bridge caps very long explanations", async (t) => {
  const { send } = await startBridge(t, {
    text: `4\nEXPLANATION:\n${"x".repeat(5000)}`,
  });
  assert.equal((await (await send()).json()).explanation.length, 4000);
});

test("quiz sessions cannot use tools, repository config, skills, hooks, or session store", async (t) => {
  const { send, sessions } = await startBridge(t);
  await send();
  assert.deepEqual(sessions[0].availableTools, []);
  assert.equal(
    sessions[0].onPermissionRequest().kind,
    "denied-interactively-by-user",
  );
  for (const option of [
    "enableConfigDiscovery",
    "enableFileHooks",
    "enableHostGitOperations",
    "enableSessionStore",
    "enableSkills",
  ]) {
    assert.equal(sessions[0][option], false);
  }
});

test("model discovery filters unavailable models and exposes billing multipliers", async (t) => {
  const { url } = await startBridge(t, {
    models: [
      {
        id: "enabled",
        name: "Enabled",
        policy: { state: "enabled" },
        billing: { multiplier: 0.5 },
      },
      { id: "disabled", policy: { state: "disabled" } },
    ],
  });

  const response = await fetch(url + "/models", {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.deepEqual((await response.json()).models, [
    { id: "enabled", name: "Enabled", multiplier: 0.5 },
  ]);
});

test("empty account model catalog gives actionable sign-in guidance", async (t) => {
  const { url } = await startBridge(t, { models: [] });
  const response = await fetch(url + "/models", {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /copilot login/);
});

test("concurrent answer requests are rejected instead of spending more quota", async (t) => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const { send, sessions, started } = await startBridge(t, { wait });
  const first = send();
  try {
    await started;
    const response = await send();
    assert.equal(response.status, 429);
    assert.equal(sessions.length, 1);
  } finally {
    release();
    await first;
  }
});

for (const [scenario, headers] of [
  ["missing token", { Authorization: "" }],
  ["wrong token", { Authorization: "Bearer wrong" }],
  ["website origin", { Origin: "https://example.com" }],
  ["DNS rebinding host", { Host: "attacker.example" }],
]) {
  test(`bridge rejects ${scenario} before creating an AI session`, async (t) => {
    const { send, sessions } = await startBridge(t);
    assert.equal((await send(QUESTION, headers)).status, 403);
    assert.equal(sessions.length, 0);
  });
}

for (const [scenario, body, status] of [
  ["malformed JSON", "{", 400],
  ["null payload", "null", 400],
  ["missing question", { ...QUESTION, question: "" }, 400],
  ["invalid option", { ...QUESTION, options: [null] }, 400],
  ["unavailable model", { ...QUESTION, model: "unknown" }, 400],
  ["oversized payload", "x".repeat(65537), 413],
]) {
  test(`bridge rejects ${scenario} without inference`, async (t) => {
    const { send, sessions } = await startBridge(t);
    assert.equal((await send(body)).status, status);
    assert.equal(sessions.length, 0);
  });
}

for (const [scenario, settings] of [
  ["SDK failure", { fail: true }],
  ["empty answer", { text: "" }],
  ["unmatched answer", { text: "An explanation instead of an option." }],
  ["explanation without answers", { text: "EXPLANATION: none of them." }],
]) {
  test(`bridge reports ${scenario} and still deletes the session`, async (t) => {
    const { send, deleted } = await startBridge(t, settings);
    assert.equal((await send()).status, 502);
    assert.deepEqual(deleted, ["test-session"]);
  });
}
