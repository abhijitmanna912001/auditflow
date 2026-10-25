import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  companyFolderName,
  DriveFolderCache,
  driveFailureOf,
  escapeQueryValue,
  folderQuery,
  listUrl,
  MAX_FOLDER_NAME_CHARS,
  monthFolderName,
  reportFolderPath,
  type DriveContext,
} from "./drive-folders";
import { FakeDrive, FOLDER_MIME, TOKEN } from "./testing/fake-drive";

const context = (drive: FakeDrive, extra: Partial<DriveContext> = {}): DriveContext => ({
  getToken: () => drive.validToken,
  fetchImpl: drive.fetch,
  ...extra,
});

const PATH = ["AuditFlow", "Kaveri Traders", "2026-10"];
const listQueries = (drive: FakeDrive) =>
  drive.requests.filter((r) => r.method === "GET" && r.url.pathname === "/drive/v3/files").map((r) => r.url.searchParams.get("q"));
const creates = (drive: FakeDrive) =>
  drive.requests.filter((r) => r.method === "POST" && r.url.pathname === "/drive/v3/files");

describe("folder queries", () => {
  it("ask for a non-trashed folder with the exact name directly in the parent", () => {
    expect(folderQuery("AuditFlow", "root")).toBe(
      `name = 'AuditFlow' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`,
    );
  });

  it("escape backslashes before single quotes", () => {
    expect(escapeQueryValue(String.raw`O'Brien \ Sons`)).toBe(String.raw`O\'Brien \\ Sons`);
    expect(escapeQueryValue(String.raw`\'`)).toBe(String.raw`\\\'`);
    expect(folderQuery(String.raw`Rao's \ Co`, "abc")).toContain(String.raw`name = 'Rao\'s \\ Co'`);
  });

  it("are URL-encoded so the exact query reaches Drive", () => {
    const query = folderQuery("A&B = 'C' #1 % ü", "root");
    const url = new URL(listUrl(query, "files(id)"));
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/drive/v3/files");
    expect(url.searchParams.get("q")).toBe(query);
    expect(url.search).not.toMatch(/[ '#&]B|ü/);
    expect(url.searchParams.get("spaces")).toBe("drive");
    expect(url.searchParams.get("orderBy")).toBe("createdTime");
  });
});

describe("folder names", () => {
  it.each([
    ["Kaveri Traders", "Kaveri Traders"],
    ["Acme/Sub\\Unit", "Acme-Sub-Unit"],
    ["Tab\there\u0000and\u001fcontrol\u007f\u0085", "Tab here and control"],
    ["..hidden", "hidden"],
    [" . .Dots", "Dots"],
    ["Société Générale Müller", "Société Générale Müller"],
    ["कावेरी ट्रेडर्स ₹", "कावेरी ट्रेडर्स ₹"],
    ["  spaced   out  ", "spaced out"],
  ])("makes %j a safe folder name", (input, expected) => {
    expect(companyFolderName(input)).toBe(expected);
  });

  it.each([undefined, null, "", "   ", "...", "\u0000\u0001", " / "])(
    "uses No company named for %j",
    (input) => {
      const name = companyFolderName(input);
      expect(name).toBe(input === " / " ? "-" : "No company named");
    },
  );

  it("cuts long names without splitting characters", () => {
    expect(companyFolderName("x".repeat(500))).toHaveLength(MAX_FOLDER_NAME_CHARS);
    const emoji = companyFolderName("😀".repeat(150));
    expect([...emoji]).toHaveLength(MAX_FOLDER_NAME_CHARS);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("builds AuditFlow / Company / YYYY-MM in local time", () => {
    expect(monthFolderName(new Date(2026, 0, 31, 23, 59))).toBe("2026-01");
    expect(reportFolderPath("", new Date(2026, 9, 25))).toEqual(["AuditFlow", "No company named", "2026-10"]);
    expect(reportFolderPath("Kaveri Traders", new Date(2026, 9, 25))).toEqual(PATH);
  });
});

describe("finding and creating folders", () => {
  it("creates the missing folders in order, each inside the one before", async () => {
    const drive = new FakeDrive();
    const id = await new DriveFolderCache().ensurePath(PATH, context(drive));

    const auditFlow = drive.folderAt("AuditFlow")!;
    const company = drive.folderAt("AuditFlow", "Kaveri Traders")!;
    const month = drive.folderAt(...PATH)!;
    expect(id).toBe(month.id);
    expect(auditFlow.parents).toEqual(["root"]);
    expect(company.parents).toEqual([auditFlow.id]);
    expect(month.parents).toEqual([company.id]);
    expect(creates(drive).map((r) => JSON.parse(String(r.init.body)))).toEqual([
      { name: "AuditFlow", mimeType: FOLDER_MIME, parents: ["root"] },
      { name: "Kaveri Traders", mimeType: FOLDER_MIME, parents: [auditFlow.id] },
      { name: "2026-10", mimeType: FOLDER_MIME, parents: [company.id] },
    ]);
  });

  it("uses existing folders instead of creating new ones", async () => {
    const drive = new FakeDrive();
    const auditFlow = drive.addFolder("AuditFlow", "root");
    const company = drive.addFolder("Kaveri Traders", auditFlow.id);
    const month = drive.addFolder("2026-10", company.id);
    expect(await new DriveFolderCache().ensurePath(PATH, context(drive))).toBe(month.id);
    expect(creates(drive)).toHaveLength(0);
  });

  it("ignores trashed folders, files with the folder's name and same-named folders elsewhere", async () => {
    const drive = new FakeDrive();
    drive.addFolder("AuditFlow", "root", { trashed: true });
    drive.addFile("AuditFlow", "root");
    const other = drive.addFolder("Elsewhere", "root");
    drive.addFolder("AuditFlow", other.id);
    await new DriveFolderCache().ensurePath(["AuditFlow"], context(drive));
    expect(creates(drive)).toHaveLength(1);
    expect(listQueries(drive)[0]).toBe(folderQuery("AuditFlow", "root"));
  });

  it("picks the oldest of two folders with the same name, every time", async () => {
    const drive = new FakeDrive();
    const older = drive.addFolder("AuditFlow", "root");
    drive.addFolder("AuditFlow", "root");
    expect(await new DriveFolderCache().ensurePath(["AuditFlow"], context(drive))).toBe(older.id);
  });

  it("queries with an escaped company name", async () => {
    const drive = new FakeDrive();
    const path = ["AuditFlow", String.raw`Rao's \ Sons`, "2026-10"];
    await new DriveFolderCache().ensurePath(path, context(drive));
    expect(listQueries(drive)).toContain(folderQuery(String.raw`Rao's \ Sons`, drive.folderAt("AuditFlow")!.id));
    expect(drive.folderAt(...path)?.name).toBe("2026-10");
  });

  it("shares one lookup between concurrent requests for the same path", async () => {
    const drive = new FakeDrive();
    const cache = new DriveFolderCache();
    const ids = await Promise.all([1, 2, 3].map(() => cache.ensurePath(PATH, context(drive))));
    expect(new Set(ids).size).toBe(1);
    expect(creates(drive)).toHaveLength(3);
    expect(drive.children("root", FOLDER_MIME)).toHaveLength(1);
  });

  it("shares the common parent between concurrent requests for different companies", async () => {
    const drive = new FakeDrive();
    const cache = new DriveFolderCache();
    await Promise.all([
      cache.ensurePath(["AuditFlow", "A", "2026-10"], context(drive)),
      cache.ensurePath(["AuditFlow", "B", "2026-10"], context(drive)),
    ]);
    expect(drive.children("root", FOLDER_MIME)).toHaveLength(1);
    expect(drive.children(drive.folderAt("AuditFlow")!.id, FOLDER_MIME).map((f) => f.name).sort()).toEqual(["A", "B"]);
  });

  it("remembers folders for the page session and checks the remembered one still exists", async () => {
    const drive = new FakeDrive();
    const cache = new DriveFolderCache();
    const first = await cache.ensurePath(PATH, context(drive));
    const before = drive.requests.length;
    expect(await cache.ensurePath(PATH, context(drive))).toBe(first);
    const again = drive.requests.slice(before);
    expect(again).toHaveLength(1);
    expect(again[0].url.pathname).toBe(`/drive/v3/files/${first}`);
  });

  it.each([
    ["deleted", (drive: FakeDrive, id: string) => drive.items.delete(id)],
    ["trashed", (drive: FakeDrive, id: string) => void (drive.items.get(id)!.trashed = true)],
  ])("recreates a remembered folder that was %s", async (_, remove) => {
    const drive = new FakeDrive();
    const cache = new DriveFolderCache();
    const first = await cache.ensurePath(PATH, context(drive));
    remove(drive, first);
    const second = await cache.ensurePath(PATH, context(drive));
    expect(second).not.toBe(first);
    expect(drive.folderAt(...PATH)?.id).toBe(second);
  });

  it("recreates the whole path when a parent was trashed", async () => {
    const drive = new FakeDrive();
    const cache = new DriveFolderCache();
    await cache.ensurePath(PATH, context(drive));
    const oldRoot = drive.folderAt("AuditFlow")!;
    for (const item of drive.items.values()) item.trashed = true; // trashing a folder trashes its contents
    const id = await cache.ensurePath(PATH, context(drive));
    expect(drive.folderAt("AuditFlow")!.id).not.toBe(oldRoot.id);
    expect(drive.folderAt(...PATH)!.id).toBe(id);
  });

  it("looks a remembered folder up again when it can no longer open it", async () => {
    const drive = new FakeDrive();
    const cache = new DriveFolderCache();
    const first = await cache.ensurePath(PATH, context(drive));
    drive.failNext((r) => r.url.pathname === `/drive/v3/files/${first}`, 403);
    const before = drive.requests.length;
    // Still listed in its parent, so the same folder is found, not a new one made.
    expect(await cache.ensurePath(PATH, context(drive))).toBe(first);
    expect(listQueries({ ...drive, requests: drive.requests.slice(before) } as FakeDrive)).toContain(
      folderQuery("2026-10", drive.folderAt("AuditFlow", "Kaveri Traders")!.id),
    );
    expect(creates(drive)).toHaveLength(3);
  });

  it("looks again instead of creating a second folder when a create's answer is lost", async () => {
    const drive = new FakeDrive();
    drive.failNext((r) => r.method === "POST", "lost");
    const id = await new DriveFolderCache().ensurePath(["AuditFlow"], context(drive));
    expect(drive.children("root", FOLDER_MIME)).toHaveLength(1);
    expect(id).toBe(drive.folderAt("AuditFlow")!.id);
  });

  it.each([
    [500, "server"],
    [403, "permission"],
    [429, "rate_limited"],
    [401, "expired"],
    ["network", "network"],
  ] as const)("fails safely on %s", async (fault, reason) => {
    const drive = new FakeDrive();
    drive.failNext(() => true, fault);
    const error = await new DriveFolderCache().ensurePath(PATH, context(drive)).catch((e: unknown) => e);
    expect(driveFailureOf(error)).toBe(reason);
    expect(drive.items.size).toBe(0);
  });

  it("reports the token as rejected on 401, and nothing else", async () => {
    const drive = new FakeDrive();
    drive.validToken = "a-different-token";
    const rejected: string[] = [];
    const error = await new DriveFolderCache()
      .ensurePath(PATH, context(drive, { getToken: () => TOKEN, onTokenRejected: (t) => rejected.push(t) }))
      .catch((e: unknown) => e);
    expect(driveFailureOf(error)).toBe("expired");
    expect(rejected).toEqual([TOKEN]);
  });

  it("forgets everything when cleared, and retries after a failed lookup", async () => {
    const drive = new FakeDrive();
    const cache = new DriveFolderCache();
    drive.failNext(() => true, "network");
    await expect(cache.ensurePath(PATH, context(drive))).rejects.toBeTruthy();
    const id = await cache.ensurePath(PATH, context(drive));
    cache.clear();
    const before = drive.requests.length;
    expect(await cache.ensurePath(PATH, context(drive))).toBe(id);
    expect(drive.requests.slice(before).every((r) => r.method === "GET" && r.url.pathname === "/drive/v3/files")).toBe(true);
  });

  it("refuses an empty path or folder name", async () => {
    const drive = new FakeDrive();
    await expect(new DriveFolderCache().ensurePath([], context(drive))).rejects.toBeTruthy();
    await expect(new DriveFolderCache().ensurePath(["AuditFlow", " "], context(drive))).rejects.toBeTruthy();
    expect(drive.requests).toHaveLength(0);
  });

  it("stops without a request when there is no token", async () => {
    const drive = new FakeDrive();
    const error = await new DriveFolderCache()
      .ensurePath(PATH, context(drive, { getToken: () => null }))
      .catch((e: unknown) => e);
    expect(driveFailureOf(error)).toBe("no_token");
    expect(drive.requests).toHaveLength(0);
  });
});

describe("requests", () => {
  it("carry the token only in the Authorization header, with no cookies or referrer", async () => {
    const drive = new FakeDrive();
    await new DriveFolderCache().ensurePath(PATH, context(drive));
    for (const request of drive.requests) {
      expect(request.url.href).not.toContain(TOKEN);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
      expect(request.headers.has("X-Access-Code")).toBe(false);
      expect(request.url.origin).toBe("https://www.googleapis.com");
      expect(request.init.credentials).toBe("omit");
      expect(request.init.referrerPolicy).toBe("no-referrer");
    }
  });
});

describe("source", () => {
  const source = readFileSync(new URL("./drive-folders.ts", import.meta.url), "utf-8");

  it("never uses browser storage, cookies or the console", () => {
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
  });

  it("never uses the AuditFlow API client or the access code", () => {
    expect(source).not.toMatch(/apiFetch|api-client|X-Access-Code|API_BASE/);
  });
});
