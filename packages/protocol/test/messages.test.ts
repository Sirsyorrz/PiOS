import { test } from "node:test";
import assert from "node:assert/strict";
import { previewText } from "../src/messages.ts";

test("previewText collapses injected skill blocks to a tag", () => {
  const text = `<skill name="grill-me" location="/home/x/SKILL.md">
long instructions
</skill>

Ask me about boats`;
  assert.equal(previewText(text), "<skill:grill-me> Ask me about boats");
});

test("previewText collapses several blocks and whitespace", () => {
  const text =
    "<system-reminder>be nice</system-reminder>\nhello   there\n<project_context>x</project_context>";
  assert.equal(
    previewText(text),
    "<system-reminder> hello there <project_context>",
  );
});

test("a skill-only message still names the skill", () => {
  const text = '<skill name="a">only this</skill>';
  assert.equal(previewText(text), "<skill:a>");
});

test("previewText leaves ordinary text alone", () => {
  assert.equal(previewText("  fix the parser  "), "fix the parser");
});
