import puppeteer from "puppeteer";
import fs from "fs/promises";
import path from "path";
import { stat } from "fs/promises";
import { spawn, execSync } from "child_process";

let detectedPort = 3000;
let devServerProcess = null;

// Logging utilities
const logLevels = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let currentLogLevel = logLevels.INFO;

function log(level, message, data = null) {
  if (level < currentLogLevel) return;

  const prefix = {
    [logLevels.DEBUG]: "🔍",
    [logLevels.INFO]: "ℹ️",
    [logLevels.WARN]: "⚠️",
    [logLevels.ERROR]: "❌",
  }[level] || "ℹ️";

  const timestamp = new Date().toISOString().split("T")[1].slice(0, -1);
  if (data) {
    console.log(`${prefix} [${timestamp}] ${message}`, data);
  } else {
    console.log(`${prefix} [${timestamp}] ${message}`);
  }
}

function logProgress(current, total, prefix = "Processing") {
  const percent = ((current / total) * 100).toFixed(1);
  const barLength = 30;
  const filled = Math.floor((current / total) * barLength);
  const bar = "█".repeat(filled) + "░".repeat(barLength - filled);
  process.stdout.write(`\r${prefix}: [${bar}] ${current}/${total} (${percent}%)`);
  if (current === total) {
    process.stdout.write("\n");
  }
}

// Simple page setup helper
async function setupPage(page) {
  await page.setDefaultTimeout(10000);
  await page.setViewport({
    width: 1200,
    height: 630,
    deviceScaleFactor: 1,
  });

  // Optimize page loading - block unnecessary resources
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const resourceType = req.resourceType();
    const url = req.url();

    if (
      resourceType === "image" ||
      resourceType === "font" ||
      resourceType === "media" ||
      url.includes("stats.paulbutler.org") ||
      url.includes("analytics") ||
      url.includes("tracking")
    ) {
      req.abort();
    } else {
      req.continue();
    }
  });
}

// Process reports in parallel with concurrency limit
async function processBatch(reports, browser, concurrency = 5, onProgress = null) {
  const results = [];
  const total = reports.length;
  let processed = 0;

  for (let i = 0; i < reports.length; i += concurrency) {
    const batch = reports.slice(i, i + concurrency);
    const batchStartTime = Date.now();

    log(logLevels.DEBUG, `Starting batch ${Math.floor(i / concurrency) + 1} (${batch.length} reports)`);

    const batchResults = await Promise.all(
      batch.map(async (report) => {
        const result = await processReport(report, browser);
        processed++;
        if (onProgress) {
          onProgress(processed, total);
        }
        return result;
      })
    );

    const batchTime = Date.now() - batchStartTime;
    const batchSuccess = batchResults.filter((r) => r.success && !r.skipped).length;
    const batchSkipped = batchResults.filter((r) => r.success && r.skipped).length;
    const batchFailed = batchResults.filter((r) => !r.success).length;

    log(
      logLevels.DEBUG,
      `Batch complete: ${batchSuccess} generated, ${batchSkipped} skipped, ${batchFailed} failed (${batchTime}ms)`
    );

    results.push(...batchResults);
  }

  return results;
}

