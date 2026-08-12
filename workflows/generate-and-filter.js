export const meta = {
  name: 'generate-and-filter',
  description: 'Bounded candidate fan-out → dedup + rubric filter → optional fresh judge → final shortlist report (port of Atomic generateAndFilter)',
  phases: [
    { title: 'Generate', detail: 'N independent candidate artifacts, bounded concurrency, manifest' },
    { title: 'Filter', detail: 'dedup + rubric shortlist, deterministic selection with fallback' },
    { title: 'Judge', detail: 'optional fresh-context re-ranking of the shortlist' },
    { title: 'Report', detail: 'final shortlist report from the authoritative decision' },
  ],
}

// args: { run_id, prompt, num_candidates = 8, shortlist_size = 3,
//         use_judge = true, max_concurrency = 4, plugin_root }
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
const NUM_CANDIDATES = Math.min(Math.max(A.num_candidates ?? 8, 2), 20)       // Atomic default 8, bounds 2-20
const SHORTLIST_LIMIT = Math.min(                                             // Atomic default 3, bounds 1-10,
  Math.min(Math.max(A.shortlist_size ?? 3, 1), 10), NUM_CANDIDATES)           // capped at num_candidates
const USE_JUDGE = A.use_judge ?? true                                         // Atomic default true
const MAX_CONCURRENCY = Math.min(Math.max(A.max_concurrency ?? 4, 1), 12)     // Atomic default 4, bounds 1-12
// Candidates and decisions are meant to be pure artifacts under .atomic-cc/runs/,
// but the generators and the final reporter run as atomic:worker (Edit/Write/Bash),
// so "does not mutate the repository" is a prompt, not a permission. The run
// registers with the commit gate anyway — while it is in_progress a stray commit
// is denied — and seals a terminal status before returning. `approved` is always
// false: a shortlist is not a reviewed deliverable and must not authorize a commit.
// Gate transitions go only through the plugin CLI; direct writes to
// run-state.json / approval.json are denied by the tamper-guard hook.
const PLUGIN_ROOT = typeof A.plugin_root === 'string' ? A.plugin_root.trim() : ''
const runStateCmd = (sub) => PLUGIN_ROOT ? `"${PLUGIN_ROOT}/bin/run-state.sh" ${sub}` : null
// Issued by the scribe (transcribe-and-run, never author), so no write-capable
// agent is handed the gate.
async function runState(sub, label) {
  const cmd = runStateCmd(sub)
  if (!cmd) { log(`atomic generate-and-filter: no plugin_root — gate registration skipped (${sub})`); return }
  await agent(
    `Run the following command EXACTLY as written, once, and report its output verbatim.
Write no files and modify nothing.

--- RUN COMMAND (verbatim) ---
${cmd}`,
    { agentType: 'atomic:scribe', label })
}
const DIR = `.atomic-cc/runs/${A.run_id}`
// Upstream numbers candidates 1..N.
const candidatePaths = Array.from({ length: NUM_CANDIDATES }, (_, i) => `${DIR}/candidate-${i + 1}.md`)
const MANIFEST_PATH = `${DIR}/manifest.json`
const FILTER_PATH = `${DIR}/filter.json`
const FINAL_PATH = `${DIR}/shortlist.md`

// Upstream schemas (generate-and-filter-runner.ts): the filter returns a ranked
// shortlist of candidate PATHS plus discarded {path, reason} entries; the judge
// returns a ranked shortlist of paths plus a rationale.
const FILTER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['shortlist', 'discarded'],
  properties: {
    shortlist: { type: 'array', items: { type: 'string' } },
    discarded: { type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['path', 'reason'],
        properties: { path: { type: 'string' }, reason: { type: 'string' } } } },
  },
}
const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['shortlist', 'rationale'],
  properties: {
    shortlist: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
}

