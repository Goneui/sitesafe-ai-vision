import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

type Hazard = {
  hazard: string;
  visual_evidence: string;
  likelihood: number;
  severity: number;
  corrective_action?: string;
  consequence?: string;
  additional_controls?: string;
};

function finding(hazard: string, visual_evidence: string, likelihood = 2, severity = 2): Hazard {
  return { hazard, visual_evidence, likelihood, severity, corrective_action: "Control " + hazard };
}

async function analyze(
  primary: unknown,
  verification: unknown,
  options: { repair?: unknown; context?: unknown } = {}
) {
  const calls: Array<{ model: string; input: any }> = [];
  const AI = {
    run: vi.fn(async (model: string, input: any) => {
      calls.push({ model, input });
      if (model.includes("llama-3.1-8b")) return options.repair;
      if (calls.filter((call) => call.model.includes("vision")).length === 1) return primary;
      return { response: JSON.stringify(verification) };
    })
  };
  const response = await worker.fetch(
    new Request("https://sitesafe.test/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: "data:image/jpeg;base64,AA==",
        context: options.context
      })
    }),
    { AI } as any
  );
  return {
    body: await response.json() as any,
    calls,
    AI
  };
}

function modelAnalysis(hazards: Hazard[], overall_risk_level = "Low") {
  return {
    response: JSON.stringify({
      overall_summary: "Model summary may be stale.",
      overall_risk_level,
      immediate_action: "Model action may mention rejected findings.",
      hazards
    })
  };
}

