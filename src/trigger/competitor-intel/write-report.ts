import { schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { google } from "googleapis";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
} from "docx";
import type { DiffedCompetitorPlace, AnalysisResult, RunCounts, ScanDepth } from "./types.js";

export const writeReport = schemaTask({
  id: "write-report",
  schema: z.object({
    places: z.array(z.any()),
    analysis: z.any(),
    runDate: z.string(),
    scanDepth: z.enum(["demo", "deep", "light"]),
    counts: z.object({
      total: z.number(),
      newCount: z.number(),
      changedCount: z.number(),
      missingCount: z.number(),
      goneCount: z.number(),
    }),
  }),
  retry: { maxAttempts: 2, minTimeoutInMs: 10000, maxTimeoutInMs: 60000 },
  run: async ({ places: rawPlaces, analysis: rawAnalysis, runDate, scanDepth, counts }) => {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const docsFolderId = process.env.GOOGLE_DOCS_FOLDER_ID;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    const clickupToken = process.env.CLICKUP_API_TOKEN;
    const clickupWorkspaceId = process.env.CLICKUP_WORKSPACE_ID;
    const clickupFolderId = process.env.CLICKUP_FOLDER_ID;
    const clickupListId = process.env.CLICKUP_LIST_ID;

    if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is not set");
    if (!docsFolderId) throw new Error("GOOGLE_DOCS_FOLDER_ID is not set");
    if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not set");
    if (!clientSecret) throw new Error("GOOGLE_CLIENT_SECRET is not set");
    if (!refreshToken) throw new Error("GOOGLE_REFRESH_TOKEN is not set");
    if (!clickupToken) throw new Error("CLICKUP_API_TOKEN is not set");
    if (!clickupWorkspaceId) throw new Error("CLICKUP_WORKSPACE_ID is not set");
    if (!clickupFolderId) throw new Error("CLICKUP_FOLDER_ID is not set");
    if (!clickupListId) throw new Error("CLICKUP_LIST_ID is not set");

    const places = rawPlaces as DiffedCompetitorPlace[];
    const analysis = rawAnalysis as AnalysisResult;

    // Auth as hortonaiagency@gmail.com via OAuth2 refresh token
    // Files are created as the actual user — no service account storage issues
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });

    // Step A — Google Sheet upsert
    const sheetRowsWritten = await upsertSheet(spreadsheetId, auth, places, runDate);
    console.log(`Sheet: ${sheetRowsWritten} rows written/updated`);

    // Step B — Google Doc
    const googleDocUrl = await createGoogleDoc(docsFolderId, auth, analysis, places, runDate, counts);
    console.log(`Google Doc: ${googleDocUrl}`);

    // Step C — ClickUp Doc (v3)
    const clickupDocUrl = await createClickupDoc(
      clickupToken, clickupWorkspaceId, clickupFolderId, analysis, places, runDate, counts
    );
    console.log(`ClickUp Doc: ${clickupDocUrl}`);

    // Step D — ClickUp Tasks (paced, deduped)
    const { clickupTasksCreated, mysteryShopTasksCreated } = await createClickupTasks(
      clickupToken, clickupListId, places, analysis, runDate
    );
    console.log(`ClickUp Tasks: ${clickupTasksCreated} competitor tasks, ${mysteryShopTasksCreated} mystery-shop tasks`);

    return { sheetRowsWritten, googleDocUrl, clickupDocUrl, clickupTasksCreated, mysteryShopTasksCreated };
  },
});

// ─── Google Sheet Upsert ──────────────────────────────────────────────────────

