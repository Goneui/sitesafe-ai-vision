export interface Env { AI: Ai; }

const MODEL_ID="@cf/meta/llama-3.2-11b-vision-instruct";
const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type"};

const PROMPT=`You are SiteSafe AI V12, a strict visual HSE inspector.
PIXEL EVIDENCE ONLY: report a hazard ONLY when the hazardous condition itself is clearly visible in the supplied image.
Never infer hidden conditions, worker behavior, energization, competence, structural integrity, or future events.
Context hints are NOT evidence. If evidence is uncertain, omit the hazard.
Every hazard needs exact visual_evidence describing what is visible and where.

Special rules:
- Electrical: exposed conductors, terminals, internal wiring, damaged insulation, unsafe connections, or an open accessible electrical enclosure are sufficient visible evidence. Do NOT require proof of energization.
- Fall from height: visible elevation/open edge/opening/ladder/scaffold/platform/roof edge/mezzanine.
- Falling objects: visible overhead/suspended/unstable object or clear falling-object exposure.
- Trip: visible obstruction/cable/material/uneven surface in a visible walking path.
- PPE: only when person, task, and missing/inadequate PPE are visibly identifiable.
Return ONLY JSON with overall_summary, overall_risk_level, immediate_action and hazards.`;

function out(x:any,status=200){
  return new Response(JSON.stringify(x),{
    status,
    headers:{"Content-Type":"application/json",...CORS}
  })
}

function norm(r:any):any{
  if(r&&typeof r==="object"){
    if(r.response&&typeof r.response==="object")return r.response;
    if(typeof r.response==="string")
      return JSON.parse(r.response.replace(/```json|```/gi,"").trim());
    if(typeof r.text==="string")
      return JSON.parse(r.text.replace(/```json|```/gi,"").trim());
  }
  if(typeof r==="string")
    return JSON.parse(r.replace(/```json|```/gi,"").trim());
  throw Error("Empty AI response");
}

function clean(r:any){
  const a=norm(r);
  if(!a||!Array.isArray(a.hazards))
    throw Error("Invalid analysis");

  a.hazards=a.hazards
    .filter((h:any)=>h&&h.hazard&&h.visual_evidence)
    .map((h:any)=>{
      const l=Math.min(5,Math.max(1,Number(h.likelihood)||1));
      const s=Math.min(5,Math.max(1,Number(h.severity)||1));
      const score=l*s;

      return {
        ...h,
        likelihood:l,
        severity:s,
        risk_score:score,
        risk_level:
          score>=20?"Critical":
          score>=12?"High":
          score>=6?"Medium":"Low"
      };
    });

  return a;
}

async function verify(env:Env,image:string,hs:any[]){
  const p=`Look at the image yourself.
For each candidate decide whether the CONDITION ITSELF is visibly present.
Reject inference, generic workplace risk, hidden conditions, or unsupported claims.
For electrical candidates, visible exposed electrical parts/wiring/open enclosure is enough; do not require proof of voltage.
Return ONLY {"verified":[{"index":0,"confirmed":true,"reason":"visible evidence"}]}
and include every index exactly once.

Candidates:${JSON.stringify(
    hs.map((h,i)=>({
      index:i,
      hazard:h.hazard,
      visual_evidence:h.visual_evidence
    }))
  )}`;

  const r=await env.AI.run(MODEL_ID,{
    messages:[
      {
        role:"system",
        content:"Independent pixel-evidence verifier."
      },
      {
        role:"user",
        content:p
      }
    ],
    image,
    max_tokens:1600,
    temperature:0,
    response_format:{type:"json_object"}
  });

  const v=norm(r);

  if(!Array.isArray(v.verified))
    throw Error("Verification failed");

  return v;
}

export default {
  async fetch(req:Request,env:Env){

    if(req.method==="OPTIONS")
      return new Response(null,{status:204,headers:CORS});

    const u=new URL(req.url);

    if(u.pathname==="/"&&req.method==="GET")
      return out({
        service:"SiteSafe AI Vision V12",
        status:"online",
        mode:"strict pixel evidence"
      });

    if(u.pathname!=="/analyze")
      return out({error:"Not found"},404);

    if(req.method!=="POST")
      return out({error:"Method not allowed"},405);

    try{

      const b=await req.json() as any;

      if(!b.image)
        return out({error:"Image is required"},400);

      const lang=
        b.language==="hi"
        ?"Hindi with important HSE terms in English"
        :"professional English";

      const r=await env.AI.run(MODEL_ID,{
        messages:[
          {
            role:"system",
            content:PROMPT
          },
          {
            role:"user",
            content:`Inspect ONLY visible evidence.
Language: ${lang}.
Site:${b.context?.site||"Not provided"}
Area:${b.context?.area||"Not provided"}
Hint:${b.context?.hint||"None"}`
          }
        ],
        image:b.image,
        max_tokens:3200,
        temperature:0,
        response_format:{type:"json_object"}
      });

      const a=clean(r);

      const v=await verify(
        env,
        b.image,
        a.hazards
      );

      const m=new Map(
        v.verified.map((x:any)=>[
          Number(x.index),
          x
        ])
      );

      a.hazards=a.hazards.filter(
        (_h:any,i:number)=>
          m.get(i)?.confirmed===true
      );

      return out({
        success:true,
        model:MODEL_ID,
        analysis:{
          ...a,
          verification:{
            mode:"independent pixel-evidence",
            confirmed:a.hazards.length
          }
        }
      });

    }catch(e){

      return out({
        success:false,
        error:"AI analysis failed",
        message:e instanceof Error
          ?e.message
          :"Unknown error"
      },500);

    }
  }
} satisfies ExportedHandler<Env>;
