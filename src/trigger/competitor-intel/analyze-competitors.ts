import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { DiffedCompetitorPlace, AnalysisResult, RunCounts } from "./types.js";

const MWJ_FULL_CONTEXT = `
Move With Jacks LLC — Port Orange, FL
Owner: Shelby Jacks, ISSA-Certified Personal Trainer, B.S. Health Science, active powerlifter
Personal story: Lost 60 lbs through training — this transformation is the brand's primary trust asset

SERVICES & PRICING:
- Park Bootcamp (group outdoor, Riverwalk Park, Mon/Thu 6:30pm + Sat 8am): $60/month, no contract, beginner-friendly
- Private 1-on-1 Training (2 sessions/week, 1hr each): $120/week
- Private 12-Week Program: $1,250 total (~$104/week)
- Online Coaching (custom programming + weekly Zoom): $50/week
- Bootcamp Add-On (for private/online clients): +$10/week
- Meal Planning Add-On: $29–$49/month (stays within ISSA scope)

KEY COMPETITIVE ADVANTAGES:
- Price: $60/month vs. Fit Body Boot Camp at ~$197/month (3x more expensive)
- No contract
- Outdoor, community setting (Riverwalk Park)
- Personal transformation story — real person, not a franchise
- Programs adapt to postpartum, perimenopause, beginners, returners

THREE PERSONAS:
1. "Mom Who's Ready" — 28–42, postpartum/busy mom, intimidated by gyms
2. "Strong at 55+" — 50–70, wants to stay mobile, doesn't want HIIT intimidation
3. "Get Back to Me" — 25–50, working professional, habit lapsed

BRAND VOICE: Warm, welcoming, empowering. No "beast mode", no shame, no diet culture.

APPROVED TAGLINES: "Move better. Live stronger." / "Strength that meets you where you are."
`.trim();

export const analyzeCompetitors = schemaTask({
  id: "analyze-competitors",
  schema: z.object({
    places: z.array(z.any()),
    runDate: z.string(),
    counts: z.object({
      total: z.number(),
      newCount: z.number(),
      changedCount: z.number(),
      missingCount: z.number(),
      goneCount: z.number(),
    }),
  }),
  retry: { maxAttempts: 3, minTimeoutInMs: 5000, maxTimeoutInMs: 30000 },
  run: async ({ places: rawPlaces, runDate, counts }) => {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error("GEMINI_API_KEY is not set");

    const places = rawPlaces as DiffedCompetitorPlace[];
    const genai = new GoogleGenerativeAI(geminiKey);
    const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });

    // Only include non-peripheral competitors with meaningful data for the prompt
    const relevant = places.filter((p) => p.tier !== "peripheral");
    const possiblyClosed = places.filter((p) => p.changeStatus === "possibly-closed");
    const missing = places.filter((p) => p.changeStatus === "missing");

    // Summarize competitor data for prompt (keep token count manageable)
    const competitorSummaries = relevant.slice(0, 60).map((p) => ({
      name: p.name,
      address: p.address,
      tier: p.tier,
      changeStatus: p.changeStatus,
      changedFields: p.changedFields,
      rating: p.rating,
      reviewCount: p.reviewCount,
      instagramFollowers: p.instagramFollowers,
      instagramBio: p.instagramBio,
      instagramRecentCaptions: p.instagramRecentCaptions.slice(0, 3),
      facebookBio: p.facebookBio,
      pricing: p.verifiedPricing ?? p.facebookPriceRange ?? null,
      offers: p.offers.slice(0, 8),
      recentReviews: p.recentReviews.slice(0, 5),
      closureEvidence: p.closureEvidence,
    }));

    const prompt = buildAnalysisPrompt(competitorSummaries, counts, runDate, possiblyClosed, missing);

    let analysisText = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await model.generateContent(prompt);
      analysisText = stripFences(result.response.text());
      try {
        JSON.parse(analysisText);
        break; // valid JSON — exit retry loop
      } catch {
        console.warn(`Gemini returned invalid JSON on attempt ${attempt + 1}`);
        if (attempt === 2) throw new Error("Gemini failed to return valid JSON after 3 attempts");
      }
    }

    const analysis = JSON.parse(analysisText) as AnalysisResult;
    console.log(`Analysis complete: ${analysis.competitors.length} competitor profiles, ${analysis.whiteSpace.length} white-space gaps`);
    return { analysis };
  },
});

