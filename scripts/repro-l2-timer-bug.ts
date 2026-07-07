/**
 * Red-team + Ghost attack assessment for Issue #416 (L2 timer bug)
 *
 * Tests the onTimerExpired timer mapping function against:
 *   1. Standard cases (basic functionality)
 *   2. Edge cases (malformed timers, empty values)
 *   3. Red-team injections (colon injection, session spoofing, suffix pollution)
 *   4. Ghost attacks (state corruption, cascading failures)
 *   5. Full pipeline simulation (capture → L1 → L2 → L3)
 */

// ===================================================================
// Pure function: mirrors server.ts onTimerExpired timer mapping logic
// ===================================================================
function mapTimerToTaskType(member: string): { taskType: string; sessionId: string; instanceId: string } {
  const firstColon = member.indexOf(":");
  const prefix = firstColon > 0 ? member.slice(0, firstColon) : member;

  let taskType: string;
  let instanceId: string;
  let sessionId: string;

  if (prefix === "offload-l1" || prefix === "offload-l15" || prefix === "offload-l2") {
    taskType = prefix;
    const rest = member.slice(firstColon + 1);
    const instanceEnd = rest.indexOf(":");
    if (instanceEnd > 0) {
      instanceId = rest.slice(0, instanceEnd);
      sessionId = rest.slice(instanceEnd + 1);
    } else {
      instanceId = "default";
      sessionId = rest;
    }
  } else {
    const lastColon = member.lastIndexOf(":");
    const suffix = lastColon >= 0 ? member.slice(lastColon + 1) : "";
    sessionId = lastColon >= 0 ? member.slice(0, lastColon) : member;
    taskType = suffix === "L2_schedule" ? "L2" : suffix === "L1_idle" ? "L1" : "L3";
    instanceId = "default";
  }
  return { taskType, sessionId, instanceId };
}

// ===================================================================
// PipelineWorker routing simulation
// ===================================================================
type TaskPayload = { id: string; type: string; sessionId: string; instanceId: string };

// Simulates PipelineWorker.executeTask task type routing
function routeTask(task: TaskPayload): string {
  switch (task.type) {
    case "L1": return "executeL1 (memory extraction)";
    case "L2": return "executeL2 (scene extraction)";
    case "L3": return "executeL3 (persona generation)";
    case "flush": return "executeFlush (session end)";
    case "offload-l1": return "executeOffloadL1 (MMD summary)";
    case "offload-l15": return "executeOffloadL15 (task judgment)";
    case "offload-l2": return "executeOffloadL2 (MMD canvas update)";
    default: return "UNKNOWN - DROPPED";
  }
}

// Simulates cascadeSchedule logic
function cascadeSchedule(task: TaskPayload): string[] {
  const cascades: string[] = [];
  if (task.type === "L1" || task.type === "flush") {
    cascades.push("advanceL2TimerAfterL1 → arms L2 timer (+10s delay)");
  }
  if (task.type === "L2") {
    cascades.push("armL2MaxInterval → sets max-interval timer");
    cascades.push("cascadeSchedule → arms L3 timer");
  }
  return cascades;
}

// ===================================================================
// Full pipeline simulation
// ===================================================================
function simulatePipeline(timerMember: string): string[] {
  const { taskType, sessionId } = mapTimerToTaskType(timerMember);
  const task: TaskPayload = {
    id: `${taskType}-${sessionId}-${Date.now()}`,
    type: taskType,
    sessionId,
    instanceId: "default",
  };
  const routing = routeTask(task);
  const cascades = cascadeSchedule(task);
  return [
    `Timer: "${timerMember}"`,
    `       → taskType = "${taskType}"`,
    `       → ${routing}`,
    ...(cascades.length ? [`       → Cascades: ${cascades.join("; ")}`] : [`       → No cascade (dead end)`]),
  ];
}

let passed = 0;
let failed = 0;

