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

Identify ONLY hazards that are visually supported by the image. Do not invent hazards that cannot reasonably be seen.

For every hazard provide:
- hazard
- observation/evidence
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
- additional_controls using the hierarchy of controls:
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
Do not claim that something is unsafe unless there is visual evidence.
If an item cannot be determined from the image, say "Not visually determinable".

Return ONLY valid JSON.
Do not use markdown.
Do not put JSON inside code fences.
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
      prompt: "agree"
    });
    return jsonResponse({ license: "accepted", result });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
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
            example: {
              image: "data:image/jpeg;base64,...",
            },
          },
          400
        );
      }

      const languageInstruction =
        body.language === "hi"
          ? `
Return all human-readable fields in Hindi.
Keep technical HSE terms understandable and include English terminology in brackets where useful.
`
          : `
Return all human-readable fields in professional English.
`;

      const userPrompt = `
Analyze this workplace image for construction/industrial HSE hazards.

${languageInstruction}

Return JSON with exactly this general structure:

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
        response_format: { type: "json_object" },
      });

      const raw =
        typeof result === "string"
          ? result
          : (result as { response?: string }).response ?? "";

      let analysis: any;

function extractJson(text: string) {
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

try {
  analysis = extractJson(raw);
} catch {
  try {
    const repair = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        {
          role: "system",
          content:
            "You are an HSE safety data formatter. Convert the supplied workplace safety analysis into ONLY valid JSON. Do not use markdown. Do not write any explanation before or after the JSON. The JSON must contain a hazards array. If multiple hazards are mentioned, create a separate object for each hazard."
        },
        {
          role: "user",
          content: `
Convert this HSE analysis into exactly this JSON structure:

{
  "overall_summary": "string",
  "overall_risk_level": "Low",
  "immediate_action": "string",
  "hazards": [
    {
      "hazard": "string",
      "observation": "string",
      "consequence": "string",
      "likelihood": 1,
      "severity": 1,
      "risk_score": 1,
      "risk_level": "Low",
      "existing_controls": [],
      "additional_controls": {
        "elimination": [],
        "substitution": [],
        "engineering": [],
        "administrative": [],
        "ppe": []
      },
      "ppe": [],
      "corrective_action": "string",
      "priority": "Low"
    }
  ]
}

Rules:
- Return ONLY valid JSON.
- Do not use markdown or code fences.
- Keep every hazard separate.
- likelihood and severity must be numbers from 1 to 5.
- risk_score = likelihood × severity.
- Use risk_level: Low, Medium, High, or Critical.
- Use priority: Immediate, High, Medium, or Low.
- If a field is not available, use an empty string or empty array.
- Preserve the actual safety observations from the supplied analysis.

HSE analysis to convert:

${raw}
`
        }
      ],
      max_tokens: 3000,
      temperature: 0.1
    });

    const repairedRaw =
      typeof repair === "string"
        ? repair
        : (repair as { response?: string }).response ?? "";

    analysis = extractJson(repairedRaw);

    if (
      !analysis ||
      !Array.isArray(analysis.hazards)
    ) {
      throw new Error("Repaired response has no hazards array");
    }
  } catch {
    analysis = {
      overall_summary: raw,
      overall_risk_level: "Not determined",
      immediate_action:
        "Review the image and verify findings with a competent HSE professional.",
      hazards: [],
      raw_response: raw
 };
 }
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
