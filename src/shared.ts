import type {
  Deadlock,
  Engine,
  ExtendedEventsBatch,
  ExtendedEventsFormat,
  Plan,
} from "@culpritsql/plan-viewer";

export type {
  Deadlock,
  Engine,
  ExtendedEventsBatch,
  ExtendedEventsFormat,
  Plan,
};

export type RecordedQuery = {
  id: string;
  timestamp: number;
  requestId?: string;
  requestLabel?: string;
  engine?: Engine;
  sql: string;
  normalizedSql: string;
  fingerprint: string;
  durationMs: number;
  rowCount?: number;
  paramsCount?: number;
  error?: string;
  plan?: Plan;
  rawExplain?: string;
};

export type NPlusOneBurst = {
  fingerprint: string;
  normalizedSql: string;
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  requestId?: string;
  requestLabel?: string;
  queryIds: string[];
  sampleSql: string;
};

export type DevtoolsStats = {
  totalQueries: number;
  slowCount: number;
  burstCount: number;
  totalDurationMs: number;
};

export type DevtoolsSnapshot = {
  queries: RecordedQuery[];
  bursts: NPlusOneBurst[];
  stats: DevtoolsStats;
};

export const EMPTY_DEVTOOLS_SNAPSHOT: DevtoolsSnapshot = {
  queries: [],
  bursts: [],
  stats: {
    totalQueries: 0,
    slowCount: 0,
    burstCount: 0,
    totalDurationMs: 0,
  },
};

function isIdentStart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isIdentPart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) ||
    c === 95 ||
    c === 36
  );
}

function isDigit(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function isHexDigit(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 70) ||
    (c >= 97 && c <= 102)
  );
}

function matchDollarQuoteTag(sql: string, start: number): string | null {
  if (sql[start] !== "$") return null;
  let i = start + 1;
  if (i < sql.length && sql[i] === "$") {
    return "$$";
  }
  if (i >= sql.length || !isIdentStart(sql[i]!)) {
    return null;
  }
  while (i < sql.length && isIdentPart(sql[i]!) && sql[i] !== "$") {
    i++;
  }
  if (i < sql.length && sql[i] === "$") {
    return sql.slice(start, i + 1);
  }
  return null;
}

/**
 * Strips SQL comments, collapses whitespace, replaces string/numeric literals and
 * positional/named placeholders ($1, ?, :param, @p1) with `?`, and collapses
 * `IN (?, ?, ...)` lists into canonical `IN (?)` so repeated N+1 queries produce
 * the exact same template and fingerprint.
 */
