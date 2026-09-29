export interface Env {
  AI: Ai;
}

const MODEL_ID = "@cf/meta/llama-3.2-11b-vision-instruct";
const REPAIR_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fast";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const PROMPT = `You are SiteSafe AI V12, a strict visual HSE inspector.

PIXEL EVIDENCE ONLY:
Report a hazard ONLY when the hazardous condition itself is clearly visible in the supplied image.

Never infer:
- hidden conditions
- worker behavior
- energization
- competence
- structural integrity
- future events
- generic workplace risks

Context hints are NOT evidence.

If evidence is uncertain, omit the hazard.

Every hazard MUST contain exact visual_evidence describing what is visibly present and where.

Special rules:

- Electrical:
  Visible exposed conductors, terminals, internal wiring, damaged insulation, unsafe electrical connections, or an open accessible electrical enclosure are sufficient visible evidence.
  Do NOT require proof that electricity is energized.

- Fall from height:
  A visible elevation, open edge, opening, ladder, scaffold, platform, roof edge or mezzanine must be visible.

- Falling objects:
  A visibly suspended, overhead, unstable or falling object must be visible.

- Trip:
  A visible obstruction, cable, material or uneven surface must be visible in a walking path.

- PPE:
  A person, their task and the missing/inadequate PPE must all be visibly identifiable.

If no hazard is clearly visible, return hazards as an empty array.

Return ONLY JSON with:
overall_summary,
overall_risk_level,
immediate_action,
hazards.`;

function out(x: any, status = 200) {
  return new Response(JSON.stringify(x), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS
    }
  });
}


/* ---------------------------------
   JSON PARSER
---------------------------------- */

function parseJSON(raw: any): any {

  if (raw && typeof raw === "object") {

    if (raw.response && typeof raw.response === "object") {
      return raw.response;
    }

    if (typeof raw.response === "string") {
      raw = raw.response;
    } else if (typeof raw.text === "string") {
      raw = raw.text;
    }
  }

  if (typeof raw !== "string") {
    throw Error("Empty AI response");
  }

  raw = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  /* Direct JSON */

  try {
    return JSON.parse(raw);
  } catch {}

  /* JSON embedded inside text */

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start >= 0 && end > start) {

    const candidate = raw.slice(start, end + 1);

    try {
      return JSON.parse(candidate);
    } catch {}
  }

  throw Error("AI returned non-JSON response");
}


/* ---------------------------------
   SAFE EMPTY RESULT
---------------------------------- */

function emptyAnalysis() {

  return {
    overall_summary:
      "No visually confirmed hazards were identified from the supplied image.",

    overall_risk_level:
      "Low",

    immediate_action:
      "No immediate action identified from the visible image evidence.",

    hazards: []
  };
}


/* ---------------------------------
   NORMALIZE PRIMARY AI RESPONSE

   If vision model returns bad JSON,
   repair it with another model.
---------------------------------- */

async function normalize(
  env: Env,
  result: any
): Promise<any> {

  /* First try normal parsing */

  try {

    const parsed = parseJSON(result);

    if (
      parsed &&
      Array.isArray(parsed.hazards)
    ) {
      return parsed;
    }

  } catch {}


  /* Extract raw model output */

  let raw = "";

  try {

    if (
      result &&
      typeof result === "object"
    ) {

      if (typeof result.response === "string") {
        raw = result.response;

      } else if (typeof result.text === "string") {
        raw = result.text;

      } else {
        raw = JSON.stringify(result);
      }

    } else {

      raw = String(result ?? "");

    }

  } catch {}


  /* Nothing useful returned */

  if (!raw.trim()) {
    return emptyAnalysis();
  }


  /* ---------------------------------
     REPAIR MODEL
  ---------------------------------- */

  try {

    const repaired = await env.AI.run(
      REPAIR_MODEL_ID,
      {
        messages: [

          {
            role: "system",

            content: `You are a JSON repair assistant for a safety inspection system.

Convert ONLY information already present in the supplied candidate text into valid JSON.

IMPORTANT:
NEVER invent a hazard.
NEVER add a visual observation that is not present in the candidate text.
NEVER create a hazard from your own knowledge.
If the candidate text contains no usable hazard information, return an empty hazards array.

Return exactly this general structure:

{
  "overall_summary": "",
  "overall_risk_level": "Low",
  "immediate_action": "",
  "hazards": [
    {
      "hazard": "",
      "visual_evidence": "",
      "consequence": "",
      "likelihood": 1,
      "severity": 1,
      "existing_controls": "",
      "additional_controls": "",
      "PPE": "",
      "corrective_action": "",
      "priority": ""
    }
  ]
}

Return ONLY JSON.`
          },

          {
            role: "user",
            content: raw.slice(0, 12000)
          }

        ],

        max_tokens: 2200,
        temperature: 0,

        response_format: {
          type: "json_object"
        }
      }
    );


    const parsed = parseJSON(repaired);

    if (
      parsed &&
      Array.isArray(parsed.hazards)
    ) {
      return parsed;
    }

  } catch {}


  /* Absolute fail-safe */

  return emptyAnalysis();
}


/* ---------------------------------
   CLEAN + CALCULATE RISK
---------------------------------- */

function clean(result: any) {

  const a =
    result &&
    typeof result === "object"
      ? result
      : emptyAnalysis();


  if (!Array.isArray(a.hazards)) {
    a.hazards = [];
  }


  a.hazards = a.hazards

    .filter(
      (h: any) =>
        h &&
        h.hazard &&
        h.visual_evidence
    )

    .map((h: any) => {

      const likelihood =
        Math.min(
          5,
          Math.max(
            1,
            Number(h.likelihood) || 1
          )
        );

      const severity =
        Math.min(
          5,
          Math.max(
            1,
            Number(h.severity) || 1
          )
        );

      const score =
        likelihood * severity;


      return {

        ...h,

        likelihood,

        severity,

        risk_score:
          score,

        risk_level:
          score >= 20
            ? "Critical"
            : score >= 12
              ? "High"
              : score >= 6
                ? "Medium"
                : "Low"
      };

    });


  return a;
}


/* ---------------------------------
   INDEPENDENT IMAGE VERIFICATION
---------------------------------- */

async function verify(
  env: Env,
  image: string,
  hazards: any[]
) {

  /* No candidates = nothing to verify */

  if (!hazards.length) {
    return {
      verified: []
    };
  }


  const prompt = `Look at the supplied image yourself.

