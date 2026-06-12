import { schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import type { CompetitorPlace, ScanDepth } from "./types.js";

const CITIES_FULL = [
  "Port Orange",
  "Daytona Beach",
  "Ormond Beach",
  "DeLand",
  "New Smyrna Beach",
  "Deltona",
  "Holly Hill",
  "South Daytona",
];
const CITIES_DEMO = ["Port Orange", "Daytona Beach"];

const CATEGORIES = ["gym", "bootcamp", "fitness studio", "personal trainer", "CrossFit"];

const LIMITS: Record<ScanDepth, number> = { demo: 10, deep: 25, light: 10 };

// All known names/handles for Shelby's business — old branding included
const MWJ_ALIASES = [
  "move with jacks",
  "bcuk port orange",
  "bcukportorange",
  "bootcamp uk port orange",
  "bootcamp uk daytona",
  "386-410-9966",
];

export const scrapeGoogleMaps = schemaTask({
  id: "scrape-google-maps",
  schema: z.object({
    scanDepth: z.enum(["demo", "deep", "light"]),
  }),
  retry: { maxAttempts: 3, minTimeoutInMs: 5000, maxTimeoutInMs: 30000 },
  run: async ({ scanDepth }) => {
    const apiKey = process.env.OUTSCRAPER_API_KEY;
    if (!apiKey) throw new Error("OUTSCRAPER_API_KEY is not set");

    const cities = scanDepth === "demo" ? CITIES_DEMO : CITIES_FULL;
    const limit = LIMITS[scanDepth];

    const seen = new Set<string>();
    const places: CompetitorPlace[] = [];

    for (const city of cities) {
      for (const category of CATEGORIES) {
        const query = `${category} ${city} FL`;
        console.log(`Searching: ${query}`);

        const results = await outscraperSearch(apiKey, query, limit);
        for (const item of results) {
          const key = `${(item.name ?? "").toLowerCase().trim()}_${item.postal_code ?? ""}`;
          if (seen.has(key)) continue;
          const nameAndPhone = `${(item.name ?? "").toLowerCase()} ${item.phone ?? ""}`;
          if (MWJ_ALIASES.some((alias) => nameAndPhone.includes(alias))) continue;

          seen.add(key);
          places.push(normalizePlace(item));
        }

        // Small delay between queries to respect free-tier rate limits
        await wait.for({ seconds: 1 });
      }
    }

    console.log(`Google Maps: ${places.length} unique competitors found`);
    return { places };
  },
});

async function outscraperSearch(apiKey: string, query: string, limit: number): Promise<OutscraperResult[]> {
  const url = new URL("https://api.app.outscraper.com/maps/search-v3");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("async", "false");
  url.searchParams.set("fields", "name,full_address,phone,site,rating,reviews,postal_code,type,social_links");

  const res = await fetch(url.toString(), {
    headers: { "X-API-KEY": apiKey },
  });

  // Outscraper sometimes returns 202 for async fallback
  if (res.status === 202) {
    const body = await res.json() as { id: string; results_location: string };
    console.log(`Outscraper returned 202 for "${query}" — polling results`);
    return pollOutscraperResults(apiKey, body.results_location);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Outscraper API error ${res.status}: ${text}`);
  }

  const body = await res.json() as { data?: OutscraperResult[][] };
  const results = body.data?.flat() ?? [];
  if (results.length > 0) {
    console.log("Outscraper raw sample (first result keys):", JSON.stringify(Object.keys(results[0])));
    console.log("Outscraper raw sample (first result):", JSON.stringify(results[0]));
  }
  return results;
}

async function pollOutscraperResults(apiKey: string, resultsUrl: string): Promise<OutscraperResult[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await wait.for({ seconds: 15 });
    const res = await fetch(resultsUrl, { headers: { "X-API-KEY": apiKey } });
    if (!res.ok) continue;

    const body = await res.json() as { status?: string; data?: OutscraperResult[][] };
    if (body.status === "Success" && body.data) {
      return body.data.flat();
    }
  }
  console.warn("Outscraper polling timed out — returning empty array for this query");
  return [];
}

function normalizePlace(item: OutscraperResult): CompetitorPlace {
  // Extract Instagram handle from social links if available
  let instagramHandle: string | null = null;
  let facebookUrl: string | null = null;

  const site = item.site ?? item.website ?? "";
  const socialLinks: string[] = item.social_links ?? [];

  // Check direct social fields first
  if (item.instagram) {
    const match = item.instagram.match(/instagram\.com\/([^/?#]+)/);
    instagramHandle = match ? match[1] : item.instagram.replace(/^@/, "");
  }
  if (item.facebook) facebookUrl = item.facebook;

  // Then check social_links array
  for (const link of socialLinks) {
    if (!instagramHandle && link.includes("instagram.com")) {
      const match = link.match(/instagram\.com\/([^/?#]+)/);
      if (match) instagramHandle = match[1];
    }
    if (!facebookUrl && link.includes("facebook.com")) {
      facebookUrl = link;
    }
  }

  // Also check the main site field for FB/IG
  if (!facebookUrl && site.includes("facebook.com")) facebookUrl = site;
  if (!instagramHandle && site.includes("instagram.com")) {
    const match = site.match(/instagram\.com\/([^/?#]+)/);
    if (match) instagramHandle = match[1];
  }

  return {
    name: item.name ?? "Unknown",
    address: item.full_address ?? item.address ?? "",
    phone: item.phone ?? null,
    website: !site.includes("facebook.com") && !site.includes("instagram.com") ? site || null : null,
    rating: typeof item.rating === "number" ? item.rating : null,
    reviewCount: typeof item.reviews === "number" ? item.reviews : null,
    instagramHandle,
    facebookUrl,
    categories: item.type ? [item.type] : [],
    source: "outscraper",
    postalCode: item.postal_code ?? "",
  };
}

// Loose typing for Outscraper response — fields vary by result
interface OutscraperResult {
  name?: string;
  full_address?: string;
  address?: string;
  phone?: string;
  site?: string;
  rating?: number;
  reviews?: number;
  postal_code?: string;
  type?: string;
  social_links?: string[];
  // Alternative field names Outscraper may use
  website?: string;
  instagram?: string;
  facebook?: string;
  twitter?: string;
  linkedin?: string;
}
