import puppeteer from "puppeteer";
import fs from "fs/promises";
import path from "path";
import { stat } from "fs/promises";
import { spawn, execSync } from "child_process";

let detectedPort = 3000;
let devServerProcess = null;

// Process reports in parallel with concurrency limit
async function processBatch(reports, browser, concurrency = 5) {
  const results = [];

  for (let i = 0; i < reports.length; i += concurrency) {
    const batch = reports.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((report) => processReport(report, browser))
    );
    results.push(...batchResults);
  }

  return results;
}

async function processReport(report, browser) {
  const reportPath = report.path;
  const outputPath = `static/share/${reportPath}.png`;
  const reportJsonPath = `report_pipeline/reports/${reportPath}/report.json`;
  const outputDir = path.dirname(outputPath);
  const reportStartTime = Date.now();

  try {
    // Check if image already exists and is newer than report
    try {
      const [imageStat, reportStat] = await Promise.all([
        stat(outputPath),
        stat(reportJsonPath),
      ]);

      if (imageStat.mtimeMs >= reportStat.mtimeMs) {
        return {
          success: true,
          skipped: true,
          path: reportPath,
          time: Date.now() - reportStartTime,
        };
      }
    } catch {
      // File doesn't exist or can't be stat'd, proceed with generation
    }

    await fs.mkdir(outputDir, { recursive: true });

    const page = await browser.newPage();
    try {
      await page.setDefaultTimeout(3000);
      await page.setViewport({
        width: 1200,
        height: 630,
        deviceScaleFactor: 1,
      });

      // Optimize page loading
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        if (
          req.resourceType() === "image" ||
          req.resourceType() === "font" ||
          req.resourceType() === "media" ||
          req.url().includes("stats.paulbutler.org")
        ) {
          req.abort();
        } else {
          req.continue();
        }
      });

      const url = `http://localhost:${detectedPort}/card/${reportPath}`;
      const loadStartTime = Date.now();

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 5000,
      });

      // Wait for card and SVG content
      await page.waitForSelector(".card", { timeout: 3000 });
      await page.waitForFunction(
        () => {
          const svgs = document.querySelectorAll(".card svg");
          return (
            svgs.length >= 2 &&
            Array.from(svgs).every((svg) => svg.children.length > 0)
          );
        },
        { timeout: 3000 },
      );

      const element = await page.$(".card");
      if (!element) {
        throw new Error("Card element not found");
      }

      await element.screenshot({
        path: outputPath,
        type: "png",
        omitBackground: false,
      });

      const totalTime = Date.now() - reportStartTime;
      const loadTime = Date.now() - loadStartTime;

      return {
        success: true,
        skipped: false,
        path: reportPath,
        time: totalTime,
        loadTime,
      };
    } finally {
      await page.close();
    }
  } catch (error) {
    return {
      success: false,
      skipped: false,
      path: reportPath,
      error: error.message,
      time: Date.now() - reportStartTime,
    };
  }
}

