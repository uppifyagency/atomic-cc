export const meta = {
  name: 'classify-and-act',
  description: 'Schema-validated classification → deterministic confidence route → scoped action worker (port of Atomic classify-and-act)',
  phases: [
    { title: 'Classify', detail: 'schema-validated agent assigns a category with confidence' },
    { title: 'Route', detail: 'deterministic threshold gate: act, or stop for human review' },
    { title: 'Act', detail: 'isolated worker executes the prompt scoped to the category' },
  ],
}

// args: { run_id, prompt, categories = ["analysis","implementation","research"], confidence_threshold = 0.75 }
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
const CLASS_PATH = `.atomic-cc/runs/${A.run_id}/classification.json`
const ACTION_PATH = `.atomic-cc/runs/${A.run_id}/action.md`

// Discipline each builtin category imposes on the action worker; custom
// categories fall back to acting in the spirit of the label.
const DISCIPLINES = {
  analysis: 'READ-ONLY analysis: inspect the codebase/materials, do NOT modify any project file. Your only write is the findings artifact below (file:line evidence, no speculation).',
  implementation: 'Implementation: make the minimal in-scope code changes, validate them narrowly (build/tests relevant to what you touched), and record what changed + evidence in the notes artifact below.',
  research: 'Research: gather and evaluate information relevant to the prompt, cite sources/evidence, and write the research artifact below. Do NOT modify project code.',
}

phase('Classify')
const cls = await agent(
  `Classify this prompt into EXACTLY ONE of these categories: ${JSON.stringify(CATEGORIES)}
Prompt: ${A.prompt}
Return the single best-fit category, your confidence (0 to 1, calibrated — do not inflate),
and a short rationale grounded in the prompt's actual wording.`,
  { schema: { type: 'object', additionalProperties: false,
      required: ['category', 'confidence', 'rationale'],
      properties: {
        category: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        rationale: { type: 'string' },
      } },
    label: 'classify' })
if (!cls) throw new Error('atomic classify-and-act: classification stage returned null')

// Deterministic route (in JS, not by the model). A category outside the
// allowed list is treated as low confidence, never trusted.
const validCategory = CATEGORIES.includes(cls.category)
const confidence = Math.min(Math.max(cls.confidence, 0), 1)
const proceed = validCategory && confidence >= THRESHOLD
const status = proceed ? 'complete' : 'needs_human'
const record = { run_id: A.run_id, status, category: cls.category, confidence,
                 rationale: cls.rationale, threshold: THRESHOLD, categories: CATEGORIES,
                 category_valid: validCategory }

phase('Route')
log(`classify-and-act: category="${cls.category}" confidence=${confidence} threshold=${THRESHOLD} -> ${status}`)
await agent(
  `Atomic run "${A.run_id}": persist the classification decision.
Write EXACTLY this JSON to ${CLASS_PATH} (create directories as needed), and no other file:
${JSON.stringify(record, null, 2)}
Do NOT git commit or push.`,
  { agentType: 'atomic:worker', label: 'record-classification' })

if (!proceed) {
  // ADAPTATION vs upstream: Atomic pauses here on a human selection gate when
  // confidence is below threshold. Claude Code workflows cannot prompt the user
  // mid-run, so we persist status "needs_human" and stop; the human re-runs
  // with a sharper prompt/categories or acts on the classification manually.
  return { status: 'needs_human', category: cls.category, confidence,
           classification_path: CLASS_PATH, action_path: null,
           rationale: cls.rationale }
}

phase('Act')
const action = await agent(
  `You are the action worker for atomic run "${A.run_id}".
The prompt was classified as "${cls.category}" (confidence ${confidence}).
Discipline for this category: ${DISCIPLINES[cls.category] ??
    `Act strictly in the spirit of the category "${cls.category}"; stay in scope for that discipline.`}
Original prompt to execute: ${A.prompt}
Write your artifact to EXACTLY this path and no other extra file: ${ACTION_PATH}
(what you did, evidence — commands run + observed output — and file:line references).
Do NOT git commit or push: commits are gated until the run is approved.
Return a compact summary of what you produced.`,
  { agentType: 'atomic:worker', label: `act:${cls.category.slice(0, 30)}` })
if (!action) throw new Error('atomic classify-and-act: action stage returned null')

return { status: 'complete', category: cls.category, confidence,
         classification_path: CLASS_PATH, action_path: ACTION_PATH,
         result: String(action).slice(0, 2000) }
