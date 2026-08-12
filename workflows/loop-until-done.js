export const meta = {
  name: 'loop-until-done',
  description: 'Bounded iterate-and-evaluate loop: worker increments against a durable progress ledger, fresh evaluator gates on explicit validation evidence (port of Atomic loop-until-done)',
  phases: [
    { title: 'Iterate', detail: 'worker performs the next increment, writes an iteration artifact' },
    { title: 'Evaluate', detail: 'fresh evaluator returns a structured done/evidence decision; ledger updated' },
    { title: 'Finalize', detail: 'completion report or exhaustion record, run-state sealed via plugin CLI' },
  ],
}

// args: { run_id, prompt, max_iterations = 5, plugin_root }
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
    '/atomic:loop-until-done {"run_id":"l-1","prompt":"..."}')
}
const A = atomicArgs(args)
if (!A.run_id) throw new Error('atomic: run_id required')
if (!/^[A-Za-z0-9._-]{1,64}$/.test(A.run_id))
  throw new Error('atomic: run_id must match [A-Za-z0-9._-], max 64 chars (no slashes, spaces, or quotes)')
if (!A.prompt) throw new Error('atomic: prompt required')
const MAX_ITERATIONS = Math.min(Math.max(A.max_iterations ?? 5, 1), 20) // Atomic default 5, bounds 1-20
const PLUGIN_ROOT = typeof A.plugin_root === 'string' && A.plugin_root.trim()
  ? A.plugin_root.trim() : null
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

const DIR = `.atomic-cc/runs/${A.run_id}`
const LEDGER_PATH = `${DIR}/progress-ledger.json`
const iterPath = n => `${DIR}/iterations/iteration-${n}.md`
const evalPath = n => `${DIR}/evaluations/evaluation-${n}.json`

// Upstream evaluation schema (loop-until-done-runner.ts): remaining_work is a STRING.
const EVAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['done', 'summary', 'new_findings', 'failures', 'validation_evidence', 'remaining_work'],
  properties: {
    done: { type: 'boolean' },
    summary: { type: 'string' },
    new_findings: { type: 'array', items: { type: 'string' } },
    failures: { type: 'array', items: { type: 'string' } },
    validation_evidence: { type: 'array', items: { type: 'string' } },
    remaining_work: { type: 'string' },
  },
}

// The ledger is maintained by this workflow JS (as upstream's runner does with fs)
// and transcribed verbatim by an atomic:scribe stage — workers never author it.
const entries = []
const iterationArtifactPaths = []
const evaluationArtifactPaths = []
const ledgerJson = status => JSON.stringify({
  task: A.prompt,
  max_iterations: MAX_ITERATIONS,
  status,
  iterations_completed: entries.length,
  entries,
}, null, 2)

// This workflow's iteration workers mutate the repository, so the run is
// registered with the approval gate via the plugin CLI on the first mutating stage.
const BEGIN = `FIRST, before any other action, run this exact shell command to register the run with the approval gate:
"${PLUGIN_ROOT}/bin/run-state.sh" begin ${A.run_id}
Never Write/Edit .atomic-cc/run-state.json or approval.json directly — a hook denies those writes; the CLI is the only channel.`

async function sealStage(status, approved) {
  await agent(
    `Atomic run "${A.run_id}" ended: status "${status}", approved=${approved}.
Run this exact shell command and do nothing else:
"${PLUGIN_ROOT}/bin/run-state.sh" seal ${A.run_id} ${status} ${approved}
Never Write/Edit .atomic-cc/run-state.json or approval.json directly — the CLI is the only channel.`,
    { agentType: 'atomic:scribe', label: `seal-${status}` })
}

// Upstream writes the initial ledger (status "active", no entries) before iteration 1.
await agent(
  `Atomic run "${A.run_id}": transcribe the initial progress ledger.
Write EXACTLY this JSON to ${LEDGER_PATH} (create parent directories as needed) and touch no other file:
${ledgerJson('active')}
Do NOT git commit or push.`,
  { agentType: 'atomic:scribe', label: 'ledger-init' })

