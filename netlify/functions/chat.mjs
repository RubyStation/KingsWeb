
const MODEL = "gemini-2.5-flash";
const COOLDOWN_MS = 60_000;

// Temporary in-memory cooldown.
// We'll add persistent enforcement later.
const lastRequestByVisitor = new Map();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function phoenixTime() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Phoenix",
    dateStyle: "full",
    timeStyle: "short"
  }).format(new Date());
}

export default async function handler(request, context) {
  if (request.method !== "POST") {
    return json({ error: "Only POST requests are supported." }, 405);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const accessCode = process.env.KINGSAI_ACCESS_CODE;

  if (!apiKey || !accessCode) {
    return json({
      error: "KingsAI is not fully configured yet."
    }, 503);
  }

  // Require the private access code before calling Gemini.
  const suppliedCode = request.headers.get("X-KingsWeb-Code");

  if (!suppliedCode || suppliedCode !== accessCode) {
    return json({
      error: "Incorrect or missing KingsAI access code."
    }, 401);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  if (!Array.isArray(body.messages)) {
    return json({ error: "Messages are required." }, 400);
  }

  const messages = body.messages
    .slice(-12)
    .filter(message =>
      message &&
      ["user", "assistant"].includes(message.role) &&
      typeof message.content === "string"
    )
    .map(message => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{
        text: message.content.slice(0, 1200)
      }]
    }));

  if (
    !messages.length ||
    messages[messages.length - 1].role !== "user"
  ) {
    return json({
      error: "Please send a message to KingsAI."
    }, 400);
  }

  const visitor = context.ip ||
    request.headers.get("x-nf-client-connection-ip") ||
    "unknown";

  const now = Date.now();
  const lastRequest = lastRequestByVisitor.get(visitor) || 0;
  const remaining = COOLDOWN_MS - (now - lastRequest);

  if (remaining > 0) {
    const retryAfter = Math.ceil(remaining / 1000);

    return json({
      error: `👑 Please wait ${retryAfter} seconds before sending another message.`,
      retryAfter
    }, 429, {
      "Retry-After": String(retryAfter)
    });
  }

  // Reserve this cooldown before sending the AI request.
  lastRequestByVisitor.set(visitor, now);

  // Remove expired entries to avoid growing memory indefinitely.
  if (lastRequestByVisitor.size > 1000) {
    for (const [id, timestamp] of lastRequestByVisitor) {
      if (now - timestamp > COOLDOWN_MS) {
        lastRequestByVisitor.delete(id);
      }
    }
  }

  const prompt =
    "You are KingsAI, the friendly royal AI assistant " +
    "inside a website called KingsWeb. " +
    "Be helpful, clear, and welcoming. " +
    "You may use a crown emoji occasionally. " +
    "Your name is KingsAI. " +
    "You are powered by Google's Gemini model. " +
    "Never claim that KingsWeb created the underlying AI model. " +
    "For local time questions, use Phoenix, Arizona time. " +
    "The current Phoenix date and time is: " +
    phoenixTime() + ".";

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      MODEL + ":generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: prompt }]
          },
          contents: messages,
          generationConfig: {
            maxOutputTokens: 600
          }
        }),
        signal: AbortSignal.timeout(25000)
      }
    );

    if (response.status === 429) {
      return json({
        error: "👑 KingsAI has reached a Gemini usage limit. Please try again later."
      }, 429);
    }

    if (!response.ok) {
      console.error("Gemini API status:", response.status);

      return json({
        error: "KingsAI could not reach the AI service. Check the model and free-tier availability."
      }, 502);
    }

    const data = await response.json();

    const reply = (data.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || "")
      .join("")
      .trim();

    if (!reply) {
      return json({
        error: "KingsAI did not receive a text response. Please try again."
      }, 502);
    }

    return json({ reply });

  } catch (error) {
    console.error("KingsAI request failed:", error.message);

    return json({
      error: "KingsAI is temporarily unavailable. Please try again later."
    }, 503);
  }
}
