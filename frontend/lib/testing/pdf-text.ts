// Test support only (not imported by the app): reads the text back out of
// a PDF that pdfmake/pdfkit generated, the way a PDF reader does.

import { inflateSync } from "node:zlib";

export interface ExtractedPdf {
  /** Page text in reading order, one line per text block. */
  readonly text: string;
  /** Characters of glyphs whose ToUnicode entry is more than one character (ligatures). */
  readonly multiCharacterGlyphs: readonly string[];
  /** Glyphs drawn with glyph 0 (.notdef), which viewers show as a box. */
  readonly missingGlyphs: number;
}

/**
 * Extracts the text from generated PDF bytes the way PDF readers do: each
 * page's content stream is inflated, and every glyph code its text
 * operators show is mapped back to characters through the font's
 * ToUnicode CMap. Written for pdfkit's output (Identity-H fonts, one
 * bfrange array per CMap), so no PDF-parsing dependency is needed.
 */
export function extractPdfText(bytes: Uint8Array): ExtractedPdf {
  // Byte-for-byte: TextDecoder's "latin1" is really windows-1252.
  const pdf = Buffer.from(bytes).toString("latin1");
  const objects = new Map<string, { dict: string; stream: string | null }>();
  for (const match of pdf.matchAll(/(\d+) 0 obj\s*([\s\S]*?)\bendobj/g)) {
    const body = match[2];
    const streamAt = body.search(/\bstream\r?\n/);
    if (streamAt === -1) {
      objects.set(match[1], { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, streamAt);
    const start = body.indexOf("\n", streamAt) + 1;
    const length = Number(/\/Length (\d+)/.exec(dict)?.[1]);
    let data: Buffer = Buffer.from(body.slice(start, start + length), "latin1");
    if (dict.includes("/FlateDecode")) data = inflateSync(data);
    objects.set(match[1], { dict, stream: data.toString("latin1") });
  }
  const ref = (dict: string, key: string) => new RegExp(`/${key} (\\d+) 0 R`).exec(dict)?.[1];

  const utf16 = (hex: string) => {
    const units = hex.replace(/\s+/g, "").match(/.{4}/g) ?? [];
    return String.fromCharCode(...units.map((unit) => parseInt(unit, 16)));
  };
  interface Font {
    readonly cmap: Map<number, string>;
    /** Glyph advance widths in 1/1000 em. */
    readonly widths: readonly number[];
  }
  const fonts = new Map<string, Font>();
  const loadFont = (fontObject: string): Font => {
    if (!fonts.has(fontObject)) {
      const dict = objects.get(fontObject)?.dict ?? "";
      const cmap = new Map<number, string>();
      const toUnicode = objects.get(ref(dict, "ToUnicode") ?? "")?.stream;
      if (!toUnicode) throw new Error(`font ${fontObject} has no ToUnicode map`);
      for (const range of toUnicode.matchAll(/<([0-9a-f]+)>\s*<[0-9a-f]+>\s*\[([^\]]*)\]/gi)) {
        [...range[2].matchAll(/<([^>]*)>/g)].forEach((target, index) =>
          cmap.set(parseInt(range[1], 16) + index, utf16(target[1])),
        );
      }
      const descendant = /\/DescendantFonts \[(\d+) 0 R\]/.exec(dict)?.[1] ?? "";
      const widths = (/\/W \[0 \[([^\]]*)\]\]/.exec(objects.get(descendant)?.dict ?? "")?.[1] ?? "")
        .trim()
        .split(/\s+/)
        .map(Number);
      fonts.set(fontObject, { cmap, widths });
    }
    return fonts.get(fontObject)!;
  };

  const pages = [...(objects.values())]
    .filter(({ dict }) => /\/Type \/Pages\b/.test(dict))
    .flatMap(({ dict }) => [.../\/Kids \[([^\]]*)\]/.exec(dict)![1].matchAll(/(\d+) 0 R/g)].map((kid) => kid[1]));
  const lines: string[] = [];
  const multiCharacterGlyphs = new Set<string>();
  let missingGlyphs = 0;
  for (const page of pages) {
    const pageDict = objects.get(page)!.dict;
    const resourcesRef = ref(pageDict, "Resources");
    const resources = resourcesRef ? objects.get(resourcesRef)!.dict : pageDict;
    const pageFonts = new Map(
      [.../\/Font <<([\s\S]*?)>>/.exec(resources)![1].matchAll(/\/(\w+) (\d+) 0 R/g)].map((font) => [font[1], font[2]]),
    );
    const content = objects.get(ref(pageDict, "Contents")!)!.stream!;
    // pdfmake draws each word as its own text object, so, like a PDF
    // reader, start a new line when the baseline moves and add a space when
    // the next word starts beyond where the last one ended.
    let font: Font = { cmap: new Map(), widths: [] };
    let fontSize = 0;
    let x = 0;
    let y = Number.NaN;
    let lineY = Number.NaN;
    let lineEnd = Number.NEGATIVE_INFINITY;
    let line = "";
    const number = String.raw`(-?[\d.]+)`;
    const tokens = new RegExp(
      String.raw`/(\w+) ${number} Tf|${Array(4).fill(number).join(" ").replaceAll("(", "(?:")} ${number} ${number} Tm|\[([^\]]*)\]\s*TJ|<([0-9a-f]*)>\s*Tj`,
      "gi",
    );
    for (const token of content.matchAll(tokens)) {
      if (token[1]) {
        font = loadFont(pageFonts.get(token[1])!);
        fontSize = Number(token[2]);
      } else if (token[3]) {
        x = Number(token[3]);
        y = Number(token[4]);
      } else {
        const hex = token[6] ?? [...token[5].matchAll(/<([0-9a-f]*)>/gi)].map((part) => part[1]).join("");
        let word = "";
        let width = 0;
        for (const code of hex.match(/.{4}/g) ?? []) {
          const glyph = parseInt(code, 16);
          const characters = font.cmap.get(glyph) ?? "�";
          if (glyph === 0) missingGlyphs++;
          if ([...characters].length > 1) multiCharacterGlyphs.add(characters);
          word += characters;
          width += ((font.widths[glyph] ?? 0) * fontSize) / 1000;
        }
        if (Math.abs(y - lineY) > 0.5) {
          if (line) lines.push(line.trimEnd());
          line = "";
        } else if (line && x > lineEnd + 0.5 && !/\s$/.test(line)) {
          line += " ";
        }
        line += word;
        lineY = y;
        lineEnd = x + width;
      }
    }
    if (line) lines.push(line.trimEnd());
  }
  return { text: lines.join("\n"), multiCharacterGlyphs: [...multiCharacterGlyphs], missingGlyphs };
}