// Decision helpers ported 1:1 from upstream generate-and-filter-runner.ts.
const isRecord = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = v => Array.isArray(v) && v.every(e => typeof e === 'string')
function filterDecision(v) {
  if (v == null || !isRecord(v) || !strings(v.shortlist) || !Array.isArray(v.discarded)) return undefined
  const valid = v.discarded.every(e => isRecord(e) && typeof e.path === 'string' && typeof e.reason === 'string')
  return valid ? v : undefined
}
function judgeDecision(v) {
  return v != null && isRecord(v) && strings(v.shortlist) && typeof v.rationale === 'string' ? v : undefined
}
// Keep only known candidate paths, dedup preserving rank order, cap at the limit.
const selectCandidates = paths =>
  [...new Set(paths.filter(p => candidatePaths.includes(p)))].slice(0, SHORTLIST_LIMIT)

phase('Generate')
// Registered once, before the fan-out: `begin` refuses to run over an existing
// in_progress run, so N parallel generators must not each try to claim the gate.
await runState(`begin ${A.run_id}`, 'gate:begin')
// Upstream runs the generators with concurrency=max_concurrency and failFast:false.
// CC adaptation: parallel() has no concurrency option here, so we batch sequential
// parallel() calls of MAX_CONCURRENCY thunks; a dead generator (null result) is
// tolerated exactly like failFast:false — the flow continues over ALL declared paths.
const thunks = candidatePaths.map((path, i) => () =>
  agent(
    `You independently generate candidate ${i + 1} for atomic generate-and-filter run "${A.run_id}"; do not imitate or assume other candidates.
Success criteria: one distinct, concrete candidate that states its value, constraints, risks, and how it can be evaluated.
Stop after one self-contained, evaluable candidate; do not add alternatives.
Write the candidate artifact to EXACTLY this path and no other file: ${path}
(create directories as needed; include a title, the proposal, a criteria-based rationale, risks, and evaluation evidence; report only what you can point to evidence for).
Do NOT write or touch any other candidate-*.md file — each attempt owns exactly one path, and the filter stage reads them all.
Do NOT git commit or push. Return a compact summary of your candidate.
Objective: ${A.prompt}`,
    { agentType: 'atomic:worker', label: `generate-${i + 1}` }))
let generated = 0
for (let i = 0; i < thunks.length; i += MAX_CONCURRENCY) {
  const batch = await parallel(thunks.slice(i, i + MAX_CONCURRENCY))
  generated += batch.filter(r => r != null).length
}
log(`atomic generate-and-filter: ${generated}/${NUM_CANDIDATES} generators returned; continuing over all declared candidate paths (upstream failFast=false)`)

await agent(
  `Atomic run "${A.run_id}": transcribe the candidate manifest.
Write EXACTLY this JSON to ${MANIFEST_PATH} (create directories as needed) and touch no other file:
${JSON.stringify({ task: A.prompt, candidate_artifact_paths: candidatePaths }, null, 2)}
Do NOT git commit or push.`,
  { agentType: 'atomic:scribe', label: 'manifest' })

phase('Filter')
const filtered = await agent(
  `You deduplicate and filter independently generated candidates for atomic run "${A.run_id}".
Read the manifest at ${MANIFEST_PATH} and EVERY candidate file (use the Read tool on every path):
${candidatePaths.map(p => `- ${p}`).join('\n')}
Rubric: first collapse substantively equivalent candidates. Then score fit to the task, feasibility, evidence, distinctiveness, and risk. Near-duplicates must not gain weight by repetition. Record every discarded candidate and a concrete reason.
Success criteria: at most ${SHORTLIST_LIMIT} strongest distinct candidates remain, ranked by the rubric, and every discarded candidate has a concrete reason.
Stop after every candidate is shortlisted once or recorded as discarded.
Return the structured result: shortlist (candidate artifact paths copied VERBATIM, in ranked order, best first) and discarded entries containing path and a concise, criteria-based reason.
Objective: select at most ${SHORTLIST_LIMIT} strongest candidates for: ${A.prompt}`,
  { schema: FILTER_SCHEMA, label: 'dedupe-and-filter' })

// Deterministic selection ported 1:1 from upstream: unknown paths are dropped,
// duplicates deduped, the list capped; an empty or invalid filter decision falls
// back to the first shortlist_size candidate paths.
const fallbackShortlist = candidatePaths.slice(0, SHORTLIST_LIMIT)
const filteredShortlist = selectCandidates(filterDecision(filtered)?.shortlist ?? [])
let shortlist = filteredShortlist.length > 0 ? filteredShortlist : fallbackShortlist

