/** Small immutable Markdown/BM25 index. Only the host reads an explicit manifest. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const name = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const instant = z.iso.datetime({ offset: true });
const scope = z.array(name).min(1).max(32);
const metadata = z.strictObject({
  doc_id: name,
  version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
  file: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.md$/),
  services: scope,
  environments: scope,
  valid_from: instant,
  valid_until: instant.nullable(),
});
const manifestSchema = z.strictObject({
  schema_version: z.literal(1),
  documents: z.array(metadata).min(1).max(32),
});
export type RunbookMetadata = z.infer<typeof metadata>;
export type RunbookChunk = RunbookMetadata & {
  version_hash: string;
  chunk_id: string;
  chunk_index: number;
  title: string;
  section: string;
  start_offset: number;
  end_offset: number;
  start_line: number;
  end_line: number;
  snippet: string;
};
export type RunbookHit = RunbookChunk & { rank: number; score: number };
export const RUNBOOK_NOTICE =
  'KnowledgeReference is investigation guidance, not observed Evidence or proof of the current root cause. Actions still require the host policy and approval.';
const forbidden =
  /(?:expected[_-]?(?:cases|docs|terms)|incident-case-matrix|INC-\d{3,}|(?:evaluation|fixtures)[/\\])/i;

export class RunbookError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function reject(code: string): never {
  throw new RunbookError(code);
}
function safeRead(file: string, maxBytes: number): string {
  // No symlink following, including a host replacing a listed file after lstat.
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > maxBytes ||
      fs.lstatSync(file).isSymbolicLink()
    )
      reject('unsafe_runbook_file');
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > maxBytes) reject('runbook_size_limit');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, count),
    );
  } finally {
    fs.closeSync(fd);
  }
}

/** English identifiers plus Chinese unigrams/bigrams; no semantic synonyms. */
export function tokenizeRunbook(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text
    .toLowerCase()
    .matchAll(/[a-z0-9_]+|[\p{Script=Han}]+/gu)) {
    if (/^[a-z0-9_]/.test(match[0])) tokens.push(match[0]);
    else {
      const chars = Array.from(match[0]);
      tokens.push(...chars);
      for (let i = 0; i + 1 < chars.length; i++)
        tokens.push(chars[i] + chars[i + 1]);
    }
  }
  return tokens;
}

