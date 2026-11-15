
const MODEL = "gemini-3.5-flash-lite";
const COOLDOWN_MS = 60000;
const TIMEOUT_MS = 18000;

const lastRequestByVisitor = new Map();

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";

  const allowed =
    origin === "https://deft-melomakarona-812c82.netlify.app" ||
    /^https:\/\/([a-z0-9-]+\.)?studio\.code\.org$/.test(origin);

  return {
    "Access-Control-Allow-Origin": allowed
      ? origin
      : "https://deft-melomakarona-812c82.netlify.app",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-KingsWeb-Code",
    "Vary": "Origin"
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
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
  const headers = corsHeaders(request);

  function reply(data, status, extraHeaders) {
    return json(data, status, {
      ...headers,
      ...extraHeaders
    });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers
    });
  }

  if (request.method !== "POST") {
    return reply({
      error: "Only POST requests are supported."
    }, 405);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const accessCode = process.env.KINGSAI_ACCESS_CODE;

  if (!apiKey || !accessCode) {
    console.error("KingsAI configuration missing");

    return reply({
      error: "KingsAI is not fully configured."
    }, 503);
  }

  const suppliedCode =
    request.headers.get("X-KingsWeb-Code");

  if (!suppliedCode || suppliedCode !== accessCode) {
    return reply({
      error: "Incorrect or missing KingsAI access code."
    }, 401);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return reply({
      error: "Invalid request body."
    }, 400);
  }

  if (!Array.isArray(body.messages)) {
    return reply({
      error: "Messages are required."
    }, 400);
  }

  const messages = body.messages
    .filter(message =>
      message &&
      ["user", "assistant"].includes(message.role) &&
      typeof message.content === "string" &&
      message.content.trim()
    )
    .slice(-12)
    .map(message => ({
      role: message.role === "assistant"
        ? "model"
        : "user",
      parts: [{
        text: message.content.slice(0, 1200)
      }]
    }));

  if (
    !messages.length ||
    messages[messages.length - 1].role !== "user"
  ) {
    return reply({
      error: "Please enter a message."
    }, 400);
  }

  const visitor =
    context.ip ||
    request.headers.get("x-nf-client-connection-ip") ||
    "unknown";

  const now = Date.now();
  const previous = lastRequestByVisitor.get(visitor) || 0;
  const remaining = COOLDOWN_MS - (now - previous);

  if (remaining > 0) {
    const seconds = Math.ceil(remaining / 1000);

    return reply({
      error:
        "👑 Please wait " + seconds +
        " seconds before sending another message.",
      retryAfter: seconds
    }, 429, {
      "Retry-After": String(seconds)
    });
  }

  const systemPrompt =
    "You are KingsAI, the friendly royal AI assistant " +
    "inside a website called KingsWeb. " +
    "Be helpful, clear, and welcoming. " +
    "Use a crown emoji occasionally. " +
    "Your name is KingsAI. " +
    "You are powered by Google's Gemini model. " +
    "Never claim KingsWeb created the underlying AI model. " +
    "For local time questions, use Phoenix, Arizona time. " +
    "The current Phoenix date and time is " +
    phoenixTime() + ".";

  const started = Date.now();

  console.log("KingsAI request started", {
    model: MODEL,
    messageCount: messages.length
  });

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(MODEL) +
      ":generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: systemPrompt
            }]
          },
          contents: messages,
          generationConfig: {
            maxOutputTokens: 1024
          }
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Gemini API error", {
        status: response.status,
        details: data.error?.message,
        elapsed: Date.now() - started
      });

      if (response.status === 404) {
        return reply({
          error:
            "Gemini model not found or unavailable " +
            "for this API key. Check Netlify logs."
        }, 502);
      }

      if (response.status === 429) {
        return reply({
          error:
            "👑 Gemini usage limit reached. " +
            "Please try again later."
        }, 429);
      }

      if (response.status === 503) {
        return reply({
          error:
            "The AI service is overloaded. " +
            "Please try again later."
        }, 503);
      }

      return reply({
        error:
          "Gemini API returned HTTP " +
          response.status +
          ". Check Netlify function logs."
      }, 502);
    }

    const text = (
      data.candidates?.[0]?.content?.parts || []
    )
      .map(part => part.text || "")
      .join("")
      .trim();

    if (!text) {
      console.error("Gemini returned no text", {
        elapsed: Date.now() - started
      });

      return reply({
        error:
          "KingsAI received no text response. " +
          "Please try again."
      }, 502);
    }

    lastRequestByVisitor.set(visitor, Date.now());

    if (lastRequestByVisitor.size > 1000) {
      for (const [id, timestamp] of lastRequestByVisitor) {
        if (Date.now() - timestamp > COOLDOWN_MS) {
          lastRequestByVisitor.delete(id);
        }
      }
    }

    console.log("KingsAI response successful", {
      elapsed: Date.now() - started,
      characters: text.length
    });

    return reply({ reply: text });

  } catch (error) {
    console.error("KingsAI request failed", {
      name: error.name,
      message: error.message,
      elapsed: Date.now() - started
    });

    return reply({
      error:
        error.name === "TimeoutError" ||
        error.name === "AbortError"
          ? "KingsAI took too long to respond. Please try again."
          : "KingsAI could not connect to Gemini."
    }, 503);
  }
}
