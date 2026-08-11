export const meta = {
  name: 'generate-and-filter',
  description: 'Bounded candidate fan-out → dedup + rubric filter → optional fresh judge (port of Atomic generateAndFilter)',
  phases: [
    { title: 'Generate', detail: 'N independent candidate artifacts, bounded concurrency' },
    { title: 'Filter', detail: 'dedup + rubric scoring, deterministic shortlist' },
    { title: 'Judge', detail: 'optional fresh-context ranking of the shortlist' },
  ],
}

// args: { run_id, prompt, num_candidates = 8, shortlist_size = 3,
//         use_judge = true, max_concurrency = 4 }
// Slash-command invocation delivers everything after the command name as a
// STRING, so accept a JSON string (optionally followed by prose) too.
function atomicArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    try { return JSON.parse(s) } catch {}
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)) } catch {} }
  }
  throw new Error('atomic: pass a JSON object of arguments, e.g. ' +
    '/atomic:generate-and-filter {"run_id":"gf-1","prompt":"..."}')
}
const A = atomicArgs(args)
if (!A.run_id) throw new Error('atomic: run_id required (e.g. gf-api-design-01)')
if (!/^[A-Za-z0-9._-]{1,64}$/.test(A.run_id))
  throw new Error('atomic: run_id must match [A-Za-z0-9._-], max 64 chars (no slashes, spaces, or quotes)')
if (!A.prompt) throw new Error('atomic: prompt required')
const NUM_CANDIDATES = Math.min(Math.max(A.num_candidates ?? 8, 2), 20)       // Atomic default 8
const SHORTLIST_SIZE = Math.min(                                              // Atomic default 3
  Math.min(Math.max(A.shortlist_size ?? 3, 1), 10), NUM_CANDIDATES)
const USE_JUDGE = A.use_judge ?? true
const MAX_CONCURRENCY = Math.min(Math.max(A.max_concurrency ?? 4, 1), 12)     // Atomic default 4
const DIR = `.atomic-cc/runs/${A.run_id}`
const candPath = (i) => `${DIR}/candidate-${i}.md`

const FILTER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['rankings'],
  properties: {
    rankings: { type: 'array', minItems: 1,
      items: { type: 'object', additionalProperties: false,
        required: ['index', 'score', 'duplicate_of', 'rationale'],
        properties: {
          index: { type: 'integer' },
          score: { type: 'number', minimum: 0, maximum: 10 },
          duplicate_of: { type: ['integer', 'null'] },
          rationale: { type: 'string' },
        } } },
  },
}
const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ranked', 'winner_index'],
  properties: {
    ranked: { type: 'array', minItems: 1,
      items: { type: 'object', additionalProperties: false,
        required: ['index', 'rank', 'rationale'],
        properties: {
          index: { type: 'integer' },
          rank: { type: 'integer' },
          rationale: { type: 'string' },
        } } },
    winner_index: { type: 'integer' },
  },
}

phase('Generate')
// Bounded fan-out: run candidates in batches of MAX_CONCURRENCY (Atomic bounds
// concurrency; batching via sequential parallel() calls keeps us at the bound).
// Diversity comes from the per-index prompt variation — Math.random is unavailable here.
const thunks = Array.from({ length: NUM_CANDIDATES }, (_, i) => () =>
  agent(
    `Candidate generator, independent attempt #${i} of atomic generate-and-filter run "${A.run_id}".
Take your own DISTINCT angle on the task — do not aim for the obvious consensus answer;
other attempts run in parallel and diversity is the point.
Task: ${A.prompt}
Produce one complete candidate solution/artifact and write it to EXACTLY this path and no other file:
${candPath(i)}
Do NOT write or touch any other candidate-*.md file — each attempt owns exactly one path,
and the filter stage reads them all; a stray write corrupts another attempt's work.
Return a compact summary of your candidate.`,
    { agentType: 'atomic:worker', label: `candidate:${i}` }))
