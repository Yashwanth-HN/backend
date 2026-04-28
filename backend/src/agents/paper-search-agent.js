/**
 * PaperSearchAgent — fetches real research papers from live databases:
 *   • arXiv           (free, no key required)
 *   • Semantic Scholar (free tier; set SEMANTIC_SCHOLAR_API_KEY for higher rate limits)
 *   • PubMed / NCBI   (free, no key required)
 *   • Google Scholar  (optional — set SERPAPI_KEY to enable)
 *
 * Constrained to 20 papers with balanced source coverage across allowed databases.
 */
import { BaseAgent } from "./base-agent.js";
import crypto from "crypto";

const FETCH_TIMEOUT_MS = 25000;
const MAX_PER_SOURCE = 100; // max requested per source per search
const FINAL_PAPER_LIMIT = 20;
const SOURCE_ORDER = ["arXiv", "PubMed", "Semantic Scholar", "Google Scholar"];
const ALLOWED_SOURCES = new Set([
  "arXiv",
  "Semantic Scholar",
  "PubMed",
  "Google Scholar",
]);

// ── Utility ──────────────────────────────────────────────────────────────────

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normalizedTitleKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

async function timedFetchWithRetry(url, options = {}, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await timedFetch(url, options);
    } catch (err) {
      lastErr = err;
      // short exponential backoff to reduce transient DNS/TLS/socket failures
      const waitMs = 400 * Math.pow(2, i);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

function makeId(prefix, key) {
  return crypto
    .createHash("md5")
    .update(`${prefix}:${key}`)
    .digest("hex")
    .slice(0, 10);
}

function scoreAndRank(papers) {
  const currentYear = new Date().getFullYear();
  return papers.map((p, i) => {
    let score = 0;
    if (p.citations != null && p.citations > 0) {
      score += Math.log10(p.citations + 1) / 5;
    }
    if (p.year && currentYear - p.year <= 3) score += 0.1;
    // preserve per-source ordering signal
    score += Math.max(0, 0.3 - i * 0.002);
    return { ...p, relevanceScore: parseFloat(Math.min(1, score).toFixed(3)) };
  });
}

// ── arXiv ─────────────────────────────────────────────────────────────────────

function extractXmlField(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? normalizeText(m[1].replace(/<[^>]+>/g, "")) : "";
}

async function fetchArxiv(query, maxResults) {
  const url =
    `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}` +
    `&start=0&max_results=${maxResults}&sortBy=relevance`;
  const resp = await timedFetchWithRetry(url, {
    headers: { "User-Agent": "glow-research-agent/1.0" },
  });
  if (!resp.ok) throw new Error(`arXiv HTTP ${resp.status}`);
  const xml = await resp.text();

  const papers = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const rawId = extractXmlField(block, "id");
    const arxivId = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
    const title = extractXmlField(block, "title");
    const abstract = extractXmlField(block, "summary");
    const published = extractXmlField(block, "published");
    const year = published ? parseInt(published.slice(0, 4), 10) : null;

    const authorBlocks = block.match(/<author>[\s\S]*?<\/author>/gi) || [];
    const authors = authorBlocks
      .map((a) => normalizeText(a.replace(/<[^>]+>/g, "")))
      .filter(Boolean);

    const catMatch = block.match(/arxiv:primary_category[^>]+term="([^"]+)"/);
    const category = catMatch ? catMatch[1] : "";

    if (title && arxivId) {
      papers.push({
        id: makeId("arxiv", arxivId),
        title,
        abstract,
        authors,
        year,
        venue: `arXiv${category ? ` [${category}]` : ""}`,
        citations: null,
        relevanceScore: null,
        url: `https://arxiv.org/abs/${arxivId}`,
        tags: category ? [category] : [],
        source: "arXiv",
      });
    }
  }
  return papers;
}

// ── Semantic Scholar ──────────────────────────────────────────────────────────

