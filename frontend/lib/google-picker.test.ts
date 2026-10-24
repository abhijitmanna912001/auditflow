import { describe, expect, it, vi } from "vitest";
import { MAX_FILES_PER_RUN } from "./drive-files";
import { openPicker, selectDriveFiles, type PickerApi, type PickerResponse } from "./google-picker";

const TOKEN = "test-drive-token-not-real";
const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF");
const OPTIONS = { token: TOKEN, apiKey: "test-api-key", appId: "123456", maxItems: 4 };

// A stand-in for google.picker that records how the dialog was set up.
// `respond` plays the user's part.
function fakePicker() {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, value: unknown) => {
    (calls[name] ??= []).push(value);
  };
  let callback: ((data: PickerResponse) => void) | undefined;
  const picker = { setVisible: vi.fn(), dispose: vi.fn() };
  class DocsView {
    constructor(viewId?: unknown) {
      record("viewId", viewId);
    }
    setMimeTypes(value: string) {
      record("setMimeTypes", value);
      return this;
    }
    setIncludeFolders(value: boolean) {
      record("setIncludeFolders", value);
      return this;
    }
    setSelectFolderEnabled(value: boolean) {
      record("setSelectFolderEnabled", value);
      return this;
    }
  }
  class PickerBuilder {
    addView(view: unknown) {
      record("addView", view);
      return this;
    }
    enableFeature(value: unknown) {
      record("enableFeature", value);
      return this;
    }
    setOAuthToken(value: string) {
      record("setOAuthToken", value);
      return this;
    }
    setDeveloperKey(value: string) {
      record("setDeveloperKey", value);
      return this;
    }
    setAppId(value: string) {
      record("setAppId", value);
      return this;
    }
    setMaxItems(value: number) {
      record("setMaxItems", value);
      return this;
    }
    setTitle(value: string) {
      record("setTitle", value);
      return this;
    }
    setCallback(value: (data: PickerResponse) => void) {
      callback = value;
      return this;
    }
    build() {
      return picker;
    }
  }
  const api: PickerApi = {
    Action: { PICKED: "picked", CANCEL: "cancel" },
    Feature: { MULTISELECT_ENABLED: "multiselect" },
    ViewId: { DOCS: "all" },
    DocsView,
    PickerBuilder,
  };
  return { api, calls, picker, respond: (data: PickerResponse) => callback?.(data) };
}

describe("openPicker", () => {
  it("offers several individual files of the supported types, and no folders", () => {
    const google = fakePicker();
    void openPicker(google.api, OPTIONS);
    expect(google.calls.setMimeTypes).toEqual(["application/pdf,image/png,image/jpeg,image/webp"]);
    expect(google.calls.setIncludeFolders).toEqual([false]);
    expect(google.calls.setSelectFolderEnabled).toEqual([false]);
    expect(google.calls.enableFeature).toEqual(["multiselect"]);
    expect(google.calls.setMaxItems).toEqual([4]);
    expect(google.calls.setOAuthToken).toEqual([TOKEN]);
    expect(google.calls.setDeveloperKey).toEqual(["test-api-key"]);
    expect(google.calls.setAppId).toEqual(["123456"]);
    expect(google.picker.setVisible).toHaveBeenCalledWith(true);
  });

  it("returns what was picked, ignoring entries without an id", async () => {
    const google = fakePicker();
    const result = openPicker(google.api, OPTIONS);
    google.respond({ action: "loaded" });
    google.respond({
      action: "picked",
      docs: [
        { id: "a1", name: "inv.pdf", mimeType: "application/pdf", sizeBytes: 1200 },
        { id: "b2", name: "scan.png", mimeType: "image/png", sizeBytes: "3400" },
        { id: "c3", name: "notes", mimeType: "application/vnd.google-apps.document" },
        { name: "no id" },
      ],
    });
    expect(await result).toEqual({
      action: "picked",
      files: [
        { id: "a1", name: "inv.pdf", mimeType: "application/pdf", sizeBytes: 1200 },
        { id: "b2", name: "scan.png", mimeType: "image/png", sizeBytes: 3400 },
        { id: "c3", name: "notes", mimeType: "application/vnd.google-apps.document", sizeBytes: undefined },
      ],
    });
    expect(google.picker.dispose).toHaveBeenCalled();
  });

  it("reports cancellation and closes the dialog", async () => {
    const google = fakePicker();
    const result = openPicker(google.api, OPTIONS);
    google.respond({ action: "cancel" });
    expect(await result).toEqual({ action: "cancelled" });
    expect(google.picker.dispose).toHaveBeenCalled();
  });
});

