  export interface Env {
  AI: Ai;
}

const MODEL_ID = "@cf/meta/llama-3.2-11b-vision-instruct";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SYSTEM_PROMPT = `
You are SiteSafe AI, a professional construction and industrial HSE safety inspector.

Analyze the supplied workplace image carefully.

Identify ONLY hazards that are visually supported by the image.

For every hazard provide:
- hazard
- observation
- consequence
- likelihood from 1 to 5
- severity from 1 to 5
- risk_score = likelihood * severity
- risk_level:
  1-4 = Low
  5-9 = Medium
  10-16 = High
  17-25 = Critical
- existing_controls
- additional_controls using:
  Elimination
  Substitution
  Engineering
  Administrative
  PPE
- PPE
- corrective_action
- priority

Also provide:
- overall_summary
- overall_risk_level
- immediate_action

Important:
Do not invent hazards.
If something cannot be determined visually, say "Not visually determinable".

Return ONLY valid JSON.
`;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function extractJson(text: string): any {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeAnalysis(value: unknown): any {
  if (typeof value === "string") {
    return extractJson(value);
  }

  if (value && typeof value === "object") {
    return value;
  }

  throw new Error("AI returned an empty response");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/agree" && request.method === "GET") {
      try {
        const result = await env.AI.run(MODEL_ID, {
          prompt: "agree",
        });

        return jsonResponse({
          license: "accepted",
          result,
        });
      } catch (error) {
        return jsonResponse(
          {
            error: String(error),
          },
          500
        );
      }
    }

    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse({
        service: "SiteSafe AI Vision",
        status: "online",
        endpoint: "/analyze",
      });
    }

    if (url.pathname !== "/analyze") {
      return jsonResponse(
        {
          error: "Not found",
          message: "Use POST /analyze",
        },
        404
      );
    }

    if (request.method !== "POST") {
      return jsonResponse(
        {
          error: "Method not allowed",
        },
        405
      );
    }

    try {
      const body = (await request.json()) as {
        image?: string;
        language?: "en" | "hi";
      };

      if (!body.image || typeof body.image !== "string") {
        return jsonResponse(
          {
            error: "Image is required",
          },
          400
        );
      }

      const languageInstruction =
        body.language === "hi"
          ? `
Return all human-readable fields in Hindi.
Keep important HSE technical terms in English brackets where useful.
`
          : `
Return all human-readable fields in professional English.
`;

      const userPrompt = `
Analyze this workplace image for construction/industrial HSE hazards.

${languageInstruction}

Return JSON using exactly this structure:

{
  "overall_summary": "string",
  "overall_risk_level": "Low | Medium | High | Critical",
  "immediate_action": "string",
  "hazards": [
    {
      "hazard": "string",
      "observation": "string",
      "consequence": "string",
      "likelihood": 1,
      "severity": 1,
      "risk_score": 1,
      "risk_level": "Low | Medium | High | Critical",
      "existing_controls": ["string"],
      "additional_controls": {
        "elimination": ["string"],
        "substitution": ["string"],
        "engineering": ["string"],
        "administrative": ["string"],
        "ppe": ["string"]
      },
      "ppe": ["string"],
      "corrective_action": "string",
      "priority": "Immediate | High | Medium | Low"
    }
  ]
}
`;

      const result = await env.AI.run(MODEL_ID, {
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        image: body.image,
        max_tokens: 3000,
        temperature: 0.1,
        response_format: {
          type: "json_object",
        },
      });

      /*
       * IMPORTANT:
       * Workers AI can return the JSON result as an object,
       * not only as a string.
       *
       * The old code assumed response was always a string.
       * This caused the real AI result to fall into the
       * prose/repair fallback and produced "0 findings".
       */

      const resultObject = result as {
        response?: unknown;
      };

      let analysis: any;

      if (
        resultObject.response &&
        typeof resultObject.response === "object"
      ) {
        analysis = resultObject.response;
      } else if (typeof resultObject.response === "string") {
        analysis = extractJson(resultObject.response);
      } else if (typeof result === "string") {
        analysis = extractJson(result);
      } else {
        analysis = normalizeAnalysis(result);
      }

      if (!analysis || !Array.isArray(analysis.hazards)) {
        throw new Error(
          "AI response did not contain a valid hazards array"
        );
      }

      return jsonResponse({
        success: true,
        model: MODEL_ID,
        analysis,
      });
    } catch (error) {
      console.error("SiteSafe AI Vision error:", error);

      return jsonResponse(
        {
          success: false,
          error: "AI analysis failed",
          message:
            error instanceof Error
              ? error.message
              : "Unknown Workers AI error",
        },
        500
      );
    }
  },
} satisfies ExportedHandler<Env>;        
