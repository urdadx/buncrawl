import { describe, expect, test } from "bun:test";

import { Deadline, DeadlineExceededError, errorCodeOf } from "../src";

describe("Deadline stop checks", () => {
  test("lets work continue while time remains", () => {
    const deadline = new Deadline(1_000);
    expect(deadline.stopReason()).toBeUndefined();
    expect(() => deadline.throwIfStopped()).not.toThrow();
    expect(() => deadline.throwIfExpired()).not.toThrow();
  });

  test("reports a coded error once the time budget is spent", async () => {
    const deadline = new Deadline(5);
    await Bun.sleep(15);
    expect(deadline.stopReason()).toBeDefined();
    expect(() => deadline.throwIfExpired()).toThrow(DeadlineExceededError);
    expect(errorCodeOf(captured(() => deadline.throwIfExpired()))).toBe("DEADLINE_EXCEEDED");
    expect(() => deadline.throwIfStopped()).toThrow();
  });

  test("reports the parent's cancellation reason", () => {
    const parent = new AbortController();
    const deadline = new Deadline(10_000, parent.signal);
    const reason = new Error("client went away");
    parent.abort(reason);
    expect(deadline.stopReason()).toBe(reason);
    expect(() => deadline.throwIfStopped()).toThrow("client went away");
  });
});

describe("errorCodeOf", () => {
  test("reads string codes and ignores everything else", () => {
    expect(errorCodeOf(Object.assign(new Error("x"), { code: "BLOCKED_DESTINATION" }))).toBe(
      "BLOCKED_DESTINATION",
    );
    expect(errorCodeOf({ code: 42 })).toBeUndefined();
    expect(errorCodeOf(new Error("plain"))).toBeUndefined();
    expect(errorCodeOf("string error")).toBeUndefined();
    expect(errorCodeOf(null)).toBeUndefined();
  });
});

function captured(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
}
