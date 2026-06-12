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
  "bcukamerica",
  "bootcamp uk", // catches all name variants, e.g. "Bootcamp UK - Daytona Beach Outdoor Fitness"
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
    // webOnly: run ONLY the free homepage-fetch + Firecrawl-search steps and skip
    // every Apify call — used for $0-cost testing of social extraction
    webOnly: z.boolean().optional(),
  }),
  retry: { maxAttempts: 3, minTimeoutInMs: 10000, maxTimeoutInMs: 60000 },
  run: async ({ places: rawPlaces, scanDepth, webOnly }) => {
    const apifyToken = process.env.APIFY_TOKEN;
    if (!apifyToken) throw new Error("APIFY_TOKEN is not set");
    const firecrawlKey = process.env.FIRECRAWL_API_KEY;
    if (!firecrawlKey) throw new Error("FIRECRAWL_API_KEY is not set");

    let places = rawPlaces as CompetitorPlace[];
    const seen = new Set(places.map((p) => dedupeKey(p.name, p.postalCode)));

    // Step 0 — Homepage social extraction (free — plain HTTP, no API credits).
    // Most fitness sites link their IG/FB in the page header/footer, so a direct
    // fetch of the homepage covers the majority of competitors at zero cost.
    const sitesToFetch = places.filter((p) => p.website && (!p.instagramHandle || !p.facebookUrl));
    console.log(`Homepage social extraction: ${sitesToFetch.length} sites to fetch (free)`);
    let igFromSites = 0;
    let fbFromSites = 0;
    for (let i = 0; i < sitesToFetch.length; i += 5) {
      const batch = sitesToFetch.slice(i, i + 5);
      await Promise.all(
        batch.map(async (place) => {
          const found = await extractSocialsFromSite(
            place.website!,
            nameMatchToken(place.name),
            extractCity(place.address).toLowerCase().replace(/[^a-z0-9]/g, "")
          );
          if (found.instagramHandle && !place.instagramHandle && !isMwjValue(found.instagramHandle)) {
            place.instagramHandle = found.instagramHandle;
            igFromSites++;
          }
          if (found.facebookUrl && !place.facebookUrl && !isMwjValue(found.facebookUrl)) {
            place.facebookUrl = found.facebookUrl;
            fbFromSites++;
          }
        })
      );
    }
    console.log(`Homepage extraction found: ${igFromSites} Instagram handles, ${fbFromSites} Facebook pages`);

    // Step 0.5 — Firecrawl name-search fallback for competitors with NO socials at
    // all after Step 0 (no website, or homepage had no social links). One web
    // search per competitor; costs Firecrawl credits only, never Apify.
    const noSocials = places.filter((p) => !p.instagramHandle && !p.facebookUrl);
    const fallbackTargets = noSocials.slice(0, 25); // safety cap per run
    console.log(`Firecrawl name-search fallback: ${noSocials.length} competitors with no socials (searching ${fallbackTargets.length}, cap 25)`);
    let fallbackCredits = 0;
    for (const place of fallbackTargets) {
      const result = await firecrawlSearchSocials(firecrawlKey, place.name, extractCity(place.address));
      fallbackCredits += result.creditsUsed;
      if (result.instagramHandle && !isMwjValue(result.instagramHandle)) place.instagramHandle = result.instagramHandle;
      if (result.facebookUrl && !isMwjValue(result.facebookUrl)) place.facebookUrl = result.facebookUrl;
      await wait.for({ seconds: 6 }); // stay under Firecrawl free-tier search rate limit
    }
    if (fallbackTargets.length > 0) {
      console.log(`Firecrawl fallback used ${fallbackCredits} credits total`);
    }

    if (webOnly) {
      console.log(`webOnly mode: skipping all Apify discovery/enrichment — returning ${places.length} places`);
      const webOnlyPlaces: EnrichedCompetitorPlace[] = places.map((p) => ({
        ...p,
        instagramFollowers: null,
        instagramBio: null,
        instagramRecentCaptions: [],
        facebookBio: null,
        facebookPriceRange: null,
        facebookEmail: null,
      }));
      return { places: webOnlyPlaces };
    }

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
      console.log(`IG profile enrichment: ${uniqueIgHandles.length} handles (~$${(uniqueIgHandles.length * 0.0026).toFixed(2)} Apify)`);
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
      console.log(`FB page enrichment: ${uniqueFbUrls.length} pages (~$${(uniqueFbUrls.length * 0.00399).toFixed(2)} Apify)`);
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

// ─── Free homepage social extraction ─────────────────────────────────────────

// instagram.com/<x> and facebook.com/<x> paths that are never a business profile
const IG_RESERVED = new Set([
  "p", "reel", "reels", "explore", "stories", "accounts", "tv", "sharer", "share",
  "embed", "developer", "about", "legal", "directory", "static",
]);
const FB_RESERVED = new Set([
  "sharer", "sharer.php", "share", "share.php", "plugins", "dialog", "tr", "login",
  "events", "groups", "photos", "watch", "hashtag", "profile.php", "policies",
  "policy", "privacy", "help", "home.php", "people", "marketplace", "reel", "stories",
]);

function isMwjValue(value: string): boolean {
  const v = value.toLowerCase();
  return MWJ_ALIASES.some((alias) => v.includes(alias));
}

async function extractSocialsFromSite(siteUrl: string, nameToken: string, cityToken: string): Promise<FoundSocials> {
  const none: FoundSocials = { instagramHandle: null, facebookUrl: null };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(siteUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return none;
    const html = await res.text();
    return extractSocialsFromHtml(html, nameToken, cityToken);
  } catch {
    // Timeouts, DNS failures, SSL errors — site just gets skipped; the Firecrawl
    // fallback step picks these competitors up if no socials were found elsewhere
    return none;
  }
}

function extractSocialsFromHtml(html: string, nameToken = "", cityToken = ""): FoundSocials {
  // Sites often embed links JSON-escaped inside scripts (https:\/\/www...) —
  // unescape so one regex pass catches both forms. Anchoring on the protocol
  // (//) blocks substring hits like cdninstagram.com.
  const text = html.replace(/\\\//g, "/");

  const igCandidates: string[] = [];
  for (const m of text.matchAll(/(?:https?:)?\/\/(?:www\.|m\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})/gi)) {
    const handle = m[1].replace(/\.+$/, "");
    if (handle.length < 3) continue; // 1-2 char handles are template junk in practice
    if (IG_RESERVED.has(handle.toLowerCase())) continue;
    if (!igCandidates.includes(handle)) igCandidates.push(handle);
    if (igCandidates.length >= 10) break;
  }

  // Matches both vanity URLs (facebook.com/MyGym) and legacy page URLs
  // (facebook.com/pages/My-Gym/12345)
  const fbCandidates: string[] = [];
  for (const m of text.matchAll(/(?:https?:)?\/\/(?:www\.|m\.)?facebook\.com\/(pages\/[A-Za-z0-9.\-_%]+\/\d+|[A-Za-z0-9.\-]{3,75})/gi)) {
    const path = m[1].replace(/\/+$/, "");
    const first = path.split("/")[0].toLowerCase();
    if (first !== "pages" && FB_RESERVED.has(first)) continue;
    // Real numeric page IDs are 15+ digits; short ones (facebook.com/2008) are
    // template/footer junk
    if (/^\d{1,9}$/.test(path)) continue;
    if (!fbCandidates.includes(path)) fbCandidates.push(path);
    if (fbCandidates.length >= 10) break;
  }

  // Prefer the candidate that mentions the city (right location for franchises),
  // then the business name, then fall back to first found
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const pick = (candidates: string[]): string | null => {
    if (candidates.length === 0) return null;
    if (cityToken) {
      const c = candidates.find((x) => squash(x).includes(cityToken));
      if (c) return c;
    }
    if (nameToken) {
      const c = candidates.find((x) => squash(x).includes(nameToken));
      if (c) return c;
    }
    return candidates[0];
  };

  const fbPick = pick(fbCandidates);
  return {
    instagramHandle: pick(igCandidates),
    facebookUrl: fbPick ? `https://www.facebook.com/${fbPick}` : null,
  };
}

// ─── Firecrawl name-search fallback ──────────────────────────────────────────

// Words too generic to identify a specific business in a match guard
const GENERIC_NAME_WORDS = new Set([
  "fitness", "training", "trainer", "personal", "gym", "studio", "health", "club",
  "center", "centre", "wellness", "crossfit", "bootcamp", "performance", "athletics",
  "athletic", "strength", "coaching", "body", "beach", "port", "orange", "daytona",
]);

async function firecrawlSearchSocials(
  apiKey: string,
  name: string,
  city: string
): Promise<FoundSocials & { creditsUsed: number }> {
  const none = { instagramHandle: null, facebookUrl: null, creditsUsed: 0 };

  const query = `"${name}" ${city} FL instagram facebook`.replace(/\s+/g, " ").trim();
  let res = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, limit: 5 }),
  });

  if (res.status === 429) {
    await wait.for({ seconds: 30 });
    res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, limit: 5 }),
    });
  }

  if (!res.ok) {
    console.warn(`Firecrawl search failed for "${name}": ${res.status}`);
    return none;
  }

  const body = await res.json() as {
    data?: Array<{ url?: string; title?: string }> | { web?: Array<{ url?: string; title?: string }> };
    creditsUsed?: number;
  };
  const results = Array.isArray(body.data) ? body.data : body.data?.web ?? [];
  const creditsUsed = typeof body.creditsUsed === "number" ? body.creditsUsed : 0;

  // Match guard: a result only counts if it contains a distinctive word from the
  // business name — prevents grabbing some other gym's profile
  const token = nameMatchToken(name);
  let instagramHandle: string | null = null;
  let facebookUrl: string | null = null;

  for (const result of results) {
    const url = String(result.url ?? "");
    const title = String(result.title ?? "");
    const haystack = (url + " " + title).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (token && !haystack.includes(token)) continue;

    if (!instagramHandle || !facebookUrl) {
      const found = extractSocialsFromHtml(url);
      if (found.instagramHandle && !instagramHandle) instagramHandle = found.instagramHandle;
      if (found.facebookUrl && !facebookUrl) facebookUrl = found.facebookUrl;
    }
  }

  return { instagramHandle, facebookUrl, creditsUsed };
}

function nameMatchToken(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !GENERIC_NAME_WORDS.has(w));
  // Fall back to the full squashed name when every word is generic
  return words[0] ?? name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractCity(address: string): string {
  // "1672 Dunlawton Ave, Port Orange, FL 32127" → "Port Orange"
  const parts = address.split(",").map((s) => s.trim());
  const flIdx = parts.findIndex((p) => /\bFL\b/i.test(p));
  return flIdx > 0 ? parts[flIdx - 1] : "";
}

interface FoundSocials {
  instagramHandle: string | null;
  facebookUrl: string | null;
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