// CC adaptation: upstream persists the filter's structured output via outputMode
// file; here a scribe transcribes the exact decision (or an explicit marker when
// the stage returned nothing usable).
await agent(
  `Atomic run "${A.run_id}": transcribe the filter decision.
Write EXACTLY this JSON to ${FILTER_PATH} (create directories as needed) and touch no other file:
${JSON.stringify(filterDecision(filtered) ?? { shortlist: [], discarded: [], note: 'filter stage returned no valid structured decision' }, null, 2)}
Do NOT git commit or push.`,
  { agentType: 'atomic:scribe', label: 'write-filter' })

let judgePath = null
let decisionPath = FILTER_PATH
if (USE_JUDGE) {
  phase('Judge')
  judgePath = `${DIR}/judge.json`
  const judged = await agent(
    `You independently judge the filtered shortlist for atomic run "${A.run_id}" against the explicit rubric. FRESH context: you did not generate or filter the candidates.
Read the filter report at ${FILTER_PATH} and every candidate path it references.
Rubric: check task fit, feasibility, evidence, distinctiveness, and material risk. Do not restore a duplicate merely because it is phrased differently.
Success criteria: at most ${SHORTLIST_LIMIT} distinct candidate paths are ranked by rubric-grounded evidence.
Stop after evaluating every filtered candidate and ranking the qualifying paths.
Return the structured result: shortlist (candidate artifact paths copied VERBATIM, ranked best first) and a concise, criteria-based rationale in complete sentences.
Objective: rank the candidates that best satisfy: ${A.prompt}`,
    { schema: JUDGE_SCHEMA, label: 'judge' })
  // Upstream: an unusable judge decision keeps the filter shortlist, but the judge
  // artifact still becomes the authoritative decisionPath.
  const judgedShortlist = selectCandidates(judgeDecision(judged)?.shortlist ?? [])
  shortlist = judgedShortlist.length > 0 ? judgedShortlist : shortlist
  decisionPath = judgePath
  await agent(
    `Atomic run "${A.run_id}": transcribe the judge decision.
Write EXACTLY this JSON to ${judgePath} (create directories as needed) and touch no other file:
${JSON.stringify(judgeDecision(judged) ?? { shortlist: [], rationale: 'judge stage returned no valid structured decision' }, null, 2)}
Do NOT git commit or push.`,
    { agentType: 'atomic:scribe', label: 'write-judge' })
}

phase('Report')
const final = await agent(
  `You present a concise, actionable final shortlist for atomic run "${A.run_id}" so the reader can choose the next evaluation without reading the selection session.
Read the authoritative selection at ${decisionPath}; follow its order and do not add candidates. The selected candidate files:
${shortlist.map(p => `- ${p}`).join('\n')}
Success criteria: every selected candidate appears once in authoritative order with its differentiator, evidence, tradeoffs, and recommended next evaluation.
Stop after presenting every selected candidate once; do not add or reorder candidates.
Write the ranked markdown shortlist (per candidate: path, differentiator, evidence, tradeoffs, recommended next evaluation) to EXACTLY ${FINAL_PATH} and no other file. Lead with the outcome; report only what you can point to evidence for.
Do NOT git commit or push. Return a compact reference to the report.
Objective: summarize the selected candidates for: ${A.prompt}`,
  { agentType: 'atomic:worker', label: 'final-shortlist' })

// approved=false: a shortlist ranks options, it does not review an
// implementation against acceptance criteria, so it never authorizes a commit.
await runState(`seal ${A.run_id} complete false`, 'gate:seal')

return { result: String(final ?? `See ${FINAL_PATH}.`).slice(0, 2000),
         shortlist, candidate_artifact_paths: candidatePaths,
         filter_path: FILTER_PATH, judge_path: judgePath,
         final_path: FINAL_PATH, artifact_dir: DIR, manifest_path: MANIFEST_PATH }
