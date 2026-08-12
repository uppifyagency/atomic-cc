export const meta = {
  name: 'tournament',
  description: 'N independent attempts at the whole task → single-elimination judged bracket → one winner (port of Atomic tournament)',
  phases: [
    { title: 'Attempt', detail: 'independent full attempts at the task, bounded' },
    { title: 'Bracket', detail: 'single-elimination pairwise judging rounds, per-round byes' },
    { title: 'Record', detail: 'persist the full bracket and reduce the winner into a final report' },
  ],
}

// args: { run_id, prompt, num_attempts = 4, max_concurrency = 4, plugin_root? }
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
    '/atomic:tournament {"run_id":"t-1","prompt":"..."}')
}
const A = atomicArgs(args)
if (!A.run_id) throw new Error('atomic: run_id required')
if (!/^[A-Za-z0-9._-]{1,64}$/.test(A.run_id))
  throw new Error('atomic: run_id must match [A-Za-z0-9._-], max 64 chars (no slashes, spaces, or quotes)')
if (!A.prompt) throw new Error('atomic: prompt required')
const NUM_ATTEMPTS = Math.min(Math.max(A.num_attempts ?? 4, 2), 8)       // Atomic default 4
const MAX_CONCURRENCY = Math.min(Math.max(A.max_concurrency ?? 4, 1), 8) // Atomic default 4

// This is a generation-only workflow by intent: every stage is told to write
// only under .atomic-cc/runs/<run_id>/ (attempt artifacts, bracket.json,
// winner.md) and never to touch the repository. But attempts, the recorder and
// the reducer all run as atomic:worker, which holds Edit/Write/Bash — so that
// confinement is a prompt, not a permission. The run therefore registers with
// the commit gate anyway: while it is in_progress a stray `git commit`/`gh pr`
// is denied by the hook, and every exit path seals a terminal status so the gate
// is never left shut. `approved` is always false — nothing here produces a
// reviewed deliverable, so this run never authorizes a commit.
// Gate transitions go only through the plugin CLI; direct writes to
// run-state.json / approval.json are denied by the tamper-guard hook.
const PLUGIN_ROOT = typeof A.plugin_root === 'string' ? A.plugin_root.trim() : ''
// F10 (independent audit, 2026-08-12): the gate used to be OPT-IN. Every gating
// path in this file is conditional on plugin_root, and plugin_root appeared in no
// usage example anywhere in the docs — so a user who followed the documentation
// got no registration, no commit gate, no seal and no stop guard, while the docs
// asserted the opposite. It now fails CLOSED: a run that cannot register refuses
// to start rather than running ungated while claiming to be gated.
if (!PLUGIN_ROOT) throw new Error(
  'atomic: plugin_root is required and was not supplied.\n' +
  'Without it this run cannot register with the commit gate, so nothing would be gated, ' +
  'sealed, or guarded by the Stop hook — the run would look supervised and be unsupervised.\n' +
  'Pass the plugin install path, e.g.\n' +
  '  {"run_id": "...", "plugin_root": "/path/to/atomic-cc"}\n' +
  'The SessionStart notice prints the exact path for this session; `claude plugin list` also shows it.')
// PLUGIN_ROOT is guaranteed non-empty by the fail-closed check above, so this
// never returns null: there is no ungated mode left for a reader to infer.
const runStateCmd = (sub) => `"${PLUGIN_ROOT}/bin/run-state.sh" ${sub}`
// The transition is issued by the scribe (transcribe-and-run, never author) so
// no write-capable agent is ever handed the gate.
async function runState(sub, label) {
  const cmd = runStateCmd(sub)
  await agent(
    `Run the following command EXACTLY as written, once, and report its output verbatim.
Write no files and modify nothing.

--- RUN COMMAND (verbatim) ---
${cmd}`,
    { agentType: 'atomic:scribe', label })
}

const DIR = `.atomic-cc/runs/${A.run_id}`
const attemptPath = i => `${DIR}/attempt-${i}.md`
const BRACKET_PATH = `${DIR}/bracket.json`
const WINNER_MD = `${DIR}/winner.md`

