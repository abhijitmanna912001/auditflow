// Test support only (not imported by the app): an in-memory stand-in for the
// parts of the Google Drive API that drive-folders.ts and
// drive-report-upload.ts use, plus a stand-in Drive session. It records
// every request and can be told to fail the next matching one in the ways a
// real connection can.

import { vi } from "vitest";

export const TOKEN = "test-drive-token-not-real";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface FakeItem {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  appProperties?: Record<string, string>;
  createdTime: number;
  bytes?: Uint8Array;
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly init: RequestInit;
}

// What to do with the next request a fault matches:
// - "network": fail before Google sees it (nothing changes).
// - "lost": Google handles it, then the response is lost.
// - "hang": never answer until the request is aborted.
// - "stall": Google handles it and sends the status, but the body never
//   finishes (and, unlike a real fetch, ignores the abort signal).
// - a number: answer with that HTTP status (nothing changes).
// - { body }: Google handles it, then answers 200 with this body instead.
//   With `handled: false`, answers with the body without handling it.
export type Fault =
  | "network"
  | "lost"
  | "hang"
  | "stall"
  | number
  | { readonly body: string; readonly handled?: boolean };

interface PendingFault {
  readonly match: (request: RecordedRequest) => boolean;
  readonly fault: Fault;
}

const unescape = (value: string) => value.replace(/\\(.)/g, "$1");
const quoted = String.raw`'((?:[^'\\]|\\.)*)'`;

