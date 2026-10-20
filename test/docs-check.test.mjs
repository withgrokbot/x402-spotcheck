// P5: the docs checker itself. CI fails on a claim without a test or a citation to a test that doesn't exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDocs } from "../scripts/docs-check.mjs";
const tree = (doc) => { const r = mkdtempSync(join(tmpdir(), "docs-")); mkdirSync(join(r, "docs")); mkdirSync(join(r, "test")); writeFileSync(join(r, "test", "a.test.mjs"), 'test("budget never exceeded", () => {});\nconst CASES = { "tail truncation": 1 };'); writeFileSync(join(r, "docs", "x.md"), doc); return r; };
test("docs-check: the repo's docs pass (every claim cites an existing test)", () => {
  const r = checkDocs();
  assert.deepEqual(r.problems, []);
  assert.ok(r.claims >= 25 && r.citations >= r.claims);
});
test("docs-check: a citation to a missing test or file fails; a claim without a citation fails", () => {
  assert.equal(checkDocs(tree("<!-- claims -->\n- ok [T:a.test.mjs#budget never exceeded] [T:a.test.mjs#tail truncation]\n<!-- /claims -->")).problems.length, 0);
  assert.match(checkDocs(tree("<!-- claims -->\n- x [T:a.test.mjs#no such test]\n<!-- /claims -->")).problems[0], /no test in a.test.mjs matches/);
  assert.match(checkDocs(tree("<!-- claims -->\n- x [T:gone.test.mjs#budget]\n<!-- /claims -->")).problems[0], /file missing/);
  assert.match(checkDocs(tree("<!-- claims -->\n- an uncited claim\n<!-- /claims -->")).problems[0], /claim without a test/);
  assert.match(checkDocs(tree("<!-- claims -->\n- x [S:scripts/gone.mjs]\n<!-- /claims -->")).problems[0], /cited script missing/);
  assert.equal(checkDocs(tree("not a claim, and `[T:x#y]` in code is ignored")).problems.length, 0);
});