// Upstream judgeDecisionSchema (tournament-runner.ts): the winner is named by
// PRESENTED position ("first"/"second"), with a rationale and evidence list.
const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['winner', 'rationale', 'evidence'],
  properties: {
    winner: { enum: ['first', 'second'] },
    rationale: { type: 'string' },
    evidence: { type: 'array', minItems: 1, items: { type: 'string' } },
  },
}

// CC adaptation (original addition, NOT in upstream): deterministic diversity
// angles selected by attempt index. Upstream gives every attempt an identical
// prompt and relies on fresh contexts alone for diversity; index-selected
// angles are the only deterministic diversity lever available here
// (Date.now()/Math.random() throw in workflow scripts).
const ANGLES = [
  'Favor the simplest solution that fully satisfies the requirements.',
  'Favor robustness: handle edge cases and failure modes explicitly.',
  'Favor thoroughness: cover every stated requirement with explicit evidence.',
  'Favor clarity: make the result as readable and well-organized as possible.',
  'Favor a first-principles approach: rederive the solution from the requirements alone.',
  'Favor a pragmatic approach: reuse existing conventions and patterns where they fit.',
  'Favor verifiability: make every claim in your report checkable.',
  'Favor minimal surface area: touch as little as possible while meeting the requirements.',
]

phase('Attempt')
// Registered once, before the fan-out: `begin` refuses to run over an existing
// in_progress run, so N parallel attempts must not each try to claim the gate.
await runState(`begin ${A.run_id}`, 'gate:begin')
// Bounded fan-out: run attempts in batches of MAX_CONCURRENCY (Atomic bounds
// concurrency; CC's own cap is 16, so batching keeps us at the requested bound).
const attemptThunks = Array.from({ length: NUM_ATTEMPTS }, (_, i) => () =>
  agent(
    `Attempt ${i} of atomic tournament run "${A.run_id}". You are one of ${NUM_ATTEMPTS}
INDEPENDENT competitors: execute the WHOLE task below yourself, end to end, without
assuming any other attempt exists.
Task: ${A.prompt}
Angle for this attempt (deliberate diversity across competitors): ${ANGLES[i % ANGLES.length]}
Deliver a complete, self-contained solution rather than commentary about how to solve it.
Ground important claims in observable evidence or executable checks; state assumptions,
limitations, and validation performed. Optimize for correctness and usefulness, not length.
Write your COMPLETE solution/report to EXACTLY this path and no other file:
${attemptPath(i)} (create directories as needed), as Markdown with Solution, Evidence and
validation, Assumptions, and Residual risks sections. Do ALL work inside that report — do
NOT modify the repository or write any other file. It must be self-contained: a judge will
read ONLY that file to compare you against another attempt.
Return a compact summary of what you produced.`,
    { agentType: 'atomic:worker', label: `attempt:${i}` }))
const attemptResults = []
for (let i = 0; i < attemptThunks.length; i += MAX_CONCURRENCY)
  attemptResults.push(...await parallel(attemptThunks.slice(i, i + MAX_CONCURRENCY)))

// CC adaptation: upstream runs attempts with failFast (one dead attempt fails
// the whole run); here a null attempt (subagent death) loses by walkover — it
// simply never enters the bracket.
const walkovers = attemptResults
  .map((r, i) => (r == null ? i : null)).filter(i => i != null)
const seeds = attemptResults
  .map((r, i) => (r != null ? i : null)).filter(i => i != null)
if (seeds.length < 2) {
  log(`atomic tournament: only ${seeds.length}/${NUM_ATTEMPTS} attempts survived — cannot run a bracket`)
  await runState(`seal ${A.run_id} failed false`, 'gate:seal')
  return { status: 'failed', winner: null,
           bracket_path: null,
           attempts: seeds.map(i => ({ index: i, path: attemptPath(i) })),
           bracket_integrity: { degraded: true, attempts_requested: NUM_ATTEMPTS,
             attempts_entered: seeds.length, walkovers,
             matches_decided_by_judgment: 0, matches_decided_by_fallback: 0, judge_errors: [],
             upstream_divergence: 'Upstream Atomic runs attempts under failFast and would have failed on the first dead attempt; this port collected the survivors first and then found too few to seed a bracket.' } }
}
log(`atomic tournament: ${seeds.length}/${NUM_ATTEMPTS} attempts survived; walkovers: [${walkovers.join(', ')}]`)

