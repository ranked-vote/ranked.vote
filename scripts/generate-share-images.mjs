import puppeteer from "puppeteer";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

async function generateShareImages() {
  const scriptStartTime = Date.now();
  console.log("Starting share image generation...");

  const chromePath =
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  console.log("Using Chrome at:", chromePath);

  let browser;
  let page;

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
        "--single-process", // Important for CI
        "--no-zygote", // Important for CI
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

    page = await browser.newPage();
    await page.setDefaultTimeout(3000);
    await page.setViewport({
      width: 1200,
      height: 630,
      deviceScaleFactor: 1,
    });

    // Optimize page loading
    await page.setCacheEnabled(false);
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

    let successCount = 0;
    let failureCount = 0;
    const timingStats = {
      totalLoadTimes: [],
      totalScreenshotTimes: [],
      totalTimes: [],
    };

    for (const report of reports) {
      const reportPath = report.path;
      const outputPath = `static/share/${reportPath}.png`;
      const outputDir = path.dirname(outputPath);
      const reportStartTime = Date.now();

      try {
        await fs.mkdir(outputDir, { recursive: true });

        const url = `http://localhost:3000/card/${reportPath}`;
        console.log(`Loading URL: ${url}`);

        const loadStartTime = Date.now();
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 2000,
        });

        await page.waitForSelector(".card", { timeout: 1500 });
        await page.waitForSelector(".card svg", { timeout: 1500 });

        // Wait for SVG content to be fully drawn
        await page.waitForFunction(
          () => {
            const svgs = document.querySelectorAll(".card svg");
            return (
              svgs.length >= 2 &&
              Array.from(svgs).every((svg) => svg.children.length > 0)
            );
          },
          { timeout: 1500 },
        );

        // Minimal wait for components to fully render
        await new Promise((resolve) => setTimeout(resolve, 100));

        const loadTime = Date.now() - loadStartTime;
        timingStats.totalLoadTimes.push(loadTime);

        const element = await page.$(".card");
        if (!element) {
          throw new Error("Card element not found");
        }

        const screenshotStartTime = Date.now();
        await element.screenshot({
          path: outputPath,
          type: "png",
          omitBackground: false,
        });
        const screenshotTime = Date.now() - screenshotStartTime;
        timingStats.totalScreenshotTimes.push(screenshotTime);

        const totalTime = Date.now() - reportStartTime;
        timingStats.totalTimes.push(totalTime);

        successCount++;
        console.log(
          `✓ Generated: ${outputPath} (${successCount}/${reports.length}) - Load: ${loadTime}ms, Screenshot: ${screenshotTime}ms, Total: ${totalTime}ms`,
        );
      } catch (error) {
        const totalTime = Date.now() - reportStartTime;
        failureCount++;
        console.error(
          `✗ Failed ${reportPath} after ${totalTime}ms:`,
          error.message,
        );
      }
    }

    const scriptTotalTime = Date.now() - scriptStartTime;

    console.log(`\nGeneration complete!`);
    console.log(`Successful: ${successCount}`);
    console.log(`Failed: ${failureCount}`);
    console.log(
      `Total script time: ${scriptTotalTime}ms (${(scriptTotalTime / 1000).toFixed(1)}s)`,
    );

    // Calculate and display timing statistics
    if (timingStats.totalLoadTimes.length > 0) {
      const avgLoadTime =
        timingStats.totalLoadTimes.reduce((a, b) => a + b, 0) /
        timingStats.totalLoadTimes.length;
      const avgScreenshotTime =
        timingStats.totalScreenshotTimes.reduce((a, b) => a + b, 0) /
        timingStats.totalScreenshotTimes.length;
      const avgTotalTime =
        timingStats.totalTimes.reduce((a, b) => a + b, 0) /
        timingStats.totalTimes.length;

      console.log(`\nTiming Statistics:`);
      console.log(`Average load time: ${avgLoadTime.toFixed(1)}ms`);
      console.log(`Average screenshot time: ${avgScreenshotTime.toFixed(1)}ms`);
      console.log(
        `Average total time per report: ${avgTotalTime.toFixed(1)}ms`,
      );

      if (timingStats.totalLoadTimes.length > 1) {
        const minLoadTime = Math.min(...timingStats.totalLoadTimes);
        const maxLoadTime = Math.max(...timingStats.totalLoadTimes);
        const minScreenshotTime = Math.min(...timingStats.totalScreenshotTimes);
        const maxScreenshotTime = Math.max(...timingStats.totalScreenshotTimes);

        console.log(`Load time range: ${minLoadTime}ms - ${maxLoadTime}ms`);
        console.log(
          `Screenshot time range: ${minScreenshotTime}ms - ${maxScreenshotTime}ms`,
        );
      }
    }
  } catch (error) {
    console.error("Fatal error during image generation:", error);
    throw error;
  } finally {
    // Ensure browser and page are always closed
    if (page) {
      try {
        await page.close();
      } catch (error) {
        console.error("Error closing page:", error.message);
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error("Error closing browser:", error.message);
      }
    }
  }
}

// Make sure the dev server is running
async function checkDevServer() {
  try {
    // Try port 3000 first, then 3001
    let response;
    try {
      response = await fetch("http://localhost:3000");
    } catch {
      response = await fetch("http://localhost:3001");
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log("Dev server is running");
    return true;
  } catch {
    console.error(
      "ERROR: Dev server is not running at http://localhost:3000 or http://localhost:3001",
    );
    console.error("Please start the dev server with './dev.sh' first");
    process.exit(1);
  }
}

// Run the script
checkDevServer()
  .then(() => generateShareImages())
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
