
const MODEL = "gemini-3.8-flash";
const COOLDOWN_MS = 60_000;
const TIMEOUT_MS = 25_000;

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

function phoenixTime() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Phoenix",
    dateStyle: "full",
    timeStyle: "short"
  }).format(new Date());
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
    return reply({
      error: "Only POST requests are supported."
    }, 405);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const accessCode = process.env.KINGSAI_ACCESS_CODE;

  if (!apiKey || !accessCode) {
    console.error("KingsAI environment variables missing");

    return reply({
      error: "KingsAI is not fully configured."
    }, 503);
  }

  const suppliedCode = request.headers.get("X-KingsWeb-Code");

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
    .slice(-12);

  const latest = messages[messages.length - 1];

  if (!latest || latest.role !== "user") {
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
      error: `👑 Please wait ${seconds} seconds before sending another message.`,
      retryAfter: seconds
    }, 429, {
      "Retry-After": String(seconds)
    });
  }

  lastRequestByVisitor.set(visitor, now);

  // Clean up expired cooldown entries.
  if (lastRequestByVisitor.size > 1000) {
    for (const [id, timestamp] of lastRequestByVisitor) {
      if (now - timestamp > COOLDOWN_MS) {
        lastRequestByVisitor.delete(id);
      }
    }
  }

  const systemInstruction =
    "You are KingsAI, the friendly royal AI assistant " +
    "inside KingsWeb. " +
    "Be helpful, clear, and welcoming. " +
    "Use a crown emoji occasionally. " +
    "Your name is KingsAI. " +
    "You are powered by Google's Gemini model. " +
    "Never claim KingsWeb created the underlying AI model. " +
    "For local time questions, use Phoenix, Arizona time. " +
    "The current Phoenix date and time is: " +
    phoenixTime() + ".";

  // Preserve recent conversation history without storing
  // the interaction on Google's server.
  const input = messages.map(message => ({
    type: message.role === "user"
      ? "user_input"
      : "model_output",
    content: [{
      type: "text",
      text: message.content.slice(0, 1200)
    }]
  }));

  const started = Date.now();

  console.log("KingsAI Interactions request started", {
    model: MODEL,
    messageCount: input.length
  });

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          model: MODEL,
          input,
          system_instruction: systemInstruction,
          store: false,
          generation_config: {
            max_output_tokens: 1024,
            thinking_level: "low"
          }
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      }
    );

    const elapsed = Date.now() - started;
    const raw = await response.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      console.error("Gemini returned invalid JSON", {
        status: response.status,
        elapsed
      });

      return reply({
        error: "Gemini returned an invalid response."
      }, 502);
    }

    if (!response.ok) {
      console.error("Gemini Interactions API error", {
        status: response.status,
        elapsed,
        details: data.error?.message?.slice(0, 800)
      });

      if (response.status === 429) {
        return reply({
          error: "👑 Gemini usage limit reached. Please try again later."
        }, 429);
      }

      return reply({
        error:
          "Gemini API returned HTTP " +
          response.status +
          ". Check Netlify function logs."
      }, 502);
    }

    if (data.status && data.status !== "completed") {
      console.error("Gemini interaction not completed", {
        status: data.status,
        elapsed
      });

      return reply({
        error: "Gemini did not finish its response."
      }, 502);
    }

    const steps = Array.isArray(data.steps)
      ? data.steps
      : [];

    const modelSteps = steps.filter(
      step => step.type === "model_output"
    );

    const lastModelStep =
      modelSteps[modelSteps.length - 1];

    const text = (lastModelStep?.content || [])
      .filter(part => part.type === "text")
      .map(part => part.text || "")
      .join("")
      .trim();

    if (!text) {
      console.error("Gemini returned no text", {
        status: data.status,
        stepTypes: steps.map(step => step.type),
        elapsed
      });

      return reply({
        error: "Gemini responded without usable text."
      }, 502);
    }

    console.log("KingsAI response successful", {
      elapsed,
      characters: text.length
    });

    return reply({
      reply: text
    });

  } catch (error) {
    const elapsed = Date.now() - started;

    console.error("KingsAI request failed", {
      name: error.name,
      message: error.message,
      elapsed
    });

    return reply({
      error: error.name === "TimeoutError"
        ? "KingsAI took too long to respond. Please try again."
        : "KingsAI could not connect to Gemini."
    }, 503);
  }
}