phase('Bracket')
// firstIdx/secondIdx are attempt indices in PRESENTATION order (the caller has
// already applied upstream's alternating first/second swap).
async function judgeMatch(round, matchNo, firstIdx, secondIdx) {
  const judgePrompt =
    `You are the impartial pairwise judge for round ${round}, match ${matchNo} of atomic tournament run "${A.run_id}".
Two independent attempts solved the same task. Evaluate only the supplied artifacts; read
BOTH files completely before deciding:
First presentation (attempt ${firstIdx}): ${attemptPath(firstIdx)}
Second presentation (attempt ${secondIdx}): ${attemptPath(secondIdx)}
Judge STRICTLY against this rubric, derived from the original task's requirements:
1. Correctness: satisfies the task without material errors.
2. Completeness: covers required outcomes and important edge cases.
3. Evidence: supports claims with observable evidence or checks.
4. Task fit: is directly usable and avoids irrelevant work.
The task both attempts had to satisfy:
${A.prompt}
Choose exactly one presented candidate; do not merge or rewrite them. Ignore presentation
order, writing length, and stylistic polish unless they affect the rubric. Cite observable
evidence from both artifacts: the selected winner must be traceable to short,
rubric-grounded evidence.`
  let verdict = await agent(judgePrompt,
    { schema: JUDGE_SCHEMA, label: `judge:r${round}:m${matchNo}:${firstIdx}v${secondIdx}` })
  if (!verdict)
    verdict = await agent(judgePrompt,
      { schema: JUDGE_SCHEMA, label: `judge:r${round}:m${matchNo}:${firstIdx}v${secondIdx}:retry` })
  if (!verdict) {
    // CC adaptation: upstream judges run with failFast (a judge failure fails
    // the run). Here a judge that died twice falls back deterministically:
    // the lower attempt index advances.
    return { round, match: matchNo, first: firstIdx, second: secondIdx,
             winner: Math.min(firstIdx, secondIdx), judge_error: true,
             rationale: 'judge_error: judge agent returned null twice; lower index advances',
             evidence: [] }
  }
  return { round, match: matchNo, first: firstIdx, second: secondIdx,
           winner: verdict.winner === 'first' ? firstIdx : secondIdx,
           judge_error: false, rationale: verdict.rationale, evidence: verdict.evidence }
}

// Single-elimination bracket, ported exactly from upstream tournament-runner.ts:
// - At EACH round with an odd entrant count, the LAST entrant in the current
//   bracket order receives that round's bye (recorded as { round, entrant })
//   and re-enters at the END of the next round, AFTER the match winners.
//   There is no power-of-two seeding and no round-1-only bye block: byes are
//   decided per round, from whatever order the previous round produced.
// - Presentation order alternates per match: for 0-based match index m in
//   round r, (r + m) % 2 === 0 swaps which candidate the judge sees first,
//   countering positional bias.
const matches = []
const byes = []
let entrants = seeds.slice()
let round = 1
while (entrants.length > 1) {
  const bye = entrants.length % 2 === 1 ? entrants[entrants.length - 1] : undefined
  if (bye !== undefined) byes.push({ round, entrant: bye })
  const pairs = []
  for (let i = 0; i + 1 < entrants.length; i += 2) pairs.push([entrants[i], entrants[i + 1]])
  log(`atomic tournament: round ${round} — ${pairs.length} match(es)` +
      (bye !== undefined ? `, bye: attempt ${bye}` : ''))
  const thunks = pairs.map(([left, right], m) => () => {
    const reverse = (round + m) % 2 === 0
    const first = reverse ? right : left
    const second = reverse ? left : right
    return judgeMatch(round, m + 1, first, second)
  })
  const roundMatches = []
  for (let i = 0; i < thunks.length; i += MAX_CONCURRENCY)
    roundMatches.push(...await parallel(thunks.slice(i, i + MAX_CONCURRENCY)))
  matches.push(...roundMatches)
  entrants = roundMatches.map(m => m.winner)
  if (bye !== undefined) entrants.push(bye)
  round += 1
}
const champion = entrants[0]

