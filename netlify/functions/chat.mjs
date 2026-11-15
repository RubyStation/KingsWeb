
const MODEL = "gemini-3.8-flash";
const COOLDOWN_MS = 60_000;

// Temporary cooldown stored in function memory.
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

export default async function handler(request, context) {
  const headers = corsHeaders(request);

  const reply = (data, status = 200, extra = {}) =>
    json(data, status, { ...headers, ...extra });

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers
    });
  }

  if (request.method !== "POST") {
    return reply({ error: "POST required." }, 405);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const accessCode = process.env.KINGSAI_ACCESS_CODE;

  if (!apiKey || !accessCode) {
    console.error("KingsAI configuration is missing.");
    return reply({
      error: "KingsAI environment variables are missing."
    }, 503);
  }

  const suppliedCode = request.headers.get("X-KingsWeb-Code");

  if (!suppliedCode || suppliedCode !== accessCode) {
    return reply({
      error: "Incorrect KingsAI access code."
    }, 401);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return reply({ error: "Invalid JSON." }, 400);
  }

  if (!Array.isArray(body.messages)) {
    return reply({ error: "Messages are required." }, 400);
  }

  const messages = body.messages
    .filter(m =>
      m &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string"
    )
    .slice(-12);

  const latest = messages[messages.length - 1];

  if (!latest || latest.role !== "user" ||
      !latest.content.trim()) {
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
      error: `👑 Please wait ${seconds} seconds before trying again.`,
      retryAfter: seconds
    }, 429, {
      "Retry-After": String(seconds)
    });
  }

  lastRequestByVisitor.set(visitor, now);

  const prompt =
    "You are KingsAI, the friendly royal assistant " +
    "inside KingsWeb. Be helpful, clear and concise. " +
    "Your name is KingsAI. " +
    "You are powered by Google's Gemini model. " +
    "For local time questions, use Phoenix, Arizona. " +
    "Current Phoenix time: " + phoenixTime() + ".";

  // Diagnostic test: send ONLY the newest message.
  // This isolates problems caused by conversation history.
  const testInput =
    prompt + "\n\nUser: " +
    latest.content.slice(0, 1200);

  const started = Date.now();

  console.log("KingsAI diagnostic request started", {
    model: MODEL,
    endpoint: "generateContent",
    inputLength: testInput.length
  });

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
          contents: [{
            role: "user",
            parts: [{ text: testInput }]
          }],
          generationConfig: {
            maxOutputTokens: 256
          }
        }),
        signal: AbortSignal.timeout(12000)
      }
    );

    const elapsed = Date.now() - started;
    const raw = await response.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error("Gemini returned non-JSON", {
        status: response.status,
        elapsed
      });

      return reply({
        error: "Gemini returned an invalid response."
      }, 502);
    }

    console.log("Gemini diagnostic result", {
      status: response.status,
      elapsed,
      errorCode: data.error?.code || null,
      errorStatus: data.error?.status || null,
      errorMessage: data.error?.message?.slice(0, 500) || null
    });

    if (!response.ok) {
      if (response.status === 429) {
        return reply({
          error: "Gemini API rate limit reached. Try again later."
        }, 429);
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
        finishReason:
          data.candidates?.[0]?.finishReason || null
      });

      return reply({
        error: "Gemini responded without usable text."
      }, 502);
    }

    console.log("KingsAI diagnostic succeeded", {
      elapsed
    });

    return reply({ reply: text });

  } catch (error) {
    const elapsed = Date.now() - started;

    console.error("KingsAI diagnostic failed", {
      name: error.name,
      message: error.message,
      elapsed
    });

    return reply({
      error: error.name === "TimeoutError"
        ? "Gemini did not respond within 12 seconds."
        : "KingsAI network request failed. Check Netlify logs."
    }, 503);
  }
}
