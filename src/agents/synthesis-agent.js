/**
 * SynthesisAgent — aggregates papers and evidence into a structured research
 * synthesis: executive summary, key themes, consensus view, and open questions.
 */
import { BaseAgent } from "./base-agent.js";

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonObject(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const direct = safeJsonParse(trimmed);
  if (direct) return direct;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return safeJsonParse(trimmed.slice(start, end + 1));
}

function normalizeConsensus(value) {
  const v = String(value || "").toLowerCase();
  if (v === "strong" || v === "moderate" || v === "emerging") return v;
  return "moderate";
}

function sanitizeLlmSynthesis(raw, fallbackThemes, fallbackQuestions, fallbackSummary, fallbackStrength) {
  const themes = Array.isArray(raw?.themes)
    ? raw.themes
        .slice(0, 5)
        .map((t) => ({
          theme: String(t?.theme || "").trim(),
          paperCount: Number.isFinite(Number(t?.paperCount)) ? Math.max(0, Number(t.paperCount)) : 0,
          description: String(t?.description || "").trim(),
          consensus: normalizeConsensus(t?.consensus),
        }))
        .filter((t) => t.theme && t.description)
    : [];

  const openQuestions = Array.isArray(raw?.openQuestions)
    ? raw.openQuestions
        .slice(0, 5)
        .map((q) => String(q || "").trim())
        .filter(Boolean)
    : [];

  const summary = String(raw?.summary || "").trim() || fallbackSummary;
  const consensusStrength = Number.isFinite(Number(raw?.consensusStrength))
    ? Math.min(1, Math.max(0, Number(raw.consensusStrength)))
    : fallbackStrength;

  return {
    summary,
    themes: themes.length > 0 ? themes : fallbackThemes,
    openQuestions: openQuestions.length > 0 ? openQuestions : fallbackQuestions,
    consensusStrength,
  };
}

async function generateSynthesisWithLlm(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const endpoint = `${baseUrl.replace(/\/$/, "")}/responses`;

  const context = {
    query: payload.originalQuery,
    keyTerms: payload.keyTerms.slice(0, 8),
    evidenceSummary: payload.evidenceSummary,
    topPapers: payload.papers.slice(0, 8).map((p) => ({
      title: p.title,
      year: p.year,
      venue: p.venue,
      citations: p.citations,
      abstract: p.abstract,
      tags: p.tags,
    })),
    evidenceItems: payload.evidenceItems.slice(0, 8).map((e) => ({
      paperTitle: e.paperTitle,
      evidenceStrength: e.evidenceStrength,
      findings: (e.findings || []).slice(0, 3).map((f) => ({ text: f.text, confidence: f.confidence })),
    })),
  };

  const prompt = [
    "You are an expert research synthesis assistant.",
    "Return ONLY valid JSON with this exact shape:",
    '{"summary": string, "themes": [{"theme": string, "paperCount": number, "description": string, "consensus": "strong"|"moderate"|"emerging"}], "openQuestions": string[], "consensusStrength": number}',
    "Rules:",
    "- Keep summary concise (120-220 words).",
    "- Return 3 to 5 themes.",
    "- Return 3 to 5 openQuestions.",
    "- consensusStrength must be between 0 and 1.",
    "- Use only information from the provided context.",
    "Context:",
    JSON.stringify(context),
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: prompt,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    const outputText = String(data?.output_text || "");
    return extractJsonObject(outputText);
  } finally {
    clearTimeout(timeout);
  }
}

function buildThemes(keyTerms, evidenceItems) {
  const topics = [...new Set(keyTerms)].slice(0, 5);

  return topics.map((term, i) => {
    const relatedEvidence = evidenceItems.filter((e) =>
      e.findings.some((f) => f.text.toLowerCase().includes(term.toLowerCase()))
    );
    const paperCount = relatedEvidence.length || Math.max(1, evidenceItems.length - i);
    return {
      theme: term,
      paperCount,
      description: `Research on "${term}" shows consistent interest across the literature. `
        + `${paperCount} paper(s) directly address this theme with varying methodological approaches.`,
      consensus: relatedEvidence.length > 1 ? "moderate" : "emerging",
    };
  });
}