// Audit finding F11. Upstream runs attempts and judges under failFast, so a dead
// attempt or a dead judge aborts the whole run; this port continues (walkover for
// a dead attempt, lower-index-advances for a judge that died twice) because the
// workflow sandbox has no way to retry a stage the way the upstream runtime does.
// That is a genuine divergence, and the auditor's objection was not that it
// exists but that it was INVISIBLE: a caller reading `winner` could not tell a
// bracket decided by judgment from one decided by an index comparison. It is
// reported now, in the return value, in the log, and in bracket.json.
const judgeErrors = matches.filter(m => m.judge_error)
  .map(m => ({ round: m.round, match: m.match, first: m.first, second: m.second, advanced: m.winner }))
const decidedByJudgment = matches.length - judgeErrors.length
if (judgeErrors.length > 0)
  log(`atomic tournament: ${judgeErrors.length}/${matches.length} match(es) had no surviving judge — ` +
      `the lower attempt index advanced by rule, not by judgment. Upstream would have failed the run.`)

phase('Record')
// Upstream bracket.json shape: { task, matches, byes, winner }. run_id,
// num_attempts, seeds, and walkovers are CC extensions (upstream failFast
// aborts on a dead attempt instead of recording walkovers).
const bracket = {
  task: A.prompt,
  run_id: A.run_id,
  num_attempts: NUM_ATTEMPTS,
  seeds,
  walkovers,
  judge_errors: judgeErrors,
  matches,
  byes,
  winner: { index: champion, path: attemptPath(champion) },
}
const bracketJson = JSON.stringify(bracket, null, 2)
await agent(
  `Atomic tournament run "${A.run_id}" finished; attempt ${champion} won the bracket.
Write EXACTLY the following content, verbatim with no additions, omissions, or reformatting,
to ${BRACKET_PATH} (create directories as needed) and no other file:
${bracketJson}`,
  { agentType: 'atomic:worker', label: 'record-bracket' })

// Upstream bracket-reducer stage (renderBracketReducerPrompt): a final
// fresh-context reporter reads the bracket ledger + winning artifact and
// writes winner.md so the caller gets an auditable decision trail.
const reducerSummary = await agent(
  `You are the tournament bracket reducer and final reporter for atomic tournament run "${A.run_id}".
Read both files before reporting:
Bracket ledger: ${BRACKET_PATH}
Winning artifact (attempt ${champion}): ${attemptPath(champion)}
Requirements:
- Return the winning solution faithfully; do not silently combine losing material into it.
- Summarize why it advanced using the recorded pairwise rationale and evidence.
- Call out bracket byes and any limitations recorded by judges.
- Cite the bracket ledger and winning artifact paths.
Write the full report via your Write tool to EXACTLY ${WINNER_MD} and no other file, as
Markdown with Winner, Winning solution, Decision trail, Evidence, and Residual risks
sections. A reader must be able to use the winning solution and audit every comparison
that selected it. Then return a compact summary of the report.`,
  { agentType: 'atomic:worker', label: 'bracket-reducer' })
if (reducerSummary == null)
  // CC adaptation: upstream fails the run when the reducer stage rejects; here
  // the winner and bracket are already durable, so surface the gap instead.
  log('atomic tournament: bracket-reducer stage returned null — winner.md may be missing')

// approved=false: a judged bracket selects the best attempt, it does not review
// the winner against acceptance criteria, so it must not authorize a commit.
await runState(`seal ${A.run_id} complete false`, 'gate:seal')

return {
  status: 'complete',
  result: reducerSummary,
  winner: { index: champion, path: attemptPath(champion) },
  result_path: WINNER_MD,
  bracket_path: BRACKET_PATH,
  attempts: seeds.map(i => ({ index: i, path: attemptPath(i) })),
  // F11 disclosure: `degraded` is true whenever some part of this bracket was
  // decided by a fallback rule rather than by a judge or an entrant. Read it
  // before treating `winner` as "the best of N".
  bracket_integrity: {
    degraded: walkovers.length > 0 || judgeErrors.length > 0,
    attempts_requested: NUM_ATTEMPTS,
    attempts_entered: seeds.length,
    walkovers,
    matches_decided_by_judgment: decidedByJudgment,
    matches_decided_by_fallback: judgeErrors.length,
    judge_errors: judgeErrors,
    upstream_divergence: (walkovers.length > 0 || judgeErrors.length > 0)
      ? 'Upstream Atomic runs attempts and judges under failFast and would have failed this run instead of completing it. This port continued and recorded the substitution.'
      : null,
  },
}
