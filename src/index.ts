export interface Env { AI: Ai; }

const MODEL_ID = "@cf/meta/llama-3.2-11b-vision-instruct";
const REPAIR_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fast";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SYSTEM_PROMPT = `
You are SiteSafe AI, a strict visual HSE inspector.

CORE RULE — EVIDENCE ONLY:
Use the supplied image as the primary and decisive source of evidence.
Identify a hazard ONLY when the hazardous condition is clearly visible in the image.
Never infer, assume, predict, or fill in missing visual information from common workplace practice.
User-selected scenario hints are context only and MUST NOT be treated as evidence.
If a hazard cannot be confirmed from visible image evidence, DO NOT include it.
A generic possibility is not a hazard finding.

For every included hazard, visual_evidence must state exactly what is visibly present and where it is in the image.
Do not write visual_evidence that cannot be pointed to in the image.

Special rules:
- Fall from height: include only when an elevated work position, open edge, opening, ladder, scaffold, platform, roof edge, mezzanine, or comparable elevation is clearly visible.
- Falling objects: include only when an overhead/suspended/unstable object or clear falling-object exposure is visibly present.
- Trip hazard: include only when a clear obstruction, loose cable/material, uneven surface, or similar condition is visibly located in a walking path.
- Electrical hazard: include only when exposed/incorrect/damaged electrical parts, conductors, unsafe connections, or another electrical condition is clearly visible.

Return ONLY valid JSON.
`;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS } });
}

function extractJson(text: string): any {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object found");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeAiResponse(result: unknown): any {
  if (result && typeof result === "object") {
    const r = result as { response?: unknown; text?: unknown };
    if (r.response && typeof r.response === "object") return r.response;
    if (typeof r.response === "string") return extractJson(r.response);
    if (typeof r.text === "string") return extractJson(r.text);
  }
  if (typeof result === "string") return extractJson(result);
  throw new Error("AI returned an empty response");
}

function validateAnalysis(value: unknown): any {
  const a = normalizeAiResponse(value);
  if (!a || typeof a !== "object" || !Array.isArray((a as any).hazards)) throw new Error("Invalid hazard analysis");
  return a;
}

async function repairAnalysis(env: Env, raw: unknown, languageInstruction: string): Promise<any> {
  const source = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
  const prompt = `Convert this HSE analysis into ONLY valid JSON. Keep ONLY hazards that are explicitly supported by visible image evidence. ${languageInstruction}

Required structure:
{"overall_summary":"string","overall_risk_level":"Low | Medium | High | Critical","immediate_action":"string","hazards":[{"hazard":"string","visual_evidence":"string","observation":"string","consequence":"string","likelihood":1,"severity":1,"risk_score":1,"risk_level":"Low | Medium | High | Critical","existing_controls":["string"],"additional_controls":{"elimination":["string"],"substitution":["string"],"engineering":["string"],"administrative":["string"],"ppe":["string"]},"ppe":["string"],"corrective_action":"string","priority":"Immediate | High | Medium | Low"}]}

SOURCE:\n${source}`;
  const r = await env.AI.run(REPAIR_MODEL_ID, { messages:[{role:"system",content:"Return strict JSON only."},{role:"user",content:prompt}], max_tokens:3000, temperature:0, response_format:{type:"json_object"} });
  return validateAnalysis(r);
}

async function verifyCandidates(env: Env, image: string, analysis: any, languageInstruction: string): Promise<any> {
  const candidates = (analysis.hazards || []).map((h:any, i:number) => ({
    index:i, hazard:h.hazard, visual_evidence:h.visual_evidence, observation:h.observation
  }));
  const prompt = `You are the final visual evidence verifier for SiteSafe AI.
