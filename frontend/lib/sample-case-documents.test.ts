import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SAMPLE_CASE_IDS, sampleCaseDocuments } from "./sample-case-documents";

const DATASET = new URL("../../dataset/", import.meta.url);
// The case folders and the .txt files in each, as the backend reads them.
const datasetCases = readdirSync(DATASET, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^CASE_\d+$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
const filesOf = (caseId: string) =>
  readdirSync(new URL(`${caseId}/`, DATASET))
    .filter((name) => name.endsWith(".txt"))
    .sort();

describe("sample case source documents", () => {
  it("cover exactly the case folders in dataset/", () => {
    expect(datasetCases.length).toBeGreaterThanOrEqual(14);
    expect([...SAMPLE_CASE_IDS].sort()).toEqual(datasetCases);
  });

  it.each(datasetCases)("list every source file of %s, as in its dataset folder", (caseId) => {
    expect(sampleCaseDocuments(caseId)).toEqual(filesOf(caseId));
  });

  it("cover every sample case the app offers", () => {
    const app = readFileSync(new URL("../components/audit-flow-app.tsx", import.meta.url), "utf-8");
    const offered = [...app.matchAll(/id: "(CASE_\d+)"/g)].map((match) => match[1]);
    expect(offered.length).toBeGreaterThanOrEqual(14);
    for (const caseId of offered) expect(sampleCaseDocuments(caseId)?.length).toBeGreaterThan(0);
  });

  it("list Case 14's five files", () => {
    expect(sampleCaseDocuments("CASE_14")).toEqual([
      "BNK-1014.txt",
      "INV-1014.txt",
      "LED-1014.txt",
      "PO-1014.txt",
      "REC-1014.txt",
    ]);
  });

  it.each(["UPLOADED_1761380000000", "UPLOADED_BUNDLE", "CASE_99", "", "constructor", "__proto__"])(
    "has nothing for %j",
    (caseId) => {
      expect(sampleCaseDocuments(caseId)).toBeUndefined();
    },
  );
});
