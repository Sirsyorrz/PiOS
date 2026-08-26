import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPresentation,
  emptyPresentation,
  stripAnsi,
  type ExtensionUiRequest,
} from "../src/index.ts";

function request(partial: Partial<ExtensionUiRequest> & { method: ExtensionUiRequest["method"] }) {
  return { type: "extension_ui_request", id: "r", ...partial } as ExtensionUiRequest;
}

test("status and widgets replace by key and keep their order", () => {
  let state = emptyPresentation();
  state = applyPresentation(state, request({ method: "setStatus", statusKey: "a", statusText: "one" }));
  state = applyPresentation(state, request({ method: "setStatus", statusKey: "b", statusText: "two" }));
  state = applyPresentation(state, request({ method: "setStatus", statusKey: "a", statusText: "three" }));

  assert.deepEqual(state.status, [
    { key: "a", text: "three" },
    { key: "b", text: "two" },
  ]);

  state = applyPresentation(state, request({ method: "setWidget", widgetKey: "w", widgetLines: ["x"] }));
  assert.deepEqual(state.widgets, [{ key: "w", lines: ["x"], placement: undefined }]);
});

test("an unchanged request returns the same state, so nothing is broadcast", () => {
  const before = applyPresentation(
    emptyPresentation(),
    request({ method: "setStatus", statusKey: "a", statusText: "one" }),
  );
  const after = applyPresentation(before, request({ method: "setStatus", statusKey: "a", statusText: "one" }));
  assert.equal(after, before);
});

test("clearing removes the key rather than leaving an empty chip", () => {
  let state = applyPresentation(
    emptyPresentation(),
    request({ method: "setStatus", statusKey: "a", statusText: "one" }),
  );
  state = applyPresentation(state, request({ method: "setStatus", statusKey: "a" }));
  assert.deepEqual(state.status, []);
});

test("dialogs and notifications are not presentation state", () => {
  const state = emptyPresentation();
  assert.equal(applyPresentation(state, request({ method: "confirm", title: "?" })), state);
  assert.equal(applyPresentation(state, request({ method: "notify", message: "hi" })), state);
});

test("a chatty extension cannot grow the state without bound", () => {
  let state = emptyPresentation();
  for (let i = 0; i < 100; i++) {
    state = applyPresentation(
      state,
      request({ method: "setStatus", statusKey: `k${i}`, statusText: "x" }),
    );
  }
  assert.equal(state.status.length, 16);

  state = applyPresentation(
    state,
    request({ method: "setTitle", title: "t".repeat(5_000) }),
  );
  assert.equal(state.title?.length, 500);
});

test("terminal styling is stripped: a DOM cannot render SGR escapes", () => {
  const state = applyPresentation(
    emptyPresentation(),
    request({
      method: "setStatus",
      statusKey: "k",
      statusText: "\u001B[38;5;167myolo\u001B[39m",
    }),
  );
  assert.deepEqual(state.status, [{ key: "k", text: "yolo" }]);
  assert.equal(stripAnsi("\u001B]0;title\u0007plain"), "plain");
});