async function upsertSheet(
  spreadsheetId: string,
  auth: ReturnType<typeof google.auth.GoogleAuth.prototype.getClient> extends Promise<infer T> ? T : never,
  places: DiffedCompetitorPlace[],
  runDate: string
): Promise<number> {
  const sheets = google.sheets({ version: "v4", auth: auth as Parameters<typeof google.sheets>[0]["auth"] });

  // Read existing rows to find row indices for updates
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Competitor Registry!A:R",
  });
  const rows = existing.data.values ?? [];

  // Build index: name_postalCode → row number (1-based, +1 for header)
  const rowIndex = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][2] ?? "").toString().trim();
    const address = (rows[i][3] ?? "").toString().trim();
    const postal = extractPostalCode(address);
    if (name) rowIndex.set(`${name.toLowerCase()}_${postal}`, i + 1);
  }

  let written = 0;

  for (const place of places) {
    if (place.changeStatus === "unchanged") {
      // Just touch Last Seen column (B)
      const key = `${place.name.toLowerCase()}_${place.postalCode}`;
      const rowNum = rowIndex.get(key);
      if (rowNum) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `Competitor Registry!B${rowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[runDate]] },
        });
      }
      continue;
    }

    const rowData = buildSheetRow(place, runDate);

    if (place.changeStatus === "new") {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Competitor Registry!A:R",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowData] },
      });
      written++;
    } else {
      // changed / missing / possibly-closed — update in place
      const key = `${place.name.toLowerCase()}_${place.postalCode}`;
      const rowNum = rowIndex.get(key);

      if (rowNum) {
        // Build update: preserve First Seen (col A) and Verified Pricing (col K)
        const updateRow = [...rowData];
        updateRow[0] = rows[rowNum - 1][0] ?? runDate; // keep First Seen
        updateRow[10] = rows[rowNum - 1][10] ?? ""; // NEVER overwrite col K (index 10)

        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `Competitor Registry!A${rowNum}:R${rowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [updateRow] },
        });
      } else {
        // Not in sheet yet — append
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: "Competitor Registry!A:R",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [rowData] },
        });
      }
      written++;
    }
  }

  return written;
}

function buildSheetRow(place: DiffedCompetitorPlace, runDate: string): string[] {
  return [
    runDate, // A: First Seen (will be replaced by existing value on updates)
    runDate, // B: Last Seen
    place.name, // C
    place.address, // D
    place.phone ?? "", // E
    place.website ?? "", // F
    place.instagramHandle ?? "", // G
    place.facebookUrl ?? "", // H
    place.categories.join(", "), // I
    place.offers.length > 0 ? JSON.stringify(place.offers) : "", // J: Offers (JSON)
    "", // K: Verified Pricing (manual) — NEVER written by automation
    place.rating?.toString() ?? "", // L
    place.reviewCount?.toString() ?? "", // M
    place.source, // N
    place.tier, // O
    "", // P: Notes
    place.changeStatus, // Q
    place.missedScans.toString(), // R
  ];
}

// ─── Google Doc (.docx upload) ───────────────────────────────────────────────
// Service accounts cannot create native Google Docs (Workspace file quota issue).
// Instead we build a .docx buffer and upload it as a regular file — Drive
// converts it to a Google Doc automatically on open.

async function createGoogleDoc(
  folderId: string,
  auth: unknown,
  analysis: AnalysisResult,
  places: DiffedCompetitorPlace[],
  runDate: string,
  counts: RunCounts
): Promise<string> {
  const drive = google.drive({ version: "v3", auth: auth as Parameters<typeof google.drive>[0]["auth"] });

  const docxBuffer = await buildDocx(analysis, places, runDate, counts);

  const { Readable } = await import("stream");
  const stream = Readable.from(docxBuffer);

  const file = await drive.files.create({
    fields: "id",
    requestBody: {
      name: `MWJ Competitor Report — ${runDate}.docx`,
      parents: [folderId],
    },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      body: stream,
    },
  });

  const fileId = file.data.id!;
  return `https://drive.google.com/file/d/${fileId}/view`;
}

