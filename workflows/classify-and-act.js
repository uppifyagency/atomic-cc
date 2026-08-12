export const meta = {
  name: 'classify-and-act',
  description: 'Schema-validated classification → deterministic confidence route with deterministic headless fallback → scoped action worker (port of Atomic classify-and-act)',
  phases: [
    { title: 'Classify', detail: 'schema-validated agent assigns a category with confidence' },
    { title: 'Route', detail: 'deterministic threshold gate; low confidence falls back deterministically, never stops' },
    { title: 'Act', detail: 'isolated worker executes the prompt scoped to the selected category' },
    { title: 'Seal', detail: 'terminal run-state seal via the plugin CLI' },
  ],
}

// args: { run_id, prompt, categories = ["analysis","implementation","research"],
//         confidence_threshold = 0.75, plugin_root }
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
    '/atomic:classify-and-act {"run_id":"ca-1","prompt":"..."}')
}
const A = atomicArgs(args)
if (!A.run_id) throw new Error('atomic: run_id required (e.g. ca-triage-01)')
if (!/^[A-Za-z0-9._-]{1,64}$/.test(A.run_id))
  throw new Error('atomic: run_id must match [A-Za-z0-9._-], max 64 chars (no slashes, spaces, or quotes)')
if (!A.prompt) throw new Error('atomic: prompt required')
const CATEGORIES = Array.isArray(A.categories) && A.categories.length
  ? A.categories.slice(0, 8).map(String)                                   // Atomic bounds: 1-8 categories
  : ['analysis', 'implementation', 'research']                             // Atomic defaults
const THRESHOLD = Math.min(Math.max(A.confidence_threshold ?? 0.75, 0.5), 0.99) // Atomic default 0.75
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
const CLASS_PATH = `${DIR}/classification.json`

// Upstream safeName(): category → filesystem-safe artifact suffix.
function safeName(value) {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return normalized || 'fallback'
}

// This workflow's action stage may mutate the repository (implementation/fix/code
// categories), so the run is registered with the approval gate via the plugin CLI.
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

phase('Classify')
// Upstream classifier runs with tools: [] (pure structured classification).
// CC adaptation: per-stage tool restriction is unavailable; the prompt scopes it.
const cls = await agent(
  `Categories:
${CATEGORIES.map(c => `- ${c}`).join('\n')}
You route a task to exactly one declared action category. Do not use any tools; classify from the task text alone.
Success criteria: the selected category is copied verbatim from the list and supported by the task's concrete wording.
Decision rules: choose exactly one listed category. Use low confidence when the task is ambiguous or spans categories. Stop after making that single classification.
Return only the structured result requested by the schema: category, confidence (0 to 1, calibrated), and a concise evidence-based rationale in complete sentences.
Classify this task: ${A.prompt}`,
  { schema: { type: 'object', additionalProperties: false,
      required: ['category', 'confidence', 'rationale'],
      properties: {
        category: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        rationale: { type: 'string' },
      } },
    label: 'classifier' })

// Ported 1:1 from upstream classify-and-act-runner.ts: a missing/invalid structured
// classification is NOT fatal — it degrades to proposed="", confidence=0, which the
// deterministic fallback below resolves. The workflow ALWAYS proceeds to act.
const v = (cls && typeof cls === 'object') ? cls : {}
const proposedCategory = 'category' in v ? String(v.category) : ''
const rawConfidence = 'confidence' in v ? v.confidence : 0
const confidence = (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence))
  ? Math.max(0, Math.min(1, rawConfidence)) : 0
const rationale = 'rationale' in v ? String(v.rationale)
  : 'Classifier did not provide a usable structured rationale.'
