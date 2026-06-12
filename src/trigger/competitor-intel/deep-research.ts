import { schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { google } from "googleapis";
import type { EnrichedCompetitorPlace, ResearchedCompetitorPlace, Offer, Tier, ScanDepth } from "./types.js";

const MWJ_CONTEXT = `
Move With Jacks LLC is a personal training and outdoor bootcamp business in Port Orange, FL.
Owner: Shelby Jacks, ISSA-Certified Personal Trainer, B.S. Health Science.
Services: Outdoor group bootcamp at Riverwalk Park ($60/month, Mon/Thu 6:30pm + Sat 8am),
Private 1-on-1 ($120/week, 2 sessions), Private 12-Week Program ($1,250),
Online Coaching ($50/week), Bootcamp Add-On (+$10/week), Meal Planning ($29–$49/month).
Key advantage: $60/month vs competitors at $197+/month. No contract. Outdoor, community-driven.
`.trim();

export const deepResearch = schemaTask({
  id: "deep-research",
  schema: z.object({
    places: z.array(z.any()),
    scanDepth: z.enum(["demo", "deep", "light"]),
  }),
  retry: { maxAttempts: 2, minTimeoutInMs: 10000, maxTimeoutInMs: 60000 },
  run: async ({ places: rawPlaces, scanDepth }) => {
    const geminiKey = process.env.GEMINI_API_KEY;
    const firecrawlKey = process.env.FIRECRAWL_API_KEY;
    const outscraper = process.env.OUTSCRAPER_API_KEY;
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!geminiKey) throw new Error("GEMINI_API_KEY is not set");
    if (!firecrawlKey) throw new Error("FIRECRAWL_API_KEY is not set");

    const places = rawPlaces as EnrichedCompetitorPlace[];
    const genai = new GoogleGenerativeAI(geminiKey);
    const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });

    // Step 1 — Tiering (skip in light mode — reuse tier from Sheet)
    const tierMap = new Map<string, Tier>();

    if (scanDepth === "light" && spreadsheetId && clientId && clientSecret && refreshToken) {
      // Reload tiers from Sheet
      const sheetTiers = await loadTiersFromSheet(spreadsheetId, clientId!, clientSecret!, refreshToken!);
      for (const [name, tier] of sheetTiers) {
        tierMap.set(name.toLowerCase(), tier);
      }
    } else {
      // Classify via Gemini in batches of 20
      const batches = chunkArray(places, 20);
      for (const batch of batches) {
        const prompt = buildTieringPrompt(batch);
        const result = await model.generateContent(prompt);
        const text = stripFences(result.response.text());
        try {
          const parsed = JSON.parse(text) as Array<{ name: string; tier: string }>;
          for (const item of parsed) {
            const tier = (item.tier === "direct" || item.tier === "adjacent" || item.tier === "peripheral")
              ? item.tier
              : "adjacent";
            tierMap.set(item.name.toLowerCase(), tier);
          }
        } catch {
          console.warn("Tiering JSON parse failed for a batch — defaulting to adjacent");
          for (const p of batch) tierMap.set(p.name.toLowerCase(), "adjacent");
        }
        await wait.for({ seconds: 1 });
      }
    }

    // Step 2 — Website crawl for offer menus (skip in light mode)
    const offersMap = new Map<string, Offer[]>();

    if (scanDepth !== "light") {
      const tosCrawl = scanDepth === "demo"
        ? places.filter((p) => p.website && tierMap.get(p.name.toLowerCase()) === "direct").slice(0, 10)
        : places.filter((p) => p.website && tierMap.get(p.name.toLowerCase()) !== "peripheral");

      console.log(`Website crawl: ${tosCrawl.length} sites`);
      let firecrawlCreditsExhausted = false;

      for (const place of tosCrawl) {
        if (firecrawlCreditsExhausted) break;
        try {
          const pageContent = await crawlSiteForOffers(firecrawlKey, place.website!);
          if (!pageContent) continue;

          // Extract offers using Gemini
          const offerPrompt = buildOfferExtractionPrompt(place.name, pageContent);
          const offerResult = await model.generateContent(offerPrompt);
          const offerText = stripFences(offerResult.response.text());

          try {
            const offers = JSON.parse(offerText) as Offer[];
            offersMap.set(place.name.toLowerCase(), Array.isArray(offers) ? offers : []);
          } catch {
            console.warn(`Offer extraction JSON parse failed for ${place.name}`);
            offersMap.set(place.name.toLowerCase(), []);
          }
          await wait.for({ seconds: 2 });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("402") || msg.toLowerCase().includes("credit") || msg.toLowerCase().includes("quota")) {
            console.warn("Firecrawl credits exhausted — stopping website crawl, continuing pipeline");
            firecrawlCreditsExhausted = true;
          } else {
            console.warn(`Failed to crawl ${place.website}: ${msg}`);
          }
        }
      }
    }

    // Step 3 — Review mining (skip in light mode)
    const reviewsMap = new Map<string, string[]>();

    if (scanDepth !== "light" && outscraper) {
      const directPlaces = places.filter((p) => tierMap.get(p.name.toLowerCase()) === "direct");

      // Score direct-tier competitors so "top N" is meaningful rather than arbitrary ordering.
      // Formula: rating × log10(reviewCount + 1) — rewards well-reviewed, established businesses.
      // Competitors with no rating/review data score 0 and fall to the bottom.
      const scored = directPlaces
        .map((p) => ({
          place: p,
          score: (p.rating ?? 0) * Math.log10((p.reviewCount ?? 0) + 1),
        }))
        .sort((a, b) => b.score - a.score);

      const reviewLimit = scanDepth === "demo" ? 5 : scored.length;
      const reviewsPerPlace = 20; // 20 most-recent reviews in all modes

      console.log(
        `Review mining: top ${Math.min(reviewLimit, scored.length)} direct-tier by score, ${reviewsPerPlace} reviews each`
      );

      for (const { place } of scored.slice(0, reviewLimit)) {
        try {
          const reviews = await fetchOutscraperReviews(outscraper, place.name, place.address, reviewsPerPlace);
          reviewsMap.set(place.name.toLowerCase(), reviews);
        } catch (err) {
          console.warn(`Review mining failed for ${place.name}: ${err}`);
        }
        await wait.for({ seconds: 1 });
      }
    }

    // Step 4 — Load manual verified pricing from Sheet
    const verifiedPricingMap = new Map<string, string>();
    if (spreadsheetId && clientId && clientSecret && refreshToken) {
      try {
        const pricing = await loadVerifiedPricingFromSheet(spreadsheetId, clientId, clientSecret, refreshToken);
        for (const [name, price] of pricing) {
          verifiedPricingMap.set(name.toLowerCase(), price);
        }
      } catch (err) {
        console.warn("Could not load verified pricing from Sheet:", err);
      }
    }

    // Assemble final researched places
    const researched: ResearchedCompetitorPlace[] = places.map((place) => ({
      ...place,
      tier: tierMap.get(place.name.toLowerCase()) ?? "adjacent",
      offers: offersMap.get(place.name.toLowerCase()) ?? [],
      verifiedPricing: verifiedPricingMap.get(place.name.toLowerCase()) ?? null,
      recentReviews: reviewsMap.get(place.name.toLowerCase()) ?? [],
    }));

    console.log(`Deep research complete: ${researched.length} places, ${offersMap.size} with offers, ${reviewsMap.size} with reviews`);
    return { places: researched };
  },
});