async function buildDocx(
  analysis: AnalysisResult,
  places: DiffedCompetitorPlace[],
  runDate: string,
  counts: RunCounts
): Promise<Buffer> {
  const children: Paragraph[] = [];

  const heading = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]) =>
    new Paragraph({ text, heading: level, spacing: { before: 300, after: 100 } });

  const body = (text: string) =>
    new Paragraph({ children: [new TextRun({ text, size: 24 })], spacing: { after: 80 } });

  const bullet = (text: string) =>
    new Paragraph({
      children: [new TextRun({ text, size: 24 })],
      bullet: { level: 0 },
      spacing: { after: 60 },
    });

  // Title
  children.push(new Paragraph({
    children: [new TextRun({ text: `MWJ Competitor Report — ${runDate}`, bold: true, size: 36 })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
  }));

  children.push(body(`Total: ${counts.total} | New: ${counts.newCount} | Changed: ${counts.changedCount} | Missing: ${counts.missingCount}`));

  // Executive Summary
  children.push(heading("Executive Summary", HeadingLevel.HEADING_1));
  children.push(body(analysis.executiveSummary));

  // Competitor Moves
  if (analysis.competitorMoves.length > 0) {
    children.push(heading("Competitor Moves This Week", HeadingLevel.HEADING_1));
    for (const move of analysis.competitorMoves) children.push(bullet(move));
  }

  // New Competitors
  const newPlaces = places.filter((p) => p.changeStatus === "new");
  if (newPlaces.length > 0) {
    children.push(heading("New Competitors", HeadingLevel.HEADING_1));
    for (const c of analysis.competitors.filter((c) => newPlaces.some((p) => p.name === c.name))) {
      children.push(heading(c.name, HeadingLevel.HEADING_2));
      children.push(body(c.oneLinerSummary));
      children.push(body(`Pricing: ${c.pricingNote}`));
      children.push(body(`Social: ${c.socialPresence}`));
      children.push(body(`vs. Shelby: ${c.positioningVsJacks}`));
    }
  }

  // Changed Competitors
  const changedPlaces = places.filter((p) => p.changeStatus === "changed");
  if (changedPlaces.length > 0) {
    children.push(heading("Changed Competitors", HeadingLevel.HEADING_1));
    for (const c of analysis.competitors.filter((c) => changedPlaces.some((p) => p.name === c.name))) {
      const place = changedPlaces.find((p) => p.name === c.name);
      children.push(heading(`${c.name} (changed: ${place?.changedFields.join(", ")})`, HeadingLevel.HEADING_2));
      children.push(body(c.oneLinerSummary));
      children.push(body(`Pricing: ${c.pricingNote}`));
      children.push(body(`vs. Shelby: ${c.positioningVsJacks}`));
    }
  }

  // Offer Matrix
  children.push(heading("Offer & Price Matrix", HeadingLevel.HEADING_1));
  for (const row of analysis.offerMatrix) {
    const shelby = row.shelbyOffers ? "✓ Shelby offers this" : "— Shelby does not offer";
    children.push(body(`${row.category}: ${row.competitorsOffering.length} competitors (${row.priceRange}) | ${shelby}`));
  }

  // White Space
  if (analysis.whiteSpace.length > 0) {
    children.push(heading("White-Space Opportunities", HeadingLevel.HEADING_1));
    for (const gap of analysis.whiteSpace) children.push(bullet(gap));
  }

  // Weakness Themes
  if (analysis.weaknessThemes.length > 0) {
    children.push(heading("Competitor Weaknesses (from reviews)", HeadingLevel.HEADING_1));
    for (const wt of analysis.weaknessThemes) {
      children.push(body(`${wt.competitor}: ${wt.themes.join(", ")}`));
    }
  }

  // Possibly Closed
  const closedPlaces = places.filter((p) => p.changeStatus === "possibly-closed");
  if (closedPlaces.length > 0) {
    children.push(heading("Possibly Closed", HeadingLevel.HEADING_1));
    for (const p of closedPlaces) {
      children.push(body(`${p.name} — ${p.closureEvidence ?? "Missing 2+ deep scans, no closure evidence found"}`));
    }
  }

  // Unchanged count
  const unchangedCount = places.filter((p) => p.changeStatus === "unchanged").length;
  if (unchangedCount > 0) {
    children.push(body(`Unchanged: ${unchangedCount} competitors tracked — no meaningful changes this week.`));
  }

  // Positioning
  children.push(heading("Shelby's Positioning This Week", HeadingLevel.HEADING_1));
  children.push(body(analysis.overallPositioningNote));

  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

function buildReportMarkdown(
  analysis: AnalysisResult,
  places: DiffedCompetitorPlace[],
  runDate: string,
  counts: RunCounts
): string {
  const lines: string[] = [];

  lines.push(`MWJ Competitor Report — ${runDate}`);
  lines.push("");
  lines.push("EXECUTIVE SUMMARY");
  lines.push(analysis.executiveSummary);
  lines.push(`Total: ${counts.total} | New: ${counts.newCount} | Changed: ${counts.changedCount} | Missing: ${counts.missingCount}`);
  lines.push("");

  if (analysis.competitorMoves.length > 0) {
    lines.push("COMPETITOR MOVES THIS WEEK");
    for (const move of analysis.competitorMoves) lines.push(`• ${move}`);
    lines.push("");
  }

  const newPlaces = places.filter((p) => p.changeStatus === "new");
  if (newPlaces.length > 0) {
    lines.push("NEW COMPETITORS");
    for (const c of analysis.competitors.filter((c) => newPlaces.some((p) => p.name === c.name))) {
      lines.push(`${c.name}`);
      lines.push(c.oneLinerSummary);
      lines.push(`Pricing: ${c.pricingNote}`);
      lines.push(`Social: ${c.socialPresence}`);
      lines.push(`vs. Shelby: ${c.positioningVsJacks}`);
      lines.push("");
    }
  }

  const changedPlaces = places.filter((p) => p.changeStatus === "changed");
  if (changedPlaces.length > 0) {
    lines.push("CHANGED COMPETITORS");
    for (const c of analysis.competitors.filter((c) => changedPlaces.some((p) => p.name === c.name))) {
      const place = changedPlaces.find((p) => p.name === c.name);
      lines.push(`${c.name} (changed: ${place?.changedFields.join(", ")})`);
      lines.push(c.oneLinerSummary);
      lines.push(`Pricing: ${c.pricingNote}`);
      lines.push(`vs. Shelby: ${c.positioningVsJacks}`);
      lines.push("");
    }
  }

  lines.push("OFFER & PRICE MATRIX");
  for (const row of analysis.offerMatrix) {
    const shelby = row.shelbyOffers ? "✓ Shelby" : "— Shelby does not offer";
    lines.push(`${row.category}: ${row.competitorsOffering.length} competitors (${row.priceRange}) | ${shelby}`);
  }
  lines.push("");

  if (analysis.whiteSpace.length > 0) {
    lines.push("WHITE-SPACE OPPORTUNITIES");
    for (const gap of analysis.whiteSpace) lines.push(`• ${gap}`);
    lines.push("");
  }

  if (analysis.weaknessThemes.length > 0) {
    lines.push("COMPETITOR WEAKNESSES (from reviews)");
    for (const wt of analysis.weaknessThemes) {
      lines.push(`${wt.competitor}: ${wt.themes.join(", ")}`);
    }
    lines.push("");
  }

  const closedPlaces = places.filter((p) => p.changeStatus === "possibly-closed");
  if (closedPlaces.length > 0) {
    lines.push("POSSIBLY CLOSED");
    for (const p of closedPlaces) {
      lines.push(`${p.name} — ${p.closureEvidence ?? "No specific evidence but missing 2+ deep scans"}`);
    }
    lines.push("");
  }

  const unchangedCount = places.filter((p) => p.changeStatus === "unchanged").length;
  if (unchangedCount > 0) {
    lines.push(`UNCHANGED: ${unchangedCount} competitors tracked — no meaningful changes this week.`);
    lines.push("");
  }

  lines.push("SHELBY'S POSITIONING THIS WEEK");
  lines.push(analysis.overallPositioningNote);

  return lines.join("\n");
}

// ─── ClickUp Doc (API v3) ─────────────────────────────────────────────────────

async function createClickupDoc(
  token: string,
  workspaceId: string,
  folderId: string,
  analysis: AnalysisResult,
  places: DiffedCompetitorPlace[],
  runDate: string,
  counts: RunCounts
): Promise<string> {
  const docTitle = `MWJ Competitor Report — ${runDate}`;
  const markdownContent = buildReportMarkdown(analysis, places, runDate, counts);

  // Create the doc
  const createRes = await fetch(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ name: docTitle, parent: { id: folderId, type: 5 } }),
  });

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`ClickUp Doc create failed: ${createRes.status} ${text}`);
  }

  const docBody = await createRes.json() as { id: string; url?: string };
  const docId = docBody.id;

  // Add a page with the report content
  const pageRes = await fetch(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Report", content: markdownContent, content_format: "text/md" }),
  });

  if (!pageRes.ok) {
    console.warn(`ClickUp Doc page creation failed: ${pageRes.status} — doc exists but may be empty`);
  }

  return docBody.url ?? `https://app.clickup.com/docs/${docId}`;
}

