// The source files of each sample case, as in dataset/CASE_XX/ (the files the
// backend reads for a sample run, sorted). A sample result only names the
// documents its findings cite, so a report lists these instead, to show
// every document the case was checked against. File names only; the files
// themselves are never read here.
//
// sample-case-documents.test.ts checks this list against the dataset
// folders, so a changed dataset fails the tests until this is updated.

const SAMPLE_CASE_DOCUMENTS: Readonly<Record<string, readonly string[]>> = {
  CASE_01: ["BNK-1001.txt", "INV-1001.txt", "LED-1001.txt", "PO-1001.txt", "REC-1001.txt"],
  CASE_02: ["BNK-1002.txt", "INV-1002.txt", "LED-1002.txt", "PO-1002.txt", "REC-1002.txt"],
  CASE_03: ["BNK-1003.txt", "INV-1003-A.txt", "INV-1003-B.txt", "LED-1003.txt", "PO-1003.txt", "REC-1003.txt"],
  CASE_04: ["BNK-1004.txt", "INV-1004.txt", "LED-1004.txt", "PO-1004.txt", "REC-1004.txt"],
  CASE_05: ["BNK-1005.txt", "INV-1005.txt", "LED-1005.txt", "REC-1005.txt"],
  CASE_06: ["BNK-1006.txt", "INV-1006.txt", "LED-1006.txt", "PO-1006.txt"],
  CASE_07: ["BNK-1007.txt", "INV-1007.txt", "LED-1007.txt", "PO-1007.txt", "REC-1007.txt"],
  CASE_08: ["BNK-1008.txt", "INV-1008.txt", "LED-1008.txt", "PO-1008.txt", "REC-1008.txt"],
  CASE_09: ["BNK-1009.txt", "INV-1009-A.txt", "INV-1009-B.txt", "LED-1009.txt", "PO-1009.txt"],
  CASE_10: ["BNK-1010.txt", "INV-1010.txt", "LED-1010.txt", "PO-1010.txt", "REC-1010.txt"],
  CASE_11: ["BNK-1011.txt", "INV-1011.txt", "LED-1011.txt", "REC-1011.txt"],
  CASE_12: ["BNK-1012.txt", "INV-1012.txt", "LED-1012.txt", "PO-1012.txt"],
  CASE_13: ["BNK-1013.txt", "INV-1013.txt", "LED-1013.txt", "PO-1013.txt", "REC-1013.txt"],
  CASE_14: ["BNK-1014.txt", "INV-1014.txt", "LED-1014.txt", "PO-1014.txt", "REC-1014.txt"],
};

/**
 * The source file names of a sample case, or undefined for anything else
 * (an upload run's result carries its own uploaded file list).
 */
export function sampleCaseDocuments(caseId: string): readonly string[] | undefined {
  return Object.hasOwn(SAMPLE_CASE_DOCUMENTS, caseId) ? SAMPLE_CASE_DOCUMENTS[caseId] : undefined;
}

export const SAMPLE_CASE_IDS: readonly string[] = Object.keys(SAMPLE_CASE_DOCUMENTS);
