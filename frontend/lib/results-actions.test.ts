import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResultsActions } from "../components/results-actions";

const button = (label: string) => createElement("button", { className: "secondary-button" }, label);
const render = (props: Partial<Parameters<typeof ResultsActions>[0]>) =>
  renderToStaticMarkup(
    createElement(ResultsActions, {
      savePdf: button("Save PDF report"),
      driveSave: button("Save to Google Drive"),
      sendAll: button("Send all findings to Zoho Desk (2)"),
      ...props,
    }),
  );

// Line endings normalised: a Windows checkout may use CRLF.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8").replace(/\r\n/g, "\n");

describe("results action row", () => {
  it("shows Save PDF report, Save to Google Drive, then Send all findings, in one row", () => {
    const html = render({});
    const row = /<div class="results-actions" role="group" aria-label="Report actions">(.*?)<\/div>/.exec(html)?.[1] ?? "";
    const order = ["Save PDF report", "Save to Google Drive", "Send all findings to Zoho Desk"].map((label) =>
      row.indexOf(label),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("leaves out an action that doesn't show, keeping the others in order", () => {
    const html = render({ driveSave: null });
    expect(html).not.toContain("Save to Google Drive");
    expect(html.indexOf("Save PDF report")).toBeLessThan(html.indexOf("Send all findings"));
  });

  it("renders nothing when there are no actions and nothing to report", () => {
    expect(render({ savePdf: null, driveSave: null, sendAll: null })).toBe("");
  });

  it("puts the caption and messages below the row, not in it", () => {
    const html = render({
      caption: "One line of help.",
      status: createElement("div", { role: "status" }, "A message"),
    });
    const rowEnd = html.indexOf("</div>");
    expect(html.indexOf('<p class="results-actions-hint">One line of help.</p>')).toBeGreaterThan(rowEnd);
    expect(html.indexOf("A message")).toBeGreaterThan(html.indexOf("One line of help."));
  });

  it("has no caption line when there is no caption", () => {
    expect(render({ caption: null })).not.toContain("results-actions-hint");
  });
});

describe("results action row styles", () => {
  const css = read("../app/globals.css");
  const rule = (selector: string, from = 0) => {
    const start = css.indexOf(`${selector} {`, from);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  };

  it("lays the actions out in one right-aligned row that wraps", () => {
    const row = rule(".results-actions");
    expect(row).toContain("display: flex;");
    expect(row).toContain("flex-wrap: wrap;");
    expect(row).toContain("justify-content: flex-end;");
  });

  it("gives every action button the same 44px minimum height and lets long labels wrap", () => {
    const buttons = rule(".results-actions .secondary-button");
    expect(buttons).toContain("min-height: 44px;");
    expect(buttons).toContain("white-space: normal;");
    expect(buttons).toContain("overflow-wrap: anywhere;");
    expect(buttons).toContain("max-width: 100%;");
  });

  it("left-aligns status messages and wraps long file names and paths", () => {
    const message = rule(".status-message");
    expect(message).toContain("text-align: left;");
    expect(message).toContain("overflow-wrap: anywhere;");
    for (const tone of ["ok", "warning", "problem"]) expect(rule(`.status-message.${tone}`)).toContain("color:");
  });

  it("left-aligns the row and lets buttons share the width on narrow screens", () => {
    const narrow = css.indexOf("@media (max-width: 620px)", css.indexOf(".results-actions-hint {"));
    expect(narrow).toBeGreaterThan(0);
    expect(rule(".results-actions", narrow)).toContain("justify-content: flex-start;");
    expect(rule(".results-actions .secondary-button", narrow)).toContain("flex: 1 1 auto;");
  });
});

describe("results header source", () => {
  const app = read("../components/audit-flow-app.tsx");

  it("passes the actions to the row in order, with their existing conditions and handlers", () => {
    const start = app.indexOf("<ResultsActions");
    const block = app.slice(start, app.indexOf("/>\n", app.indexOf("caption={", start)));
    const positions = ["savePdf={", "driveSave={", "sendAll={"].map((prop) => block.indexOf(prop));
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(block).toContain("onClick={saveReport}");
    expect(block).toContain("onSend={() => void sendFindings(pendingFindings)}");
    expect(block).toContain("canSend={canSend}");
    expect(block).toContain("showsDriveSaveAction(driveSave)");
    // Save to Google Drive's report: only a completed run with backend results.
    const hook = app.slice(app.indexOf("const driveSave = useDriveSave("), app.indexOf("<ResultsActions"));
    expect(hook).toContain("isComplete && backendLoaded && workpaper && completedRun");
  });

  it("shows the Drive hint only while the Drive button shows, and one message area below the row", () => {
    const start = app.indexOf("<ResultsActions");
    // Up to the row's own closing "/>" (indented under <ResultsActions).
    const block = app.slice(start, app.indexOf("\n          />", start));
    expect(block).toMatch(/\{showsDriveSaveAction\(driveSave\) && \(\s*<span id=\{DRIVE_SAVE_HINT_ID\}>\{DRIVE_SAVE_HINT\}<\/span>/);
    expect(block).toContain("<DriveSaveStatus control={driveSave} />");
    expect(app.match(/<DriveSaveStatus /g)).toHaveLength(1);
  });

  it("keeps the resolver badge and results source out of the action row", () => {
    const meta = app.slice(app.indexOf('<div className="workpaper-meta">'), app.indexOf("<ResultsActions"));
    expect(meta).toContain("<ResolverBadge");
    expect(meta).toContain('className="contract-note"');
    expect(meta).not.toMatch(/secondary-button|SendAllButton|DriveSave/);
  });
});