// Upstream iterates 1..max_iterations inclusive.
for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
  phase('Iterate')
  await agent(
    `${iteration === 1 ? `${BEGIN}\n\n` : ''}You are the active worker in a bounded evidence-driven completion loop (atomic run "${A.run_id}", iteration ${iteration} of ${MAX_ITERATIONS}).
Read ${LEDGER_PATH} first — it is the durable source of truth for attempted work, findings, failures, validation evidence, and remaining work.${iteration > 1 ? `\nAlso read the previous iteration artifact at ${iterPath(iteration - 1)}.` : ''}
Success criteria: this iteration makes measurable progress or supplies decisive evidence that the explicit objective is complete.
Requirements:
- Select the highest-value unfinished item supported by the ledger and current state.
- Perform concrete work; do not merely restate the objective or ledger.
- Avoid repeating failed approaches unless new evidence justifies the retry.
- Run the strongest practical validation for the work completed in this iteration.
- Report exactly what changed, evidence gathered, failures encountered, and what remains; report only work you can point to a tool result for, and say so explicitly when something is unverified.
End this iteration after delivering measurable progress, or after evidence shows the objective is complete.
Write your iteration artifact to EXACTLY ${iterPath(iteration)} (create directories as needed):
Markdown with Work performed, Changes, Validation evidence, New findings, Failures, and Remaining work headings. Lead with the outcome.
Do NOT git commit or push: commits are gated until the run is approved.
Objective: ${A.prompt}`,
    { agentType: 'atomic:worker', label: `iteration-${iteration}` })
  iterationArtifactPaths.push(iterPath(iteration))

  phase('Evaluate')
  const evaluation = await agent(
    `You are an independent completion evaluator for atomic run "${A.run_id}", iteration ${iteration}. Judge evidence, not the worker's confidence. You did NOT do the work.
Read BOTH files before deciding:
- Durable progress ledger: ${LEDGER_PATH}
- Current iteration artifact: ${iterPath(iteration)}
Stop condition:
- Set done=true only when the objective is fully satisfied and current validation evidence proves it.
- Set done=false when any required behavior, validation, cleanup, or evidence remains missing or uncertain.
- Do not invent requirements beyond the objective.
Evidence rules: list concrete validation evidence supporting the decision, including commands and observed output; cite file:line where applicable. Record new findings and failures distinctly. When incomplete, state actionable remaining work for the next iteration. Report only what you can point to evidence for.
Return only the required structured decision with done, summary, new_findings, failures, validation_evidence, and remaining_work (complete sentences).
Objective: ${A.prompt}`,
    { schema: EVAL_SCHEMA, label: `evaluate-${iteration}` })
  if (!evaluation) {
    // Upstream throws when the evaluator returns no structured decision — a dead
    // evaluator never counts as progress or as done. Seal first so the approval
    // gate is not left dangling on an aborted run.
    await sealStage('failed', false)
    throw new Error(`loop-until-done: evaluator evaluate-${iteration} did not return a structured decision`)
  }

  entries.push({
    iteration,
    artifact_path: iterPath(iteration),
    evaluation_artifact_path: evalPath(iteration),
    summary: evaluation.summary,
    findings: evaluation.new_findings,
    failures: evaluation.failures,
    validation_evidence: evaluation.validation_evidence,
    done: evaluation.done,
    remaining_work: evaluation.remaining_work,
  })
  evaluationArtifactPaths.push(evalPath(iteration))
  await agent(
    `Atomic run "${A.run_id}": transcribe the iteration ${iteration} records.
Write BOTH files EXACTLY as given (create directories as needed) and touch no other file:
1. ${evalPath(iteration)}:
${JSON.stringify(evaluation, null, 2)}
2. ${LEDGER_PATH} (overwrite the existing file):
${ledgerJson(evaluation.done ? 'complete' : 'active')}
Do NOT git commit or push.`,
    { agentType: 'atomic:scribe', label: `ledger-${iteration}` })

  if (evaluation.done) {
    phase('Finalize')
    const RESULT_PATH = `${DIR}/result.md`
    const final = await agent(
      `You are the final completion reporter for atomic run "${A.run_id}".
Read the complete ledger at ${LEDGER_PATH} and the final iteration artifact at ${iterPath(iteration)}.
Requirements:
- Summarize the delivered outcome without adding unsupported claims.
- Cite the validation evidence that satisfied the stop condition.
- List the artifact paths needed to audit the work.
- Report residual risks even when no work remains.
Stop after accounting for the outcome, supporting evidence, audit artifacts, residual risks, and any remaining work.
Write your report to EXACTLY ${RESULT_PATH} and no other file:
Markdown with Outcome, Evidence, Artifacts, Residual risks, and Remaining work (None) headings. Lead with the outcome.
Do NOT git commit or push. Return a compact reference to the report.
Objective: ${A.prompt}`,
      { agentType: 'atomic:worker', label: 'completion-summary' })
    // Audit finding F8 — CORRECTED to approved=false. Upstream's
    // loop-until-done-runner.ts has no approval concept at all: its terminal
    // states are complete and failed, and it never opens a commit gate. Minting a
    // gate-opening approval from one evaluator's `done` boolean was a capability
    // this port INVENTED, in the workflow a user reaches for precisely because it
    // is the cheapest — while the marketplace copy advertised "deterministic
    // quorum reducers". An independent evaluator is a real signal and it is
    // recorded in the ledger; it is not a review quorum, so it does not certify.
    // Use /atomic:goal or /atomic:adversarial-verification when the result must
    // carry an approval, or /atomic:approve to sign off yourself.
    await sealStage('complete', false)
    return { result: String(final ?? `Complete. See ${RESULT_PATH}.`).slice(0, 2000),
             status: 'complete', iterations_completed: iteration,
             ledger_path: LEDGER_PATH,
             iteration_artifact_paths: iterationArtifactPaths,
             evaluation_artifact_paths: evaluationArtifactPaths,
             result_path: RESULT_PATH, remaining_work: '', artifact_dir: DIR }
  }
  log(`atomic loop-until-done: iteration ${iteration} not done — ${evaluation.remaining_work}`)
}

// Budget exhausted without proven completion → 'failed' (upstream's exhaustion status);
// the ledger is rewritten with status "failed" and points at the last remaining work.
phase('Finalize')
const last = entries[entries.length - 1]
await agent(
  `Atomic run "${A.run_id}" exhausted its iteration budget (${MAX_ITERATIONS} iterations).
1. Write EXACTLY this JSON to ${LEDGER_PATH} (overwrite the existing file) and touch no other file:
${ledgerJson('failed')}
2. Then run this exact shell command:
"${PLUGIN_ROOT}/bin/run-state.sh" seal ${A.run_id} failed false
Never Write/Edit .atomic-cc/run-state.json or approval.json directly — the CLI is the only channel. Do NOT git commit or push.`,
  { agentType: 'atomic:scribe', label: 'finalize-failed' })

return { result: `Iteration limit exhausted after ${MAX_ITERATIONS} iterations. Inspect ${LEDGER_PATH}.`,
         status: 'failed', iterations_completed: MAX_ITERATIONS,
         ledger_path: LEDGER_PATH,
         iteration_artifact_paths: iterationArtifactPaths,
         evaluation_artifact_paths: evaluationArtifactPaths,
         result_path: LEDGER_PATH,
         remaining_work: last?.remaining_work ?? '', artifact_dir: DIR }
