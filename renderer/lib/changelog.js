// Release notes use ## version — date headings and plain-text - bullets.
export function parseChangelog(markdown) {
  return markdown.split(/^## /m).slice(1).map((section) => {
    const [heading, ...lines] = section.trim().split(/\r?\n/);
    const match = heading.match(/^(\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/);
    if (!match) throw new Error(`Invalid release heading: ${heading}`);
    const items = lines.filter((line) => line.startsWith('- ')).map((line) => line.slice(2));
    if (!items.length) throw new Error(`Release ${match[1]} has no notes`);
    return { version: match[1], date: match[2], items };
  });
}