/** Original UTF-16 positions; do not normalize the bytes being cited. */
export function splitRunbook(
  text: string,
  meta: RunbookMetadata,
): RunbookChunk[] {
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  const chunks: RunbookChunk[] = [];
  const headings: string[] = [];
  let title = '';
  let paragraphStart: number | undefined;
  let fence: string | undefined;
  const flush = (end: number) => {
    if (paragraphStart === undefined) return;
    let start = paragraphStart;
    let finish = end;
    while (start < finish && /\s/.test(text[start])) start++;
    while (finish > start && /\s/.test(text[finish - 1])) finish--;
    while (start < finish) {
      let stop = Math.min(start + 1000, finish);
      if (stop < finish && /[\uD800-\uDBFF]/.test(text[stop - 1])) stop--;
      const chunk_index = chunks.length;
      chunks.push({
        ...meta,
        services: [...meta.services],
        environments: [...meta.environments],
        version_hash: hash,
        chunk_id: `${meta.doc_id}:${hash}:${chunk_index}`,
        chunk_index,
        title,
        section: headings.filter(Boolean).join(' > '),
        start_offset: start,
        end_offset: stop,
        start_line: text.slice(0, start).split('\n').length,
        end_line: text.slice(0, stop).split('\n').length,
        snippet: text.slice(start, stop),
      });
      if (stop === finish) break;
      start = stop - 120;
      if (/[\uDC00-\uDFFF]/.test(text[start])) start++;
    }
    paragraphStart = undefined;
  };
  let offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const stripped = line.replace(/\r?\n$/, '').replace(/^\uFEFF/, '');
    const code = stripped.match(/^\s*(`{3,}|~{3,})/);
    if (code) {
      if (!fence) fence = code[1][0];
      else if (fence === code[1][0]) fence = undefined;
      paragraphStart ??= offset;
    } else if (!fence) {
      const heading = stripped.match(/^(#{1,6})\s+(.+?)\s*#*$/);
      if (heading) {
        if (heading[2].length > 160) reject('invalid_runbook_markdown');
        flush(offset);
        const level = heading[1].length;
        headings.length = level;
        headings[level - 1] = heading[2];
        if (!title) title = heading[2];
        // Heading-only matches also retain an original fragment.
        paragraphStart = offset;
        flush(offset + stripped.length);
      } else if (!stripped.trim()) flush(offset);
      else paragraphStart ??= offset;
    }
    offset += line.length;
  }
  flush(text.length);
  if (!title || !chunks.length || fence) reject('invalid_runbook_markdown');
  return chunks;
}

type IndexedChunk = {
  chunk: RunbookChunk;
  frequency: Map<string, number>;
  length: number;
};
export class RunbookIndex {
  private readonly chunks: IndexedChunk[];
  readonly catalog_hash: string;
  readonly document_count: number;
  readonly chunk_count: number;
  private constructor(
    chunks: RunbookChunk[],
    catalogHash: string,
    documentCount: number,
  ) {
    this.chunks = chunks.map((chunk) => {
      const terms = tokenizeRunbook(
        `${chunk.title} ${chunk.section} ${chunk.snippet}`,
      );
      const frequency = new Map<string, number>();
      for (const term of terms)
        frequency.set(term, (frequency.get(term) ?? 0) + 1);
      return { chunk, frequency, length: terms.length };
    });
    this.catalog_hash = catalogHash;
    this.document_count = documentCount;
    this.chunk_count = chunks.length;
  }

  static load(root: string): RunbookIndex {
    try {
      const absolute = path.resolve(root);
      const protectedDirectories = new Set([
        'docs',
        'tests',
        'evaluation',
        'fixtures',
        '.git',
        'node_modules',
      ]);
      if (
        path.basename(absolute) !== 'runbooks' ||
        absolute
          .split(/[\\/]+/)
          .some((part) => protectedDirectories.has(part.toLowerCase())) ||
        forbidden.test(absolute) ||
        fs.lstatSync(absolute).isSymbolicLink() ||
        !fs.lstatSync(absolute).isDirectory() ||
        path.resolve(fs.realpathSync(absolute)) !== absolute
      )
        reject('unsafe_runbook_root');
      const raw = safeRead(path.join(absolute, 'manifest.json'), 32768);
      if (forbidden.test(raw)) reject('protected_knowledge');
      const manifest = manifestSchema.parse(JSON.parse(raw));
      if (forbidden.test(JSON.stringify(manifest)))
        reject('protected_knowledge');
      const identities = new Set<string>();
      const chunks: RunbookChunk[] = [];
      let totalBytes = Buffer.byteLength(raw);
      for (const doc of manifest.documents) {
        const identity = `${doc.doc_id}:${doc.version}`;
        if (identities.has(identity)) reject('duplicate_runbook_version');
        identities.add(identity);
        if (
          doc.valid_until &&
          Date.parse(doc.valid_until) <= Date.parse(doc.valid_from)
        )
          reject('invalid_runbook_validity');
        const file = path.join(absolute, doc.file);
        if (
          path.dirname(file) !== absolute ||
          fs.lstatSync(file).isSymbolicLink() ||
          path.dirname(fs.realpathSync(file)) !== absolute
        )
          reject('unsafe_runbook_file');
        const content = safeRead(file, 65536);
        if (forbidden.test(content)) reject('protected_knowledge');
        totalBytes += Buffer.byteLength(content);
        if (totalBytes > 524288) reject('runbook_size_limit');
        chunks.push(...splitRunbook(content, doc));
        if (chunks.length > 1024) reject('runbook_chunk_limit');
      }
      const hash = createHash('sha256').update(raw);
      for (const chunk of chunks) hash.update(chunk.chunk_id);
      return new RunbookIndex(
        chunks,
        hash.digest('hex'),
        manifest.documents.length,
      );
    } catch (error) {
      if (error instanceof RunbookError) throw error;
      throw new RunbookError('runbook_index_unavailable');
    }
  }

  search(
    query: string,
    scope: { service: string; environment: string; allowed_doc_ids: string[] },
    topK = 3,
    at = new Date(),
  ): RunbookHit[] {
    if (
      !query.trim() ||
      query.length > 256 ||
      !Number.isInteger(topK) ||
      topK < 1 ||
      topK > 5 ||
      !Number.isFinite(at.getTime())
    )
      reject('invalid_search');
    const granted = new Set(scope.allowed_doc_ids);
    // Filter before document frequencies, averages or scoring: denied text affects no rank.
    let candidates = this.chunks.filter(
      ({ chunk: c }) =>
        granted.has(c.doc_id) &&
        c.services.includes(scope.service) &&
        c.environments.includes(scope.environment) &&
        Date.parse(c.valid_from) <= at.getTime() &&
        (!c.valid_until || at.getTime() < Date.parse(c.valid_until)),
    );
    const latest = new Map<string, RunbookChunk>();
    const compareVersion = (a: string, b: string) => {
      const av = a.split('.').map(Number),
        bv = b.split('.').map(Number);
      return av[0] - bv[0] || av[1] - bv[1] || av[2] - bv[2];
    };
    for (const { chunk } of candidates) {
      const previous = latest.get(chunk.doc_id);
      if (!previous || compareVersion(chunk.version, previous.version) > 0)
        latest.set(chunk.doc_id, chunk);
    }
    candidates = candidates.filter(
      ({ chunk }) =>
        latest.get(chunk.doc_id)?.version_hash === chunk.version_hash &&
        latest.get(chunk.doc_id)?.version === chunk.version,
    );
    if (!candidates.length) return [];
    const terms = [...new Set(tokenizeRunbook(query))];
    const average =
      candidates.reduce((n, c) => n + c.length, 0) / candidates.length;
    const dfs = new Map(
      terms.map((term) => [
        term,
        candidates.filter((c) => c.frequency.has(term)).length,
      ]),
    );
    const ranked = candidates
      .map(({ chunk, frequency, length }) => {
        let score = 0;
        for (const term of terms) {
          const count = frequency.get(term) ?? 0;
          if (!count) continue;
          const df = dfs.get(term)!;
          const idf = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5));
          score +=
            (idf * count * 2.2) /
            (count + 1.2 * (1 - 0.75 + (0.75 * length) / average));
        }
        return { ...chunk, score };
      })
      .filter((hit) => hit.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.doc_id.localeCompare(b.doc_id, 'en') ||
          a.chunk_index - b.chunk_index,
      );
    return ranked.slice(0, topK).map((hit, i) => ({
      ...hit,
      services: [...hit.services],
      environments: [...hit.environments],
      rank: i + 1,
    }));
  }
}
