import { schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import type { CompetitorPlace, EnrichedCompetitorPlace, ScanDepth } from "./types.js";

const LOCAL_KEYWORDS = ["port orange", "daytona", "ormond", "deland", "new smyrna", "volusia", "deltona", "holly hill"];

// All known handles/names for Shelby's business — filter these out everywhere
const MWJ_ALIASES = [
  "move with jacks",
  "movwithjacks",
  "bcukportorange",
  "bcuk port orange",
  "bootcamp uk port orange",
  "bootcamp uk daytona",
  "386-410-9966",
];
const FITNESS_KEYWORDS = ["trainer", "coach", "fitness", "bootcamp", "workout", "cpt", "nasm", "issa", "personal training", "strength", "gym"];

const IG_HASHTAGS_FULL = [
  "portorangefitness", "portorangepersonaltrainer", "portorangebootcamp",
  "daytonafitness", "daytonabeachfitness", "daytonabootcamp", "daytonapersonaltrainer",
  "ormondfitness", "ormondbeachfitness", "delandfitness",
  "newsmyrnabeachfitness", "volusiafitness", "volusiacountyfitness",
  "centralfloridafitness", "centralfloridapersonaltrainer",
];
const IG_HASHTAGS_DEMO = ["portorangefitness", "daytonafitness", "volusiafitness"];

const CITIES_FULL = ["Port Orange", "Daytona Beach", "Ormond Beach", "DeLand", "New Smyrna Beach", "Deltona", "Holly Hill", "South Daytona"];
const CATEGORIES_FB = ["gym", "personal trainer", "fitness bootcamp", "fitness studio", "CrossFit"];

export const scrapeSocial = schemaTask({
  id: "scrape-social",
  schema: z.object({
    places: z.array(z.any()),
    scanDepth: z.enum(["demo", "deep", "light"]),
  }),
  retry: { maxAttempts: 3, minTimeoutInMs: 10000, maxTimeoutInMs: 60000 },
  run: async ({ places: rawPlaces, scanDepth }) => {
    const apifyToken = process.env.APIFY_TOKEN;
    if (!apifyToken) throw new Error("APIFY_TOKEN is not set");

    let places = rawPlaces as CompetitorPlace[];
    const seen = new Set(places.map((p) => dedupeKey(p.name, p.postalCode)));

    // Step 1 — Instagram hashtag discovery (skip in light mode)
    const newIgHandles: string[] = [];
    if (scanDepth !== "light") {
      const hashtags = scanDepth === "demo" ? IG_HASHTAGS_DEMO : IG_HASHTAGS_FULL;
      const postsLimit = scanDepth === "demo" ? 20 : 100;
      console.log(`IG hashtag discovery: ${hashtags.length} hashtags × ${postsLimit} posts`);

      const hashtagData = await runApifyActor(apifyToken, "apify/instagram-hashtag-scraper", {
        hashtags: hashtags, // actor expects handles without # prefix
        resultsLimit: postsLimit,
      });

      const discoveredHandles = new Set<string>();
      for (const post of hashtagData) {
        const username: string = String(post.ownerUsername ?? post.username ?? "");
        if (!username || discoveredHandles.has(username)) continue;

        const bio: string = String(post.ownerBio ?? post.bio ?? "").toLowerCase();
        const caption: string = String(post.caption ?? "").toLowerCase();
        const combined = `${bio} ${caption}`;

        const isFitness = FITNESS_KEYWORDS.some((k) => combined.includes(k));
        const isLocal = LOCAL_KEYWORDS.some((k) => combined.includes(k));
        const isShelby = MWJ_ALIASES.some((alias) => username.toLowerCase().includes(alias) || combined.includes(alias));

        if (isFitness && isLocal && !isShelby) {
          discoveredHandles.add(username);
          newIgHandles.push(username);
        }
      }
      console.log(`IG discovery: ${newIgHandles.length} local fitness accounts found`);
    }

    // Step 2 — Facebook page discovery (skip in light mode)
    const newFbUrls: string[] = [];
    if (scanDepth !== "light") {
      const queries: string[] = [];
      if (scanDepth === "demo") {
        queries.push("personal trainer Port Orange FL", "fitness bootcamp Daytona Beach FL");
      } else {
        for (const city of CITIES_FULL) {
          for (const cat of CATEGORIES_FB) {
            queries.push(`${cat} ${city} FL`);
          }
        }
      }
      console.log(`FB page discovery: ${queries.length} queries`);

      for (const query of queries) {
        const fbData = await runApifyActor(apifyToken, "data-slayer/facebook-search-pages", { query, limit: 10 });
        for (const page of fbData) {
          const url: string = String(page.profileUrl ?? page.url ?? "");
          const pagePhone: string = String(page.phone ?? "");
          const isShelbyFb = MWJ_ALIASES.some((alias) => url.toLowerCase().includes(alias) || pagePhone.includes(alias));
          if (url && !newFbUrls.includes(url) && !isShelbyFb) newFbUrls.push(url);
        }
        await wait.for({ seconds: 2 });
      }
      console.log(`FB discovery: ${newFbUrls.length} pages found`);
    }

    // Collect all Instagram handles to enrich (existing + newly discovered)
    const allIgHandles = [
      ...places.filter((p) => p.instagramHandle).map((p) => p.instagramHandle!),
      ...newIgHandles,
    ];
    const uniqueIgHandles = [...new Set(allIgHandles)];

    // Collect all Facebook URLs to enrich (existing + newly discovered)
    const allFbUrls = [
      ...places.filter((p) => p.facebookUrl).map((p) => p.facebookUrl!),
      ...newFbUrls,
    ];
    const uniqueFbUrls = [...new Set(allFbUrls)];

    // Step 3 — Instagram profile enrichment
    const igProfileMap = new Map<string, IgProfile>();
    if (uniqueIgHandles.length > 0) {
      console.log(`IG profile enrichment: ${uniqueIgHandles.length} handles`);
      const igData = await runApifyActor(apifyToken, "apify/instagram-profile-scraper", {
        usernames: uniqueIgHandles,
      });
      for (const profile of igData) {
        const username: string = String(profile.username ?? "");
        if (username) {
          const latestPosts = Array.isArray(profile.latestPosts) ? profile.latestPosts : [];
          igProfileMap.set(username.toLowerCase(), {
            followers: typeof profile.followersCount === "number" ? profile.followersCount : null,
            bio: profile.biography != null ? String(profile.biography) : null,
            recentCaptions: latestPosts
              .map((p: unknown) => String((p as Record<string, unknown>).caption ?? ""))
              .filter(Boolean)
              .slice(0, 10),
            website: profile.externalUrl != null ? String(profile.externalUrl) : null,
          });
        }
      }
    }

    // Step 4 — Facebook page enrichment
    const fbPageMap = new Map<string, FbPage>();
    if (uniqueFbUrls.length > 0) {
      console.log(`FB page enrichment: ${uniqueFbUrls.length} pages`);
      const fbData = await runApifyActor(apifyToken, "corent1robert/facebook-page-contact-scraper", {
        pageUrls: uniqueFbUrls.map((url) => ({ url })),
      });
      for (const page of fbData) {
        const url: string = String(page.pageUrl ?? page.url ?? "");
        const phone: string = String(page.phone ?? "");
        const isShelby = MWJ_ALIASES.some((alias) => url.toLowerCase().includes(alias) || phone.includes(alias));
        if (url && !isShelby) {
          fbPageMap.set(normalizeUrl(url), {
            bio: page.about != null ? String(page.about) : page.description != null ? String(page.description) : null,
            priceRange: page.priceRange != null ? String(page.priceRange) : null,
            email: page.email != null ? String(page.email) : null,
            phone: page.phone != null ? String(page.phone) : null,
          });
        }
      }
    }

    // Build enriched places array — start with existing places
    const enrichedMap = new Map<string, EnrichedCompetitorPlace>();

    for (const place of places) {
      const igProfile = place.instagramHandle ? igProfileMap.get(place.instagramHandle.toLowerCase()) : null;
      const fbPage = place.facebookUrl ? fbPageMap.get(normalizeUrl(place.facebookUrl)) : null;

      const enriched: EnrichedCompetitorPlace = {
        ...place,
        instagramFollowers: igProfile?.followers ?? null,
        instagramBio: igProfile?.bio ?? null,
        instagramRecentCaptions: igProfile?.recentCaptions ?? [],
        facebookBio: fbPage?.bio ?? null,
        facebookPriceRange: fbPage?.priceRange ?? null,
        facebookEmail: fbPage?.email ?? null,
        // Fill in phone from FB if not already present
        phone: place.phone ?? fbPage?.phone ?? null,
        // Fill in website from IG if not already present
        website: place.website ?? igProfile?.website ?? null,
      };
      enrichedMap.set(dedupeKey(place.name, place.postalCode), enriched);
    }

    // Add Instagram-discovery-only accounts not already in places
    for (const handle of newIgHandles) {
      const igProfile = igProfileMap.get(handle.toLowerCase());
      if (!igProfile) continue;

      const name = handle; // Use handle as name placeholder
      const key = `ig_${handle.toLowerCase()}`;
      if (seen.has(key) || enrichedMap.has(key)) continue;

      seen.add(key);
      enrichedMap.set(key, {
        name,
        address: "",
        phone: null,
        website: igProfile.website ?? null,
        rating: null,
        reviewCount: null,
        instagramHandle: handle,
        facebookUrl: null,
        categories: [],
        source: "instagram-discovery",
        postalCode: "",
        instagramFollowers: igProfile.followers,
        instagramBio: igProfile.bio,
        instagramRecentCaptions: igProfile.recentCaptions,
        facebookBio: null,
        facebookPriceRange: null,
        facebookEmail: null,
      });
    }

    // Add Facebook-discovery-only pages not already in places
    for (const fbUrl of newFbUrls) {
      const fbPage = fbPageMap.get(normalizeUrl(fbUrl));
      if (!fbPage) continue;

      const key = `fb_${normalizeUrl(fbUrl)}`;
      if (seen.has(key) || enrichedMap.has(key)) continue;

      seen.add(key);
      enrichedMap.set(key, {
        name: fbUrl, // placeholder, will be refined in deep-research tiering
        address: "",
        phone: fbPage.phone ?? null,
        website: null,
        rating: null,
        reviewCount: null,
        instagramHandle: null,
        facebookUrl: fbUrl,
        categories: [],
        source: "facebook-discovery",
        postalCode: "",
        instagramFollowers: null,
        instagramBio: null,
        instagramRecentCaptions: [],
        facebookBio: fbPage.bio,
        facebookPriceRange: fbPage.priceRange,
        facebookEmail: fbPage.email,
      });
    }

    const result = Array.from(enrichedMap.values());
    console.log(`Social complete: ${result.length} total enriched competitors`);
    return { places: result };
  },
});

async function runApifyActor(token: string, actorId: string, input: Record<string, unknown>): Promise<ApifyItem[]> {
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${actorId.replace("/", "~")}/runs?waitForFinish=45`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    }
  );

  if (!runRes.ok) {
    const text = await runRes.text();
    throw new Error(`Apify actor ${actorId} failed to start: ${runRes.status} ${text}`);
  }

  const runBody = await runRes.json() as { data: { id: string; status: string; defaultDatasetId: string } };
  const { id: runId, status, defaultDatasetId } = runBody.data;

  // If still running after 45s, poll
  if (status === "RUNNING" || status === "CREATED") {
    for (let attempt = 0; attempt < 3; attempt++) {
      await wait.for({ seconds: 30 });
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const statusBody = await statusRes.json() as { data: { status: string; defaultDatasetId: string } };
      if (statusBody.data.status === "SUCCEEDED") break;
      if (statusBody.data.status === "FAILED" || statusBody.data.status === "ABORTED") {
        throw new Error(`Apify actor ${actorId} run ${runId} failed with status ${statusBody.data.status}`);
      }
    }
  }

  const datasetRes = await fetch(
    `https://api.apify.com/v2/datasets/${defaultDatasetId}/items?limit=500`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!datasetRes.ok) throw new Error(`Failed to fetch Apify dataset ${defaultDatasetId}`);
  return datasetRes.json() as Promise<ApifyItem[]>;
}

function dedupeKey(name: string, postalCode: string): string {
  return `${name.toLowerCase().trim()}_${postalCode}`;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "").toLowerCase();
}

interface IgProfile {
  followers: number | null;
  bio: string | null;
  recentCaptions: string[];
  website: string | null;
}

interface FbPage {
  bio: string | null;
  priceRange: string | null;
  email: string | null;
  phone: string | null;
}

type ApifyItem = Record<string, unknown>;
