import { describe, expect, it } from "vitest";
import {
  finishedRunState,
  resolveStageState,
  showsResults,
  stageStateLabel,
  type RunState,
} from "./run-progress";

const STAGES = 5;
const stagesFor = (activeStage: number, runState: RunState) =>
  Array.from({ length: STAGES }, (_, index) => resolveStageState(index, activeStage, runState));

describe("finishing a run", () => {
  it("is complete only when the backend returned a workpaper", () => {
    expect(finishedRunState({ case_id: "CASE_01", rows: [], summary: {} })).toBe("complete");
    expect(finishedRunState(null)).toBe("failed");
    expect(finishedRunState(undefined)).toBe("failed");
  });

  it("shows results after both outcomes, so a failed run can show its sample-data warning", () => {
    expect(showsResults("complete")).toBe(true);
    expect(showsResults("failed")).toBe(true);
    expect(showsResults("ready")).toBe(false);
    expect(showsResults("running")).toBe(false);
  });
});

describe("stage states", () => {
  it("marks every stage done after a successful run", () => {
    expect(stagesFor(STAGES, finishedRunState({ rows: [] }))).toEqual(Array(STAGES).fill("complete"));
  });

  it("never marks a stage done after a failed run", () => {
    // Wherever the animation had reached when the backend failed.
    for (let activeStage = -1; activeStage <= STAGES; activeStage++) {
      const states = stagesFor(activeStage, finishedRunState(null));
      expect(states).toEqual(Array(STAGES).fill("failed"));
      expect(states).not.toContain("complete");
    }
  });

  it("labels failed stages for screen readers", () => {
    expect(stageStateLabel.failed).toBe("not completed");
    expect(stageStateLabel.complete).toBe("done");
  });

  it("keeps the running animation unchanged", () => {
    expect(stagesFor(2, "running")).toEqual(["complete", "complete", "active", "idle", "idle"]);
  });

  it("shows nothing started before a run", () => {
    expect(stagesFor(-1, "ready")).toEqual(Array(STAGES).fill("idle"));
  });
});