async function processReport(report, browser, retries = 1) {
  const reportPath = report.path;
  const outputPath = `static/share/${reportPath}.png`;
  const reportJsonPath = `report_pipeline/reports/${reportPath}/report.json`;
  const outputDir = path.dirname(outputPath);
  const reportStartTime = Date.now();

  try {
    // Verify report file exists and has data
    try {
      const reportContent = await fs.readFile(reportJsonPath, "utf8");
      const reportData = JSON.parse(reportContent);

      // Skip if report is empty (no ballots, candidates, or rounds)
      if (
        reportData.ballotCount === 0 ||
        !reportData.candidates ||
        reportData.candidates.length === 0 ||
        !reportData.rounds ||
        reportData.rounds.length === 0
      ) {
        return {
          success: true,
          skipped: true,
          path: reportPath,
          time: Date.now() - reportStartTime,
          reason: "empty report",
        };
      }
    } catch (error) {
      // If file doesn't exist, skip it (shouldn't happen since we check earlier, but handle gracefully)
      if (error.code === 'ENOENT') {
        return {
          success: true,
          skipped: true,
          path: reportPath,
          time: Date.now() - reportStartTime,
          reason: "report file not found",
        };
      }
      return {
        success: false,
        skipped: false,
        path: reportPath,
        error: `Report file error: ${error.message}`,
        time: Date.now() - reportStartTime,
      };
    }

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
      await setupPage(page);

      const url = `http://localhost:${detectedPort}/card/${reportPath}`;
      const loadStartTime = Date.now();

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      await page.waitForSelector(".card", { timeout: 10000 });

      // Wait for page to be ready
      await page.waitForFunction(
        () => {
          const card = document.querySelector(".card");
          if (!card) return false;

          const header = card.querySelector(".electionHeader");
          if (!header || !header.textContent?.trim()) return false;

          const svgs = card.querySelectorAll("svg");
          if (svgs.length === 0) {
            return true;
          }

          return Array.from(svgs).every((svg) => {
            return (
              svg.children.length > 0 ||
              (svg.getAttribute("width") && svg.getAttribute("height")) ||
              svg.innerHTML.trim().length > 0
            );
          });
        },
        { timeout: 10000 },
      );

      await new Promise((resolve) => setTimeout(resolve, 200));

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
    } catch (error) {
      if (retries > 0) {
        await page.close();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return processReport(report, browser, retries - 1);
      }
      throw error;
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
  log(logLevels.INFO, "Starting share image generation");

  // Set log level from environment
  if (process.env.DEBUG === "1" || process.env.DEBUG === "true") {
    currentLogLevel = logLevels.DEBUG;
  }

  const chromePath =
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  log(logLevels.INFO, `Using Chrome executable: ${chromePath}`);

  let browser;

  try {
    const browserStartTime = Date.now();
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
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
      ],
      executablePath: chromePath,
    });

    const browserInitTime = Date.now() - browserStartTime;
    log(logLevels.DEBUG, `Browser launched in ${browserInitTime}ms`);

    // Read reports index
    const indexStartTime = Date.now();
    const indexRaw = await fs.readFile(
      "report_pipeline/reports/index.json",
      "utf8",
    );
    const index = JSON.parse(indexRaw);
    const indexLoadTime = Date.now() - indexStartTime;
    log(logLevels.DEBUG, `Index loaded in ${indexLoadTime}ms`);

    // Flatten all contests from all elections, filtering out empty reports and missing files
    const reports = [];
    const skippedEmpty = [];
    const skippedMissing = [];
    for (const election of index.elections || []) {
      for (const contest of election.contests || []) {
        // Skip empty reports (no candidates, no rounds, or no ballots)
        if (
          contest.numCandidates === 0 ||
          contest.numRounds === 0 ||
          contest.winner === "No Winner"
        ) {
          skippedEmpty.push(`${election.path}/${contest.office}`);
          continue;
        }

        const reportPath = `${election.path}/${contest.office}`;
        const reportJsonPath = `report_pipeline/reports/${reportPath}/report.json`;

        // Skip if report file doesn't exist
        try {
          await stat(reportJsonPath);
        } catch {
          skippedMissing.push(reportPath);
          continue;
        }

        reports.push({
          path: reportPath,
          election: election,
          contest: contest,
        });
      }
    }

    if (skippedEmpty.length > 0) {
      log(logLevels.INFO, `Skipped ${skippedEmpty.length} empty reports:`, {
        reports: skippedEmpty,
      });
    }
    if (skippedMissing.length > 0) {
      log(logLevels.INFO, `Skipped ${skippedMissing.length} missing report files:`, {
        reports: skippedMissing,
      });
    }
    log(logLevels.INFO, `Found ${reports.length} reports to process`);

    // Determine concurrency
    const concurrency = parseInt(process.env.CONCURRENCY || "5", 10);

    log(logLevels.INFO, `Configuration: concurrency=${concurrency}`);

    // Process with progress tracking
    const results = await processBatch(
      reports,
      browser,
      concurrency,
      (current, total) => {
        logProgress(current, total, "Generating images");
      },
    );

    const scriptTotalTime = Date.now() - scriptStartTime;
    const successCount = results.filter((r) => r.success && !r.skipped).length;
    const skippedCount = results.filter((r) => r.success && r.skipped).length;
    const failureCount = results.filter((r) => !r.success).length;

    // Summary output
    log(logLevels.INFO, "\n" + "=".repeat(60));
    log(logLevels.INFO, "Generation Summary");
    log(logLevels.INFO, "=".repeat(60));
    log(logLevels.INFO, `✅ Generated: ${successCount}`);
    log(logLevels.INFO, `⏭️  Skipped (up to date): ${skippedCount}`);
    if (failureCount > 0) {
      log(logLevels.WARN, `❌ Failed: ${failureCount}`);
    }
    log(
      logLevels.INFO,
      `⏱️  Total time: ${(scriptTotalTime / 1000).toFixed(2)}s`,
    );

    // Calculate timing statistics
    const processedResults = results.filter((r) => r.success && !r.skipped);
    if (processedResults.length > 0) {
      const times = processedResults.map((r) => r.time);
      const loadTimes = processedResults.map((r) => r.loadTime || 0);

      const avgTime = times.reduce((sum, t) => sum + t, 0) / times.length;
      const avgLoadTime = loadTimes.reduce((sum, t) => sum + t, 0) / loadTimes.length;
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const p50Time = times.sort((a, b) => a - b)[Math.floor(times.length * 0.5)];
      const p95Time = times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)];

      log(logLevels.INFO, "\nTiming Statistics:");
      log(logLevels.INFO, `  Average load time: ${avgLoadTime.toFixed(1)}ms`);
      log(logLevels.INFO, `  Average total time: ${avgTime.toFixed(1)}ms`);
      log(logLevels.INFO, `  Min/Max: ${minTime}ms / ${maxTime}ms`);
      log(logLevels.INFO, `  P50/P95: ${p50Time}ms / ${p95Time}ms`);
      log(
        logLevels.INFO,
        `  Throughput: ${((processedResults.length / scriptTotalTime) * 1000).toFixed(2)} reports/second`,
      );
    }

    if (failureCount > 0) {
      log(logLevels.ERROR, "\nFailed Reports:");
      results
        .filter((r) => !r.success)
        .forEach((r) => {
          log(logLevels.ERROR, `  ${r.path}: ${r.error}`);
        });
    }
  } catch (error) {
    log(logLevels.ERROR, "Fatal error during image generation", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
        log(logLevels.DEBUG, "Browser closed");
      } catch (error) {
        log(logLevels.ERROR, "Error closing browser", {
          error: error.message,
        });
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
        log(logLevels.INFO, `Dev server detected on port ${port}`);
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
  log(logLevels.INFO, "Starting dev server...");

  const env = { ...process.env, RANKED_VOTE_REPORTS: "report_pipeline/reports" };

  // Use spawn without shell to avoid security warning
  devServerProcess = spawn("bun", ["run", "dev"], {
    env,
    stdio: "ignore",
    shell: false,
  });

  devServerProcess.on("error", (error) => {
    log(logLevels.ERROR, "Failed to start dev server", { error: error.message });
  });

  // Wait for server to be ready
  const ports = [3000, 5173, 3001];
  const maxAttempts = 30;
  const checkInterval = 1000;

  log(logLevels.DEBUG, `Waiting for dev server (max ${maxAttempts}s)...`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, checkInterval));

    for (const port of ports) {
      try {
        const response = await fetch(`http://localhost:${port}`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          log(logLevels.INFO, `✅ Dev server ready on port ${port}`);
          detectedPort = port;
          return;
        }
      } catch {
        continue;
      }
    }

    if (attempt % 5 === 4) {
      log(logLevels.DEBUG, `Still waiting... (${attempt + 1}/${maxAttempts})`);
    }
  }

  throw new Error(`Dev server failed to start after ${maxAttempts} seconds`);
}

// Stop dev server
function stopDevServer() {
  if (devServerProcess) {
    log(logLevels.INFO, "Stopping dev server...");
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
      log(logLevels.INFO, "Using existing dev server");
    }

    // Generate images
    await generateShareImages();

    // Count generated images
    try {
      const imageCount = execSync(
        'find static/share -name "*.png" 2>/dev/null | wc -l',
        { encoding: "utf8" },
      ).trim();
      log(logLevels.INFO, `\n📊 Total share images in static/share: ${imageCount}`);
    } catch {
      // Ignore if find fails
    }
  } catch (error) {
    log(logLevels.ERROR, "Fatal error in main execution", {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  } finally {
    // Only stop server if we started it
    if (!serverWasRunning) {
      stopDevServer();
    }
  }
})();
