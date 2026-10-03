/** Evaluation-only labels; production code never imports this script/corpus. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunbookIndex } from '../container/agent-runner/src/incident-runbooks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v030-runbook-eval-'));
try {
  const source = path.join(root, 'runbooks');
  const review = path.join(tmp, 'runbooks');
  fs.mkdirSync(review);
  // Copy only the explicit handbooks; labels are not used to create source text.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'),
  );
  for (const doc of manifest.documents)
    fs.copyFileSync(path.join(source, doc.file), path.join(review, doc.file));
  fs.copyFileSync(
    path.join(root, 'evaluation', 'runbook-review', 'old-resource-pool.md'),
    path.join(review, 'old-resource-pool.md'),
  );
  const expired = {
    ...manifest.documents.find(
      (d: { doc_id: string }) => d.doc_id === 'resource-pool',
    ),
    version: '0.1.0',
    file: 'old-resource-pool.md',
    valid_from: '2019-01-01T00:00:00Z',
    valid_until: '2020-01-01T00:00:00Z',
  };
  fs.writeFileSync(
    path.join(review, 'manifest.json'),
    JSON.stringify({
      ...manifest,
      documents: [...manifest.documents, expired],
    }),
  );
  const index = RunbookIndex.load(source),
    reviewIndex = RunbookIndex.load(review);
  // Read relevance judgments only AFTER both document indexes exist.
  const labels = JSON.parse(
    fs.readFileSync(
      path.join(root, 'evaluation', 'runbook-queries.json'),
      'utf8',
    ),
  ).cases as Array<{
    id: string;
    service: string;
    environment: string;
    query: string;
    expected_docs: string[];
    expected_first: string | null;
    excluded_first?: string;
    expected_version?: string;
    review_corpus?: string;
  }>;
  const allowed = manifest.documents.map((d: { doc_id: string }) => d.doc_id);
  const results = labels.map((label) => {
    const hits = (label.review_corpus ? reviewIndex : index).search(
      label.query,
      {
        service: label.service,
        environment: label.environment,
        allowed_doc_ids: allowed,
      },
      3,
    );
    const docs = [...new Set(hits.map((h) => h.doc_id))];
    const hit = label.expected_docs.length
      ? label.expected_docs.every((doc) => docs.includes(doc))
      : hits.length === 0;
    const first = (hits[0]?.doc_id ?? null) === label.expected_first;
    const version =
      !label.expected_version ||
      hits
        .filter((h) => h.doc_id === label.expected_first)
        .every((h) => h.version === label.expected_version);
    const excluded =
      !label.excluded_first || hits[0]?.doc_id !== label.excluded_first;
    return {
      id: label.id,
      docs,
      hit_at_3: hit,
      first_correct: first,
      version_correct: version,
      passed: hit && first && version && excluded,
    };
  });
  const relevant = results.filter((_, i) => labels[i].expected_docs.length > 0);
  const reciprocal =
    results.reduce(
      (n, r, i) =>
        n +
        (labels[i].expected_first
          ? 1 / (r.docs.indexOf(labels[i].expected_first!) + 1 || Infinity)
          : 0),
      0,
    ) / relevant.length;
  const summary = {
    result: results.every((r) => r.passed) ? 'PASS' : 'FAIL',
    queries: labels.length,
    relevant_queries: relevant.length,
    hit_at_3: relevant.filter((r) => r.hit_at_3).length / relevant.length,
    top_1_accuracy:
      relevant.filter((r) => r.first_correct).length / relevant.length,
    mrr_at_3: reciprocal,
    empty_cases_passed: results.filter(
      (r, i) => !labels[i].expected_docs.length && r.passed,
    ).length,
    documents: index.document_count,
    chunks: index.chunk_count,
    ranking: 'chunk BM25; metrics use distinct documents within top 3 chunks',
    model_calls: 0,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.result !== 'PASS') process.exitCode = 1;
} finally {
  if (
    path.dirname(path.resolve(tmp)) !== path.resolve(os.tmpdir()) ||
    !path.basename(tmp).startsWith('v030-runbook-eval-')
  )
    throw new Error('unsafe_temp_path');
  fs.rmSync(tmp, { recursive: true, force: true });
}