async function fetchSemanticScholar(query, maxResults) {
  const fields =
    "title,abstract,authors,year,venue,citationCount,externalIds,openAccessPdf";
  const limit = Math.min(maxResults, 100);
  const url =
    `https://api.semanticscholar.org/graph/v1/paper/search` +
    `?query=${encodeURIComponent(query)}&limit=${limit}&fields=${fields}`;

  const headers = {};
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }

  const resp = await timedFetchWithRetry(url, { headers });
  if (!resp.ok) throw new Error(`Semantic Scholar HTTP ${resp.status}`);
  const data = await resp.json();

  return (data.data || [])
    .map((p) => {
      const doi = p.externalIds?.DOI;
      const arxivId = p.externalIds?.ArXiv;
      const paperUrl =
        p.openAccessPdf?.url ||
        (doi ? `https://doi.org/${doi}` : null) ||
        (arxivId ? `https://arxiv.org/abs/${arxivId}` : null);

      return {
        id: makeId("ss", p.paperId || p.title),
        title: normalizeText(p.title),
        abstract: normalizeText(p.abstract),
        authors: (p.authors || []).map((a) => a.name).filter(Boolean),
        year: p.year || null,
        venue: normalizeText(p.venue) || "Semantic Scholar",
        citations: p.citationCount ?? null,
        relevanceScore: null,
        url: paperUrl,
        tags: [],
        source: "Semantic Scholar",
      };
    })
    .filter((p) => p.title);
}

// ── PubMed ────────────────────────────────────────────────────────────────────

async function fetchPubMed(query, maxResults) {
  const searchUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` +
    `?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json`;

  const pubmedHeaders = {
    "User-Agent": "glow-research-agent/1.0 (contact: local-dev)",
  };

  const searchResp = await timedFetchWithRetry(searchUrl, { headers: pubmedHeaders });
  if (!searchResp.ok) throw new Error(`PubMed search HTTP ${searchResp.status}`);
  const searchData = await searchResp.json();
  const ids = (searchData.esearchresult?.idlist || []).slice(0, maxResults);
  if (ids.length === 0) return [];

  const summaryUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi` +
    `?db=pubmed&id=${ids.join(",")}&retmode=json`;
  const summaryResp = await timedFetchWithRetry(summaryUrl, { headers: pubmedHeaders });
  if (!summaryResp.ok) throw new Error(`PubMed summary HTTP ${summaryResp.status}`);
  const summaryData = await summaryResp.json();
  const result = summaryData.result || {};

  return ids
    .map((id) => {
      const p = result[id];
      if (!p || !p.title) return null;
      const authors = (p.authors || []).map((a) => a.name).filter(Boolean);
      const year = p.pubdate ? parseInt(p.pubdate.slice(0, 4), 10) || null : null;
      const doi = (p.elocationid || "").replace(/^doi:\s*/i, "").trim();
      return {
        id: makeId("pubmed", id),
        title: normalizeText(p.title),
        abstract: "",
        authors,
        year,
        venue: normalizeText(p.fulljournalname || p.source) || "PubMed",
        citations: null,
        relevanceScore: null,
        // Always open PubMed papers on the PubMed record page.
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        tags: [],
        source: "PubMed",
      };
    })
    .filter(Boolean);
}

// ── Google Scholar via SerpAPI (optional) ─────────────────────────────────────

async function fetchGoogleScholar(query, maxResults) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return [];

  const url =
    `https://serpapi.com/search.json?engine=google_scholar` +
    `&q=${encodeURIComponent(query)}&num=${Math.min(maxResults, 20)}&api_key=${apiKey}`;
  const resp = await timedFetchWithRetry(url);
  if (!resp.ok) throw new Error(`SerpAPI HTTP ${resp.status}`);
  const data = await resp.json();

  return (data.organic_results || [])
    .map((p) => {
      const summaryText = p.publication_info?.summary || "";
      const yearMatch = summaryText.match(/\b(19|20)\d{2}\b/);
      return {
        id: makeId("gs", p.title || p.link),
        title: normalizeText(p.title),
        abstract: normalizeText(p.snippet),
        authors: (p.publication_info?.authors || []).map((a) => a.name).filter(Boolean),
        year: yearMatch ? parseInt(yearMatch[0], 10) : null,
        venue: normalizeText(summaryText) || "Google Scholar",
        citations: p.inline_links?.cited_by?.total ?? null,
        relevanceScore: null,
        url: p.link || null,
        tags: [],
        source: "Google Scholar",
      };
    })
    .filter((p) => p.title);
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicate(allPapers) {
  const seenTitles = new Set();
  const seenUrls = new Set();
  const out = [];

  for (const p of allPapers) {
    const titleKey = normalizedTitleKey(p.title);
    const urlKey = p.url ? p.url.toLowerCase().split("?")[0] : null;

    if (seenTitles.has(titleKey)) continue;
    if (urlKey && seenUrls.has(urlKey)) continue;

    seenTitles.add(titleKey);
    if (urlKey) seenUrls.add(urlKey);
    out.push(p);
  }
  return out;
}

