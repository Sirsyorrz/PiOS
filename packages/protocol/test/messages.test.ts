import { test } from "node:test";
import assert from "node:assert/strict";
import { messagePreview, previewText } from "../src/messages.ts";

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

test("a screenshot-only message previews as an image tag", () => {
  const preview = messagePreview({
    role: "user",
    content: [
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "what is this" },
    ],
  } as never);
  assert.equal(preview, "<image> what is this");
});

test("a pasted temp-file screenshot collapses to an image tag", () => {
  assert.equal(
    previewText("/tmp/pi-clipboard-be5fb74b-2d4b-455d-b.png\nwhat is this"),
    "<image> what is this",
  );
  assert.equal(previewText("/tmp/screenshot-2026.png"), "<image>");
});

test("an ordinary /tmp path is left alone", () => {
  assert.equal(previewText("read /tmp/build.log"), "read /tmp/build.log");
});
