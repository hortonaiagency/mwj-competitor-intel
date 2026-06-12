# Workflow: MWJ Weekly Competitor Intelligence

## Objective

Every Monday at 8 AM Eastern, automatically discover fitness competitors in the Volusia County, FL area (Port Orange, Daytona Beach, Ormond Beach, DeLand), analyze their services and pricing with AI, and deliver the findings to four destinations so Shelby Jacks can monitor the competitive landscape and sharpen her positioning for Move With Jacks LLC.

---

## Client Context

**Client:** Move With Jacks LLC — Shelby Jacks, Port Orange FL  
**Why this matters:** Shelby's core pricing advantage is $60/month group bootcamp vs. competitors at $197+/month. She needs to know weekly if new competitors have entered the market, if existing ones have changed pricing, and how her offering compares. This intelligence directly informs her ad copy, social content, and offer positioning.  
**Brand profile:** `brand-assets/move-with-jacks-brand-profile.md`

---

## Inputs Required

None — this automation is fully scheduled. It runs every Monday at 8 AM Eastern without any manual trigger.

The only configuration inputs are environment variables (set once, never change unless credentials rotate):

| Variable | What it is | Where to get it |
|---|---|---|
| `OUTSCRAPER_API_KEY` | Outscraper REST API key | outscraper.com → Profile → API Key |
| `APIFY_TOKEN` | Apify platform token | console.apify.com → Account → Integrations |
| `GEMINI_API_KEY` | Google Gemini API key (free) | aistudio.google.com → Get API key |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | ID of the "MWJ Competitor Intelligence" Sheet | From the Sheet URL |
| `GOOGLE_DOCS_FOLDER_ID` | ID of the "MWJ Competitor Reports" Drive folder | From the Drive folder URL |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Stringified JSON of GCP service account key | GCP Console → IAM → Service Accounts |
| `CLICKUP_API_TOKEN` | ClickUp personal API token | ClickUp → Settings → Apps → API Token |
| `CLICKUP_FOLDER_ID` | ID of the "Competitor Intelligence" folder in ClickUp | From ClickUp folder URL |
| `CLICKUP_LIST_ID` | ID of the "Weekly Competitor Tasks" list in ClickUp | From ClickUp list URL |

---

## Tools Used

| Tool | Purpose | File |
|---|---|---|
| Outscraper API | Discover local fitness businesses on Google Maps | `src/trigger/competitor-intel/scrape-google-maps.ts` |
| Apify — `apify/instagram-profile-scraper` | Scrape Instagram profiles of discovered competitors | `src/trigger/competitor-intel/scrape-social.ts` |
| Apify — `corent1robert/facebook-page-contact-scraper` | Scrape Facebook business pages of discovered competitors | `src/trigger/competitor-intel/scrape-social.ts` |
| Google Gemini API (`gemini-1.5-flash`, free tier) | Analyze competitor data and write structured report | `src/trigger/competitor-intel/analyze-competitors.ts` |
| Google Sheets API v4 | Append raw competitor rows to tracking sheet | `src/trigger/competitor-intel/write-report.ts` |
| Google Docs API v1 | Create weekly narrative report Doc | `src/trigger/competitor-intel/write-report.ts` |
| ClickUp API v2 | Create weekly Doc and individual competitor Tasks | `src/trigger/competitor-intel/write-report.ts` |

---

## Search Scope

### Google Maps (Outscraper) — 40 queries

All 8 Volusia County cities × 5 fitness categories = 40 queries, 25 results each, up to 1,000 raw results before deduplication:

**Cities:** Port Orange, Daytona Beach, Ormond Beach, DeLand, New Smyrna Beach, Deltona, Holly Hill, South Daytona

**Categories per city:**
- `"gym {city} FL"`
- `"bootcamp {city} FL"`
- `"fitness studio {city} FL"`
- `"personal trainer {city} FL"`
- `"CrossFit {city} FL"`

Results are deduplicated by name + postal code. Move With Jacks is always filtered out. Expected yield: 100–300 unique businesses.

### Instagram Hashtag Discovery

Searched to find trainers who operate primarily through Instagram and don't appear in Google Maps results:

`#portorangefitness` `#portorangepersonaltrainer` `#portorangebootcamp` `#daytonafitness` `#daytonabeachfitness` `#daytonabootcamp` `#daytonapersonaltrainer` `#ormondfitness` `#ormondbeachfitness` `#delandfitness` `#newsmyrnabeachfitness` `#volusiafitness` `#volusiacountyfitness` `#centralfloridafitness` `#centralfloridapersonaltrainer`

100 posts per hashtag. Accounts are filtered to likely fitness professionals by keyword matching in bio/captions.

### Facebook Page Discovery

Searched to find local fitness businesses active on Facebook across all Volusia County cities × fitness categories. Same city and category scope as Outscraper:

**Cities:** Port Orange, Daytona Beach, Ormond Beach, DeLand, New Smyrna Beach, Deltona, Holly Hill, South Daytona

