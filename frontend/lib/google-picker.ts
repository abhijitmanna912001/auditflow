// Google Picker, used to choose individual Drive files. Picking a file with
// the app id set grants this app drive.file access to that file only, so no
// wider Drive scope is needed. Folders can be opened to find files, but a
// folder itself can't be chosen, and nothing is scanned.
//
// The Drive token is handed to the Picker for this one dialog and is not kept
// here.

import {
  GOOGLE_FOLDER,
  importDriveFiles,
  MAX_FILES_PER_RUN,
  SUPPORTED_TYPES,
  type DriveImportOptions,
  type DriveImportResult,
  type PickedFile,
} from "./drive-files";

const GAPI_SCRIPT_URL = "https://apis.google.com/js/api.js";
const LOAD_TIMEOUT_MS = 15_000;

// What the Picker lists: the supported file types, plus folders so the user
// can open them. Folders have their own MIME type, and Google's reference
// doesn't say a MIME filter exempts them, so the folder type is listed
// alongside setIncludeFolders(true) to keep them visible. Folders stay
// unselectable, and importDriveFiles still refuses anything that isn't a
// supported file.
export const PICKER_VIEW_MIME_TYPES = [...SUPPORTED_TYPES, GOOGLE_FOLDER].join(",");

// The parts of google.picker used here.
interface DocsView {
  setMimeTypes(mimeTypes: string): DocsView;
  setIncludeFolders(include: boolean): DocsView;
  setSelectFolderEnabled(enabled: boolean): DocsView;
}

interface Picker {
  setVisible(visible: boolean): void;
  dispose(): void;
}

interface PickerBuilder {
  addView(view: DocsView): PickerBuilder;
  enableFeature(feature: unknown): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setMaxItems(max: number): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setCallback(callback: (data: PickerResponse) => void): PickerBuilder;
  build(): Picker;
}

export interface PickerDocument {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
}

export interface PickerResponse {
  action?: string;
  docs?: PickerDocument[];
}

export interface PickerApi {
  readonly Action: { readonly PICKED: string; readonly CANCEL: string };
  readonly Feature: { readonly MULTISELECT_ENABLED: unknown };
  readonly ViewId: { readonly DOCS: unknown };
  readonly DocsView: new (viewId?: unknown) => DocsView;
  readonly PickerBuilder: new () => PickerBuilder;
}

export interface PickerOptions {
  readonly token: string;
  readonly apiKey: string;
  readonly appId: string;
  readonly maxItems: number;
}

export type PickerResult =
  | { readonly action: "picked"; readonly files: PickedFile[] }
  | { readonly action: "cancelled" };

function toPickedFile(doc: PickerDocument): PickedFile | null {
  if (typeof doc.id !== "string" || doc.id === "") return null;
  const size = Number(doc.sizeBytes);
  return {
    id: doc.id,
    name: typeof doc.name === "string" ? doc.name : "",
    mimeType: typeof doc.mimeType === "string" ? doc.mimeType : "",
    sizeBytes: doc.sizeBytes !== undefined && Number.isFinite(size) ? size : undefined,
  };
}

// Shows the Picker and resolves once the user picks files or closes it.
export function openPicker(api: PickerApi, options: PickerOptions): Promise<PickerResult> {
  return new Promise<PickerResult>((resolve, reject) => {
    let picker: Picker | null = null;
    const finish = (result: PickerResult) => {
      picker?.dispose();
      picker = null;
      resolve(result);
    };
    try {
      const view = new api.DocsView(api.ViewId.DOCS)
        .setMimeTypes(PICKER_VIEW_MIME_TYPES)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false);
      picker = new api.PickerBuilder()
        .addView(view)
        .enableFeature(api.Feature.MULTISELECT_ENABLED)
        .setMaxItems(Math.max(1, options.maxItems))
        .setOAuthToken(options.token)
        .setDeveloperKey(options.apiKey)
        .setAppId(options.appId)
        .setTitle("Select PDF or image files")
        .setCallback((data) => {
          if (data.action === api.Action.PICKED) {
            const files = (data.docs ?? []).map(toPickedFile).filter((f): f is PickedFile => f !== null);
            finish({ action: "picked", files });
          } else if (data.action === api.Action.CANCEL) {
            finish({ action: "cancelled" });
          }
          // Other actions (such as "loaded") need nothing.
        })
        .build();
      picker.setVisible(true);
    } catch (error) {
      picker?.dispose();
      reject(error);
    }
  });
}

