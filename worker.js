/**
 * CHSL Mastery — AI Test Worker
 *
 * Deploy this file as a Cloudflare Worker.
 * Required Worker secrets/variables:
 *   GEMINI_API_KEY        Secret: Google AI Studio / Gemini API key
 *   FIREBASE_WEB_API_KEY  Variable: Firebase Web API key for bcom-notes-7ab45
 *   ALLOWED_ORIGIN        Variable: your CHSL Mastery site origin, or * for local HTML testing
 *
 * Endpoint:
 *   POST /generate-test
 *
 * The Worker verifies the Firebase ID token before calling Gemini.
 * No Gemini secret is sent to the browser.
 */

const MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const FIREBASE_LOOKUP_URL = "https://identitytoolkit.googleapis.com/v1/accounts:lookup";

const SYLLABUS = {
  "Tier-I": {
    reasoning: {
      name: "General Intelligence & Reasoning",
      topics: [
        "Semantic Analogy", "Symbolic/Number Analogy", "Figural Analogy",
        "Semantic Classification", "Symbolic/Number Classification", "Figural Classification",
        "Semantic Series", "Number Series", "Figural Series", "Problem Solving",
        "Word Building", "Coding & De-coding", "Numerical Operations", "Venn Diagrams"
      ]
    },
    maths: {
      name: "Quantitative Aptitude",
      topics: [
        "Number Systems", "Fundamental Arithmetical Operations", "Percentage",
        "Ratio & Proportion", "Square Roots", "Averages", "Interest (Simple & Compound)",
        "Profit & Loss", "Discount", "Partnership Business", "Mixture & Alligation",
        "Time & Distance", "Time & Work", "Basic Algebra", "Geometry", "Mensuration", "Trigonometry"
      ]
    },
    english: {
      name: "English Language",
      topics: [
        "Vocabulary", "Grammar", "Sentence Structure", "Synonyms & Antonyms", "Spot the Error",
        "Fill in the Blanks", "Idioms & Phrases", "One Word Substitution", "Active/Passive Voice",
        "Direct/Indirect Narration", "Cloze Passage", "Comprehension Passage"
      ]
    },
    ga: {
      name: "General Awareness",
      topics: [
        "History", "Culture", "Geography", "Economic Scene", "General Polity",
        "Indian Constitution", "Scientific Research", "Static General Knowledge"
      ]
    }
  },
  "Tier-II": {
    tier2_math: {
      name: "Mathematical Abilities (Module I)",
      topics: ["Number Systems", "Algebra", "Geometry", "Mensuration", "Trigonometry", "Statistics & Probability"]
    },
    tier2_reasoning: {
      name: "Reasoning & General Intelligence (Module II)",
      topics: ["Semantic Analogy", "Symbolic Operations", "Space Orientation", "Venn Diagrams", "Critical Thinking"]
    },
    tier2_computer: {
      name: "Computer Knowledge Module",
      topics: ["Computer Basics", "CPU & Input/Output Devices", "Memory Organization", "Windows OS", "MS Word", "MS Excel", "Internet & E-mail", "Cyber Security & Viruses"]
    }
  }
};

const JSON_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 10,
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            minItems: 4,
            maxItems: 4,
            items: { type: "string" }
          },
          answer: { type: "integer", minimum: 0, maximum: 3 },
          explanation: { type: "string" },
          topic: { type: "string" },
          difficulty: { type: "string", enum: ["Easy", "Medium", "Hard"] }
        },
        required: ["question", "options", "answer", "explanation", "topic", "difficulty"]
      }
    }
  },
  required: ["questions"]
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(env) }
  });
}

function cleanString(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
}

function uniqueQuestions(questions) {
  const seen = new Set();
  const result = [];
  for (const q of questions) {
    const key = cleanString(q.question, 800).toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) continue;
    const options = Array.isArray(q.options) ? q.options.map(x => cleanString(x, 300)) : [];
    if (options.length !== 4 || new Set(options.map(x => x.toLowerCase())).size !== 4) continue;
    const answer = Number(q.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) continue;
    if (!cleanString(q.explanation, 1200)) continue;
    seen.add(key);
    result.push({
      question: cleanString(q.question, 800),
      options,
      answer,
      explanation: cleanString(q.explanation, 1200),
      topic: cleanString(q.topic, 160) || "Mixed",
      difficulty: ["Easy", "Medium", "Hard"].includes(q.difficulty) ? q.difficulty : "Medium"
    });
  }
  return result;
}