**Queries per city (5 per city = 40 total Facebook searches):**
- `"gym {city} FL"`
- `"personal trainer {city} FL"`
- `"fitness bootcamp {city} FL"`
- `"fitness studio {city} FL"`
- `"CrossFit {city} FL"`

### Week-over-Week Comparison

Every discovered competitor is compared against the Google Sheet baseline from prior runs:
- **NEW** — first time this competitor has appeared
- **CHANGED** — data has meaningfully shifted (rating, pricing, follower count)
- **UNCHANGED** — no meaningful change (skipped in Sheet write, lighter treatment in report)
- **GONE** — was found in a prior run but not this week (may have closed or de-listed)

---

## Task Sequence

The orchestrator (`check-competitors`) runs on schedule and calls each sub-task in this exact order using `triggerAndWait`. Tasks are never run in parallel.

```
[Monday 8 AM ET]
       │
       ▼
check-competitors (orchestrator)
       │
       ├─► scrape-google-maps
       │     Outscraper: 40 queries × 8 cities × 5 categories
       │     Returns deduplicated CompetitorPlace[] (100–300 expected)
       │     If 0 results: write NO_DATA to Run Log, exit early
       │
       ├─► scrape-social
       │     Step 1: Instagram hashtag discovery (new competitors via hashtags)
       │     Step 2: Facebook page discovery (new competitors via FB search)
       │     Step 3: Instagram profile enrichment (all handles)
       │     Step 4: Facebook page enrichment (all URLs)
       │     Returns merged EnrichedCompetitorPlace[] (Maps + social discoveries)
       │
       ├─► compare-competitors
       │     Reads Google Sheet baseline (prior weeks' data)
       │     Tags each competitor: NEW / CHANGED / UNCHANGED / GONE
       │     Returns EnrichedCompetitorPlaceWithDiff[]
       │
       ├─► analyze-competitors
       │     Gemini 1.5 Flash (free tier) → returns AnalysisResult
       │     Change-aware: leads with new/changed/gone counts
       │     Deeper analysis for NEW and CHANGED only
       │
       └─► write-report
             Step A: Google Sheet — upsert (new rows for NEW, update for CHANGED, skip UNCHANGED, mark GONE)
             Step B: Create Google Doc (narrative with change highlights)
             Step C: Create ClickUp Doc (same content as Google Doc)
             Step D: Create ClickUp Tasks (one per NEW or CHANGED competitor)
             Returns: sheetRowsWritten, googleDocUrl, clickupDocUrl, clickupTasksCreated
```

---

## Outputs

### 1. Google Sheet — "MWJ Competitor Intelligence"
**Tab: Weekly Snapshot**  
One new row appended per competitor per Monday run. Columns: Date Captured, Competitor Name, Address, Phone, Website, Instagram Handle, Facebook URL, Services Offered, Pricing, Rating, Review Count, Source, Notes.

**Tab: Run Log**  
One row per Monday run. Columns: Run Date, Status (SUCCESS / PARTIAL / NO_DATA / ERROR), Competitors Found, Google Doc URL, ClickUp Doc URL, Error Message.

**Purpose:** Historical record. Enables week-over-week comparison of competitor count, pricing changes, and social growth over time.

### 2. Google Doc — "MWJ Competitor Report — {date}"
Created fresh each Monday in the "MWJ Competitor Reports" Drive folder.  
Structure:
- **Executive Summary** — 3–4 sentence AI-written overview of what's notable this week
- **Competitor Profiles** — one section per competitor: what they offer, pricing if found, social presence, how they compare to Shelby
- **Shelby's Positioning This Week** — 2–3 sentence AI-written strategic note

**Purpose:** Readable narrative for Shelby or team to review without opening a spreadsheet.

### 3. ClickUp Doc — "MWJ Competitor Report — {date}"
Same content as the Google Doc, delivered inside ClickUp workspace in the "Competitor Intelligence" folder.  
**Purpose:** Keeps competitive intel inside the tool Shelby uses for her business operations.

### 4. ClickUp Tasks — one per competitor
Created in the "Weekly Competitor Tasks" list inside ClickUp.  
Each task contains: competitor name (task title), address, phone, website, Instagram, Facebook, pricing, rating, review count, and a one-line positioning note from Claude.  
Tagged: `competitor`, `auto-generated`, and the run date.  
**Purpose:** Enables Shelby to assign follow-up actions (e.g., "visit their class", "monitor their pricing") directly from her task manager.

---

## Expected Costs (weekly)

| Service | Estimated cost |
|---|---|
| Outscraper (175 places) | $0.00 (within 500/month free tier) |
| Apify Instagram (~15 profiles) | ~$0.04 |
| Apify Facebook (~10 pages) | ~$0.04 |
| Gemini API (`gemini-1.5-flash`, free tier) | $0.00 |
| Google APIs | $0.00 (free) |
| ClickUp API | $0.00 (free) |
| **Total per Monday run** | **~$0.04–0.08** |

---

## Error Handling

