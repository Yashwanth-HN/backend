/**
 * QueryPlannerAgent — decomposes a natural-language research query into
 * focused sub-queries and identifies key concepts / search terms.
 */
import { BaseAgent } from "./base-agent.js";

const CONCEPT_SEEDS = {
  keywords: ["mechanism", "effect", "treatment", "model", "analysis", "review", "study", "impact"],
  aspects: ["background", "methods", "findings", "limitations", "future work"],
};

function extractKeyTerms(query) {
  const stopWords = new Set([
    "a","an","the","is","are","was","were","be","been","being",
    "have","has","had","do","does","did","will","would","could","should","may","might",
    "i","me","my","we","our","you","your","it","its","this","that","these","those",
    "and","or","but","nor","so","for","yet","both","either","neither","not",
    "in","on","at","to","of","by","up","as","if","no","more","what","how","why","when",
  ]);
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

function buildSubQueries(query, keyTerms) {
  const base = query.trim();
  const subQueries = [base];

  if (keyTerms.length >= 2) {
    subQueries.push(`${keyTerms.slice(0, 2).join(" ")} research review`);
    subQueries.push(`${keyTerms[0]} systematic analysis`);
    subQueries.push(`recent advances in ${keyTerms.slice(0, 3).join(" ")}`);
  }

  CONCEPT_SEEDS.aspects.forEach((aspect) => {
    if (keyTerms.length > 0) {
      subQueries.push(`${keyTerms[0]} ${aspect}`);
    }
  });

  return [...new Set(subQueries)].slice(0, 6);
}

export class QueryPlannerAgent extends BaseAgent {
  constructor() {
    super("QueryPlannerAgent");
  }

  async run(input, sharedLogs) {
    const { query } = input;

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      throw new Error("QueryPlannerAgent requires a non-empty query string");
    }

    sharedLogs.push(this.log("Parsing query", { query }));

    const keyTerms = extractKeyTerms(query);
    const subQueries = buildSubQueries(query, keyTerms);
    const concepts = keyTerms.slice(0, 8);

    sharedLogs.push(this.log("Extracted key terms", { keyTerms: concepts }));
    sharedLogs.push(this.log("Generated sub-queries", { count: subQueries.length }));

    return {
      originalQuery: query,
      keyTerms: concepts,
      subQueries,
      aspects: CONCEPT_SEEDS.aspects,
    };
  }
}