export function normalizeSqlForFingerprint(sql: string): string {
  const len = sql.length;
  let out = "";
  let i = 0;
  let lastNonSpace = "";

  const pushChar = (ch: string) => {
    out += ch;
    if (ch !== " ") lastNonSpace = ch;
  };

  const pushSpace = () => {
    if (out.length > 0 && out[out.length - 1] !== " ") {
      out += " ";
    }
  };

  while (i < len) {
    const ch = sql[i]!;
    const next = i + 1 < len ? sql[i + 1]! : "";

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
      pushSpace();
      i++;
      continue;
    }

    // Line comment: -- ...
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n" && sql[i] !== "\r") {
        i++;
      }
      pushSpace();
      continue;
    }

    // Block comment: /* ... */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      pushSpace();
      continue;
    }

    // Typed string literal prefix: E'...', N'...', X'...', B'...'
    if (
      (ch === "E" || ch === "e" || ch === "N" || ch === "n" || ch === "X" || ch === "x" || ch === "B" || ch === "b") &&
      next === "'" &&
      (i === 0 || !isIdentPart(sql[i - 1]!))
    ) {
      i += 2;
      while (i < len) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      pushChar("?");
      continue;
    }

    // Single-quoted string literal: '...'
    if (ch === "'") {
      i++;
      while (i < len) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      pushChar("?");
      continue;
    }

    // Double-quoted identifier: "..."
    if (ch === '"') {
      pushChar('"');
      i++;
      while (i < len) {
        const c = sql[i]!;
        pushChar(c);
        i++;
        if (c === '"') {
          if (sql[i] === '"') {
            pushChar('"');
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }

    // Backtick identifier: `...`
    if (ch === "`") {
      pushChar("`");
      i++;
      while (i < len) {
        const c = sql[i]!;
        pushChar(c);
        i++;
        if (c === "`") {
          if (sql[i] === "`") {
            pushChar("`");
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }

    // Bracket identifier: [...]
    if (ch === "[") {
      pushChar("[");
      i++;
      while (i < len) {
        const c = sql[i]!;
        pushChar(c);
        i++;
        if (c === "]") break;
      }
      continue;
    }

    // Positional $1..$N parameter or PostgreSQL dollar-quoted string $$...$$ / $tag$...$tag$
    if (ch === "$") {
      if (isDigit(next)) {
        i++;
        while (i < len && isDigit(sql[i]!)) {
          i++;
        }
        pushChar("?");
        continue;
      }
      const tag = matchDollarQuoteTag(sql, i);
      if (tag) {
        const closeIdx = sql.indexOf(tag, i + tag.length);
        i = closeIdx === -1 ? len : closeIdx + tag.length;
        pushChar("?");
        continue;
      }
    }

    // Question-mark parameter: ?, ?1, ?2
    if (ch === "?") {
      i++;
      while (i < len && isDigit(sql[i]!)) {
        i++;
      }
      pushChar("?");
      continue;
    }

    // Named parameter :param (preserving PostgreSQL ::type casts and := assignment)
    if (ch === ":") {
      if (next === ":" || next === "=") {
        pushChar(ch);
        pushChar(next);
        i += 2;
        continue;
      }
      if (isIdentStart(next)) {
        i++;
        while (i < len && isIdentPart(sql[i]!)) {
          i++;
        }
        pushChar("?");
        continue;
      }
    }

    // SQL Server / MySQL parameter @param (preserving @@system variables)
    if (ch === "@" && next !== "@" && isIdentStart(next)) {
      i++;
      while (i < len && isIdentPart(sql[i]!)) {
        i++;
      }
      pushChar("?");
      continue;
    }

    // Signed negative numeric literal after operator, comma, open paren, or start
    if (
      ch === "-" &&
      (isDigit(next) || (next === "." && i + 2 < len && isDigit(sql[i + 2]!))) &&
      (lastNonSpace === "" || "(,=<>+-*/%!".includes(lastNonSpace))
    ) {
      i++;
      while (i < len && isDigit(sql[i]!)) i++;
      if (i < len && sql[i] === ".") {
        i++;
        while (i < len && isDigit(sql[i]!)) i++;
      }
      if (i < len && (sql[i] === "e" || sql[i] === "E")) {
        i++;
        if (i < len && (sql[i] === "+" || sql[i] === "-")) i++;
        while (i < len && isDigit(sql[i]!)) i++;
      }
      pushChar("?");
      continue;
    }

    // Unsigned numeric literal (integer, float, hex, scientific) outside identifiers
    if (isDigit(ch) || (ch === "." && isDigit(next))) {
      if (ch === "0" && (next === "x" || next === "X")) {
        i += 2;
        while (i < len && isHexDigit(sql[i]!)) i++;
      } else {
        while (i < len && isDigit(sql[i]!)) i++;
        if (i < len && sql[i] === "." && (i + 1 >= len || sql[i + 1] !== ".")) {
          i++;
          while (i < len && isDigit(sql[i]!)) i++;
        }
        if (i < len && (sql[i] === "e" || sql[i] === "E")) {
          i++;
          if (i < len && (sql[i] === "+" || sql[i] === "-")) i++;
          while (i < len && isDigit(sql[i]!)) i++;
        }
      }
      pushChar("?");
      continue;
    }

    // Identifier or SQL keyword: consume whole word so trailing digits in col_1 stay intact
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < len && isIdentPart(sql[i]!)) {
        i++;
      }
      const word = sql.slice(start, i);
      const upper = word.toUpperCase();
      if (upper === "TRUE" || upper === "FALSE") {
        pushChar("?");
      } else {
        out += word;
        lastNonSpace = word[word.length - 1]!;
      }
      continue;
    }

    pushChar(ch);
    i++;
  }

  let normalized = out.trim();
  // Strip trailing semicolons
  while (normalized.endsWith(";")) {
    normalized = normalized.slice(0, -1).trimEnd();
  }

  // Collapse IN (?, ?, ...) or IN ( ? ) into canonical IN (?)
  normalized = normalized.replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, "IN (?)");
  // Collapse PostgreSQL = ANY (ARRAY[?, ?, ...]) into canonical = ANY (?)
  normalized = normalized.replace(/\bANY\s*\(\s*ARRAY\s*\[\s*\?(?:\s*,\s*\?)*\s*\]\s*\)/gi, "ANY (?)");
  // Normalize whitespace around commas and parentheses for consistent templates
  normalized = normalized
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+,/g, ",")
    .replace(/,\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Re-ensure IN (?) canonical spacing after paren/comma normalization
  normalized = normalized.replace(/\bIN\s*\(\?(?:,\s*\?)*\)/gi, "IN (?)");

  return normalized;
}

/**
 * Computes a deterministic 64-bit FNV-1a hex fingerprint for a SQL statement
 * (case-insensitive over `normalizeSqlForFingerprint(sql)`).
 */
export function fingerprintSql(sql: string): string {
  const canonical = normalizeSqlForFingerprint(sql).toLowerCase();
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Generates plain-language batching advice for an N+1 query template.
 */
export function detectNPlusOneAdvice(normalizedSql: string, engine?: Engine): string {
  const whereMatch = normalizedSql.match(/\bWHERE\s+([A-Za-z0-9_."`[\]]+)\s*=\s*\?/i);
  const column = whereMatch?.[1] ?? "id";
  const fromMatch = normalizedSql.match(/\bFROM\s+([A-Za-z0-9_."`[\]]+)/i);
  const table = fromMatch?.[1] ?? "the target table";

  if (engine === "postgres" || engine === "yugabyte") {
    return `Batch this lookup into one query on ${table}: collect IDs up front and filter with WHERE ${column} = ANY($1), or fetch rows alongside the parent query with a JOIN.`;
  }
  return `Batch this lookup into one query on ${table}: collect keys up front and filter with WHERE ${column} IN (...), or load related rows in the parent query with a JOIN.`;
}