| Error condition | What happens |
|---|---|
| Outscraper returns 0 places | Orchestrator writes NO_DATA to Run Log and exits. No downstream tasks fire. No empty docs created. |
| Outscraper API error | Task retries up to 3 times with exponential backoff. If all retries fail, orchestrator writes ERROR to Run Log. |
| No Instagram handles found in results | `scrape-social` skips the Instagram actor call entirely — no error, no empty run. |
| No Facebook URLs found in results | `scrape-social` skips the Facebook actor call entirely. |
| Apify actor still running after 45s wait | Polling loop: waits 30 seconds between checks, up to 3 polls. If still running after 3 polls, throws an error and Trigger.dev retries the sub-task. |
| Claude returns malformed JSON | `analyze-competitors` throws immediately. Trigger.dev retries the sub-task up to 3 times. |
| Google Sheets write fails | `write-report` throws. Trigger.dev retries. Sheet append is idempotent within the same run (duplicate rows are acceptable — one per run is not critical). |
| ClickUp task creation rate-limited | Task creation calls are sequential (not parallel). If a 429 rate limit is returned, the task throws and Trigger.dev retries after backoff. Google Sheet and Doc writes happen first, so data is not lost if ClickUp fails. |
| Any sub-task fails all retries | Orchestrator catches the failure, writes ERROR + the error message to the Run Log tab, then rethrows so the Trigger.dev run is marked as failed for visibility. |

---

## Known Constraints

- **Outscraper free tier:** 500 places/month. At ~175/week, this consumes the free tier in ~3 weeks. After that, Outscraper charges $3/1,000 places (~$0.50/week). Budget accordingly if the search scope expands.
- **Instagram and Facebook:** Only public profile data is scraped — no login required. If a competitor's profile is private or recently deleted, it is silently skipped.
- **Pricing data accuracy:** Pricing is only captured if a competitor publishes it publicly on Google Maps, Facebook (About section), or their website. Many personal trainers do not publish pricing — Claude will note "No pricing found publicly" for these.
- **Cron timing:** The Monday 8 AM Eastern cron fires at 13:00 UTC. Florida observes EDT (UTC-4) in summer and EST (UTC-5) in winter, so the actual local time shifts by 1 hour seasonally (8 AM EST in winter, 9 AM EDT in summer). This is acceptable — update the cron if exact 8 AM year-round is required.
- **ClickUp API version:** Uses v2 (`/api/v2/`). If ClickUp releases v3 and deprecates v2, update the base URL in `write-report.ts`.

---

## How to Update the Search Terms

Search terms are defined as a constant array in `check-competitors.ts`. To add or remove terms:

1. Open `src/trigger/competitor-intel/check-competitors.ts`
2. Edit the `SEARCH_TERMS` array
3. Test locally with `npx trigger.dev@latest dev` and a manual trigger
4. Deploy: push to `master` (auto-deploys via GitHub Actions)

No env var changes needed — search terms are not secrets.

---

## How to Add a New Output Destination

If you want to add a new delivery target (e.g., email, Slack, Notion):

1. Add the new API credentials to `.env` and the Trigger.dev dashboard
2. Add the delivery logic as a new "Step" inside `write-report.ts` — after the existing four steps
3. Update the return type to include the new output URL
4. Update the Run Log column in the Google Sheet to capture the new URL
5. Test locally before deploying

---

## Monitoring and Alerts

- **Trigger.dev dashboard:** Every run is logged with full task traces. Failed runs appear as red in the Run History tab. Check weekly after the Monday run.
- **Run Log tab in Google Sheet:** A human-readable log of every run. If a Monday row is missing, the run did not fire (check Trigger.dev for schedule issues).
- **Trigger.dev email alerts:** Enable in Project Settings → Notifications → Email on run failure. This sends an email if any Monday run fails all retries.

---

## Deploying Changes

All production changes go through GitHub — never deploy directly from a local machine.

**Standard deploy flow:**
```bash
# Make and test changes locally first
npx trigger.dev@latest dev   # confirm it works

# Commit and push to trigger auto-deploy
git add <changed files>
git commit -m "feat: describe the change"
git push origin main
```

GitHub Actions runs `.github/workflows/deploy.yml` on every push to `main`, which runs `trigger.dev deploy --ci` using the `TRIGGER_ACCESS_TOKEN` secret. The new version is live in ~60 seconds.

**After every deploy:**
1. Check GitHub → Actions tab — confirm the workflow run is green
2. Check Trigger.dev dashboard → Schedules tab — confirm the Monday cron is still registered
3. If the cron disappears after a deploy, trigger a manual run to re-register it

**Never push untested changes to `main`** — the automation runs every Monday and a broken deploy will fail silently until the next scheduled run.

---

## Maintenance Schedule

| Frequency | Action |
|---|---|
| Monthly | Check Outscraper usage at outscraper.com — confirm within free tier or budget for overage |
| Quarterly | Review search terms — add new competitor categories if Shelby's market expands |
| On credential rotation | Update affected env var in both `.env` and Trigger.dev dashboard → Environment Variables |
| If a competitor closes | No action needed — they will stop appearing in Outscraper results naturally |
| If Claude model is deprecated | Update `model` string in `analyze-competitors.ts` → commit → push to `main` |
