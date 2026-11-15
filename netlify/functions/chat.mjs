
/* =========================================
   KINGSWEB — KINGSAI GEMINI BACKEND
   Code.org + Netlify compatible
   ========================================= */


const MODEL = "gemini-3.8-flash";

const COOLDOWN_MS = 60_000;

const NETLIFY_ORIGIN =
  "https://deft-melomakarona-812c82.netlify.app";

// Temporary cooldown storage.
// May reset or differ across Netlify instances.
const lastRequestByVisitor = new Map();

/* =========================================
   CORS — ALLOW KINGSAI ON CODE.ORG
   ========================================= */

function isAllowedOrigin(origin) {
  if (!origin) return false;

  if (origin === NETLIFY_ORIGIN) return true;

  try {
    const url = new URL(origin);

    if (url.protocol !== "https:") {
      return false;
    }

    // Code.org editor and project previews
    if (
      url.hostname === "code.org" ||
      url.hostname.endsWith(".code.org")
    ) {
      return true;
    }

    // Code.org published project hosting
    if (
      url.hostname === "codeprojects.org" ||
      url.hostname.endsWith(".codeprojects.org")
    ) {
      return true;
    }

    return false;

  } catch {
    return false;
  }
}

function getCorsHeaders(request) {
  const origin =
    request.headers.get("Origin") || "";

  if (!isAllowedOrigin(origin)) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods":
      "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-KingsWeb-Code",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin"
  };
}

/* =========================================
   JSON RESPONSE HELPER
   ========================================= */

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

/* =========================================
   PHOENIX TIME
   ========================================= */

function phoenixTime() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Phoenix",
    dateStyle: "full",
    timeStyle: "short"
  }).format(new Date());
}

/* =========================================
   MAIN KINGSAI HANDLER
   ========================================= */

export default async function handler(request, context) {

  const cors = getCorsHeaders(request);

  const origin =
    request.headers.get("Origin") || "";

  // Browser CORS preflight
  if (request.method === "OPTIONS") {

    if (!isAllowedOrigin(origin)) {
      return json({
        error: "Origin not allowed."
      }, 403);
    }

    return new Response(null, {
      status: 204,
      headers: cors
    });
  }

  // All normal responses include CORS headers.
  const reply = (data, status = 200, extra = {}) => {
    return json(data, status, {
      ...cors,
      ...extra
    });
  };

  // Reject unauthorized browser origins.
  if (origin && !isAllowedOrigin(origin)) {
    return reply({
      error: "Origin not allowed."
    }, 403);
  }

  // Only accept POST requests.
  if (request.method !== "POST") {
    return reply({
      error: "Only POST requests are supported."
    }, 405);
  }

  /* =====================================
     PRIVATE ENVIRONMENT VARIABLES
     ===================================== */

  const apiKey = process.env.GEMINI_API_KEY;
  const accessCode =
    process.env.KINGSAI_ACCESS_CODE;

  if (!apiKey || !accessCode) {
    return reply({
      error: "KingsAI is not fully configured yet."
    }, 503);
  }

  /* =====================================
     VERIFY KINGSAI ACCESS CODE
     ===================================== */

  const suppliedCode =
    request.headers.get("X-KingsWeb-Code");

  if (!suppliedCode || suppliedCode !== accessCode) {
    return reply({
      error: "Incorrect or missing KingsAI access code."
    }, 401);
  }

  /* =====================================
     READ CHAT MESSAGES
     ===================================== */

  let body;

  try {
    body = await request.json();
  } catch {
    return reply({
      error: "Invalid request."
    }, 400);
  }

  if (!Array.isArray(body.messages)) {
    return reply({
      error: "Messages are required."
    }, 400);
  }

  const messages = body.messages
    .slice(-12)
    .filter(message =>
      message &&
      ["user", "assistant"].includes(message.role) &&
      typeof message.content === "string"
    )
    .map(message => ({
      role:
        message.role === "assistant"
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
      error: "Please send a message to KingsAI."
    }, 400);
  }

  /* =====================================
     60-SECOND COOLDOWN
     ===================================== */

  const visitor =
    context.ip ||
    request.headers.get(
      "x-nf-client-connection-ip"
    ) ||
    "unknown";

  const now = Date.now();

  const lastRequest =
    lastRequestByVisitor.get(visitor) || 0;

  const remaining =
    COOLDOWN_MS - (now - lastRequest);

  if (remaining > 0) {
    const retryAfter =
      Math.ceil(remaining / 1000);

    return reply({
      error:
        "👑 Please wait " +
        retryAfter +
        " seconds before sending another message.",
      retryAfter
    }, 429, {
      "Retry-After": String(retryAfter)
    });
  }

  // Start cooldown before the Gemini request.
  lastRequestByVisitor.set(visitor, now);

  // Remove expired entries when memory grows.
  if (lastRequestByVisitor.size > 1000) {

    for (const [id, timestamp] of lastRequestByVisitor) {

      if (now - timestamp > COOLDOWN_MS) {
        lastRequestByVisitor.delete(id);
      }

    }
  }

  /* =====================================
     KINGSAI PERSONALITY
     ===================================== */

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

  /* =====================================
     SEND REQUEST TO GOOGLE GEMINI
     ===================================== */

  try {

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      MODEL +
      ":generateContent",
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

    /* =================================
       GEMINI USAGE LIMIT
       ================================= */

    if (response.status === 429) {
      return reply({
        error:
          "👑 KingsAI has reached a Gemini usage limit. Please try again later."
      }, 429);
    }

    /* =================================
       GEMINI SERVICE ERROR
       ================================= */

    if (!response.ok) {

     
const errorBody = await response.text();

console.error(
  "Gemini API status:",
  response.status,
  "Details:",
  errorBody.slice(0, 1500)
);


      return reply({
        error:
          "KingsAI could not reach the AI service. Check the model and free-tier availability."
      }, 502);
    }

    /* =================================
       READ GEMINI ANSWER
       ================================= */

    const data = await response.json();

    const answer =
      (data.candidates?.[0]?.content?.parts || [])
        .map(part => part.text || "")
        .join("")
        .trim();

    if (!answer) {
      return reply({
        error:
          "KingsAI did not receive a text response. Please try again."
      }, 502);
    }

    /* =================================
       SUCCESSFUL KINGSAI REPLY
       ================================= */

    return reply({
      reply: answer
    });

  } catch (error) {

    console.error(
      "KingsAI request failed:",
      error.message
    );

    return reply({
      error:
        "KingsAI is temporarily unavailable. Please try again later."
    }, 503);
  }
}

/* =========================================
   END OF KINGSAI BACKEND
   ========================================= */
