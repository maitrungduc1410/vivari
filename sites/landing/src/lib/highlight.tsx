import type { ReactNode } from "react";

// A deliberately tiny JS/TS/JSX highlighter. We don't want to pull a full
// tokenizer (Prism/Shiki) into the landing bundle just to color two code
// snippets, so this scans with one regex and colors tokens with the same
// palette the hero editor uses. It's cosmetic, not a real parser.

const KEYWORDS = new Set([
  "import", "from", "export", "default", "function", "const", "let", "var",
  "await", "async", "return", "new", "if", "else", "for", "of", "in",
  "typeof", "void", "class", "extends", "this", "yield", "delete",
]);

const LITERALS = new Set(["true", "false", "null", "undefined"]);

// Order matters: comment, string, number, identifier, whitespace, punctuation.
const TOKEN =
  /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z0-9_$'"`]+)/g;

export function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let key = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;

  while ((m = TOKEN.exec(code))) {
    const [full, comment, str, num, ident, ws, punct] = m;

    if (comment) {
      out.push(<span key={key++} className="text-faint italic">{comment}</span>);
    } else if (str) {
      out.push(<span key={key++} className="text-emerald-400">{str}</span>);
    } else if (num) {
      out.push(<span key={key++} className="text-amber-300">{num}</span>);
    } else if (ident) {
      let cls = "text-fg";
      if (KEYWORDS.has(ident)) {
        cls = "text-brand-3";
      } else if (LITERALS.has(ident)) {
        cls = "text-amber-300";
      } else {
        // An identifier immediately followed by "(" reads as a call, and a
        // capitalized one reads as a type/component - color both cyan.
        let j = m.index + full.length;
        while (j < code.length && /\s/.test(code[j])) j++;
        if (code[j] === "(" || /^[A-Z]/.test(ident)) cls = "text-brand-2";
      }
      out.push(<span key={key++} className={cls}>{ident}</span>);
    } else if (ws) {
      out.push(ws);
    } else if (punct) {
      out.push(<span key={key++} className="text-muted">{punct}</span>);
    } else {
      out.push(full);
    }

    if (m.index === TOKEN.lastIndex) TOKEN.lastIndex++;
  }

  return out;
}
