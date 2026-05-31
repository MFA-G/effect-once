import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOnceStore } from "../src/index.js";

const keyHash = (key: string) =>
  createHash("sha256").update(key).digest("hex").slice(0, 16);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "effect-once-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("OnceStore", () => {
  it("runs the effect once and returns its value", async () => {
    const store = createOnceStore({ dir });
    let calls = 0;
    const res = await store.once("k", async () => {
      calls += 1;
      return 42;
    });
    expect(res.ran).toBe(true);
    expect(res.value).toBe(42);
    expect(res.status).toBe("done");
    expect(calls).toBe(1);
  });

  it("skips a second call for the same key (the duplicate-fire case)", async () => {
    const store = createOnceStore({ dir });
    let calls = 0;
    await store.once("dup", async () => void calls++);
    const second = await store.once("dup", async () => void calls++);
    expect(calls).toBe(1);
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("already-done");
  });

  it("runs exactly once under concurrent calls", async () => {
    const store = createOnceStore({ dir });
    let calls = 0;
    const fn = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.once("race", fn)),
    );
    expect(calls).toBe(1);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
  });

  it("does NOT swallow the effect when it fails — the next call retries", async () => {
    // This is the regression guard for the classic 'write marker before send'
    // bug: a failed effect must remain retryable, never permanently skipped.
    const store = createOnceStore({ dir });
    let calls = 0;
    await expect(
      store.once("flaky", async () => {
        calls += 1;
        throw new Error("send failed");
      }),
    ).rejects.toThrow("send failed");
    expect(await store.status("flaky")).toBe("failed");

    const retry = await store.once("flaky", async () => {
      calls += 1;
      return "ok";
    });
    expect(calls).toBe(2);
    expect(retry.ran).toBe(true);
    expect(retry.status).toBe("done");
  });

  it("reclaims a stale lock from a crashed run", async () => {
    const store = createOnceStore({ dir, leaseMs: 1000, now: () => 100_000 });
    // Simulate a crashed run that left a lock behind, older than the lease.
    const lockPath = path.join(
      dir,
      // mirrors OnceStore.markerPath naming so we hit the same key
      `crashed.${keyHash("crashed")}.json.lock`,
    );
    await writeFile(lockPath, JSON.stringify({ pid: 999, acquiredAt: 0 }));
    let calls = 0;
    const res = await store.once("crashed", async () => void calls++);
    expect(calls).toBe(1);
    expect(res.ran).toBe(true);
  });

  it("sweeps old done markers", async () => {
    let clock = 1_000_000;
    const store = createOnceStore({ dir, now: () => clock });
    await store.once("old", async () => 1);
    clock += 10_000;
    const removed = await store.sweep(5_000);
    expect(removed).toBe(1);
    expect(await store.status("old")).toBe("absent");
  });
});