describe("selectDriveFiles", () => {
  const base = { apiKey: "test-api-key", appId: "123456" };

  it("does nothing when the Picker is cancelled", async () => {
    const google = fakePicker();
    const fetchImpl = vi.fn();
    const outcome = selectDriveFiles({
      ...base,
      existingCount: 0,
      getToken: () => TOKEN,
      loadPicker: async () => google.api,
      fetchImpl,
    });
    await vi.waitFor(() => expect(google.picker.setVisible).toHaveBeenCalled());
    google.respond({ action: "cancel" });
    expect(await outcome).toEqual({ kind: "cancelled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks to connect first, without opening the Picker, when there is no token", async () => {
    const loadPicker = vi.fn();
    const outcome = await selectDriveFiles({ ...base, existingCount: 0, getToken: () => null, loadPicker });
    expect(outcome).toEqual({ kind: "not_connected" });
    expect(loadPicker).not.toHaveBeenCalled();
  });

  it("doesn't open the Picker when the check is already full", async () => {
    const loadPicker = vi.fn();
    const outcome = await selectDriveFiles({
      ...base,
      existingCount: MAX_FILES_PER_RUN,
      getToken: () => TOKEN,
      loadPicker,
    });
    expect(outcome).toEqual({ kind: "full" });
    expect(loadPicker).not.toHaveBeenCalled();
  });

  it("reads the token again after loading, and doesn't open the Picker if it's gone", async () => {
    const google = fakePicker();
    let finishLoading: (api: PickerApi) => void = () => {};
    const loadPicker = vi.fn(() => new Promise<PickerApi>((resolve) => (finishLoading = resolve)));
    const open = vi.fn(openPicker);
    let token: string | null = TOKEN;
    const getToken = vi.fn(() => token);
    const fetchImpl = vi.fn();
    const outcome = selectDriveFiles({ ...base, existingCount: 0, getToken, loadPicker, open, fetchImpl });
    await vi.waitFor(() => expect(loadPicker).toHaveBeenCalled());
    // Drive is disconnected, or the token expires, while the Picker loads.
    token = null;
    finishLoading(google.api);
    expect(await outcome).toEqual({ kind: "not_connected" });
    expect(open).not.toHaveBeenCalled();
    expect(google.picker.setVisible).not.toHaveBeenCalled();
    expect(google.calls.setOAuthToken).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("gives the Picker the token current when it opens, not the one from before loading", async () => {
    const google = fakePicker();
    let finishLoading: (api: PickerApi) => void = () => {};
    let token = "token-before-loading";
    const outcome = selectDriveFiles({
      ...base,
      existingCount: 0,
      getToken: () => token,
      loadPicker: () => new Promise<PickerApi>((resolve) => (finishLoading = resolve)),
    });
    await Promise.resolve();
    token = "token-after-reconnect";
    finishLoading(google.api);
    await vi.waitFor(() => expect(google.picker.setVisible).toHaveBeenCalled());
    expect(google.calls.setOAuthToken).toEqual(["token-after-reconnect"]);
    google.respond({ action: "cancel" });
    expect(await outcome).toEqual({ kind: "cancelled" });
  });

  it("adds nothing when Drive is disconnected while files download", async () => {
    const google = fakePicker();
    let disconnected = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.get("alt") !== "media") {
        return new Response(JSON.stringify({ name: "inv.pdf", mimeType: "application/pdf", size: String(PDF.byteLength) }));
      }
      disconnected = true; // the user disconnects mid-download
      return new Response(PDF);
    });
    const outcome = selectDriveFiles({
      ...base,
      existingCount: 0,
      getToken: () => TOKEN,
      wasDisconnected: () => disconnected,
      loadPicker: async () => google.api,
      fetchImpl,
    });
    await vi.waitFor(() => expect(google.picker.setVisible).toHaveBeenCalled());
    google.respond({ action: "picked", docs: [{ id: "a1", name: "inv.pdf", mimeType: "application/pdf" }] });
    expect(await outcome).toEqual({ kind: "disconnected" });
  });

  it("doesn't download anything when Drive is disconnected while the Picker is open", async () => {
    const google = fakePicker();
    let disconnected = false;
    const fetchImpl = vi.fn();
    const outcome = selectDriveFiles({
      ...base,
      existingCount: 0,
      getToken: () => TOKEN,
      wasDisconnected: () => disconnected,
      loadPicker: async () => google.api,
      fetchImpl,
    });
    await vi.waitFor(() => expect(google.picker.setVisible).toHaveBeenCalled());
    disconnected = true;
    google.respond({ action: "picked", docs: [{ id: "a1", name: "inv.pdf", mimeType: "application/pdf" }] });
    expect(await outcome).toEqual({ kind: "disconnected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a Picker that fails to load", async () => {
    const outcome = await selectDriveFiles({
      ...base,
      existingCount: 0,
      getToken: () => TOKEN,
      loadPicker: () => Promise.reject(new Error("blocked")),
    });
    expect(outcome).toEqual({ kind: "picker_failed" });
  });

  it("limits the Picker to the room left and downloads what was picked", async () => {
    const google = fakePicker();
    const fetchImpl = vi.fn(async (url: string) =>
      new URL(url).searchParams.get("alt") === "media"
        ? new Response(PDF)
        : new Response(JSON.stringify({ name: "inv.pdf", mimeType: "application/pdf", size: String(PDF.byteLength) })),
    );
    const onPicked = vi.fn();
    const outcome = selectDriveFiles({
      ...base,
      existingCount: 6,
      getToken: () => TOKEN,
      loadPicker: async () => google.api,
      onPicked,
      fetchImpl,
    });
    await vi.waitFor(() => expect(google.picker.setVisible).toHaveBeenCalled());
    expect(google.calls.setMaxItems).toEqual([MAX_FILES_PER_RUN - 6]);
    google.respond({ action: "picked", docs: [{ id: "a1", name: "inv.pdf", mimeType: "application/pdf", sizeBytes: PDF.byteLength }] });
    const result = await outcome;
    expect(onPicked).toHaveBeenCalledWith(1);
    expect(result.kind).toBe("imported");
    if (result.kind !== "imported") return;
    expect(result.result.accepted.map((f) => f.file.name)).toEqual(["inv.pdf"]);
    expect(result.result.skipped).toEqual([]);
  });

  it("stops if Drive access ends between picking and downloading", async () => {
    const google = fakePicker();
    const fetchImpl = vi.fn();
    let live = true;
    const getToken = vi.fn(() => (live ? TOKEN : null));
    const outcome = selectDriveFiles({ ...base, existingCount: 0, getToken, loadPicker: async () => google.api, fetchImpl });
    await vi.waitFor(() => expect(google.picker.setVisible).toHaveBeenCalled());
    live = false;
    google.respond({ action: "picked", docs: [{ id: "a1", name: "inv.pdf", mimeType: "application/pdf" }] });
    const result = await outcome;
    expect(result).toEqual({
      kind: "imported",
      result: { accepted: [], skipped: [{ name: "inv.pdf", reason: "expired" }], expired: true },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