function buildSummary(query, papers, evidenceSummary, themes) {
  const topPapers = papers.slice(0, 3).map((p) => `"${p.title}" (${p.year})`).join(", ");
  const themeNames = themes.map((t) => t.theme).join(", ");
  return (
    `This synthesis covers ${papers.length} research papers on the topic: "${query}". ` +
    `Key themes identified include: ${themeNames || "multiple interdisciplinary areas"}. ` +
    `The body of evidence contains ${evidenceSummary.totalFindings} distinct findings, ` +
    `of which ${evidenceSummary.supportingFindings} are supporting (average strength: ` +
    `${evidenceSummary.averageEvidenceStrength.toFixed(2)}). ` +
    `Notable contributions include ${topPapers}. ` +
    `Overall, the literature reflects a growing consensus with several open methodological questions.`
  );
}

function buildOpenQuestions(keyTerms) {
  const QUESTION_PATTERNS = [
    (t) => `What are the long-term effects of ${t} across heterogeneous populations?`,
    (t) => `How does ${t} scale under real-world distributed conditions?`,
    (t) => `Can the findings related to ${t} be replicated in non-laboratory settings?`,
    (t) => `What causal mechanisms underpin the observed relationship with ${t}?`,
    (t) => `Are current evaluation benchmarks for ${t} sufficiently representative?`,
  ];

  return keyTerms.slice(0, 5).map((term, i) => QUESTION_PATTERNS[i % QUESTION_PATTERNS.length](term));
}

export class SynthesisAgent extends BaseAgent {
  constructor() {
    super("SynthesisAgent");
  }

  async run(input, sharedLogs) {
    const { originalQuery, keyTerms, papers, evidenceItems, evidenceSummary } = input;

    if (!papers || papers.length === 0) throw new Error("SynthesisAgent: no papers provided");

    sharedLogs.push(this.log("Building synthesis", { papers: papers.length }));

    const fallbackThemes = buildThemes(keyTerms ?? [], evidenceItems ?? []);
    const fallbackSummary = buildSummary(
      originalQuery,
      papers,
      evidenceSummary ?? { totalFindings: 0, supportingFindings: 0, averageEvidenceStrength: 0 },
      fallbackThemes
    );
    const fallbackQuestions = buildOpenQuestions(keyTerms ?? []);

    const fallbackConsensusStrength = evidenceSummary
      ? evidenceSummary.averageEvidenceStrength
      : 0.6;

    let summary = fallbackSummary;
    let themes = fallbackThemes;
    let openQuestions = fallbackQuestions;
    let consensusStrength = fallbackConsensusStrength;

    try {
      const llmOutput = await generateSynthesisWithLlm({
        originalQuery,
        keyTerms: keyTerms ?? [],
        papers,
        evidenceItems: evidenceItems ?? [],
        evidenceSummary: evidenceSummary ?? {
          totalFindings: 0,
          supportingFindings: 0,
          averageEvidenceStrength: 0,
        },
      });

      if (llmOutput) {
        const sanitized = sanitizeLlmSynthesis(
          llmOutput,
          fallbackThemes,
          fallbackQuestions,
          fallbackSummary,
          fallbackConsensusStrength
        );
        summary = sanitized.summary;
        themes = sanitized.themes;
        openQuestions = sanitized.openQuestions;
        consensusStrength = sanitized.consensusStrength;
        sharedLogs.push(this.log("Synthesis generated via LLM", { model: process.env.OPENAI_MODEL || "gpt-4.1-mini" }));
      } else {
        sharedLogs.push(this.log("Synthesis generated via fallback templates"));
      }
    } catch (err) {
      sharedLogs.push(this.log("LLM synthesis failed; using fallback", { error: err.message }));
    }

    sharedLogs.push(this.log("Synthesis complete", { themes: themes.length, openQuestions: openQuestions.length }));

    return {
      summary,
      themes,
      openQuestions,
      consensusStrength: parseFloat(consensusStrength.toFixed(3)),
      paperCount: papers.length,
      evidenceSummary: evidenceSummary ?? null,
    };
  }
}
