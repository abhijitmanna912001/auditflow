// How a check's progress is shown. A run that got no results from the
// backend ends as "failed", so its steps are never shown as done, even
// though the page then shows sample results with a warning.

export type RunState = "ready" | "running" | "complete" | "failed";
export type StageState = "idle" | "active" | "complete" | "failed";

export const stageStateLabel: Record<StageState, string> = {
  idle: "not started",
  active: "in progress",
  complete: "done",
  failed: "not completed",
};

// The state a finished run ends in: complete only with a real workpaper.
export function finishedRunState(workpaper: unknown): "complete" | "failed" {
  return workpaper ? "complete" : "failed";
}

// Results are shown after any finished run: real ones after a complete run,
// sample ones with a warning after a failed run.
export function showsResults(runState: RunState): boolean {
  return runState === "complete" || runState === "failed";
}

export function resolveStageState(
  index: number,
  activeStage: number,
  runState: RunState,
): StageState {
  if (runState === "ready") return "idle";
  // The stage animation is only an estimate, so a failed run can't say which
  // step failed; none of them is shown as done.
  if (runState === "failed") return "failed";
  if (index < activeStage) return "complete";
  if (index === activeStage && runState === "running") return "active";
  if (runState === "complete") return "complete";
  return "idle";
}
