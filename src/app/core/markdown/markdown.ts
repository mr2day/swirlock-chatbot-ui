import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * Parses a Markdown string and sanitizes the result. Returns an empty
 * string for null/empty input. Components bind the output via
 * `[innerHTML]` or `DomSanitizer.bypassSecurityTrustHtml` after this
 * function has already removed any unsafe markup.
 */
export function renderMarkdownSafe(input: string | null | undefined): string {
  if (!input) return '';
  const html = marked.parse(input, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'lang'],
  });
}
