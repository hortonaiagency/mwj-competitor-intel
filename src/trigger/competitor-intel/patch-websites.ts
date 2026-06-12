import { task } from "@trigger.dev/sdk";
import { google } from "googleapis";

const WEBSITES: Record<string, string> = {
  "Anytime Fitness_32129": "https://www.anytimefitness.com/locations/port-orange-florida-3296/",
  "Greater Fitness- Port Orange_32129": "http://www.greaterfitnessdaytona.com/",
  "Workout Anytime Port Orange_32127": "https://workoutanytime.com/location/port-orange/",
  "LA Fitness_32127": "https://www.lafitness.com/",
  "All Things Fitness_32127": "http://all-things-fitness.net/",
  "Bounce and Bang Fitness_32129": "http://www.bounceandbangfitness.com/",
  "HOTWORX - Port Orange, Fl - Port Orange Pavilion_32128": "http://www.hotworx.net/",
  "386 Fitness \"Home of CrossFit 386\"_32129": "http://www.386fitness.com/",
  "Port Orange The YMCA_32129": "https://vfymca.org/locations/port-orange-family-ymca/",
  "Orangetheory Fitness_32128": "https://www.orangetheory.com/",
  "Fit Body Boot Camp Port Orange_32127": "http://www.portorangefitbody.com/",
  "Maxwell's Fitness Programs_32128": "http://www.fittothemax.net/",
  "D1 Training Port Orange_32127": "https://www.d1training.com/port-orange/",
  "Light + Glory Fitness_32127": "http://www.lightandgloryfitness.com/",
  "The Muscle Clinic_32127": "http://www.therealmuscleclinic.com/",
  "Trinity Gym & Fitness, LLC_32128": "https://trinitygm.fitness/",
  "Amped Fitness (Daytona)_32114": "https://ampedfitness.com/join-daytona-beach/",
  "Gold's Gym_32114": "https://www.goldsgym.com/daytona-beach-fl/",
  "24/7 Daytona Fitness Club_32119": "http://www.daytonafitnessclub.com/",
  "Crunch Fitness - Daytona Beach_32114": "https://www.crunch.com/locations/daytona-beach",
  "Greater Fitness - Daytona Beach Shores_32118": "http://greaterfitnessdaytona.com/",
  "Sharper Edge Fitness_32114": "https://www.sharperedgefitness.org/",
  "Planet Fitness_32114": "https://www.planetfitness.com/",
  "HOTWORX- Daytona Beach, FL - International Speedway_32114": "http://www.hotworx.net/",
  "Oxygen Yoga & Fitness Downtown Daytona_32114": "https://oxygenyogaandfitness.com/downtown-daytona",
  "Greater Fitness_32119": "http://www.greaterfitnessdaytona.com/",
  "Bootcamp UK - Daytona Beach Outdoor Fitness_32129": "https://www.bcukamerica.com/",
  "Elite Strength and Performance_32117": "https://www.espathletics.com/",
  "Spine & Strength_32124": "https://www.spine-strength.com/",
  "CrossFit Diehard - Hybrid Training Gym, Hyrox and Fitness_32117": "http://www.crossfitdiehard.com/",
  "STUDIO 311 Yoga & Fitness_32118": "http://www.studio311yoga.com/",
  "Renew Yoga Studio_32114": "http://www.renew-yoga.com/",
  "UFitness_32114": "http://goufitness.com/",
  "Paradigm Training and Nutrition_32119": "https://paradigmtraining-nutrition.com/",
  "Limitless Fitness Personal Training Studio_32174": "https://www.limitlessfitness6.com/",
  "Modern Human CrossFit_32114": "https://www.modernhumancrossfit.com/",
  "Nova Training_32117": "http://thenovatrainingcenter.com/",
  "MOVE CrossFit_32119": "https://movecrossfit.com/",
};

export const patchWebsites = task({
  id: "patch-websites",
  run: async () => {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!spreadsheetId || !clientId || !clientSecret || !refreshToken) {
      throw new Error("Missing required env vars");
    }

    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const sheets = google.sheets({ version: "v4", auth: auth as Parameters<typeof google.sheets>[0]["auth"] });

    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Competitor Registry!A:R",
    });
    const rows = existing.data.values ?? [];

    let updated = 0;
    for (let i = 1; i < rows.length; i++) {
      const name = (rows[i][2] ?? "").toString().trim();
      const address = (rows[i][3] ?? "").toString().trim();
      const postal = address.match(/\b\d{5}\b/)?.[0] ?? "";
      const key = `${name}_${postal}`;
      const website = WEBSITES[key];

      if (website && !rows[i][5]) {
        const rowNum = i + 1;
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `Competitor Registry!F${rowNum}`,
          valueInputOption: "RAW",
          requestBody: { values: [[website]] },
        });
        console.log(`Updated ${name}: ${website}`);
        updated++;
      }
    }

    console.log(`Done — ${updated} websites written`);
    return { updated };
  },
});