async function crawlSiteForOffers(apiKey: string, siteUrl: string): Promise<string | null> {
  // 1. Map the site to find pricing/services pages
  const mapRes = await fetch("https://api.firecrawl.dev/v1/map", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ url: siteUrl, limit: 20 }),
  });

  if (mapRes.status === 402) throw new Error("Firecrawl 402: credits exhausted");
  if (!mapRes.ok) {
    console.warn(`Firecrawl map failed for ${siteUrl}: ${mapRes.status}`);
    return null;
  }

  const mapBody = await mapRes.json() as { links?: string[] };
  const allLinks: string[] = [siteUrl, ...(mapBody.links ?? [])];

  // Filter to pricing/services pages
  const pricingPattern = /pricing|services|rates|memberships|packages|programs|book|train|offer|cost|fee/i;
  const relevantLinks = allLinks.filter((l) => pricingPattern.test(l)).slice(0, 4);
  const pagesToScrape = [siteUrl, ...relevantLinks].slice(0, 5);

  // 2. Scrape each relevant page
  const pageContents: string[] = [];
  for (const pageUrl of pagesToScrape) {
    const scrapeRes = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ url: pageUrl, formats: ["markdown"] }),
    });

    if (scrapeRes.status === 402) throw new Error("Firecrawl 402: credits exhausted");
    if (!scrapeRes.ok) continue;

    const scrapeBody = await scrapeRes.json() as { data?: { markdown?: string } };
    const markdown = scrapeBody.data?.markdown ?? "";
    if (markdown.length > 100) pageContents.push(`## ${pageUrl}\n\n${markdown}`);
    await wait.for({ seconds: 1 });
  }

  return pageContents.length > 0 ? pageContents.join("\n\n---\n\n") : null;
}

