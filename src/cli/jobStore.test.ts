import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobsPath, loadJobs, restoreStatus, saveJobs, type StoredJob } from "./jobStore";

const configIn = () => join(mkdtempSync(join(tmpdir(), "jobs-")), "snipe.config.json");

const job = (over: Partial<StoredJob> = {}): StoredJob => ({
  id: "job1",
  label: "PixelHood Monkes",
  addedAt: 1,
  status: "queued",
  request: {
    chainId: 4663,
    collection: "0x2117ab19424ff9f1cac344c3f7ed29828c4ac90d",
    stage: "public",
    quantity: "max",
    extraRpcs: [],
    gas: { maxFeeGwei: "0.4", tipGwei: "0.05", limit: 350_000 },
    timing: "wait",
    dryRun: false,
  },
  ...over,
});

describe("keeping the queue on disk", () => {
  it("has nothing to restore before anything was saved", () => {
    expect(loadJobs(configIn())).toEqual([]);
  });

  it("brings a queued job back exactly as it was", () => {
    const cfg = configIn();
    saveJobs(cfg, [job({ startTime: 1_787_945_400, wallets: ["0xabc"] })]);
    const [back] = loadJobs(cfg);
    expect(back.id).toBe("job1");
    expect(back.startTime).toBe(1_787_945_400);
    expect(back.wallets).toEqual(["0xabc"]);
    expect(back.request.gas.limit).toBe(350_000);
  });

  it("writes the file so only its owner can read it", () => {
    // A job's request carries the endpoint URLs it mints through, and on a
    // paid plan those URLs are the API key.
    const cfg = configIn();
    saveJobs(cfg, [job()]);
    expect(statSync(jobsPath(cfg)).mode & 0o777).toBe(0o600);
  });

  it("survives a file nobody can parse", () => {
    const cfg = configIn();
    saveJobs(cfg, [job()]);
    writeFileSync(jobsPath(cfg), "{ not json");
    expect(loadJobs(cfg)).toEqual([]);
  });

  it("drops a record that is missing what a job needs", () => {
    const cfg = configIn();
    writeFileSync(jobsPath(cfg), JSON.stringify([{ id: "x" }, job()]));
    expect(loadJobs(cfg).map((j) => j.id)).toEqual(["job1"]);
  });

  it("replaces the file rather than appending to it", () => {
    const cfg = configIn();
    saveJobs(cfg, [job(), job({ id: "job2" })]);
    saveJobs(cfg, [job({ id: "job2" })]);
    expect(loadJobs(cfg).map((j) => j.id)).toEqual(["job2"]);
    expect(JSON.parse(readFileSync(jobsPath(cfg), "utf8"))).toHaveLength(1);
  });
});

describe("what a restored job becomes", () => {
  const start = 1_787_945_400;

  it("puts a queued job straight back on the queue", () => {
    expect(restoreStatus(job({ startTime: start }), start * 1000 - 60_000)).toEqual({
      status: "queued",
    });
  });

  it("requeues a job that was arming, if its stage is still ahead", () => {
    // Arming happens two minutes out; a restart inside that window should not
    // cost the drop when there is still time to arm again.
    expect(restoreStatus(job({ status: "armed", startTime: start }), start * 1000 - 30_000)).toEqual(
      { status: "queued" },
    );
  });

  it("does not pretend a job is still waiting once its stage has opened", () => {
    const r = restoreStatus(job({ status: "armed", startTime: start }), start * 1000 + 1);
    expect(r.status).toBe("error");
    expect("error" in r && r.error).toMatch(/restarted while this job was firing/);
  });

  it("fails an arming job whose start was never known", () => {
    const r = restoreStatus(job({ status: "armed" }), start * 1000);
    expect(r.status).toBe("error");
    expect("error" in r && r.error).toMatch(/requeue it/);
  });
});
