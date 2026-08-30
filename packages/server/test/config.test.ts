import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.ts";

test("sessions run as child processes unless in-process is asked for by name", () => {
  assert.equal(defaultConfig().sessionHostMode, "subprocess");
  assert.equal(withEnv("PIOS_HOST", "inprocess").sessionHostMode, "subprocess");
  assert.equal(withEnv("PIOS_HOST", "in-process").sessionHostMode, "in-process");
});

test("an explicit host mode wins over the environment", () => {
  const previous = process.env.PIOS_HOST;
  process.env.PIOS_HOST = "in-process";
  try {
    assert.equal(defaultConfig({ sessionHostMode: "subprocess" }).sessionHostMode, "subprocess");
  } finally {
    restore("PIOS_HOST", previous);
  }
});

function withEnv(name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return defaultConfig();
  } finally {
    restore(name, previous);
  }
}

function restore(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}