describe("SiteSafe AI V12 visual evidence and verification", () => {
  it("keeps visibly exposed electrical wiring without requiring proof of voltage", async () => {
    const candidate = finding(
      "Exposed electrical wiring",
      "Loose copper conductors protrude from the open panel at the lower right",
      3,
      4
    );
    const result = await analyze(modelAnalysis([candidate]), {
      verified: [{ index: 0, confirmed: true, reason: "Copper conductors are visible" }]
    });

    expect(result.body.analysis.hazards).toHaveLength(1);
    expect(result.body.analysis.hazards[0].hazard).toBe(candidate.hazard);
    expect(result.calls[1].input.messages[1].content).toContain("Do NOT require proof of voltage");
  });

  it("recognizes protruding nails only when the sharp point is visible", async () => {
    const candidate = finding(
      "Sharp / puncture hazard",
      "Two pointed nails protrude from the top face of the wooden plank in the foreground"
    );
    const result = await analyze(modelAnalysis([candidate]), {
      verified: [{ index: 0, confirmed: true, reason: "Two nail points are visible" }]
    });

    expect(result.body.analysis.hazards.map((h: Hazard) => h.hazard)).toEqual([candidate.hazard]);
    expect(result.calls[0].input.messages[0].content).toContain("protruding nail");
    expect(result.calls[1].input.messages[1].content).toContain("sharp point or edge itself is visible");
  });

  it("requires visible person and fall exposure, and rejects generic height claims", async () => {
    const candidate = finding(
      "Fall exposure",
      "A worker stands on the elevated platform beside its unprotected open edge",
      3,
      5
    );
    const result = await analyze(modelAnalysis([candidate]), {
      verified: [{ index: 0, confirmed: true, reason: "Worker is beside the open edge" }]
    });

    expect(result.body.analysis.hazards).toHaveLength(1);
    expect(result.calls[0].input.messages[0].content).toContain("both the person and a meaningful fall exposure");
    expect(result.calls[1].input.messages[1].content).toContain("A person merely at height");
  });

  it("removes unsupported false positives and rebuilds final text without them", async () => {
    const unsupported = finding("Unsecured gas cylinder", "A cylinder is assumed to be unsecured", 5, 5);
    const supported = finding("Trip hazard", "A loose cable crosses the visible walking path", 2, 3);
    supported.corrective_action =
      "Remove the unsecured gas cylinder and report the imaginary energized circuit.";
    const result = await analyze(modelAnalysis([unsupported, supported], "Critical"), {
      verified: [
        { index: 0, confirmed: false, reason: "No visible evidence of unsecured condition" },
        { index: 1, confirmed: true, reason: "Cable crosses the path" }
      ]
    });

    expect(result.body.analysis.hazards.map((h: Hazard) => h.hazard)).toEqual([supported.hazard]);
    expect(result.body.analysis.overall_summary).not.toContain(unsupported.hazard);
    expect(result.body.analysis.immediate_action).not.toContain(unsupported.hazard);
    expect(result.body.analysis.immediate_action).not.toContain("imaginary energized circuit");
    expect(result.body.analysis.overall_risk_level).toBe("Medium");
  });

  it("fails closed when malformed model output is repaired into a new unsupported hazard", async () => {
    const repairedHazard = finding("Invented electrical hazard", "A bright red ladder is visible");
    repairedHazard.consequence = "Fatal electrocution is certain";
    repairedHazard.corrective_action = "Shut down the imaginary circuit";
    repairedHazard.additional_controls = "Install an unsupported barrier";
    const result = await analyze(
      { response: "not valid JSON; no candidate findings" },
      { verified: [{ index: 0, confirmed: true, reason: "" }] },
      { repair: { response: JSON.stringify({ hazards: [repairedHazard] }) } }
    );

    expect(result.body.analysis.hazards).toEqual([]);
    expect(result.body.analysis.overall_risk_level).toBe("Low");
    expect(result.AI.run).toHaveBeenCalledTimes(2);
    expect(result.body.analysis.overall_summary).not.toContain(repairedHazard.hazard);
  });

  it("does not let a negative verifier index confirm a candidate", async () => {
    const candidate = finding(
      "Exposed electrical wiring",
      "Loose copper conductors protrude from the open panel"
    );
    const result = await analyze(modelAnalysis([candidate]), {
      verified: [{ index: -1, confirmed: true, reason: "Must not apply to candidate 0" }]
    });

    expect(result.body.analysis.hazards).toEqual([]);
    expect(result.body.analysis.overall_risk_level).toBe("Low");
    expect(result.body.analysis.overall_summary).not.toContain(candidate.hazard);
  });

  it("builds action text without model controls that mention rejected hazards or unsupported claims", async () => {
    const confirmed = finding(
      "Visible trip hazard",
      "A loose cable crosses the visible walking path"
    );
    const rejected = finding(
      "Unsecured gas cylinder",
      "The cylinder is assumed to be unsecured"
    );
    confirmed.corrective_action =
      "Remove the unsecured gas cylinder, report the imaginary live circuit, and evacuate because a collapse is imminent.";
    confirmed.additional_controls =
      "Install a guardrail around a nonexistent opening.";
    const result = await analyze(modelAnalysis([confirmed, rejected]), {
      verified: [
        { index: 0, confirmed: true, reason: "Cable is visible" },
        { index: 1, confirmed: false, reason: "Unsecured condition is not visible" }
      ]
    });

    expect(result.body.analysis.overall_summary).toContain(confirmed.hazard);
    expect(result.body.analysis.overall_summary).not.toContain(rejected.hazard);
    expect(result.body.analysis.immediate_action).toContain("low-risk");
    expect(result.body.analysis.immediate_action).toContain(confirmed.hazard.toLowerCase());
    expect(result.body.analysis.immediate_action).not.toContain(rejected.hazard);
    expect(result.body.analysis.immediate_action).not.toContain("imaginary live circuit");
    expect(result.body.analysis.immediate_action).not.toContain("collapse is imminent");
    expect(result.body.analysis.immediate_action).not.toContain("nonexistent opening");
  });

  it("uses the highest confirmed risk and ignores invalid, duplicate, and rejected indices", async () => {
    const low = finding("Visible trip hazard", "A small cable lies in the walking path", 1, 3);
    const high = finding("Visible fall exposure", "A worker is beside an open elevated edge", 3, 4);
    const rejected = finding("Unsupported hazard", "No image evidence", 5, 5);
    const result = await analyze(modelAnalysis([low, high, rejected], "Low"), {
      verified: [
        { index: 0, confirmed: true, reason: "" },
        { index: 1, confirmed: true, reason: "" },
        { index: 2, confirmed: true, reason: "Unsupported candidate should be rejected" },
        { index: 2, confirmed: false, reason: "Duplicate index is ambiguous" },
        { index: "1", confirmed: true, reason: "String indices are invalid" },
        { index: 90, confirmed: true, reason: "Out of range" }
      ]
    });

    expect(result.body.analysis.hazards.map((h: Hazard) => h.hazard)).toEqual([low.hazard, high.hazard]);
    expect(result.body.analysis.overall_risk_level).toBe("High");
    expect(result.body.analysis.overall_summary).toContain(low.hazard);
    expect(result.body.analysis.overall_summary).toContain(high.hazard);
    expect(result.body.analysis.overall_summary).not.toContain(rejected.hazard);
    expect(result.body.analysis.immediate_action).not.toContain(rejected.hazard);
  });

  it("returns a clean Low result when no hazard is confirmed", async () => {
    const result = await analyze(modelAnalysis([], "Critical"), { verified: [] });

    expect(result.body.analysis.hazards).toEqual([]);
    expect(result.body.analysis.overall_risk_level).toBe("Low");
    expect(result.body.analysis.overall_summary).toBe(
      "No visually confirmed hazards were identified from the supplied image."
    );
    expect(result.body.analysis.immediate_action).toBe(
      "No immediate action identified from the visible image evidence."
    );
  });
});
