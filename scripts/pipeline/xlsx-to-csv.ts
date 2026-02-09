/**
 * XLSX-to-CSV conversion with caching.
 *
 * Converts Excel files to CSV format once and caches the result in a
 * `.csv-cache/` directory alongside the original XLSX files.
 * Subsequent calls return the cached CSV path if it is still fresh
 * (based on mtime comparison). This avoids the expensive XML-inside-ZIP
 * parsing on every pipeline run.
 */

import {
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { join, dirname, basename } from "path";
import ExcelJS from "exceljs";

const CACHE_DIR = ".csv-cache";

// ---- Global concurrency limiter ----
// Prevents too many simultaneous ExcelJS readers from overwhelming disk I/O
// and file descriptors, regardless of how many callers invoke ensureCsv().

const MAX_CONCURRENT_CONVERSIONS = 4;
let activeConversions = 0;
const waitQueue: Array<() => void> = [];

async function withConversionLimit<T>(fn: () => Promise<T>): Promise<T> {
  while (activeConversions >= MAX_CONCURRENT_CONVERSIONS) {
    await new Promise<void>((resolve) => waitQueue.push(resolve));
  }
  activeConversions++;
  try {
    return await fn();
  } finally {
    activeConversions--;
    const next = waitQueue.shift();
    if (next) next();
  }
}

// ---- CSV helpers ----

/**
 * Quote a CSV field per RFC 4180.
 * Fields containing commas, double quotes, or newlines are wrapped
 * in double quotes. Internal double quotes are escaped by doubling.
 */
function csvQuote(value: string): string {
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Convert a single ExcelJS cell value to its CSV string representation.
 */
function cellToCsvValue(cell: any): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") return String(cell);
  if (typeof cell === "boolean") return cell ? "true" : "false";
  if (typeof cell === "string") return cell;
  if (cell instanceof Date) return cell.toISOString();
  // ExcelJS rich text objects
  if (cell.richText) {
    return cell.richText.map((rt: any) => rt.text).join("");
  }
  // ExcelJS formula result
  if (cell.result !== undefined) return String(cell.result);
  // ExcelJS error value
  if (cell.error) return String(cell.error);
  return String(cell);
}

/**
 * Parse a CSV line respecting quoted fields per RFC 4180.
 * Does NOT trim field values — returns exact values as written.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ---- Cache path helpers ----

function getCachePath(xlsxPath: string): string {
  const dir = dirname(xlsxPath);
  const name = basename(xlsxPath).replace(/\.(xlsx|xlsm|xls)$/i, ".csv");
  return join(dir, CACHE_DIR, name);
}

function isCacheFresh(xlsxPath: string, csvPath: string): boolean {
  if (!existsSync(csvPath)) return false;
  const xlsxMtime = statSync(xlsxPath).mtimeMs;
  const csvMtime = statSync(csvPath).mtimeMs;
  return csvMtime > xlsxMtime;
}

// ---- Conversion ----

/**
 * Convert an XLSX file to CSV using ExcelJS streaming reader.
 * Only reads the first worksheet.
 */
async function convertXlsxToCsv(
  xlsxPath: string,
  csvPath: string,
): Promise<void> {
  const cacheDir = dirname(csvPath);
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(xlsxPath);
  const lines: string[] = [];

  for await (const ws of reader) {
    for await (const row of ws) {
      const values = row.values as any[];
      if (!values) continue;
      // ExcelJS row.values is 1-indexed (index 0 is undefined).
      // Write as 0-indexed CSV columns.
      const fields: string[] = [];
      for (let i = 1; i < values.length; i++) {
        fields.push(csvQuote(cellToCsvValue(values[i])));
      }
      lines.push(fields.join(","));
    }
    break; // Only first sheet
  }

  writeFileSync(csvPath, lines.join("\n") + "\n");
}

// ---- Public API ----

/**
 * Ensure a CSV cache exists for the given XLSX file.
 * Returns the path to the cached CSV. If the cache is fresh, returns
 * immediately without re-converting.
 *
 * Conversions are throttled by a process-wide limiter to avoid
 * overwhelming disk I/O when many callers convert simultaneously.
 */
export async function ensureCsv(xlsxPath: string): Promise<string> {
  const csvPath = getCachePath(xlsxPath);
  if (isCacheFresh(xlsxPath, csvPath)) {
    return csvPath;
  }
  return withConversionLimit(async () => {
    // Re-check after acquiring the semaphore — another caller may
    // have converted the same file while we were waiting.
    if (isCacheFresh(xlsxPath, csvPath)) {
      return csvPath;
    }
    const start = Date.now();
    await convertXlsxToCsv(xlsxPath, csvPath);
    const ms = Date.now() - start;
    console.log(`      ${basename(xlsxPath)} -> CSV (${ms}ms)`);
    return csvPath;
  });
}

/**
 * Ensure CSV caches exist for multiple XLSX files.
 * All conversions are submitted concurrently but throttled by the
 * process-wide limiter (max 4 simultaneous ExcelJS readers).
 * Returns an array of CSV paths in the same order as the input paths.
 */
export async function ensureCsvBatch(
  xlsxPaths: string[],
): Promise<string[]> {
  return Promise.all(xlsxPaths.map((path) => ensureCsv(path)));
}
