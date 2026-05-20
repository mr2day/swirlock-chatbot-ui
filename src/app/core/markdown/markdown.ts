import { marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * Renderer that runs fenced code blocks through highlight.js so the
 * Atom One Dark theme (loaded globally in styles.scss) can color
 * tokens. Falls back to escaped plain text when the language is
 * unknown or highlighting throws.
 */
const renderer = new Renderer();
renderer.code = ({ text, lang }) => {
  const language = (lang || '').split(/\s+/)[0];
  let html: string;
  let cls: string;
  if (language && hljs.getLanguage(language)) {
    try {
      html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      cls = `hljs language-${language}`;
    } catch {
      html = escapeHtml(text);
      cls = 'hljs';
    }
  } else {
    try {
      html = hljs.highlightAuto(text).value;
      cls = 'hljs';
    } catch {
      html = escapeHtml(text);
      cls = 'hljs';
    }
  }
  return `<pre><code class="${cls}">${html}</code></pre>`;
};
marked.use({ renderer });

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
    // Includes `src`/`alt`/`title` so markdown `![alt](url)` images
    // actually render — without `src` here DOMPurify strips it and
    // leaves an `<img>` with no source (invisible). DOMPurify's
    // default URI safety still blocks `javascript:` and other unsafe
    // schemes, and the CSS in message-bubble.scss constrains image
    // width to the bubble so a wide image can't widen the page.
    ALLOWED_ATTR: [
      'href',
      'target',
      'rel',
      'class',
      'lang',
      'src',
      'alt',
      'title',
    ],
  }).trim();
}