// Evaluates the query forms the modules build (clauses joined by "and").
function matches(item: FakeItem, query: string): boolean {
  const name = new RegExp(`name = ${quoted}`).exec(query);
  if (name && item.name !== unescape(name[1])) return false;
  const mime = new RegExp(`mimeType = ${quoted}`).exec(query);
  if (mime && item.mimeType !== unescape(mime[1])) return false;
  const parent = new RegExp(`${quoted} in parents`).exec(query);
  if (parent && !item.parents.includes(unescape(parent[1]))) return false;
  if (/trashed = false/.test(query) && item.trashed) return false;
  const property = new RegExp(`appProperties has \\{ key=${quoted} and value=${quoted} \\}`).exec(query);
  if (property && item.appProperties?.[unescape(property[1])] !== unescape(property[2])) return false;
  return true;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export class FakeDrive {
  readonly items = new Map<string, FakeItem>();
  readonly requests: RecordedRequest[] = [];
  validToken: string | null = TOKEN;
  private nextId = 1;
  private clock = 1;
  private faults: PendingFault[] = [];

  readonly fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const request: RecordedRequest = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers: new Headers(init.headers),
      init,
    };
    this.requests.push(request);
    const index = this.faults.findIndex((pending) => pending.match(request));
    const fault = index === -1 ? null : this.faults.splice(index, 1)[0].fault;
    if (fault === "network") throw new TypeError("Failed to fetch");
    if (fault === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }
    if (typeof fault === "number") return json(fault, { error: { code: fault, message: "fake failure" } });
    if (fault && typeof fault === "object" && fault.handled === false) return new Response(fault.body, { status: 200 });
    const response = await this.handle(request);
    if (fault === "lost") throw new TypeError("Failed to fetch");
    if (fault === "stall") return new Response(new ReadableStream<Uint8Array>(), { status: response.status });
    if (fault && typeof fault === "object") return new Response(fault.body, { status: 200 });
    return response;
  });

  /** Fails the next request that `match` accepts. */
  failNext(match: (request: RecordedRequest) => boolean, fault: Fault): void {
    this.faults.push({ match, fault });
  }

  addFolder(name: string, parent: string, extra: Partial<FakeItem> = {}): FakeItem {
    return this.add({ name, mimeType: FOLDER_MIME, parents: [parent], ...extra });
  }

  addFile(name: string, parent: string, extra: Partial<FakeItem> = {}): FakeItem {
    return this.add({ name, mimeType: "application/pdf", parents: [parent], ...extra });
  }

  /** Items in a folder (not trashed) with a given MIME type. */
  children(parent: string, mimeType?: string): FakeItem[] {
    return [...this.items.values()].filter(
      (item) => item.parents.includes(parent) && !item.trashed && (!mimeType || item.mimeType === mimeType),
    );
  }

  /** The folder at a path from My Drive, if there is exactly one. */
  folderAt(...names: string[]): FakeItem | undefined {
    let parent = "root";
    let found: FakeItem | undefined;
    for (const name of names) {
      const matchesName = this.children(parent, FOLDER_MIME).filter((item) => item.name === name);
      if (matchesName.length !== 1) return undefined;
      found = matchesName[0];
      parent = found.id;
    }
    return found;
  }

  private add(fields: Omit<FakeItem, "id" | "trashed" | "createdTime"> & Partial<FakeItem>): FakeItem {
    const item: FakeItem = {
      id: `fake-id-${this.nextId++}`,
      trashed: false,
      createdTime: this.clock++,
      ...fields,
    };
    this.items.set(item.id, item);
    return item;
  }

  private parentUsable(id: string): boolean {
    if (id === "root") return true;
    const parent = this.items.get(id);
    return Boolean(parent && !parent.trashed && parent.mimeType === FOLDER_MIME);
  }

  private async handle(request: RecordedRequest): Promise<Response> {
    if (request.headers.get("Authorization") !== `Bearer ${this.validToken}`) {
      return json(401, { error: { code: 401, message: "Invalid Credentials" } });
    }
    const { method, url } = request;
    const path = url.pathname;
    if (method === "GET" && path === "/drive/v3/files") {
      const query = url.searchParams.get("q") ?? "";
      const files = [...this.items.values()]
        .filter((item) => matches(item, query))
        .sort((a, b) => a.createdTime - b.createdTime)
        .map(({ id, name, mimeType, trashed, appProperties }) => ({ id, name, mimeType, trashed, appProperties }));
      return json(200, { files });
    }
    const single = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (method === "GET" && single) {
      const item = this.items.get(single[1]);
      if (!item) return json(404, { error: { code: 404, message: "File not found" } });
      return json(200, { id: item.id, mimeType: item.mimeType, trashed: item.trashed });
    }
    if (method === "POST" && path === "/drive/v3/files") {
      const body = JSON.parse(String(request.init.body)) as { name: string; mimeType: string; parents: string[] };
      if (!body.parents.every((id) => this.parentUsable(id))) return json(404, { error: { code: 404 } });
      const item = this.add({ name: body.name, mimeType: body.mimeType, parents: body.parents });
      return json(200, { id: item.id, name: item.name, mimeType: item.mimeType, trashed: false });
    }
    if (method === "POST" && path === "/upload/drive/v3/files") {
      const boundary = /boundary=(\S+)/.exec(request.headers.get("Content-Type") ?? "")?.[1] ?? "";
      const raw = Buffer.from(await (request.init.body as Blob).arrayBuffer()).toString("latin1");
      const [, metadataPart, filePart] = raw.split(`--${boundary}`);
      const metadata = JSON.parse(
        Buffer.from(metadataPart.split("\r\n\r\n")[1].trimEnd(), "latin1").toString("utf8"),
      ) as { name: string; mimeType: string; parents: string[]; appProperties?: Record<string, string> };
      const content = filePart.slice(filePart.indexOf("\r\n\r\n") + 4, -2);
      if (!metadata.parents.every((id) => this.parentUsable(id))) return json(404, { error: { code: 404 } });
      const item = this.add({ ...metadata, bytes: new Uint8Array(Buffer.from(content, "latin1")) });
      return json(200, { id: item.id, name: item.name, mimeType: item.mimeType, parents: item.parents });
    }
    return json(405, { error: { code: 405, message: `unexpected ${method} ${path}` } });
  }
}

/** A stand-in for the page's DriveSession. */
export function fakeSession(drive: FakeDrive) {
  let state: "connected" | "expired" | "disconnected" = "connected";
  const listeners = new Set<() => void>();
  const session = {
    getState: () => state,
    getAccessToken: () => (state === "connected" ? drive.validToken : null),
    markTokenRejected: vi.fn((token: string) => {
      if (state === "connected" && token === drive.validToken) state = "expired";
    }),
    onDisconnect: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    expire: () => {
      state = "expired";
    },
    disconnect: () => {
      state = "disconnected";
      listeners.forEach((listener) => listener());
    },
    reconnect: () => {
      state = "connected";
    },
  };
  return session;
}

/** A small valid PDF, made of bytes only (no generator needed). */
export const TINY_PDF = new TextEncoder().encode("%PDF-1.3\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