async function generateShareImages() {
  const scriptStartTime = Date.now();
  console.log("Starting share image generation...");

  const chromePath =
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  console.log("Using Chrome at:", chromePath);

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=TranslateUI",
        "--disable-ipc-flooding-protection",
      ],
      executablePath: chromePath,
    });

    // Read reports index
    const indexRaw = await fs.readFile(
      "report_pipeline/reports/index.json",
      "utf8",
    );
    const index = JSON.parse(indexRaw);

    // Flatten all contests from all elections
    const reports = [];
    for (const election of index.elections || []) {
      for (const contest of election.contests || []) {
        reports.push({
          path: `${election.path}/${contest.office}`,
          election: election,
          contest: contest,
        });
      }
    }

    console.log(`Found ${reports.length} reports to process`);

    // Process in parallel batches
    const concurrency = parseInt(process.env.CONCURRENCY || "5", 10);
    console.log(`Processing with concurrency: ${concurrency}`);

    const results = await processBatch(reports, browser, concurrency);

    const scriptTotalTime = Date.now() - scriptStartTime;
    const successCount = results.filter((r) => r.success && !r.skipped).length;
    const skippedCount = results.filter((r) => r.success && r.skipped).length;
    const failureCount = results.filter((r) => !r.success).length;

    console.log(`\nGeneration complete!`);
    console.log(`Successful: ${successCount}`);
    console.log(`Skipped (up to date): ${skippedCount}`);
    console.log(`Failed: ${failureCount}`);
    console.log(
      `Total script time: ${scriptTotalTime}ms (${(scriptTotalTime / 1000).toFixed(1)}s)`,
    );

    // Calculate timing statistics
    const processedResults = results.filter((r) => r.success && !r.skipped);
    if (processedResults.length > 0) {
      const avgTime =
        processedResults.reduce((sum, r) => sum + r.time, 0) /
        processedResults.length;
      const avgLoadTime =
        processedResults.reduce((sum, r) => sum + (r.loadTime || 0), 0) /
        processedResults.length;

      console.log(`\nTiming Statistics:`);
      console.log(`Average load time: ${avgLoadTime.toFixed(1)}ms`);
      console.log(`Average total time per report: ${avgTime.toFixed(1)}ms`);
      console.log(
        `Throughput: ${((processedResults.length / scriptTotalTime) * 1000).toFixed(1)} reports/second`,
      );
    }

    if (failureCount > 0) {
      console.log(`\nFailed reports:`);
      results
        .filter((r) => !r.success)
        .forEach((r) => {
          console.error(`  - ${r.path}: ${r.error}`);
        });
    }
  } catch (error) {
    console.error("Fatal error during image generation:", error);
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error("Error closing browser:", error.message);
      }
    }
  }
}

// Check if dev server is running and detect which port
async function checkDevServer() {
  const ports = [3000, 5173, 3001];

  for (const port of ports) {
    try {
      const response = await fetch(`http://localhost:${port}`);
      if (response.ok) {
        console.log(`Dev server is running on port ${port}`);
        detectedPort = port;
        return { running: true, port };
      }
    } catch {
      continue;
    }
  }

  return { running: false };
}

// Start dev server and wait for it to be ready
async function startDevServer() {
  console.log("Starting dev server...");

  const env = { ...process.env, RANKED_VOTE_REPORTS: "report_pipeline/reports" };
  devServerProcess = spawn("npm", ["run", "dev"], {
    env,
    stdio: "ignore",
    shell: true,
  });

  // Wait for server to be ready
  const ports = [3000, 5173, 3001];
  const maxAttempts = 30;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    for (const port of ports) {
      try {
        const response = await fetch(`http://localhost:${port}`);
        if (response.ok) {
          console.log(`✅ Dev server is ready on port ${port}`);
          detectedPort = port;
          return;
        }
      } catch {
        continue;
      }
    }
  }

  throw new Error(`Dev server failed to start after ${maxAttempts} seconds`);
}

// Stop dev server
function stopDevServer() {
  if (devServerProcess) {
    console.log("Stopping dev server...");
    devServerProcess.kill();
    devServerProcess = null;
  }
}

// Cleanup on exit
process.on("SIGINT", () => {
  stopDevServer();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopDevServer();
  process.exit(0);
});

// Run the script
(async () => {
  let serverWasRunning = false;

  try {
    // Check if server is already running
    const serverStatus = await checkDevServer();

    if (!serverStatus.running) {
      // Start server if not running
      await startDevServer();
    } else {
      serverWasRunning = true;
    }

    // Generate images
    await generateShareImages();

    // Count generated images
    try {
      const imageCount = execSync('find static/share -name "*.png" 2>/dev/null | wc -l', { encoding: "utf8" }).trim();
      console.log(`\n📊 Total share images: ${imageCount}`);
    } catch {
      // Ignore if find fails
    }
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  } finally {
    // Only stop server if we started it
    if (!serverWasRunning) {
      stopDevServer();
    }
  }
})();