For every candidate below, decide whether the CONDITION ITSELF is visibly present in the image.

Reject:
- inference
- generic workplace risks
- hidden conditions
- assumptions
- unsupported claims

For electrical candidates:
Visible exposed electrical parts, wiring, terminals or an open accessible electrical enclosure is enough evidence.
Do NOT require proof of voltage.

Return ONLY:

{
  "verified": [
    {
      "index": 0,
      "confirmed": true,
      "reason": "visible evidence"
    }
  ]
}

You MUST include every candidate index exactly once.

Candidates:

${JSON.stringify(
    hazards.map((h, index) => ({
      index,
      hazard: h.hazard,
      visual_evidence: h.visual_evidence
    }))
  )}`;


  const result = await env.AI.run(
    MODEL_ID,
    {
      messages: [

        {
          role: "system",
          content:
            "Independent pixel-evidence verifier."
        },

        {
          role: "user",
          content: prompt
        }

      ],

      image,

      max_tokens: 1600,

      temperature: 0,

      response_format: {
        type: "json_object"
      }
    }
  );


  return parseJSON(result);
}


/* ---------------------------------
   MAIN WORKER
---------------------------------- */

export default {

  async fetch(
    req: Request,
    env: Env
  ) {


    /* CORS */

    if (req.method === "OPTIONS") {

      return new Response(null, {
        status: 204,
        headers: CORS
      });

    }


    const url =
      new URL(req.url);


    /* HEALTH CHECK */

    if (
      url.pathname === "/" &&
      req.method === "GET"
    ) {

      return out({

        service:
          "SiteSafe AI Vision V12",

        status:
          "online",

        mode:
          "strict pixel evidence + fail-safe JSON"

      });

    }


    /* ONLY /analyze */

    if (url.pathname !== "/analyze") {

      return out(
        {
          error:
            "Not found"
        },
        404
      );

    }


    if (req.method !== "POST") {

      return out(
        {
          error:
            "Method not allowed"
        },
        405
      );

    }


    try {

      const body =
        await req.json() as any;


      /* IMAGE REQUIRED */

      if (!body.image) {

        return out(
          {
            error:
              "Image is required"
          },
          400
        );

      }


      const language =
        body.language === "hi"
          ? "Hindi with important HSE terms in English"
          : "professional English";


      /* ---------------------------------
         PRIMARY VISION AI
      ---------------------------------- */

      const result =
        await env.AI.run(
          MODEL_ID,
          {

            messages: [

              {
                role: "system",
                content: PROMPT
              },

              {
                role: "user",

                content: `Inspect ONLY visible evidence.

Language: ${language}

Site:
${body.context?.site || "Not provided"}

Area:
${body.context?.area || "Not provided"}

Hint:
${body.context?.hint || "None"}`
              }

            ],

            image:
              body.image,

            max_tokens:
              3200,

            temperature:
              0,

            response_format:
              {
                type:
                  "json_object"
              }
          }
        );


      /* ---------------------------------
         NORMALIZE RESPONSE
      ---------------------------------- */

      const analysis =
        clean(
          await normalize(
            env,
            result
          )
        );


      /* ---------------------------------
         INDEPENDENT VERIFICATION

         If verifier fails, do NOT crash
         the entire application.
      ---------------------------------- */

      let verification: any;

      try {

        verification =
          await verify(
            env,
            body.image,
            analysis.hazards
          );


        if (
          !verification ||
          !Array.isArray(
            verification.verified
          )
        ) {

          throw Error(
            "Invalid verification response"
          );

        }

      } catch {

        /* Safest fallback:
           reject all unverified hazards */

        verification = {
          verified: []
        };

      }


      /* ---------------------------------
         KEEP ONLY CONFIRMED HAZARDS
      ---------------------------------- */

      const verifiedMap =
        new Map(
          verification.verified.map(
            (item: any) => [
              Number(item.index),
              item
            ]
          )
        );


      analysis.hazards =
        analysis.hazards.filter(
          (_hazard: any, index: number) =>
            verifiedMap.get(index)
              ?.confirmed === true
        );


      /* ---------------------------------
         SAFE FINAL SUMMARY
      ---------------------------------- */

      if (!analysis.hazards.length) {

        analysis.overall_risk_level =
          "Low";

        analysis.immediate_action =
          "No hazard was confirmed by independent visual verification.";

      }


      /* ---------------------------------
         FINAL RESPONSE
      ---------------------------------- */

      return out({

        success:
          true,

        model:
          MODEL_ID,

        analysis: {

          ...analysis,

          verification: {

            mode:
              "independent pixel-evidence",

            confirmed:
              analysis.hazards.length

          }

        }

      });


    } catch (error) {


      /* ---------------------------------
         LAST SERVER-SIDE SAFETY NET
      ---------------------------------- */

      return out({

        success:
          false,

        error:
          "AI analysis failed",

        message:
          error instanceof Error
            ? error.message
            : "Unknown error"

      }, 500);

    }

  }

} satisfies ExportedHandler<Env>;