function selectBalancedPapers(papers, limit) {
  const buckets = new Map(SOURCE_ORDER.map((source) => [source, []]));
  for (const paper of papers) {
    const queue = buckets.get(paper.source);
    if (!queue) continue;
    queue.push(paper);
  }

  const selected = [];
  while (selected.length < limit) {
    let pickedAny = false;
    for (const source of SOURCE_ORDER) {
      const queue = buckets.get(source);
      if (!queue || queue.length === 0) continue;
      selected.push(queue.shift());
      pickedAny = true;
      if (selected.length >= limit) break;
    }
    if (!pickedAny) break;
  }

  return selected;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export class PaperSearchAgent extends BaseAgent {
  constructor() {
    super("PaperSearchAgent");
  }

  async run(input, sharedLogs) {
    const { originalQuery, keyTerms, subQueries } = input;
    if (!originalQuery) throw new Error("PaperSearchAgent: missing originalQuery");

    // Keep fan-out moderate to reduce transient fetch failures under load.
    const searchTerms = [originalQuery, ...subQueries.slice(0, 1)];
    const sourceMax = Math.ceil(MAX_PER_SOURCE / searchTerms.length);

    sharedLogs.push(this.log("Fetching from live databases", { sources: ["arXiv", "Semantic Scholar", "PubMed", "Google Scholar (if key set)"], searchTerms }));

    if (!process.env.SERPAPI_KEY) {
      sharedLogs.push(this.log("GoogleScholar skipped: SERPAPI_KEY not set"));
    }

    const allPapers = [];
    for (const term of searchTerms) {
      const [arxiv, semantic, pubmed, google] = await Promise.all([
        fetchArxiv(term, sourceMax).catch((e) => {
          sharedLogs.push(this.log(`arXiv error for "${term}"`, { error: e.message }));
          return [];
        }),
        fetchSemanticScholar(term, sourceMax).catch((e) => {
          sharedLogs.push(this.log(`SemanticScholar error for "${term}"`, { error: e.message }));
          return [];
        }),
        fetchPubMed(term, Math.ceil(sourceMax / 2)).catch((e) => {
          sharedLogs.push(this.log(`PubMed error for "${term}"`, { error: e.message }));
          return [];
        }),
        fetchGoogleScholar(term, 20).catch((e) => {
          sharedLogs.push(this.log(`GoogleScholar error for "${term}"`, { error: e.message }));
          return [];
        }),
      ]);

      allPapers.push(...arxiv, ...semantic, ...pubmed, ...google);
    }

    const filteredBySource = allPapers.filter((p) => ALLOWED_SOURCES.has(p.source));

    sharedLogs.push(this.log("Raw results before deduplication", { count: filteredBySource.length }));

    const unique = deduplicate(filteredBySource);

    let papers;
    if (unique.length === 0) {
      sharedLogs.push(this.log("All allowed sources returned no papers", {
        allowedSources: ["arXiv", "Semantic Scholar", "PubMed", "Google Scholar"],
      }));
      papers = [];
    } else {
      papers = scoreAndRank(unique);
      // Sort: papers with citations first (by score), then uncited sorted by year desc
      papers.sort((a, b) => {
        if (a.citations != null && b.citations != null) return b.relevanceScore - a.relevanceScore;
        if (a.citations != null) return -1;
        if (b.citations != null) return 1;
        return (b.year || 0) - (a.year || 0);
      });
    }

    papers = selectBalancedPapers(papers, FINAL_PAPER_LIMIT);

    const sourceCounts = papers.reduce((acc, p) => {
      acc[p.source] = (acc[p.source] || 0) + 1;
      return acc;
    }, {});

    const availableBySource = unique.reduce((acc, p) => {
      acc[p.source] = (acc[p.source] || 0) + 1;
      return acc;
    }, {});

    sharedLogs.push(this.log("Papers retrieved", {
      total: papers.length,
      limit: FINAL_PAPER_LIMIT,
      availableBySource,
      bySource: sourceCounts,
    }));

    return { papers };
  }
}