Look at the supplied image yourself. Do NOT trust the candidate descriptions as proof.
For each candidate, independently decide whether the hazardous condition is clearly visible in the image.
Reject anything that is only a possibility, inference, generic workplace risk, or unsupported by the pixels.
${languageInstruction}
Return ONLY JSON in this exact form:
{"verified":[{"index":0,"confirmed":true,"reason":"short description of the visible evidence"}]}
Every candidate index must appear exactly once. confirmed=true only when the condition is clearly visible.

CANDIDATES:\n${JSON.stringify(candidates)}`;
  const r = await env.AI.run(MODEL_ID, {
    messages:[
      {role:"system",content:"You are a strict visual evidence verifier. Image evidence is mandatory."},
      {role:"user",content:prompt}
    ],
    image,
    max_tokens:1800,
    temperature:0,
    response_format:{type:"json_object"}
  });
  const out = normalizeAiResponse(r);
  if (!out || !Array.isArray(out.verified)) throw new Error("Visual verification failed");
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null,{status:204,headers:CORS_HEADERS});
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") return jsonResponse({service:"SiteSafe AI Vision V11",status:"online",endpoint:"/analyze"});
    if (url.pathname !== "/analyze") return jsonResponse({error:"Not found",message:"Use POST /analyze"},404);
    if (request.method !== "POST") return jsonResponse({error:"Method not allowed"},405);

    try {
      const body = await request.json() as { image?:string; language?:"en"|"hi"; context?:{site?:string;area?:string;hint?:string} };
      if (!body.image || typeof body.image !== "string") return jsonResponse({error:"Image is required"},400);
      const languageInstruction = body.language === "hi" ? "Return human-readable fields in Hindi, with important HSE technical terms in English where useful." : "Return human-readable fields in professional English.";
      const context = `Site: ${body.context?.site || "Not provided"}\nArea: ${body.context?.area || "Not provided"}\nOptional hint: ${body.context?.hint || "None"}`;
      const userPrompt = `Analyze ONLY what is visibly supported by this workplace image. Do not assume hidden conditions. ${languageInstruction}\n\n${context}\n\nReturn JSON with overall_summary, overall_risk_level, immediate_action and hazards. Each hazard must include visual_evidence and the complete HSE fields. If no hazard is clearly visible, return an empty hazards array.`;

      let analysis:any = null; let last:any = null;
      for(let i=0;i<2 && !analysis;i++){
        try {
          const r = await env.AI.run(MODEL_ID,{messages:[{role:"system",content:SYSTEM_PROMPT},{role:"user",content:userPrompt}],image:body.image,max_tokens:3200,temperature:0,response_format:{type:"json_object"}});
          analysis=validateAnalysis(r);
        } catch(e){ last=e; console.error("Vision attempt failed",e); }
      }
      if(!analysis){
        try { analysis=await repairAnalysis(env,last,languageInstruction); }
        catch(e){ console.error("Repair failed",e); return jsonResponse({success:false,error:"AI analysis failed",message:"The visual analysis could not be converted into a safe structured result. Please retry."},502); }
      }

      // Mandatory independent visual verification. If verification cannot be completed,
      // fail closed rather than returning unsupported hazards.
      const verification = await verifyCandidates(env, body.image, analysis, languageInstruction);
      const byIndex = new Map<number, any>((verification.verified||[]).map((v:any)=>[Number(v.index),v]));
      const verifiedHazards = (analysis.hazards||[]).filter((_h:any,i:number)=>byIndex.get(i)?.confirmed === true);

      const finalAnalysis = { ...analysis, hazards: verifiedHazards, verification: { mode:"independent_visual_evidence", candidates:analysis.hazards?.length||0, confirmed:verifiedHazards.length } };
      return jsonResponse({success:true,model:MODEL_ID,analysis:finalAnalysis});
    } catch(error){
      console.error("SiteSafe AI V11 error",error);
      return jsonResponse({success:false,error:"AI analysis failed",message:error instanceof Error?error.message:"Unknown error"},500);
    }
  }
} satisfies ExportedHandler<Env>;