// ─── ClickUp Tasks ────────────────────────────────────────────────────────────

async function createClickupTasks(
  token: string,
  listId: string,
  places: DiffedCompetitorPlace[],
  analysis: AnalysisResult,
  runDate: string
): Promise<{ clickupTasksCreated: number; mysteryShopTasksCreated: number }> {
  // Fetch existing tasks tagged with today's runDate to support idempotent retries
  const existingTaskNames = await fetchExistingTaskNames(token, listId, runDate);
  const existingMysteryShopNames = await fetchExistingTaskNames(token, listId, "mystery-shop");

  let clickupTasksCreated = 0;
  let mysteryShopTasksCreated = 0;

  // Standard tasks for NEW and CHANGED competitors
  const actionable = places.filter((p) => p.changeStatus === "new" || p.changeStatus === "changed");

  for (const place of actionable) {
    if (existingTaskNames.has(place.name.toLowerCase())) continue;

    const competitorAnalysis = analysis.competitors.find((c) => c.name === place.name);
    const description = buildTaskDescription(place, competitorAnalysis);

    await createClickupTask(token, listId, {
      name: place.name,
      description,
      tags: ["competitor", "auto-generated", runDate],
    });

    existingTaskNames.add(place.name.toLowerCase());
    clickupTasksCreated++;
    await wait.for({ seconds: 1 }); // Pace at ~60/min, well under 100/min limit
  }

  // Mystery-shop tasks for direct-tier competitors with no public pricing
  const mysteryShopCandidates = places.filter(
    (p) =>
      p.tier === "direct" &&
      !p.verifiedPricing &&
      !p.facebookPriceRange &&
      p.offers.length === 0 &&
      p.changeStatus !== "possibly-closed"
  );

  for (const place of mysteryShopCandidates) {
    const taskName = `💰 Pricing intel needed: ${place.name}`;
    if (existingMysteryShopNames.has(place.name.toLowerCase())) continue;

    await createClickupTask(token, listId, {
      name: taskName,
      description: buildMysteryShopDescription(place),
      tags: ["mystery-shop", "competitor"],
    });

    existingMysteryShopNames.add(place.name.toLowerCase());
    mysteryShopTasksCreated++;
    await wait.for({ seconds: 1 });
  }

  return { clickupTasksCreated, mysteryShopTasksCreated };
}

