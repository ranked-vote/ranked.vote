/**
 * Name normalization utility.
 *
 * Ported from report_pipeline/src/formats/common/normalize_name.rs.
 * Converts names to title case and handles special characters.
 */

export function normalizeName(name: string, flipComma: boolean): string {
  let fixed = name;

  if (flipComma) {
    // Convert "Last, First" to "First Last"
    const match = fixed.match(/^(.+), (.+)$/);
    if (match) {
      fixed = `${match[2]} ${match[1]}`;
    }
  }

  // Handle double apostrophes
  const parts = fixed.split("''");
  if (parts.length > 2) {
    fixed = fixed.replace(/''/g, '"');
  } else {
    fixed = fixed.replace(/''/g, "'");
  }

  // Title case: capitalize first letter of each word
  const chars = [...fixed];
  const newChars: string[] = [];
  let first = true;
  let inQuote = false;

  for (const ch of chars) {
    if (ch === " " || ch === "-" || ch === "." || ch === "'") {
      first = true;
      newChars.push(ch);
    } else if (ch === '"' && !inQuote) {
      newChars.push("\u201c"); // left double quote
      inQuote = true;
      first = true;
    } else if (ch === '"') {
      newChars.push("\u201d"); // right double quote
      inQuote = false;
    } else if (first) {
      newChars.push(ch);
      first = false;
    } else {
      newChars.push(ch.toLowerCase());
    }
  }

  return newChars.join("");
}