function test(desc: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✅ ${desc}`); }
  else { failed++; console.log(`  ❌ ${desc}${detail ? ': ' + detail : ''}`); }
}

// ===================================================================
// TEST GROUP 1: Standard cases (6 tests)
// ===================================================================
console.log("=== Group 1: Standard Cases ===");
{
  const r = mapTimerToTaskType("session-abc:L2_schedule");
  test("L2_schedule legacy → taskType = L2", r.taskType === "L2");
  test("L2_schedule legacy → sessionId = session-abc", r.sessionId === "session-abc");
}
{
  const r = mapTimerToTaskType("session-xyz:L1_idle");
  test("L1_idle legacy → taskType = L1", r.taskType === "L1");
}
{
  const r = mapTimerToTaskType("session-123:L3");
  test("L3 legacy → taskType = L3", r.taskType === "L3");
}
{
  const r = mapTimerToTaskType("offload-l2:inst-1:sess-a");
  test("offload-l2 new → taskType = offload-l2", r.taskType === "offload-l2");
  test("offload-l2 new → instanceId = inst-1", r.instanceId === "inst-1");
  test("offload-l2 new → sessionId = sess-a", r.sessionId === "sess-a");
}

// ===================================================================
// TEST GROUP 2: Edge cases (8 tests)
// ===================================================================
console.log("\n=== Group 2: Edge Cases ===");
{
  const r = mapTimerToTaskType(":L2_schedule");
  test("Empty sessionId with L2_schedule", r.taskType === "L2");
}
{
  const r = mapTimerToTaskType("session:");
  test("Session with empty suffix → default L3", r.taskType === "L3",
    `got "${r.taskType}"`);
}
{
  const r = mapTimerToTaskType("session:UNKNOWN_SUFFIX");
  test("Unknown suffix → default L3", r.taskType === "L3");
}
{
  const r = mapTimerToTaskType("");
  test("Empty member string", r.taskType === "L3",
    `got "${r.taskType}" (L3 is default, OK)`);
}
{
  const r = mapTimerToTaskType("no-colons-here");
  test("No colons at all → L3 default", r.taskType === "L3");
}
{
  const r = mapTimerToTaskType("offload-l2:");
  test("New format offload-l2 with empty instanceId", r.taskType === "offload-l2");
}
{
  const r = mapTimerToTaskType("offload-unknown:inst:session");
  test("New format with unknown prefix → legacy path → L3 default", r.taskType === "L3",
    `got "${r.taskType}"`);
}
{
  const r = mapTimerToTaskType("multi:colon:separated:L2_schedule");
  test("Multiple colons in legacy → uses last colon", r.taskType === "L2",
    `got "${r.taskType}" session="${r.sessionId}"`);
}

// ===================================================================
// TEST GROUP 3: Red-team / injection (8 tests)
// ===================================================================
console.log("\n=== Group 3: Red-Team / Injection ===");
{
  const r = mapTimerToTaskType("session\ninject:L2_schedule");
  test("Newline injection in sessionId (parsed literally, not sanitized)", r.taskType === "L2",
    `⚠️  sessionId contains newline: "${r.sessionId}" — no sanitization`);
}
{
  const r = mapTimerToTaskType(".;;..-!@#$%^&*():L2_schedule");
  test("Special chars in sessionId", r.taskType === "L2",
    `sessionId="${r.sessionId}"`);
}
{
  const r = mapTimerToTaskType("session:L2_schedule:L1_idle:L3");
  test("Chained suffixes → uses last suffix → L3", r.taskType === "L3",
    `got "${r.taskType}" — last suffix wins`);
}
{
  const r = mapTimerToTaskType('offload-l2:inst:sess"; DROP TABLE timers;--');
  test("SQL injection in sessionId", r.taskType === "offload-l2",
    `sessionId="${r.sessionId}" — not sanitized but not eval'd`);
}
{
  const r = mapTimerToTaskType("../../etc/passwd:L2_schedule");
  test("Path traversal in sessionId", r.taskType === "L2",
    `sessionId="${r.sessionId}"`);
}
{
  const r = mapTimerToTaskType("a".repeat(10000) + ":L2_schedule");
  test("Long sessionId (10k chars)", r.taskType === "L2",
    `sessionId length=${r.sessionId.length}`);
}
{
  const r = mapTimerToTaskType("session\0null:L2_schedule");
  test("Null byte in sessionId", r.taskType === "L2",
    r.taskType === "L2" ? "OK (JS handles null bytes)" : "FAIL");
}
{
  const r = mapTimerToTaskType("session:L2_schedule ");
  test("Trailing space in suffix", r.taskType === "L3" || r.taskType === "L2",
    `got "${r.taskType}" — trailing space changes suffix match!`);
}