const exactCategory = CATEGORIES.find(c => c === proposedCategory)
const needsFallback = exactCategory === undefined || confidence < THRESHOLD
// CC adaptation: upstream first tries an interactive human selection (ctx.ui.select)
// and falls back deterministically when the run is headless. Claude Code workflows
// cannot prompt the user mid-run, so we always take upstream's deterministic branch:
// the exact proposed category when it is listed, else the first configured category.
const category = needsFallback ? (exactCategory ?? CATEGORIES[0]) : exactCategory
const fallbackMode = needsFallback ? 'deterministic' : 'none'
const ACTION_PATH = `${DIR}/action-${safeName(category)}.md`

phase('Route')
log(`classify-and-act: proposed="${proposedCategory}" confidence=${confidence} threshold=${THRESHOLD} -> selected="${category}" (fallback=${needsFallback ? fallbackMode : 'none'})`)
const record = {
  proposed_category: proposedCategory,
  selected_category: category,
  confidence,
  threshold: THRESHOLD,
  rationale,
  fallback_used: needsFallback,
  fallback_mode: fallbackMode,
}
await agent(
  `Atomic run "${A.run_id}": transcribe the classification decision.
Write EXACTLY this JSON to ${CLASS_PATH} (create parent directories as needed) and touch no other file:
${JSON.stringify(record, null, 2)}
Do NOT git commit or push.`,
  { agentType: 'atomic:scribe', label: 'record-classification' })

// Upstream scopes the action stage's TOOLS per category (actionTools): categories
// containing implement/fix/code get read+edit+write+bash; research gets read+web;
// everything else is read-only. CC adaptation: tools cannot be restricted per stage,
// so the same scoping is imposed as a hard prompt discipline on the worker.
const normalized = category.toLowerCase()
const writeCapable = normalized.includes('implement') || normalized.includes('fix') || normalized.includes('code')
const discipline = writeCapable
  ? 'Discipline: implementation — make the minimal in-scope changes (Read/Edit/Write/Bash) and validate them narrowly (build/tests relevant to what you touched).'
  : normalized.includes('research')
    ? 'Discipline: research — read, search, and evaluate information only. Do NOT modify any project file; your only write is the report artifact below.'
    : 'Discipline: read-only — inspect the codebase/materials only. Do NOT modify any project file; your only write is the report artifact below.'

phase('Act')
const action = await agent(
  `${BEGIN}

You are the isolated action agent for category "${category}" in atomic run "${A.run_id}".
Evidence: read the classification artifact at ${CLASS_PATH}. Use only relevant evidence available to this stage; do not assume access to the classifier's conversation context.
${discipline}
Success criteria: complete the requested action for this category, distinguish verified facts from assumptions, and report concrete evidence, validation, and remaining risks.
Stop when the category-specific action is complete or a remaining blocker is stated with its missing evidence.
Write your report to EXACTLY this path and no other extra file: ${ACTION_PATH}
Markdown with Outcome, Evidence, Validation, and Remaining risks headings. Lead with the outcome; report only work you can point to evidence for, and say so explicitly when something is unverified.
Do NOT git commit or push: commits are gated until the run is approved.
Return a compact summary of what you produced.

Objective: ${A.prompt}`,
  { agentType: 'atomic:worker', label: `action-${safeName(category)}` })
if (!action) {
  await sealStage('failed', false)
  throw new Error('atomic classify-and-act: action stage returned null')
}

phase('Seal')
// approved=false: this workflow is a router (classify → act) and has no review
// stage, so there is nothing to base an approval on. Sealing approved=true here
// would mint the "independently reviewed" receipt (.atomic-cc/runs/<id>/
// approval.json) for work no verifier ever read. The action completed; a human
// who wants the receipt runs /atomic:approve, or routes the work through
// /atomic:goal or /atomic:adversarial-verification, which do review it.
await sealStage('complete', false)

return { status: 'complete', result: String(action).slice(0, 2000),
         category, confidence, proposed_category: proposedCategory,
         fallback_used: needsFallback, rationale,
         classification_path: CLASS_PATH, action_path: ACTION_PATH, artifact_dir: DIR }
