import { schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import type { DiffedCompetitorPlace } from "./types.js";

const CLOSURE_SIGNALS = ["permanently closed", "out of business", "closed permanently", "this place is closed", "no longer in business"];

export const verifyClosure = schemaTask({
  id: "verify-closure",
  schema: z.object({
    candidates: z.array(z.any()),
  }),
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 30000 },
  run: async ({ candidates: rawCandidates }) => {
    const apifyToken = process.env.APIFY_TOKEN;
    if (!apifyToken) throw new Error("APIFY_TOKEN is not set");

    const candidates = rawCandidates as DiffedCompetitorPlace[];
    console.log(`Verifying possible closure for ${candidates.length} candidates`);

    const verified: Array<{ name: string; closureEvidence: string | null }> = [];

    for (const candidate of candidates) {
      const city = extractCity(candidate.address);
      const queries = [
        `"${candidate.name}" ${city} FL`,
        `"${candidate.name}" permanently closed`,
      ];

      let evidence: string | null = null;

      for (const query of queries) {
        if (evidence) break;
        try {
          const results = await searchSerp(apifyToken, query);
          for (const result of results) {
            const text = `${result.title ?? ""} ${result.snippet ?? ""}`.toLowerCase();
            for (const signal of CLOSURE_SIGNALS) {
              if (text.includes(signal)) {
                evidence = `Search result: "${result.title}" — "${result.snippet?.slice(0, 200)}"`;
                break;
              }
            }
            if (evidence) break;
          }
        } catch (err) {
          console.warn(`SERP search failed for "${query}": ${err}`);
        }
        await wait.for({ seconds: 2 });
      }

      verified.push({ name: candidate.name, closureEvidence: evidence });
      console.log(`${candidate.name}: ${evidence ? "possibly closed" : "no closure evidence found"}`);
    }

    return { verified };
  },
});

async function searchSerp(token: string, query: string): Promise<SerpResult[]> {
  const actorId = "s-r~free-google-search-results-serp---only-0-25-per-1-000-results";
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/runs?waitForFinish=45`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ queries: query, resultsPerPage: 10, maxPagesPerQuery: 1 }),
    }
  );

  if (!runRes.ok) {
    const text = await runRes.text();
    throw new Error(`SERP actor failed: ${runRes.status} ${text}`);
  }

  const runBody = await runRes.json() as { data: { status: string; defaultDatasetId: string } };
  const { status, defaultDatasetId } = runBody.data;

  if (status === "RUNNING" || status === "CREATED") {
    for (let i = 0; i < 3; i++) {
      await wait.for({ seconds: 20 });
      const statusRes = await fetch(`https://api.apify.com/v2/datasets/${defaultDatasetId}/items?limit=20`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (statusRes.ok) {
        const items = await statusRes.json() as SerpResult[];
        if (items.length > 0) return items;
      }
    }
    return [];
  }

  const dataRes = await fetch(`https://api.apify.com/v2/datasets/${defaultDatasetId}/items?limit=20`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!dataRes.ok) return [];
  return dataRes.json() as Promise<SerpResult[]>;
}

function extractCity(address: string): string {
  const parts = address.split(",");
  return parts.length >= 2 ? parts[parts.length - 2].trim() : "Port Orange";
}

interface SerpResult {
  title?: string;
  snippet?: string;
  url?: string;
}