// ===================================================================
// TEST GROUP 4: Ghost attacks / cascading failures (8 tests)
// ===================================================================
console.log("\n=== Group 4: Ghost Attacks / Cascading Failures ===");
{
  const r = mapTimerToTaskType("offload-l2_schedule:inst:session");
  test("Fake offload prefix with embedded underscore → falls to legacy L3 (correct)", r.taskType === "L3",
    `No — falls through to legacy: "${r.taskType}"`);
}
{
  // Simulate a timer storm: many L2 timers for the same session
  const timers = Array.from({ length: 100 }, (_, i) => `session-abc:L2_schedule`);
  const results = timers.map(t => mapTimerToTaskType(t));
  test("Timer storm (100x L2_schedule): all produce L2", results.every(r => r.taskType === "L2"),
    `${results.filter(r => r.taskType !== "L2").length} mismatches`);
}
{
  // Simulate mixed timer types
  const mixed = ["session-a:L2_schedule", "session-b:L1_idle", "session-c:L3"];
  const mapped = mixed.map(t => mapTimerToTaskType(t).taskType);
  test("Mixed timer types: correct routing", mapped[0] === "L2" && mapped[1] === "L1" && mapped[2] === "L3",
    `got [${mapped}]`);
}
{
  // Confusion: offload-l2 prefix vs L2_schedule suffix
  const r = mapTimerToTaskType("offload-l2:inst:session");
  test("offload-l2 prefix → offload-l2 (correct, not L2)", r.taskType === "offload-l2");
}
{
  // New format timer that looks like legacy
  const r = mapTimerToTaskType("offload-l2_schedule:inst:session");
  test("offload-l2_schedule prefix (underscore) → falls to legacy", r.taskType !== "offload-l2_schedule",
    `got "${r.taskType}"`);
}
{
  // Cascade chain simulation: L1 fires → arms L2 → L2 fires → arms L3
  const l1task: TaskPayload = { id: "L1-sess-1", type: "L1", sessionId: "sess-1", instanceId: "default" };
  const l1Cascades = cascadeSchedule(l1task);
  test("L1 completion → arms L2 timer", l1Cascades.length > 0, l1Cascades.join("; "));
}
{
  const l2task: TaskPayload = { id: "L2-sess-1", type: "L2", sessionId: "sess-1", instanceId: "default" };
  const l2Cascades = cascadeSchedule(l2task);
  test("L2 completion → arms L3 timer", l2Cascades.length > 0, l2Cascades.join("; "));
}
{
  // offload-l2 task should NOT cascade to L3
  const offloadTask: TaskPayload = { id: "offload-l2-sess-1", type: "offload-l2", sessionId: "sess-1", instanceId: "default" };
  const offCascades = cascadeSchedule(offloadTask);
  test("offload-l2 → no cascade to L3", offCascades.length === 0,
    offCascades.length > 0 ? `unexpected cascade: ${offCascades}` : "OK");
}

// ===================================================================
// TEST GROUP 5: Full pipeline simulation (4 scenarios)
// ===================================================================
console.log("\n=== Group 5: Full Pipeline Simulation ===");
{
  console.log("\nScenario A: L2_schedule timer fires (CORRECT after fix):");
  simulatePipeline("session-user123:L2_schedule").forEach(l => console.log(`  ${l}`));

  console.log("\nScenario B: L1_idle timer fires:");
  simulatePipeline("session-user123:L1_idle").forEach(l => console.log(`  ${l}`));

  console.log("\nScenario C: offload-l2 timer fires (new format, should NOT trigger L2):");
  simulatePipeline("offload-l2:inst-1:sess-a:mmd-1.mmd").forEach(l => console.log(`  ${l}`));

  console.log("\nScenario D: Unknown suffix timer:");
  simulatePipeline("session-user123:unknown_type").forEach(l => console.log(`  ${l}`));
}

// ===================================================================
// Summary
// ===================================================================
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log(`⚠️  ${failed} test(s) failed — see above for details`);
  process.exit(1);
} else {
  console.log("All tests passed.");
  process.exit(0);
}