async function createClickupTask(
  token: string,
  listId: string,
  task: { name: string; description: string; tags: string[] }
): Promise<void> {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: task.name,
      description: task.description,
      tags: task.tags,
    }),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10");
    console.warn(`ClickUp 429 — waiting ${retryAfter}s`);
    await wait.for({ seconds: retryAfter });
    // Retry once
    await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: task.name, description: task.description, tags: task.tags }),
    });
  } else if (!res.ok) {
    const text = await res.text();
    console.warn(`ClickUp task creation failed for "${task.name}": ${res.status} ${text}`);
  }
}

async function fetchExistingTaskNames(token: string, listId: string, tag: string): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const res = await fetch(
      `https://api.clickup.com/api/v2/list/${listId}/task?tags[]=${encodeURIComponent(tag)}&limit=100`,
      { headers: { Authorization: token } }
    );
    if (!res.ok) return names;
    const body = await res.json() as { tasks: Array<{ name: string }> };
    for (const task of body.tasks ?? []) {
      // Extract competitor name: remove "💰 Pricing intel needed: " prefix if present
      const name = task.name.replace("💰 Pricing intel needed: ", "").toLowerCase().trim();
      names.add(name);
    }
  } catch { /* non-fatal */ }
  return names;
}

function buildTaskDescription(place: DiffedCompetitorPlace, competitorAnalysis?: { pricingNote: string; oneLinerSummary: string; positioningVsJacks: string }): string {
  const lines = [
    `**Change:** ${place.changeStatus.toUpperCase()}${place.changedFields.length > 0 ? ` (${place.changedFields.join(", ")})` : ""}`,
    `**Address:** ${place.address || "Unknown"}`,
    `**Phone:** ${place.phone ?? "Not found"}`,
    `**Website:** ${place.website ?? "Not found"}`,
    `**Instagram:** ${place.instagramHandle ? `@${place.instagramHandle} (${place.instagramFollowers?.toLocaleString() ?? "?"} followers)` : "None found"}`,
    `**Facebook:** ${place.facebookUrl ?? "None found"}`,
    `**Google Rating:** ${place.rating ?? "N/A"} (${place.reviewCount ?? 0} reviews)`,
    `**Tier:** ${place.tier}`,
    "",
    `**Pricing:** ${competitorAnalysis?.pricingNote ?? place.verifiedPricing ?? place.facebookPriceRange ?? "Not public"}`,
  ];

  if (place.offers.length > 0) {
    lines.push("", "**Offers found:**");
    for (const offer of place.offers.slice(0, 10)) {
      lines.push(`- ${offer.offerName}: ${offer.price}${offer.cadence ? ` (${offer.cadence})` : ""}${offer.notes ? ` — ${offer.notes}` : ""}`);
    }
  }

  if (competitorAnalysis?.positioningVsJacks) {
    lines.push("", `**vs. Shelby:** ${competitorAnalysis.positioningVsJacks}`);
  }

  return lines.join("\n");
}

function buildMysteryShopDescription(place: DiffedCompetitorPlace): string {
  return [
    `**${place.name}** is a direct-tier competitor with no publicly available pricing.`,
    `**Address:** ${place.address || "Unknown"}`,
    `**Website:** ${place.website ?? "Not found"}`,
    `**Instagram:** ${place.instagramHandle ? `@${place.instagramHandle}` : "None found"}`,
    "",
    "**To find their pricing, try one of the following:**",
    "- [ ] Send a DM to their Instagram asking about rates",
    "- [ ] Call them directly",
    "- [ ] Book a free consult or trial class",
    "- [ ] Walk in and ask",
    "",
    "**Once you have pricing, enter it in the Google Sheet:**",
    "Open the Competitor Registry sheet → find this competitor → enter pricing in column K (Verified Pricing — manual).",
    "The automation will pick it up automatically next Monday and include it in all future reports.",
    "",
    "_This task will not be created again once pricing is entered in the sheet._",
  ].join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractPostalCode(address: string): string {
  const match = address.match(/\b\d{5}\b/);
  return match ? match[0] : "";
}