interface GapiWindow {
  gapi?: {
    load(
      name: string,
      config: { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void },
    ): void;
  };
  google?: { picker?: PickerApi };
}

let pickerPromise: Promise<PickerApi> | null = null;

// Loads Google's API loader and the Picker once per page. A failed load can
// be retried.
export function loadPickerApi(): Promise<PickerApi> {
  pickerPromise ??= new Promise<PickerApi>((resolve, reject) => {
    const win = window as unknown as GapiWindow;
    const fail = () => reject(new Error("Google Picker did not load"));
    const loadPicker = () => {
      if (win.google?.picker) {
        resolve(win.google.picker);
        return;
      }
      if (!win.gapi) {
        fail();
        return;
      }
      win.gapi.load("picker", {
        callback: () => (win.google?.picker ? resolve(win.google.picker) : fail()),
        onerror: fail,
        timeout: LOAD_TIMEOUT_MS,
        ontimeout: fail,
      });
    };
    if (win.gapi) {
      loadPicker();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GAPI_SCRIPT_URL}"]`);
    if (existing?.dataset.loaded === "yes") {
      loadPicker();
      return;
    }
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => {
      script.dataset.loaded = "yes";
      loadPicker();
    }, { once: true });
    script.addEventListener("error", fail, { once: true });
    if (!existing) {
      script.src = GAPI_SCRIPT_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  }).catch((error: unknown) => {
    pickerPromise = null;
    throw error;
  });
  return pickerPromise;
}

export type DriveSelection =
  | { readonly kind: "not_connected" }
  | { readonly kind: "full" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "picker_failed" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "imported"; readonly result: DriveImportResult };

export interface DriveSelectionOptions extends Omit<DriveImportOptions, "picked"> {
  readonly apiKey: string;
  readonly appId: string;
  readonly loadPicker?: () => Promise<PickerApi>;
  readonly open?: typeof openPicker;
  // Called once the user has picked, before downloading starts.
  readonly onPicked?: (count: number) => void;
  // True once the user has disconnected Drive since this selection began.
  readonly wasDisconnected?: () => boolean;
}

// The whole Drive flow: show the Picker for the room left in this check,
// then download what was picked.
export async function selectDriveFiles(options: DriveSelectionOptions): Promise<DriveSelection> {
  const room = MAX_FILES_PER_RUN - options.existingCount;
  if (room <= 0) return { kind: "full" };
  // A quick check first, so the Picker isn't loaded for nothing.
  if (!options.getToken()) return { kind: "not_connected" };
  let api: PickerApi;
  try {
    api = await (options.loadPicker ?? loadPickerApi)();
  } catch {
    return { kind: "picker_failed" };
  }
  // Read again once loading is done: Drive may have been disconnected, or
  // the token may have expired, while the Picker was loading.
  const token = options.getToken();
  if (!token) return { kind: "not_connected" };
  let picked: PickerResult;
  try {
    picked = await (options.open ?? openPicker)(api, {
      token,
      apiKey: options.apiKey,
      appId: options.appId,
      maxItems: room,
    });
  } catch {
    return { kind: "picker_failed" };
  }
  if (picked.action === "cancelled" || picked.files.length === 0) return { kind: "cancelled" };
  if (options.wasDisconnected?.()) return { kind: "disconnected" };
  options.onPicked?.(picked.files.length);
  const result = await importDriveFiles({ ...options, picked: picked.files });
  // Files downloaded before a disconnect are dropped, not added afterwards.
  if (options.wasDisconnected?.()) return { kind: "disconnected" };
  return { kind: "imported", result };
}