function buildAnalysisPrompt(
  competitors: Record<string, unknown>[],
  counts: RunCounts,
  runDate: string,
  possiblyClosed: DiffedCompetitorPlace[],
  missing: DiffedCompetitorPlace[]
): string {
  const OFFER_CATEGORIES = [
    "group bootcamp (outdoor)",
    "group bootcamp (indoor)",
    "private 1-on-1 training (in-person)",
    "private 1-on-1 training (online)",
    "12-week program",
    "online coaching",
    "women-only class",
    "55+ / senior class",
    "postpartum program",
    "nutrition / meal planning",
    "CrossFit / barbell program",
  ];

  return `You are a competitive intelligence analyst for Move With Jacks LLC.

BUSINESS CONTEXT:
${MWJ_FULL_CONTEXT}

RUN DATE: ${runDate}
CHANGE SUMMARY: ${counts.newCount} new competitors found, ${counts.changedCount} changed, ${counts.missingCount} missing/not-found this week

COMPETITOR DATA:
${JSON.stringify(competitors, null, 2)}

POSSIBLY CLOSED (missed 2+ deep scans with closure evidence):
${JSON.stringify(possiblyClosed.map((p) => ({ name: p.name, address: p.address, closureEvidence: p.closureEvidence })), null, 2)}

STILL MISSING (missed scans but no closure evidence):
${JSON.stringify(missing.map((p) => ({ name: p.name, address: p.address, missedScans: p.missedScans })), null, 2)}

OFFER TAXONOMY TO USE FOR MATRIX:
${OFFER_CATEGORIES.join(", ")}

INSTRUCTIONS:
1. executiveSummary: 3–5 sentences. Lead with change counts. Highlight the most notable finding (new entrant, price change, closure). Reference Shelby's $60/month vs. competitors.
2. competitorMoves: Array of strings. Each describes a specific promo, launch, or campaign spotted in Instagram captions this week (e.g. "Fit Body Boot Camp Port Orange launched a 6-week summer challenge at $199"). Only include if actual caption evidence exists — don't fabricate.
3. offerMatrix: For each offer category in the taxonomy, list which competitors offer it, whether Shelby offers it, and the price range found (e.g. "$60–$197/month"). Be precise.
4. whiteSpace: Array of specific gaps Shelby could own (e.g. "No competitor in Port Orange offers outdoor group training under $75/month", "No one targets postpartum specifically in Port Orange"). Be concrete, cite evidence.
5. weaknessThemes: For competitors with reviews, cluster review complaints into themes (e.g. "contract trap", "overcrowded classes", "impersonal/no community"). These are positioning ammunition.
6. competitors: One object per competitor. For NEW and CHANGED: full treatment with all fields. For UNCHANGED: brief one-liner only (set positioningVsJacks to "No change from prior week"). For MISSING/POSSIBLY-CLOSED: include with appropriate note.
   - pricingNote: Use verifiedPricing if present (note it as "verified manually"). Otherwise use best available scraped data. If nothing, say "Pricing not public".
7. overallPositioningNote: 2–3 sentences. How does Shelby's full offering compare to the landscape? What is her clearest unique position this week?

Return ONLY a valid JSON object matching this exact schema — no explanation, no markdown fences:
{
  "executiveSummary": "string",
  "competitorMoves": ["string"],
  "offerMatrix": [
    { "category": "string", "competitorsOffering": ["string"], "shelbyOffers": boolean, "priceRange": "string" }
  ],
  "whiteSpace": ["string"],
  "weaknessThemes": [
    { "competitor": "string", "themes": ["string"] }
  ],
  "competitors": [
    {
      "name": "string",
      "oneLinerSummary": "string",
      "pricingNote": "string",
      "socialPresence": "string",
      "positioningVsJacks": "string"
    }
  ],
  "overallPositioningNote": "string"
}`;
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
}