async function verifyFirebaseToken(token, env) {
  if (!env.FIREBASE_WEB_API_KEY) throw new Error("FIREBASE_WEB_API_KEY is not configured.");
  const response = await fetch(`${FIREBASE_LOOKUP_URL}?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: token })
  });
  if (!response.ok) throw new Error("Invalid or expired Firebase session.");
  const data = await response.json();
  const account = data?.users?.[0];
  if (!account?.localId || account.disabled) throw new Error("Firebase account is not valid.");
  return { uid: account.localId, emailVerified: !!account.emailVerified };
}

function buildPrompt({ tier, subjectId, subjectName, topic, difficulty, count, mode, avoidQuestions, performance }) {
  const subject = SYLLABUS[tier]?.[subjectId];
  const allowedTopics = subject?.topics || [];
  const topicInstruction = mode === "mixed"
    ? `Create a balanced mixed test using these allowed topics: ${allowedTopics.join(", ")}.`
    : `Create the questions specifically from this topic: ${topic}.`;

  const avoid = (Array.isArray(avoidQuestions) ? avoidQuestions : [])
    .map(x => cleanString(x, 500))
    .filter(Boolean)
    .slice(-20);

  const weakTopics = (Array.isArray(performance?.weakTopics) ? performance.weakTopics : [])
    .map(x => cleanString(x, 160)).filter(Boolean).slice(-15);

  return `You are the dedicated question-generation engine for CHSL Mastery, an SSC CHSL preparation application.

Generate ORIGINAL, exam-appropriate SSC CHSL multiple-choice questions. Do not reproduce or closely paraphrase copyrighted previous-paper questions. The questions must be suitable for the selected SSC CHSL tier, subject and topic.

EXAM CONTEXT
Tier: ${tier}
Subject: ${subjectName}
Subject ID: ${subjectId}
Requested difficulty: ${difficulty}
Question count: ${count}
Test type: ${mode}
${topicInstruction}

ALLOWED TOPICS FOR THIS SUBJECT
${allowedTopics.join(" | ")}

QUALITY RULES
1. Return exactly ${count} questions.
2. Every question must have exactly four distinct options and exactly one correct answer.
3. The answer field is a zero-based option index (0, 1, 2, or 3).
4. Explanations must actually justify the correct answer and be concise but useful for an SSC aspirant.
5. Do not repeat questions, numbers, wording patterns, or merely rename the same question. Vary concepts, values, contexts and reasoning steps.
6. Keep all questions within the selected syllabus. Do not invent an unrelated topic.
7. For Mathematics/Reasoning, verify the answer mathematically/logically before returning it.
8. For English, ensure grammar, vocabulary and usage are unambiguous.
9. For General Awareness, prefer established factual knowledge and avoid uncertain claims.
10. For Computer Knowledge, use technically accurate terminology.
11. If difficulty is Mixed, distribute difficulty across Easy, Medium and Hard.
12. Never include an answer key in the question text itself.
13. Return JSON only according to the supplied schema.

PREVIOUSLY GENERATED QUESTIONS TO AVOID
${avoid.length ? avoid.map((x, i) => `${i + 1}. ${x}`).join("\n") : "None available."}

USER PERFORMANCE CONTEXT
Overall accuracy: ${performance?.overallAccuracy ?? "not enough data"}%
Weak topics: ${weakTopics.length ? weakTopics.join(", ") : "none recorded"}
Use weak-topic information only to make practice useful; do not mention the user's private performance in the question text or explanations.`;
}

async function generateWithGemini(prompt, env) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured.");
  const response = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: "You output only structured JSON for a secure exam-question API. Follow the requested schema exactly." }]
      },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.75,
        maxOutputTokens: 14000,
        responseMimeType: "application/json",
        responseSchema: JSON_SCHEMA
      }
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    let detail = "Gemini request failed.";
    try { detail = JSON.parse(raw)?.error?.message || detail; } catch (_) {}
    throw new Error(detail);
  }

  let payload;
  try { payload = JSON.parse(raw); } catch (_) { throw new Error("Gemini returned invalid JSON."); }
  const text = payload?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  if (!text) throw new Error("Gemini returned no question data.");
  try { return JSON.parse(text); } catch (_) { throw new Error("Gemini question data could not be parsed."); }
}

async function handleGenerate(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Authentication required." }, 401, env);

  try {
    await verifyFirebaseToken(auth.slice(7).trim(), env);
  } catch (error) {
    return json({ error: error.message || "Authentication failed." }, 401, env);
  }

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "Request body must be valid JSON." }, 400, env); }

  const tier = body?.tier;
  const subjectId = body?.subjectId;
  const subject = SYLLABUS[tier]?.[subjectId];
  if (!subject) return json({ error: "Invalid CHSL tier or subject." }, 400, env);

  const count = Math.min(Math.max(Number(body?.count) || 20, 10), 20);
  const difficulty = ["Easy", "Medium", "Hard", "Mixed"].includes(body?.difficulty) ? body.difficulty : "Medium";
  const mode = body?.mode === "mixed" ? "mixed" : "topic";
  const topic = cleanString(body?.topic, 160);

  if (mode === "topic" && !subject.topics.includes(topic)) {
    return json({ error: "Invalid topic for the selected CHSL subject." }, 400, env);
  }

  const prompt = buildPrompt({
    tier,
    subjectId,
    subjectName: subject.name,
    topic,
    difficulty,
    count,
    mode,
    avoidQuestions: body?.avoidQuestions,
    performance: body?.performance
  });

  // Two attempts give the model a chance to replace accidental duplicates.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const generated = await generateWithGemini(prompt, env);
      const questions = uniqueQuestions(generated?.questions || []);
      if (questions.length >= count) return json({ questions: questions.slice(0, count), model: MODEL }, 200, env);
    } catch (error) {
      if (attempt === 1) return json({ error: error.message || "AI generation failed." }, 502, env);
    }
  }

  return json({ error: "The AI returned duplicate or incomplete questions. Please generate the test again." }, 502, env);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "CHSL Mastery AI" }, 200, env);
    if (request.method === "POST" && url.pathname === "/generate-test") return handleGenerate(request, env);
    // Serve the GitHub Pages site through Cloudflare Workers Static Assets.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: "Not found." }, 404, env);
  }
};
