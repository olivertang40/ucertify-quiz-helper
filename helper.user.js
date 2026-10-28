// ==UserScript==
// @name         ucertify-quiz-helper
// @version      3.2.0
// @description  ucertify-quiz-helper
// @author       guanhua
// @include      *ucertify*
// @require      https://raw.githubusercontent.com/0guanhua0/ucertify-quiz-helper/refs/heads/main/db.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  "use strict";

  // https://aistudio.google.com/app/apikey
  // update MY_API_KEY
  let GEMINI_API_KEY = "MY_API_KEY";
  const GEMINI_MODEL = "gemini-3.8-flash";
  const GEMINI_TIMEOUT_MS = 30000;
  const AI_PROVIDER = "gemini"; // "gemini" or "copilot"
  const COPILOT_MODEL = ""; // Choose an ID from npm run models.
  const COPILOT_BRIDGE_TOKEN = ""; // From local .copilot-bridge.json, not GitHub.
  const COPILOT_BRIDGE_URL = "http://127.0.0.1:37371/answer";
  const COPILOT_TIMEOUT_MS = 60000;
  const GEMINI_COOLDOWN_MS = 60000;
  const MAX_CACHED_ANSWERS = 100;

  let lastProcessedQuestion = null;
  let geminiRetryAfter = 0;
  const pendingAIRequests = new Map();
  const aiAnswerCache = new Map();

  function normalizeText(text) {
    return text
      .replace(/ /g, " ")
      .replace(/–/g, "-")
      .replace(/−/g, "-")
      .replace(/\u00A0/g, " ")
      .replace(/“|”/g, '"')
      .replace(/‘|’/g, "'")
      .trim();
  }

  function matchKey(question, quiz) {
    for (let key in quiz) {
      if (question.includes(key)) {
        return key;
      }
    }
    return null;
  }

  function highlightAnswers(answersToHighlight, optionElements) {
    answersToHighlight.forEach((value) => {
      for (let element of optionElements) {
        let text = normalizeText(element.innerText.trim());
        if (text === value) {
          element.style.backgroundColor = "#00ff00";
          console.log("Highlighting answer:", value);
        }
      }
    });
  }

  async function askGemini(question, options) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY === "MY_API_KEY") {
      console.error("no Gemini API Key.");
      return [];
    }
    if (Date.now() < geminiRetryAfter) {
      console.error("Gemini quota cooldown active. Wait before retrying.");
      return [];
    }

    let API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    let prompt = `
      Respond exact text of the correct option(s).
      If multiple options, list each one on a new line.

      Question:
      ${question}

      Options:
      ${options.join("\n")}
    `;

    try {
      let response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
          },
        }),
      });

      if (!response.ok) {
        if (response.status === 429) {
          geminiRetryAfter = Date.now() + GEMINI_COOLDOWN_MS;
        }
        let errorData = await response.json();
        console.error(
          `Gemini (${GEMINI_MODEL}) HTTP ${response.status}: ${errorData.error?.message || response.statusText}`,
        );
        return [];
      }

      let data = await response.json();
      let candidate = data.candidates?.[0];
      let aiResponseText = (candidate?.content?.parts || [])
        .filter((part) => !part.thought && typeof part.text === "string")
        .map((part) => part.text)
        .join("");

      if (!aiResponseText.trim()) {
        console.error(
          `Gemini (${GEMINI_MODEL}) returned no answer text: ${data.promptFeedback?.blockReason || candidate?.finishReason || "empty response"}`,
        );
        return [];
      }

      return aiResponseText
        .trim()
        .split("\n")
        .map((ans) => ans.trim())
        .filter(Boolean);
    } catch (error) {
      console.error(
        `Gemini (${GEMINI_MODEL}) request failed: ${error.message}`,
      );
      return [];
    }
  }

  function askCopilot(question, options) {
    if (!COPILOT_MODEL || !COPILOT_BRIDGE_TOKEN) {
      console.error(
        "Configure COPILOT_MODEL and COPILOT_BRIDGE_TOKEN first. Run npm run models for available models.",
      );
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: COPILOT_BRIDGE_URL,
        anonymous: true,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${COPILOT_BRIDGE_TOKEN}`,
        },
        data: JSON.stringify({ question, options, model: COPILOT_MODEL }),
        timeout: COPILOT_TIMEOUT_MS,
        onload: (response) => {
          let data;
          try {
            data = JSON.parse(response.responseText);
          } catch (error) {
            console.error(
              `Copilot bridge returned invalid JSON (HTTP ${response.status}).`,
            );
            resolve([]);
            return;
          }
          if (response.status !== 200 || !Array.isArray(data?.answers)) {
            console.error(
              `Copilot bridge HTTP ${response.status}: ${data?.error || "missing answers"}`,
            );
            resolve([]);
            return;
          }
          if (
            data.answers.some(
              (answer) =>
                typeof answer !== "string" || !options.includes(answer),
            )
          ) {
            console.error("Copilot bridge returned invalid answer options.");
            resolve([]);
            return;
          }
          resolve(data.answers);
        },
        onerror: () => {
          console.error(
            "Cannot reach Copilot bridge. Start it with npm run bridge.",
          );
          resolve([]);
        },
        ontimeout: () => {
          console.error("Copilot bridge request timed out.");
          resolve([]);
        },
      });
    });
  }

  async function askAI(question, options) {
    const model = AI_PROVIDER === "copilot" ? COPILOT_MODEL : GEMINI_MODEL;
    const key = JSON.stringify([AI_PROVIDER, model, question, options]);
    if (aiAnswerCache.has(key)) return aiAnswerCache.get(key);
    // Concurrent page events for the same question share one in-flight request.
    if (pendingAIRequests.has(key)) return pendingAIRequests.get(key);
    const request = requestAI(question, options, key);
    pendingAIRequests.set(key, request);
    try {
      return await request;
    } finally {
      pendingAIRequests.delete(key);
    }
  }

  async function requestAI(question, options, key) {
    let answers;
    if (AI_PROVIDER === "copilot") {
      answers = await askCopilot(question, options);
    } else if (AI_PROVIDER === "gemini") {
      answers = await askGemini(question, options);
    } else {
      console.error(`Unknown AI provider: ${AI_PROVIDER}`);
      return [];
    }
    if (answers.length) {
      if (aiAnswerCache.size >= MAX_CACHED_ANSWERS) {
        aiAnswerCache.delete(aiAnswerCache.keys().next().value);
      }
      aiAnswerCache.set(key, answers);
    }
    return answers;
  }

  async function runHelper() {
    let questionElement = document.querySelector('[data-itemtype="question"]');
    if (!questionElement) {
      return;
    }

    let currentQuestion = normalizeText(questionElement.innerText.trim());
    console.log(JSON.stringify(currentQuestion));

    lastProcessedQuestion = currentQuestion;

    let optionElements = document.querySelectorAll("#item_answer seq");
    let options = Array.from(optionElements).map((el) =>
      normalizeText(el.innerText.trim()),
    );

    console.log(JSON.stringify(options));

    let matchingKey = matchKey(currentQuestion, quiz);

    if (matchingKey) {
      highlightAnswers(quiz[matchingKey], optionElements);
    } else {
      console.log(`No match in DB, ask ${AI_PROVIDER}...`);
      let aiAnswers = await askAI(currentQuestion, options);

      if (aiAnswers.length > 0) {
        console.log(`${AI_PROVIDER} AI suggests:`, aiAnswers);
        highlightAnswers(aiAnswers, optionElements);
      } else {
        console.log("no answer from ai");
      }
    }
  }

  let observer = new MutationObserver((mutations) => {
    let questionElement = document.querySelector('[data-itemtype="question"]');
    let currentQuestionTextOnPage = questionElement
      ? normalizeText(questionElement.innerText.trim())
      : null;

    if (
      currentQuestionTextOnPage &&
      currentQuestionTextOnPage !== lastProcessedQuestion
    ) {
      console.log("new question, run helper");
      lastProcessedQuestion = currentQuestionTextOnPage;
      setTimeout(() => {
        runHelper();
      }, 100);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  window.addEventListener("load", function () {
    console.log("Page loaded, running quiz logic");
    setTimeout(runHelper, 100);
  });

  let patch = {};

  function getAnsLetter() {
    let txt = document.querySelector(".explanation_content").innerText;

    let single = txt.match(/Answer\s+([A-Z])\s+is\s+correct/i);
    if (single) return [single[1].toUpperCase()];

    let multi = txt.match(/Answers?\s+([A-Z,\sand&]+)\s+are\s+correct/i);
    return multi[1]
      .replace(/and/gi, ",")
      .replace(/&/g, ",")
      .split(",")
      .map((s) => s.replace(/[^A-Z]/gi, "").toUpperCase())
      .filter(Boolean);
  }

  function getCurr() {
    let question = normalizeText(
      document.querySelector(".ebook_item_text").innerText,
    ).replace("Copy \nStart of code", "Start of code");
    let letter = getAnsLetter();

    let allAns = [...document.querySelectorAll(".answer")];
    let ans = letter.map((l) => {
      let idx = l.charCodeAt(0) - "A".charCodeAt(0);
      return normalizeText(allAns[idx].innerText);
    });
    return { question, ans };
  }

  async function getAll() {
    while (true) {
      let current = getCurr();
      let status = document.querySelector("#ans-text").innerText;
      patch[current.question] = current.ans;

      document.querySelector("#next").click();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  unsafeWindow.patch = patch;
  unsafeWindow.getCurr = getCurr;
  unsafeWindow.getAll = getAll;
})();
