  export interface Env {
  AI: Ai;
}

const MODEL_ID = "@cf/meta/llama-3.2-11b-vision-instruct";
const REPAIR_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fast";

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

function normalizeAiResponse(result: unknown): any {
  if (result && typeof result === "object") {
    const responseValue = (result as { response?: unknown }).response;

    // Workers AI may already return an object.
    if (responseValue && typeof responseValue === "object") {
      return responseValue;
    }

    // Or it may return JSON as a string.
    if (typeof responseValue === "string") {
      return extractJson(responseValue);
    }

    const textValue = (result as { text?: unknown }).text;

    if (typeof textValue === "string") {
      return extractJson(textValue);
    }
  }

  if (typeof result === "string") {
    return extractJson(result);
  }

  throw new Error("AI returned an empty response");
}

function validateAnalysis(value: unknown): any {
  const analysis = normalizeAiResponse(value);

  if (!analysis || typeof analysis !== "object") {
    throw new Error("AI response was not an object");
  }

  if (!Array.isArray((analysis as { hazards?: unknown }).hazards)) {
    throw new Error("AI response did not contain a valid hazards array");
  }

  return analysis;
}

async function repairAnalysis(
  env: Env,
  raw: unknown,
  languageInstruction: string
): Promise<any> {
  const rawText =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object"
        ? JSON.stringify(raw)
        : String(raw ?? "");

  const repairPrompt = `
Convert the following workplace HSE analysis into ONLY valid JSON.

${languageInstruction}

Use exactly this structure:

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

Do not add markdown.
Do not add commentary.

SOURCE:
${rawText}
`;

  const repaired = await env.AI.run(REPAIR_MODEL_ID, {
    messages: [
      {
        role: "system",
        content:
          "You repair HSE analysis into strict machine-readable JSON.",
      },
      {
        role: "user",
        content: repairPrompt,
      },
    ],
    max_tokens: 3000,
    temperature: 0,
    response_format: {
      type: "json_object",
    },
  });

  return validateAnalysis(repaired);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);

    // Meta license acceptance
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

    // Health check
    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse({
        service: "SiteSafe AI Vision",
        status: "online",
        endpoint: "/analyze",
      });
    }

    // Endpoint check
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

      let analysis: any = null;
      let firstResult: unknown = null;
      let firstError: unknown = null;

      // --------------------------------------------------
      // ATTEMPT 1 + AUTOMATIC RETRY
      // --------------------------------------------------

      for (let attempt = 1; attempt <= 2 && !analysis; attempt++) {
        try {
          firstResult = await env.AI.run(MODEL_ID, {
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

            // Force structured JSON.
            response_format: {
              type: "json_object",
            },
          });

          analysis = validateAnalysis(firstResult);
        } catch (error) {
          firstError = error;

          console.error(
            `Vision attempt ${attempt} failed:`,
            error
          );
        }
      }

      // --------------------------------------------------
      // AUTOMATIC JSON REPAIR
      // --------------------------------------------------

      if (!analysis) {
        try {
          analysis = await repairAnalysis(
            env,
            firstResult ?? firstError,
            languageInstruction
          );
        } catch (repairError) {
          console.error(
            "SiteSafe AI Vision repair error:",
            repairError
          );
        }
      }

      // --------------------------------------------------
      // FINAL SAFE RESPONSE
      // --------------------------------------------------

      if (!analysis) {
        return jsonResponse(
          {
            success: false,
            error: "AI analysis failed",
            message:
              "The AI response could not be converted into the required hazard format. Please retry once.",
          },
          502
        );
      }

      return jsonResponse({
        success: true,
        model: MODEL_ID,
        analysis,
      });
    } catch (error) {
      console.error(
        "SiteSafe AI Vision error:",
        error
      );

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
      
