/**
 * The part of pdfmake 0.3's browser build that AuditFlow uses. pdfmake ships
 * no type declarations; these cover only the calls in lib/report-pdf.ts.
 */
declare module "pdfmake/build/pdfmake" {
  interface PdfMakeOutputDocument {
    getBuffer(): Promise<Uint8Array>;
  }

  interface PdfMake {
    addVirtualFileSystem(vfs: Record<string, string>): void;
    /** Return true to allow a URL. pdfmake fetches only allowed URLs. */
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    createPdf(docDefinition: object): PdfMakeOutputDocument;
  }

  const pdfMake: PdfMake;
  export default pdfMake;
}

declare module "pdfmake/build/vfs_fonts" {
  /** Roboto font files, base64-encoded, keyed by file name. */
  const vfs: Record<string, string>;
  export default vfs;
}
