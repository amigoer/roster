import { test } from "node:test";
import assert from "node:assert/strict";
import { planUsage, quotaOf } from "../dist/plan.js";

// what get_usage answered on a Max plan, trimmed to the fields that matter
const answer = {
  five_hour: { utilization: 30, resets_at: "2026-09-15T19:10:00.962988+00:00" },
  seven_day: { utilization: 64, resets_at: "2026-09-17T15:00:00.963015+00:00" },
  seven_day_opus: null,
  limits: [
    { kind: "session", group: "session", percent: 30, resets_at: "2026-09-15T19:10:00.342941+00:00", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 64, resets_at: "2026-09-17T15:00:00.342965+00:00", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 27, resets_at: "2026-09-17T15:00:00.343207+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null } },
    { kind: "something_new", percent: 5, resets_at: null, scope: null },
  ],
};

test("the limits list becomes the plan's windows, scoped weeks named by model", () => {
  const q = quotaOf("max", answer);
  assert.equal(q.plan, "max");
  assert.equal(q.url, "https://claude.ai/settings/usage");
  assert.deepEqual(q.windows, [
    { kind: "session", usedPercent: 30, resetsAt: Date.parse("2026-09-15T19:10:00.342941+00:00") },
    { kind: "weekly", usedPercent: 64, resetsAt: Date.parse("2026-09-17T15:00:00.342965+00:00") },
    { kind: "weekly", scope: "Fable", usedPercent: 27, resetsAt: Date.parse("2026-09-17T15:00:00.343207+00:00") },
  ]);
});

test("without the list, the fixed fields are read", () => {
  const { limits: _, ...fields } = answer;
  const q = quotaOf("pro", { ...fields, seven_day_opus: { utilization: 150, resets_at: null } });
  assert.deepEqual(q.windows, [
    { kind: "session", usedPercent: 30, resetsAt: Date.parse("2026-09-15T19:10:00.962988+00:00") },
    { kind: "weekly", usedPercent: 64, resetsAt: Date.parse("2026-09-17T15:00:00.963015+00:00") },
    { kind: "weekly", scope: "Opus", usedPercent: 100 },
  ]);
});

test("nothing to show is no plan at all", () => {
  assert.equal(quotaOf("max", null), null);
  assert.equal(quotaOf("max", { limits: [] }), null);
  assert.equal(quotaOf(null, { five_hour: { utilization: null, resets_at: null } }), null);
});

test("an account without plan limits reports none", async () => {
  const q = await planUsage({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ subscription_type: null, rate_limits_available: false, rate_limits: null }),
  });
  assert.equal(q, null);
});

test("get_usage answers are mapped with the plan they name", async () => {
  const q = await planUsage({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ subscription_type: "max", rate_limits_available: true, rate_limits: answer }),
  });
  assert.equal(q.plan, "max");
  assert.equal(q.windows.length, 3);
});
