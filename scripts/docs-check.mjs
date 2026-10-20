// P5: every claim in docs/ must cite a test, and every citation must resolve. CI runs this via npm test.
// Citation: [T:<file in test/>#<text>]; <text> must appear inside a string literal of that file (a test title or a
// table case). [S:<path>] cites a script, which must exist. Between <!-- claims --> and <!-- /claims -->, every list item must carry at least one citation.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
export function checkDocs(root = new URL("..", import.meta.url).pathname) {
  const problems = [], cited = [];
  let claims = 0;
  for (const f of readdirSync(join(root, "docs")).filter((x) => x.endsWith(".md"))) {
    const text = readFileSync(join(root, "docs", f), "utf8").replace(/`[^`\n]*`/g, ""); // inline code is not a citation
    for (const m of text.matchAll(/\[T:([^#\]]+)#([^\]]+)\]/g)) {
      const file = join(root, "test", m[1].trim()), want = m[2].trim();
      cited.push(`${m[1]}#${want}`);
      if (!existsSync(file)) { problems.push(`${f}: cited test file missing: ${m[1]}`); continue; }
      const src = readFileSync(file, "utf8");
      const strings = [...src.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((s) => s[2]);
      if (!strings.some((s) => s.includes(want))) problems.push(`${f}: no test in ${m[1]} matches "${want}"`);
    }
    for (const m of text.matchAll(/\[S:([^\]]+)\]/g)) {
      cited.push(m[1]);
      if (!existsSync(join(root, m[1].trim()))) problems.push(`${f}: cited script missing: ${m[1]}`);
    }
    let inClaims = false, item = null;
    const flush = () => { if (item !== null) { claims++; if (!/\[[TS]:[^\]]+\]/.test(item)) problems.push(`${f}: claim without a test: ${item.slice(0, 90)}`); } item = null; };
    for (const line of text.split("\n")) {
      if (line.includes("<!-- claims -->")) { inClaims = true; continue; }
      if (line.includes("<!-- /claims -->")) { flush(); inClaims = false; continue; }
      if (!inClaims) continue;
      if (/^- /.test(line)) { flush(); item = line; } else if (item !== null && line.trim()) item += " " + line;
    }
    flush();
  }
  return { claims, citations: cited.length, unique_tests: new Set(cited).size, problems };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkDocs();
  console.log(JSON.stringify({ claims: r.claims, citations: r.citations, unique_tests: r.unique_tests, problems: r.problems.length }));
  for (const p of r.problems) console.error("docs-check: " + p);
  process.exit(r.problems.length ? 1 : 0);
}
