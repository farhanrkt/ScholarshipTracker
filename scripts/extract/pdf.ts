/**
 * Reading the PDFs funders publish their actual rules in.
 *
 * WHY THIS EXISTS. The crawler skipped every `.pdf` link, and for several
 * programmes that is where the entire answer lives. MEXT and the Global Korea
 * Scholarship publish a short HTML overview and then a thirty-page application
 * guideline as a PDF carrying the eligibility limits, the stipend, the document
 * checklist and the closing date. The catalogue's Japan and Korea rows were
 * thin for exactly that reason: the pipeline was reading the poster and
 * skipping the handbook.
 *
 * A PDF reaches grounding as text like any other page, so nothing downstream
 * changes: the same quoting rule, the same verbatim search, the same rejection
 * of anything that cannot be quoted.
 *
 * WHAT IS DELIBERATELY NOT HANDLED. A scanned PDF is an image and yields no
 * text; it fails the short-text guard and is reported like a JavaScript-only
 * page, which is the honest outcome. There is no OCR here and should not be:
 * OCR output is approximate, and an approximate quote would pass a grounding
 * check that exists to be exact.
 */

/**
 * Bytes we are willing to pull down for one document.
 *
 * Guideline PDFs are a few hundred kilobytes; anything past this is a prospectus
 * or a scanned archive, and neither is worth the memory or the wait on a
 * serverless host. The cap is checked twice — once against the declared length,
 * once against what actually arrived — because `content-length` is optional and
 * a chunked response can simply not have one.
 */
export const MAX_PDF_BYTES = 12 * 1024 * 1024;

/**
 * Pages read from one document.
 *
 * The facts we want are in the first few pages of a guideline, and a long tail
 * of appendices costs prompt budget that passage selection then has to spend
 * discarding. Forty is comfortably past every real application guideline seen
 * so far.
 */
export const MAX_PDF_PAGES = 40;

/** Does this response carry a PDF, whatever the URL happened to end in? */
export function isPdf(contentType: string | null, url: string): boolean {
  if (contentType && /application\/pdf|application\/x-pdf/i.test(contentType)) {
    return true;
  }
  // Content-negotiated downloads routinely arrive as octet-stream; the path is
  // the only other thing that says what this is.
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return /\.pdf(\?|#|$)/i.test(url);
  }
}

/**
 * Plain text from a PDF's bytes.
 *
 * `unpdf` is a serverless build of pdf.js — no native modules, no system
 * binaries, which is what makes it deployable on Vercel alongside the CLI.
 * Imported lazily so a crawl that meets no PDFs never pays to load it.
 */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");

  const document = await getDocumentProxy(bytes);
  const { text } = await extractText(document, { mergePages: false });

  const pages = Array.isArray(text) ? text : [text];

  return (
    pages
      .slice(0, MAX_PDF_PAGES)
      .join("\n\n")
      // pdf.js emits a glyph per positioned run, so a line arrives as a
      // scattering of fragments. Collapsing runs of whitespace is what turns it
      // back into sentences a quote can be found in — and it matches what
      // `normalise` does to both sides of the grounding check anyway.
      .replace(/[ \t ]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
