export const meta = {
  name: 'tournament',
  description: 'N independent attempts at the whole task → single-elimination judged bracket → one winner (port of Atomic tournament)',
  phases: [
    { title: 'Attempt', detail: 'independent full attempts at the task, bounded' },
    { title: 'Bracket', detail: 'single-elimination pairwise judging rounds' },
    { title: 'Record', detail: 'persist the full bracket and declare the winner' },
  ],
}

// args: { run_id, prompt, num_attempts = 4, max_concurrency = 4 }
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

const attemptPath = i => `.atomic-cc/runs/${A.run_id}/attempt-${i}.md`

const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['winner', 'rationale', 'criteria_scores'],
  properties: {
    winner: { enum: ['a', 'b'] },
    rationale: { type: 'string' },
    criteria_scores: { type: 'array', minItems: 1,
      items: { type: 'object', additionalProperties: false,
        required: ['criterion', 'a', 'b'],
        properties: { criterion: { type: 'string' },
          a: { type: 'number', minimum: 0, maximum: 10 },
          b: { type: 'number', minimum: 0, maximum: 10 } } } },
  },
}

// Deterministic diversity angles, selected by index (no randomness allowed:
// Date.now()/Math.random() throw in workflow scripts).
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
// Bounded fan-out: run attempts in batches of MAX_CONCURRENCY (Atomic bounds
// concurrency; CC's own cap is 16, so batching keeps us at the requested bound).
const attemptThunks = Array.from({ length: NUM_ATTEMPTS }, (_, i) => () =>
  agent(
    `Attempt ${i} of atomic tournament run "${A.run_id}". You are one of ${NUM_ATTEMPTS}
INDEPENDENT competitors: execute the WHOLE task below yourself, end to end, without
assuming any other attempt exists.
Task: ${A.prompt}
Angle for this attempt (deliberate diversity across competitors): ${ANGLES[i % ANGLES.length]}
Write your COMPLETE solution/report to EXACTLY this path and no other file:
${attemptPath(i)} (create directories as needed). It must be self-contained: a judge will
read ONLY that file to compare you against another attempt.
Return a compact summary of what you produced.`,
    { agentType: 'atomic:worker', label: `attempt:${i}` }))
const attemptResults = []
for (let i = 0; i < attemptThunks.length; i += MAX_CONCURRENCY)
  attemptResults.push(...await parallel(attemptThunks.slice(i, i + MAX_CONCURRENCY)))

// A null attempt (subagent death) loses by walkover: it simply never enters the bracket.
const walkovers = attemptResults
  .map((r, i) => (r == null ? i : null)).filter(i => i != null)
const seeds = attemptResults
  .map((r, i) => (r != null ? i : null)).filter(i => i != null)
if (seeds.length < 2) {
  log(`atomic tournament: only ${seeds.length}/${NUM_ATTEMPTS} attempts survived — cannot run a bracket`)
  return { status: 'failed', winner: null,
           bracket_path: null,
           attempts: seeds.map(i => ({ index: i, path: attemptPath(i) })) }
}
log(`atomic tournament: ${seeds.length}/${NUM_ATTEMPTS} attempts survived; walkovers: [${walkovers.join(', ')}]`)

phase('Bracket')
async function judgeMatch(round, matchNo, ai, bi) {
  const judgePrompt =
    `You are the judge for round ${round}, match ${matchNo} of atomic tournament run "${A.run_id}".
Two independent attempts solved the same task. Read BOTH files in full:
attempt a (index ${ai}): ${attemptPath(ai)}
attempt b (index ${bi}): ${attemptPath(bi)}
Judge STRICTLY on how well each satisfies the original prompt's requirements — nothing else:
${A.prompt}
Score each attempt per criterion you derive from those requirements (0-10), then pick the
single overall winner. Do not reward length, style flourishes, or work beyond the requirements.`
  let verdict = await agent(judgePrompt,
    { schema: JUDGE_SCHEMA, label: `judge:r${round}:m${matchNo}:${ai}v${bi}` })
  if (!verdict)
    verdict = await agent(judgePrompt,
      { schema: JUDGE_SCHEMA, label: `judge:r${round}:m${matchNo}:${ai}v${bi}:retry` })
  if (!verdict) {
    // Judge died twice: deterministic fallback — lower index advances.
    const winner = Math.min(ai, bi)
    return { round, match: matchNo, a: ai, b: bi, winner,
             judge_error: true, rationale: 'judge_error: judge agent returned null twice; lower index advances',
             criteria_scores: [] }
  }
  return { round, match: matchNo, a: ai, b: bi,
           winner: verdict.winner === 'a' ? ai : bi,
           judge_error: false, rationale: verdict.rationale,
           criteria_scores: verdict.criteria_scores }
}

// Balanced single-elimination bracket, seeded deterministically by attempt index.
// With non-power-of-2 counts, byes go to the LOWEST-index seeds in round 1
// (like upstream): pow2 = next power of 2 ≥ n, byes = pow2 - n, seeds[0..byes-1]
// skip round 1 while the remaining seeds pair off in index order.
let pow2 = 1
while (pow2 < seeds.length) pow2 *= 2
const round1Byes = pow2 - seeds.length

const rounds = []
let alive = seeds.slice()
let round = 1
while (alive.length > 1) {
  const byes = round === 1 ? alive.slice(0, round1Byes) : []
  const playing = round === 1 ? alive.slice(round1Byes) : alive
  const pairs = []
  for (let i = 0; i < playing.length; i += 2) pairs.push([playing[i], playing[i + 1]])
  log(`atomic tournament: round ${round} — ${pairs.length} match(es), byes: [${byes.join(', ')}]`)
  const thunks = pairs.map(([ai, bi], m) => () => judgeMatch(round, m, ai, bi))
  const matches = []
  for (let i = 0; i < thunks.length; i += MAX_CONCURRENCY)
    matches.push(...await parallel(thunks.slice(i, i + MAX_CONCURRENCY)))
  rounds.push({ round, byes, matches })
  alive = [...byes, ...matches.map(m => m.winner)]
  round += 1
}
const champion = alive[0]

phase('Record')
const bracket = {
  run_id: A.run_id,
  num_attempts: NUM_ATTEMPTS,
  seeds,
  walkovers,
  round1_byes: seeds.slice(0, round1Byes),
  rounds,
  winner: { index: champion, path: attemptPath(champion) },
}
const bracketJson = JSON.stringify(bracket, null, 2)
await agent(
  `Atomic tournament run "${A.run_id}" finished; attempt ${champion} won the bracket.
Write EXACTLY the following content, verbatim with no additions, omissions, or reformatting,
to .atomic-cc/runs/${A.run_id}/bracket.json (create directories as needed) and no other file:
${bracketJson}`,
  { agentType: 'atomic:worker', label: 'record-bracket' })

return {
  status: 'complete',
  winner: { index: champion, path: attemptPath(champion) },
  bracket_path: `.atomic-cc/runs/${A.run_id}/bracket.json`,
  attempts: seeds.map(i => ({ index: i, path: attemptPath(i) })),
}
