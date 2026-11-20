import { extractText, getDocumentProxy } from "unpdf";

/** How much of a file reaches the manager: a CV or a job post, not a book. */
export const FILE_CHARS = 15_000;

/** Telegram hands bots files up to 20 MB. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const tidy = (s: string): string =>
  s
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** The words in a file someone sent (a PDF or plain text), or null for any other kind of file. */
export async function fileText(bytes: Uint8Array, name: string, mime: string | null): Promise<string | null> {
  const lower = name.toLowerCase();
  if (mime === "application/pdf" || lower.endsWith(".pdf")) {
    const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true });
    return tidy(text);
  }
  if (mime?.startsWith("text/") || /\.(txt|md|markdown)$/.test(lower)) return tidy(new TextDecoder().decode(bytes));
  return null;
}
