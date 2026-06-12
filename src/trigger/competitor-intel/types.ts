export type ScanDepth = "demo" | "deep" | "light";
export type ChangeStatus = "new" | "changed" | "unchanged" | "missing" | "possibly-closed";
export type Tier = "direct" | "adjacent" | "peripheral";

export interface Offer {
  offerName: string;
  format: string;        // "in-person 1-on-1" | "online" | "group" | "hybrid"
  duration: string | null;
  price: string;
  cadence: string | null; // "per session" | "weekly" | "monthly" | "one-time"
  notes: string | null;
}

export interface CompetitorPlace {
  name: string;
  address: string;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  instagramHandle: string | null;
  facebookUrl: string | null;
  categories: string[];
  source: "outscraper" | "instagram-discovery" | "facebook-discovery";
  postalCode: string;
}

export interface EnrichedCompetitorPlace extends CompetitorPlace {
  instagramFollowers: number | null;
  instagramBio: string | null;
  instagramRecentCaptions: string[];
  facebookBio: string | null;
  facebookPriceRange: string | null;
  facebookEmail: string | null;
}

export interface ResearchedCompetitorPlace extends EnrichedCompetitorPlace {
  tier: Tier;
  offers: Offer[];
  verifiedPricing: string | null; // human-entered in Sheet column K — authoritative, never overwritten
  recentReviews: string[];
}

export interface DiffedCompetitorPlace extends ResearchedCompetitorPlace {
  changeStatus: ChangeStatus;
  changedFields: string[];
  missedScans: number;
  closureEvidence: string | null;
}

export interface AnalysisResult {
  executiveSummary: string;
  competitorMoves: string[];
  offerMatrix: Array<{
    category: string;
    competitorsOffering: string[];
    shelbyOffers: boolean;
    priceRange: string;
  }>;
  whiteSpace: string[];
  weaknessThemes: Array<{
    competitor: string;
    themes: string[];
  }>;
  competitors: Array<{
    name: string;
    oneLinerSummary: string;
    pricingNote: string;
    socialPresence: string;
    positioningVsJacks: string;
  }>;
  overallPositioningNote: string;
}

export interface RunCounts {
  total: number;
  newCount: number;
  changedCount: number;
  missingCount: number;
  goneCount: number;
}
