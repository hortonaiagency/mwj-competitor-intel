import { schedules } from "@trigger.dev/sdk";
import { google } from "googleapis";
import type { ScanDepth, RunCounts } from "./types.js";
import { scrapeGoogleMaps } from "./scrape-google-maps.js";
import { scrapeSocial } from "./scrape-social.js";
import { deepResearch } from "./deep-research.js";
import { compareCompetitors } from "./compare-competitors.js";
import { verifyClosure } from "./verify-closure.js";
import { analyzeCompetitors } from "./analyze-competitors.js";
import { writeReport } from "./write-report.js";

// Monday 8:00 AM Eastern, true year-round (handles EST/EDT automatically)
export const checkCompetitors = schedules.task({
  id: "check-competitors",
  cron: {
    pattern: "0 8 * * 1",
    timezone: "America/New_York",
  },
  run: async () => {
    const scanMode = process.env.SCAN_MODE ?? "demo";
    const runDate = new Date().toISOString().split("T")[0];

    // Compute scan depth from mode + date
    const scanDepth: ScanDepth = computeScanDepth(scanMode);
    console.log(`Starting MWJ competitor intelligence run — mode: ${scanMode}, depth: ${scanDepth}, date: ${runDate}`);

    // Step 1: Discover competitors on Google Maps
    const mapsResult = await scrapeGoogleMaps.triggerAndWait({ scanDepth });
    if (!mapsResult.ok) {
      await writeRunLog(runDate, scanMode, "ERROR", null, String(mapsResult.error));
      throw new Error(`scrape-google-maps failed: ${mapsResult.error}`);
    }
    const { places: rawPlaces } = mapsResult.output;

    if (rawPlaces.length === 0) {
      console.log("No places returned from Maps — writing NO_DATA and exiting");
      await writeRunLog(runDate, scanMode, "NO_DATA", null, "Outscraper returned 0 results");
      return { status: "NO_DATA" };
    }
    console.log(`Maps: ${rawPlaces.length} places found`);

    // Step 2: Enrich via Instagram + Facebook
    const socialResult = await scrapeSocial.triggerAndWait({ places: rawPlaces, scanDepth });
    if (!socialResult.ok) {
      await writeRunLog(runDate, scanMode, "ERROR", null, String(socialResult.error));
      throw new Error(`scrape-social failed: ${socialResult.error}`);
    }
    const { places: enrichedPlaces } = socialResult.output;
    console.log(`Social: ${enrichedPlaces.length} total after social discovery`);

    // Step 3: Tier competitors, crawl websites, mine reviews
    const researchResult = await deepResearch.triggerAndWait({ places: enrichedPlaces, scanDepth });
    if (!researchResult.ok) {
      await writeRunLog(runDate, scanMode, "ERROR", null, String(researchResult.error));
      throw new Error(`deep-research failed: ${researchResult.error}`);
    }
    const { places: researchedPlaces } = researchResult.output;

    // Step 4: Diff against Google Sheet baseline
    const compareResult = await compareCompetitors.triggerAndWait({ places: researchedPlaces, scanDepth });
    if (!compareResult.ok) {
      await writeRunLog(runDate, scanMode, "ERROR", null, String(compareResult.error));
      throw new Error(`compare-competitors failed: ${compareResult.error}`);
    }
    let { places: diffedPlaces, newCount, changedCount, missingCount } = compareResult.output;

    // Step 5: Verify possible closures (deep scans only)
    if (scanDepth === "deep") {
      const closureCandidates = diffedPlaces.filter((p) => p.missedScans >= 2);
      if (closureCandidates.length > 0) {
        const closureResult = await verifyClosure.triggerAndWait({ candidates: closureCandidates });
        if (closureResult.ok) {
          // Merge closure evidence back into diffedPlaces
          const evidenceMap = new Map(
            closureResult.output.verified.map((v) => [v.name, v])
          );
          diffedPlaces = diffedPlaces.map((p) => {
            const verified = evidenceMap.get(p.name);
            if (verified) {
              return {
                ...p,
                changeStatus: verified.closureEvidence ? ("possibly-closed" as const) : p.changeStatus,
                closureEvidence: verified.closureEvidence,
              };
            }
            return p;
          });
        }
        // Non-fatal if closure verification fails — continue without it
      }
    }

    // Step 6: AI analysis
    const counts: RunCounts = {
      total: diffedPlaces.length,
      newCount,
      changedCount,
      missingCount,
      goneCount: 0,
    };
    const analyzeResult = await analyzeCompetitors.triggerAndWait({ places: diffedPlaces, runDate, counts });
    if (!analyzeResult.ok) {
      await writeRunLog(runDate, scanMode, "ERROR", null, String(analyzeResult.error));
      throw new Error(`analyze-competitors failed: ${analyzeResult.error}`);
    }
    const { analysis } = analyzeResult.output;

    // Step 7: Write all four outputs
    const writeResult = await writeReport.triggerAndWait({
      places: diffedPlaces,
      analysis,
      runDate,
      scanDepth,
      counts,
    });
    if (!writeResult.ok) {
      await writeRunLog(runDate, scanMode, "ERROR", null, String(writeResult.error));
      throw new Error(`write-report failed: ${writeResult.error}`);
    }
    const { googleDocUrl, clickupDocUrl, sheetRowsWritten, clickupTasksCreated, mysteryShopTasksCreated } =
      writeResult.output;

    await writeRunLog(runDate, scanMode, "SUCCESS", { googleDocUrl, clickupDocUrl, counts });
    console.log(
      `Run complete — ${sheetRowsWritten} sheet rows, ${clickupTasksCreated} tasks, ${mysteryShopTasksCreated} mystery-shop tasks`
    );

    return { status: "SUCCESS", googleDocUrl, clickupDocUrl, counts };
  },
});

function computeScanDepth(scanMode: string): ScanDepth {
  if (scanMode === "demo") return "demo";
  // First Monday of the month: date <= 7
  const today = new Date();
  const dayOfMonth = today.getDate();
  return dayOfMonth <= 7 ? "deep" : "light";
}

async function writeRunLog(
  runDate: string,
  mode: string,
  status: string,
  urls: { googleDocUrl?: string; clickupDocUrl?: string; counts?: RunCounts } | null,
  errorMessage?: string
) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!spreadsheetId || !clientId || !clientSecret || !refreshToken) return; // Skip if not configured yet

  try {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const sheets = google.sheets({ version: "v4", auth });

    const row = [
      runDate,
      mode,
      status,
      urls?.counts?.total ?? "",
      urls?.counts?.newCount ?? "",
      urls?.counts?.changedCount ?? "",
      urls?.counts?.missingCount ?? "",
      urls?.googleDocUrl ?? "",
      urls?.clickupDocUrl ?? "",
      errorMessage ?? "",
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Run Log!A:J",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
  } catch (err) {
    // Log but don't throw — run log failure should not fail the whole run
    console.error("Failed to write run log:", err);
  }
}