function buildOfferExtractionPrompt(businessName: string, pageContent: string): string {
  return `You are extracting pricing and service offerings from a fitness business website.

Business: ${businessName}

Website content:
${pageContent.slice(0, 8000)}

Extract EVERY distinct priced offer from the content above.
A page listing in-person 1-hr sessions, online video sessions, a 12-week one-time program, AND a 12-week recurring program is FOUR separate offers.
Never stop at the first price you find. Capture ALL of them.

Return a JSON array only — no explanation, no markdown fences:
[
  {
    "offerName": "string — descriptive name",
    "format": "string — in-person 1-on-1 | online | group | hybrid",
    "duration": "string or null — e.g. '1 hr', '12 weeks', '6 weeks'",
    "price": "string — e.g. '$80/session', '$75/12 weeks recurring', '$197/month'",
    "cadence": "string or null — per session | weekly | monthly | one-time | recurring",
    "notes": "string or null — contract terms, caps, bundle details"
  }
]

If no pricing is found at all, return an empty array: []`;
}

function buildTieringPrompt(places: EnrichedCompetitorPlace[]): string {
  const list = places.map((p) => ({
    name: p.name,
    categories: p.categories,
    instagramBio: p.instagramBio,
    facebookBio: p.facebookBio,
    address: p.address,
  }));

  return `Classify each fitness business as a competitor tier for Move With Jacks LLC in Port Orange, FL.

${MWJ_CONTEXT}

Tiers:
- "direct": group training, bootcamps, personal trainers, women-focused studios in or near Port Orange/Daytona Beach
- "adjacent": CrossFit boxes, boutique studios, online coaches elsewhere in Volusia County
- "peripheral": large chain gyms (Planet Fitness, Anytime Fitness, LA Fitness etc.) — chain-standard pricing, not relevant to Shelby's positioning

Businesses to classify:
${JSON.stringify(list, null, 2)}

Return a JSON array only — no explanation, no markdown fences:
[{"name": "...", "tier": "direct" | "adjacent" | "peripheral"}]`;
}

async function fetchOutscraperReviews(apiKey: string, name: string, address: string, limit: number): Promise<string[]> {
  const query = `${name} ${address}`;
  const url = new URL("https://api.app.outscraper.com/maps/reviews-v3");
  url.searchParams.set("query", query);
  url.searchParams.set("reviewsLimit", String(limit));
  url.searchParams.set("sort", "newest"); // most recent reviews first
  url.searchParams.set("async", "false");
  url.searchParams.set("language", "en");

  const res = await fetch(url.toString(), { headers: { "X-API-KEY": apiKey } });
  if (!res.ok) return [];

  const body = await res.json() as { data?: Array<{ reviews_data?: Array<{ review_text?: string }> }> };
  const reviews: string[] = [];
  for (const place of body.data ?? []) {
    for (const review of place.reviews_data ?? []) {
      if (review.review_text) reviews.push(review.review_text);
    }
  }
  return reviews.slice(0, limit);
}

function makeOAuth2(clientId: string, clientSecret: string, refreshToken: string) {
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

async function loadVerifiedPricingFromSheet(
  spreadsheetId: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<Map<string, string>> {
  const auth = makeOAuth2(clientId, clientSecret, refreshToken);
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Competitor Registry!C:K",
  });

  const rows = res.data.values ?? [];
  const map = new Map<string, string>();
  for (const row of rows.slice(1)) {
    const name = (row[0] ?? "").toString().toLowerCase().trim();
    const pricing = (row[8] ?? "").toString().trim();
    if (name && pricing) map.set(name, pricing);
  }
  return map;
}

async function loadTiersFromSheet(
  spreadsheetId: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<Map<string, Tier>> {
  const auth = makeOAuth2(clientId, clientSecret, refreshToken);
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Competitor Registry!C:O",
  });

  const rows = res.data.values ?? [];
  const map = new Map<string, Tier>();
  for (const row of rows.slice(1)) {
    const name = (row[0] ?? "").toString().toLowerCase().trim();
    const tier = (row[12] ?? "").toString().toLowerCase().trim() as Tier;
    if (name && (tier === "direct" || tier === "adjacent" || tier === "peripheral")) {
      map.set(name, tier);
    }
  }
  return map;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
}
