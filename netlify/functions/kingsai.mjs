
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const SYSTEM_PROMPT = `
You are KingsAI, a highly capable general-purpose and educational AI.

IDENTITY AND BEHAVIOR
- Google Gemini is the intelligence generating every answer.
- Answer only after the user submits a question or instruction.
- Attempt to answer almost any reasonable question.
- Understand natural human language, spelling errors, informal
  writing, grammar, sentence structures, and follow-up questions.
- Answer directly first, then explain when useful.
- Never invent facts, definitions, sources, or quotations.
- Admit uncertainty when an answer cannot be established.
- Never claim a calculation or fact was independently verified
  unless an actual verification occurred.
- Never expose private internal reasoning. Provide useful
  explanations, calculations, and concise reasoning summaries.

MATHEMATICS
Support:
- Addition, subtraction, multiplication and division.
- Fractions, mixed numbers, decimals and percentages.
- Ratios, proportions and rates.
- Integers, exponents and order of operations.
- Mean, median, mode and range.
- Expressions, variables and equations.
- Multi-step mathematical word problems.
- Unit conversions and measurement.

GEOMETRY — GRADES 6 AND 7
Support:
- Points, lines, rays and line segments.
- Acute, right, obtuse and straight angles.
- Adjacent, vertical, complementary and supplementary angles.
- Missing angles and triangle angle sums.
- Triangles and quadrilaterals.
- Polygons and their properties.
- Perimeter and area.
- Area of rectangles, squares, triangles,
  parallelograms and trapezoids.
- Circles, radius, diameter and circumference.
- Pi and approximate calculations.
- Three-dimensional figures and nets.
- Volume and surface area of rectangular prisms.
- Coordinate planes and ordered pairs.
- Reflections, rotations and translations.
- Scale drawings and scale factors.
- Composite figures and geometry word problems.

For geometry problems:
1. Identify the known measurements.
2. Identify what must be found.
3. Select the correct formula.
4. Substitute the values.
5. Calculate carefully.
6. Include units.
7. Check whether the answer is reasonable.

When mathematical calculations are complicated, use the
available code execution tool to calculate or check them.
Never claim code was executed if it was not.

MULTIPLE CHOICE
When given multiple-choice questions:
- Evaluate all answer options.
- Select the best-supported answer.
- State the letter and answer text when provided.
- Explain why it is correct.
- Explain why another option is incorrect when helpful.
- If none is correct, say so.

DICTIONARY AND LANGUAGE
Support:
- Definitions and meanings.
- Parts of speech.
- Synonyms and antonyms.
- Pronunciation guidance.
- Word origins when supported by evidence.
- Grammar, punctuation and spelling.
- Sentence structure and writing.
- Metaphors, similes and literary devices.
- Vocabulary and reading comprehension.

SOCIAL STUDIES
Provide detailed and understandable explanations of:
- Ancient and modern history.
- Historical people and civilizations.
- Historical events and timelines.
- Geography and cultures.
- Government and civics.
- Economics and trade.
- Primary and secondary historical sources.

SCIENCE AND TECHNOLOGY
Support biology, chemistry, physics, Earth science,
astronomy, environmental science, computers and programming.

RESEARCH AND SOURCES
Use Google Search when information would benefit from
external research, verification, definitions, historical
context, or current information.

Prefer trustworthy sources such as:
- Official dictionaries.
- Educational institutions.
- Government websites.
- Museums and historical archives.
- Scientific and academic organizations.

When search sources are supplied, cite them using their
actual titles and links. Do not invent citations.

RESPONSE FORMAT
- Simple questions: concise direct answers.
- Difficult questions: detailed explanations.
- Math: answer first, then calculation steps.
- Multiple choice: letter and answer first.
- Definitions: definition first, followed by examples.
- History: explain what happened, when, who was involved,
  why it happened, and its importance when relevant.
- Word problems: show the solution method and final answer.
- Use headings, lists and tables when they improve clarity.

Do not unnecessarily turn every answer into a long lesson.
Adapt the level of explanation to the question.

Your goal is to be accurate, useful, clear, and honest.
`;


const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-kingsai-access-code",
  "Access-Control-Max-Age": "86400"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  if (request.method !== "POST") {
    return json({ error: "Only POST requests are allowed." }, 405);
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const accessCode = process.env.KINGSAI_ACCESS_CODE;

    if (!apiKey) {
      return json({
        error: "GEMINI_API_KEY is missing from Netlify."
      }, 500);
    }

    if (!accessCode) {
      return json({
        error: "KINGSAI_ACCESS_CODE is missing from Netlify."
      }, 500);
    }

    const suppliedCode =
      request.headers.get("x-kingsai-access-code");

    if (suppliedCode !== accessCode) {
      return json({
        error: "Incorrect KingsAI access code."
      }, 401);
    }

    const body = await request.json();

    const question = String(body.question || "").trim();

    const mode = String(body.mode || "medium").toLowerCase();

    if (!question) {
      return json({ error: "Please enter a question." }, 400);
    }

    if (question.length > 8000) {
      return json({
        error: "Your question is too long. Maximum 8,000 characters."
      }, 400);
    }

    const thinkingLevels = {
      instant: "low",
      medium: "medium",
      high: "high"
    };

    const thinkingLevel = thinkingLevels[mode];

    if (!thinkingLevel) {
      return json({ error: "Invalid thinking mode." }, 400);
    }

    const history = Array.isArray(body.history)
      ? body.history.slice(-12)
      : [];

    const contents = history
      .filter(item =>
        item &&
        ["user", "model"].includes(item.role) &&
        typeof item.text === "string"
      )
      .map(item => ({
        role: item.role,
        parts: [{
          text: item.text.slice(0, 5000)
        }]
      }));

    contents.push({
      role: "user",
      parts: [{ text: question }]
    });

    const apiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }]
          },

          contents,

          tools: [
            { google_search: {} },
            { code_execution: {} }
          ],

          generationConfig: {
            thinkingConfig: {
              thinkingLevel: thinkingLevel
            }
          }
        })
      }
    );

    const data = await apiResponse.json();

    if (!apiResponse.ok) {
      console.error("Gemini API error:", data);

      return json({
        error: data.error?.message ||
          "Google Gemini could not process the request."
      }, apiResponse.status);
    }

    const candidate = data.candidates?.[0];

    const answer = candidate?.content?.parts
      ?.filter(part =>
        typeof part.text === "string" &&
        part.thought !== true
      )
      .map(part => part.text)
      .join("\n")
      .trim();

    if (!answer) {
      return json({
        error: "Gemini did not return a usable answer. Please try again."
      }, 502);
    }

    const groundingChunks =
      candidate?.groundingMetadata?.groundingChunks || [];

    const sources = groundingChunks
      .filter(chunk =>
        chunk.web &&
        /^https?:\/\//i.test(chunk.web.uri || "")
      )
      .map(chunk => ({
        title: chunk.web.title || "Research source",
        url: chunk.web.uri
      }));

    const uniqueSources = [
      ...new Map(
        sources.map(source => [source.url, source])
      ).values()
    ].slice(0, 8);

    return json({
      answer,
      sources: uniqueSources,
      provider: "Google Gemini",
      model: MODEL,
      mode,
      thinkingLevel,
      searched: uniqueSources.length > 0,
      finishReason: candidate.finishReason || null
    });

  } catch (error) {
    console.error("KingsAI error:", error);

    return json({
      error: "KingsAI encountered an unexpected server error."
    }, 500);
  }
}
