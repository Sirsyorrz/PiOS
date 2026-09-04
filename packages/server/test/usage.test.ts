import assert from "node:assert/strict";
import test from "node:test";
import { parseUsage } from "../src/usage.ts";

const sample = {
  limits: [
    { kind: "session", percent: 11.4, resets_at: "2026-09-04T03:09:59Z" },
    { kind: "weekly_all", percent: 12, resets_at: null },
    { kind: "broken" },
  ],
  spend: {
    enabled: true,
    used: { amount_minor: 670, currency: "USD", exponent: 2 },
    limit: null,
  },
};

test("cc-usage output becomes windows a phone can render", () => {
  const report = parseUsage(sample);
  assert.deepEqual(
    report?.windows.map((w) => [w.key, w.percent, w.resetsAt]),
    [
      ["session", 11, "2026-09-04T03:09:59Z"],
      ["weekly_all", 12, null],
    ],
  );
  assert.equal(report?.windows[0]?.label, "Current session (5h)");
  assert.deepEqual(report?.spend, { used: 670, limit: null, currency: "USD", exponent: 2 });
});

test("usage with extra credits off reports no spend", () => {
  const report = parseUsage({ limits: [], spend: { enabled: false } });
  assert.equal(report?.spend, null);
});

test("anything that is not a usage document is unavailable, not a crash", () => {
  assert.equal(parseUsage(null), null);
  assert.equal(parseUsage("nope"), null);
  assert.deepEqual(parseUsage({})?.windows, []);
});
