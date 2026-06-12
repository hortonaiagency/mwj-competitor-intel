import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { google } from "googleapis";
import type { ResearchedCompetitorPlace, DiffedCompetitorPlace, ChangeStatus, Tier } from "./types.js";

export const compareCompetitors = schemaTask({
  id: "compare-competitors",
  schema: z.object({
    places: z.array(z.any()),
    scanDepth: z.enum(["demo", "deep", "light"]),
  }),
  retry: { maxAttempts: 3, minTimeoutInMs: 5000, maxTimeoutInMs: 30000 },
  run: async ({ places: rawPlaces, scanDepth }) => {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is not set");
    if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not set");
    if (!clientSecret) throw new Error("GOOGLE_CLIENT_SECRET is not set");
    if (!refreshToken) throw new Error("GOOGLE_REFRESH_TOKEN is not set");

    const places = rawPlaces as ResearchedCompetitorPlace[];

    // Load baseline from Sheet
    const baseline = await loadBaseline(spreadsheetId, clientId, clientSecret, refreshToken);
    console.log(`Baseline: ${baseline.size} known competitors in Sheet`);

    let newCount = 0, changedCount = 0, missingCount = 0;

    // Classify each found competitor
    const diffed: DiffedCompetitorPlace[] = places.map((place) => {
      const key = baselineKey(place.name, place.postalCode);
      const prior = baseline.get(key);

      if (!prior) {
        newCount++;
        return {
          ...place,
          changeStatus: "new" as ChangeStatus,
          changedFields: [],
          missedScans: 0,
          closureEvidence: null,
        };
      }

      // Mark this key as "seen this scan" so we can detect gone ones
      baseline.delete(key);

      // Detect meaningful changes
      const changedFields: string[] = [];

      if (prior.rating !== null && place.rating !== null && Math.abs(prior.rating - place.rating) >= 0.2) {
        changedFields.push("rating");
      }
      if (prior.reviewCount !== null && place.reviewCount !== null && place.reviewCount !== prior.reviewCount) {
        changedFields.push("reviewCount");
      }
      if (prior.instagramFollowers !== null && place.instagramFollowers !== null) {
        const pct = Math.abs(place.instagramFollowers - prior.instagramFollowers) / (prior.instagramFollowers || 1);
        if (pct >= 0.1) changedFields.push("instagramFollowers");
      }
      if (prior.facebookPriceRange !== place.facebookPriceRange && place.facebookPriceRange) {
        changedFields.push("facebookPriceRange");
      }
      if (offersChanged(prior.offers ?? [], place.offers)) {
        changedFields.push("offers");
      }

      if (changedFields.length > 0) {
        changedCount++;
        return {
          ...place,
          changeStatus: "changed" as ChangeStatus,
          changedFields,
          missedScans: 0,
          closureEvidence: null,
        };
      }

      return {
        ...place,
        changeStatus: "unchanged" as ChangeStatus,
        changedFields: [],
        missedScans: 0,
        closureEvidence: null,
      };
    });

    // Remaining keys in baseline were not found this scan — mark as missing
    // But only increment missed count for sources this scan was able to query
    // Light scans skip social discovery, so hashtag-only competitors can't be missing
    const canBeMissing = (source: string) => {
      if (scanDepth === "light" && (source === "instagram-discovery" || source === "facebook-discovery")) {
        return false;
      }
      return true;
    };

    for (const [, prior] of baseline) {
      if (!canBeMissing(prior.source)) continue;
      missingCount++;
      diffed.push({
        name: prior.name,
        address: prior.address,
        phone: prior.phone,
        website: prior.website,
        rating: prior.rating,
        reviewCount: prior.reviewCount,
        instagramHandle: prior.instagramHandle,
        facebookUrl: prior.facebookUrl,
        categories: prior.categories,
        source: prior.source as "outscraper" | "instagram-discovery" | "facebook-discovery",
        postalCode: prior.postalCode,
        instagramFollowers: prior.instagramFollowers,
        instagramBio: prior.instagramBio,
        instagramRecentCaptions: prior.instagramRecentCaptions,
        facebookBio: prior.facebookBio,
        facebookPriceRange: prior.facebookPriceRange,
        facebookEmail: prior.facebookEmail,
        tier: prior.tier,
        offers: prior.offers,
        verifiedPricing: prior.verifiedPricing,
        recentReviews: prior.recentReviews,
        changeStatus: "missing" as ChangeStatus,
        changedFields: [],
        missedScans: (prior.missedScans ?? 0) + 1,
        closureEvidence: null,
      });
    }

    console.log(`Compare: ${newCount} new, ${changedCount} changed, ${diffed.filter(p => p.changeStatus === "unchanged").length} unchanged, ${missingCount} missing`);
    return { places: diffed, newCount, changedCount, missingCount };
  },
});