const survived = []
for (let i = 0; i < thunks.length; i += MAX_CONCURRENCY) {
  const batch = await parallel(thunks.slice(i, i + MAX_CONCURRENCY))
  batch.forEach((r, j) => { if (r != null) survived.push(i + j) })
}
log(`atomic generate-and-filter: ${survived.length}/${NUM_CANDIDATES} candidates survived generation`)
if (survived.length < 2)
  return { status: 'failed',
           reason: `only ${survived.length} of ${NUM_CANDIDATES} candidates survived generation; need at least 2 to filter`,
           shortlist: [], filter_path: null, judge_path: null,
           candidates_generated: survived.length }

phase('Filter')
const filtered = await agent(
  `You are the dedup + rubric filter for atomic generate-and-filter run "${A.run_id}".
Read EACH of these candidate files (use the Read tool on every path):
${survived.map(i => `- ${candPath(i)} (index ${i})`).join('\n')}
Task the candidates address: ${A.prompt}
For every candidate return a ranking entry: its index, a score 0-10 for quality/fit against the
task, duplicate_of (the LOWER index of a candidate it substantially duplicates, or null if it is
distinct), and a short rationale. Score on substance, not length or confidence.`,
  { schema: FILTER_SCHEMA, label: 'filter' })
if (!filtered) throw new Error('atomic generate-and-filter: filter stage returned null')

// Deterministic shortlist in JS (Atomic: drop dupes, sort score desc, take top K).
const known = new Set(survived)
const rankings = filtered.rankings.filter(r => known.has(r.index))
let shortlist = rankings
  .filter(r => r.duplicate_of == null)
  .slice()
  .sort((a, b) => b.score - a.score)
  .slice(0, SHORTLIST_SIZE)
  .map(r => ({ index: r.index, path: candPath(r.index), score: r.score }))
if (shortlist.length === 0)
  return { status: 'failed',
           reason: 'filter stage marked every candidate as a duplicate or returned no usable rankings',
           shortlist: [], filter_path: null, judge_path: null,
           candidates_generated: survived.length }

const FILTER_PATH = `${DIR}/filter.json`
await agent(
  `Atomic generate-and-filter run "${A.run_id}": persist the filter result.
Write EXACTLY this JSON to ${FILTER_PATH} (create directories as needed), and no other file:
${JSON.stringify({ rankings, shortlist }, null, 2)}`,
  { agentType: 'atomic:worker', label: 'write:filter.json' })

let JUDGE_PATH = null
if (USE_JUDGE) {
  phase('Judge')
  const judged = await agent(
    `You are a FRESH-context judge for atomic generate-and-filter run "${A.run_id}".
Read ONLY these shortlisted candidate files (use the Read tool on every path):
${shortlist.map(s => `- ${s.path} (index ${s.index})`).join('\n')}
Task the candidates address: ${A.prompt}
Rank them best-first: return "ranked" with one entry per candidate (index, rank starting at 1
for the best, rationale) and "winner_index" for the single best candidate. Judge on substance
against the task, not on style or self-confidence.`,
    { schema: JUDGE_SCHEMA, label: 'judge' })
  if (judged) {
    // Re-order the shortlist by the judge's ranking; keep any unranked entries at the end.
    const rankOf = new Map(judged.ranked.map(r => [r.index, r.rank]))
    shortlist = shortlist.slice().sort((a, b) =>
      (rankOf.get(a.index) ?? Infinity) - (rankOf.get(b.index) ?? Infinity))
    JUDGE_PATH = `${DIR}/judge.json`
    await agent(
      `Atomic generate-and-filter run "${A.run_id}": persist the judge result.
Write EXACTLY this JSON to ${JUDGE_PATH} (create directories as needed), and no other file:
${JSON.stringify({ ranked: judged.ranked, winner_index: judged.winner_index, shortlist }, null, 2)}`,
      { agentType: 'atomic:worker', label: 'write:judge.json' })
  } else {
    log('atomic generate-and-filter: judge stage returned null; keeping filter-stage order')
  }
}

return { status: 'complete', shortlist, filter_path: FILTER_PATH,
         judge_path: JUDGE_PATH, candidates_generated: survived.length }