interface BaselineEntry {
  name: string;
  postalCode: string;
  source: string;
  rating: number | null;
  reviewCount: number | null;
  instagramFollowers: number | null;
  facebookPriceRange: string | null;
  offers: Array<{ price: string; offerName: string; format: string; duration: string | null; cadence: string | null; notes: string | null }>;
  missedScans: number;
  tier: Tier;
  // Full place data for reconstructing "missing" entries
  address: string;
  phone: string | null;
  website: string | null;
  instagramHandle: string | null;
  facebookUrl: string | null;
  categories: string[];
  instagramBio: string | null;
  instagramRecentCaptions: string[];
  facebookBio: string | null;
  facebookEmail: string | null;
  verifiedPricing: string | null;
  recentReviews: string[];
}

async function loadBaseline(spreadsheetId: string, clientId: string, clientSecret: string, refreshToken: string): Promise<Map<string, BaselineEntry>> {
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Competitor Registry!A:R",
  });

  const rows = res.data.values ?? [];
  const map = new Map<string, BaselineEntry>();

  // Headers: A=First Seen, B=Last Seen, C=Competitor Name, D=Address, E=Phone,
  // F=Website, G=Instagram Handle, H=Facebook URL, I=Categories, J=Offers(JSON),
  // K=Verified Pricing (manual), L=Rating, M=Review Count, N=Source, O=Tier,
  // P=Notes, Q=Change Status, R=Missed Scans
  for (const row of rows.slice(1)) {
    const name = (row[2] ?? "").toString().trim();
    const address = (row[3] ?? "").toString().trim();
    const postalCode = extractPostalCode(address);

    if (!name) continue;

    let offers: BaselineEntry["offers"] = [];
    try {
      const offersJson = (row[9] ?? "").toString();
      if (offersJson) offers = JSON.parse(offersJson);
    } catch { /* ignore parse errors */ }

    const entry: BaselineEntry = {
      name,
      postalCode,
      address,
      phone: row[4]?.toString() ?? null,
      website: row[5]?.toString() ?? null,
      instagramHandle: row[6]?.toString() ?? null,
      facebookUrl: row[7]?.toString() ?? null,
      categories: row[8] ? (row[8] as string).split(",").map((s: string) => s.trim()) : [],
      offers,
      verifiedPricing: row[10]?.toString() ?? null,
      rating: row[11] ? parseFloat(row[11] as string) : null,
      reviewCount: row[12] ? parseInt(row[12] as string) : null,
      source: row[13]?.toString() ?? "outscraper",
      tier: (row[14]?.toString() ?? "adjacent") as Tier,
      instagramFollowers: null,
      instagramBio: null,
      instagramRecentCaptions: [],
      facebookBio: null,
      facebookPriceRange: null,
      facebookEmail: null,
      recentReviews: [],
      missedScans: row[17] ? parseInt(row[17] as string) : 0,
    };

    map.set(baselineKey(name, postalCode), entry);
  }

  return map;
}

function offersChanged(
  prior: Array<{ price: string; offerName: string }>,
  current: Array<{ price: string; offerName: string }>
): boolean {
  if (prior.length !== current.length) return true;
  const priorPrices = new Set(prior.map((o) => `${o.offerName}|${o.price}`));
  return current.some((o) => !priorPrices.has(`${o.offerName}|${o.price}`));
}

function baselineKey(name: string, postalCode: string): string {
  return `${name.toLowerCase().trim()}_${postalCode}`;
}

function extractPostalCode(address: string): string {
  const match = address.match(/\b\d{5}\b/);
  return match ? match[0] : "";
}
