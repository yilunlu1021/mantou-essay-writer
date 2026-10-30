# Mantou Essay Writer

A local writing project for your existing coding agent. It prepares task-specific rules, preserves originals, validates edits, checks review records and exports versioned Word drafts. It supports Chinese, English and mixed text, with separate scopes for academic work, personal narratives, application explanations and advisor feedback.

Preview 0.3 adds a dedicated logic review, contextual checks for repeated infinitive frames, and a natural-language folder entry. Read [开始使用.md](开始使用.md): place a draft and its prompt in inbox/, open the folder in your agent, and ask for a review or edit. The tool aggregates seven current review inputs and leaves human adoption separate.

This preview includes 55 policy groups. Mechanical findings are checked by code. Facts, reasoning, author voice and context-dependent language still need human review. The tool does not predict AI detector scores or approve an essay for submission.

## Start on Windows or macOS

1. Download the runtime ZIP, or GitHub **Code → Download ZIP**, and extract it. Check for `bin/essay.mjs`; if it is absent, build that source checkout using CONTRIBUTING.md before running it.
2. Install [Node.js 22 or 24 LTS](https://nodejs.org/en/download) if needed. Open a new terminal after installation.
3. Open the extracted folder in Codex or another agent. Ask: **Read AGENTS.md, run doctor and the demo, then help me edit my document.**

Run these commands in that folder. They work in PowerShell and macOS Terminal:

```sh
node bin/essay.mjs doctor
node bin/essay.mjs demo --out "my demo"
```

Open `my demo/versions/v0001/working-draft.docx` and `review.md`. The demo uses synthetic text, changes one punctuation span and preserves the original. Windows users can also right-click `start.ps1` and choose Run with PowerShell, or run `powershell -File start.ps1`. On macOS, run `sh start.sh`. Both launchers only run diagnostics.

Runtime dependencies are bundled. No Python, package installation, model API key or network connection is needed to run the tool. Your agent uses its own model and may send text to its provider, depending on its settings. Review those settings before giving it private text.

## Edit your own draft

Save the full essay question in `prompt.txt`. Keep drafts and sessions outside the downloaded code folder when possible.

```sh
node bin/essay.mjs import --input "draft.docx" --out "my essay" --language en --genre personal-narrative --prompt-file "prompt.txt"
node bin/essay.mjs prepare --session "my essay"
```

The agent reads `original.json`, the current `document.json`, `prepare.json` and `review.md`. It copies `patch-template.json` outside the version folder, fills in exact changes, then runs:

```sh
node bin/essay.mjs revise --session "my essay" --patch-file "edits.json"
node bin/essay.mjs status --session "my essay"
```

For a complete revision, prepare a source-review template, save its completed `template` outside the version folders, then validate it:

```sh
node bin/essay.mjs prepare-source-review --session "my essay"
node bin/essay.mjs review-source --session "my essay" --review-file "source-review.json"
```

The agent compares each sentence or inseparable unit with exact source spans and explains meaning, voice, relevance and omissions. The tool checks references, full coverage and current bindings. `recorded` means the record is complete. It does not certify the agent's judgments. Explicit meaning changes, unresolved judgments and padding require rework. Both review outcomes keep human review pending and return exit code 3.

Each successful edit creates a new folder such as `versions/v0001`. Each version contains:

| File | Purpose |
| --- | --- |
| `working-draft.docx` | Full prompt and candidate body in a simple Word layout |
| `document.json` / `document.txt` | Paragraph IDs and text, or a readable text copy |
| `review.md` / `audit.json` | Findings and rules requiring human review |
| `prepare.json` | Rules that apply to this task and version bindings |
| `patch-template.json` | Exact hashes to copy into the next patch |
| `changes.json` | Applied edits with reasons, using codepoint offsets |

A Word file is a **working draft**, including when mechanical findings remain. Its review is stored separately so comments and status labels do not enter the essay itself. Read the review before using the text. No command marks a draft as officially approved.

Do not edit stored session files. Their hashes detect accidental changes. These local hashes are provenance checks, not digital signatures or a trusted approval system. Save proposed changes in a new patch file. Back up the complete session folder to retain its history.

## Choose the task context

Use `--language en`, `zh` or `mixed`. Choose a genre:

| Genre | Use |
| --- | --- |
| `personal-narrative` | Personal application essays and narrative creative writing |
| `application-explanatory` | Academic interests, plans, program fit and explanatory answers |
| `academic` | Academic analysis, evidence, terminology and qualified conclusions |
| `advisor-feedback` | Comments and feedback written by an advisor |
| `general` | Other text |
| `unknown` | Ask the agent to clarify the genre before applying special rules |

Default mode is `edit`. Keep events, reasoning and the author's way of expressing them. The `revise` command applies a patch and does not itself authorize structural rewriting. If the user explicitly requests structural changes, import a new session using `--mode revision --authorize-revision`.

Use `--role advisor --genre advisor-feedback --channel wechat --stage material` for early WeChat feedback. All rules and their scope are in [language standards](policy/language-standards.md) and [writing collaboration rules](policy/collaboration-writing.md). Semantic rules remain visible in review even when they cannot be checked automatically. The [complete self-contained execution copy](policy/agent-rules.md) includes all rules and term lists, with a [human ledger template](policy/rule-execution-template.json). All applicable subrequirements are mandatory; empty or unverified ledger entries do not count as compliance, and no automatic semantic validation is implied. This release uses the bundled policy. Task-specific exceptions require human review and do not silently suppress machine findings.

For an English clean draft, supply the verified official limit, for example `--stage clean-draft --max 650`. The minimum is then at least 635 words. A stricter `--min` is allowed, while a lower value cannot widen the range. `--unit` selects the counting unit. The tool counts English words, Han characters or non-whitespace codepoints. It does not verify an institution's limit. Never invent facts or add filler to reach a target.

`--protect-blocks p1,p3` prevents edits anywhere in those blocks. `--edit-budget 2000` sets the total changed codepoints permitted per revision, counting removed and inserted text. A large allowed budget does not authorize a change of meaning. Sessions support up to 100 versions and 200 paragraphs, with a total text limit of 200,000 UTF-16 units.

## File support

UTF-8 `.txt` and `.md` files are limited to 1 MB. BOM and CRLF are supported. Markdown is imported as literal text, without interpreting headings or emphasis. Blank lines separate paragraphs.

`.docx` files are limited to 5 MB compressed, 20 MB expanded and 1,000 ZIP entries. The importer accepts plain body paragraphs, including spaces, tabs and line breaks. It preserves the exact original file separately. Export creates a new simple layout and does not preserve source formatting.

The importer rejects tables, tracked changes, fields, formulas, text boxes, notes, meaningful headers/footers, external links and styled content whose visible meaning may be lost, including numbered or hidden text. A styled Word file may need a body-only UTF-8 text copy. Review that copy against the original before import. Old `.doc` and PDF files are unsupported.

## Errors and recovery

`--help`, `--version`, `schema` and `example` work without a draft. `doctor` checks Node and policy integrity, without installing software or changing settings.

| Exit code | Meaning |
| --- | --- |
| 0 | Utility or demo completed |
| 1 | Request or runtime failure, with a safe error and hint on stderr |
| 2 | Draft stored or audited, with mechanical blockers |
| 3 | Draft stored or audited, with human review pending |

Codes 2 and 3 are valid audit outcomes. Check the JSON result before retrying import or revise. Existing output folders are never overwritten. In PowerShell, inspect `$LASTEXITCODE` when needed. File options avoid shell-specific input redirection.

If a process was interrupted, `status` still reads the last complete version. A leftover writer lock prevents another edit. Run `node bin/essay.mjs recover --session "my essay"` on the same computer. Recovery removes a lock only when its recorded process no longer exists. It retains incomplete staging folders for inspection and never changes completed versions. If lock metadata is missing, a recovery itself was interrupted, or the recorded PID has been reused, stop all writers and keep a backup before inspecting the lock folder manually. Starting a new session from the last verified text is also possible.

See [AGENTS.md](AGENTS.md) for the editing protocol, [CONTRIBUTING.md](CONTRIBUTING.md) for development and [SECURITY.md](SECURITY.md) for data handling.

## License and release status

MIT license. Bundled dependencies retain their notices in `THIRD_PARTY_NOTICES.txt`.

This is a preview release. The CI workflow tests Node 22 and 24 on Windows, macOS and Linux, including first use from a ZIP in a folder with spaces and Chinese characters. A passing test does not replace reviewing the exported essay. The workflow records its actual runner architecture in its output.

## Whole-answer review

Before polishing a complete essay, run `prepare-answer-review --session ...`. Read the prompt and body independently, then save a completed template outside version folders and run `review-answer --session ... --review-file ...`. Record the answer to the prompt, key relationships, bounded conclusions, selection decisions and unresolved reader questions. Repeat after editing. A recorded result validates references and bindings only. Explicit missing conditions, overreach, unanswered requirements and open questions require rework, even when the top-level recommendation is to adopt the draft. Source review remains required.

## Style and detector feedback

For a complete student revision or detector feedback, run `prepare-style-review --session ...`, then `review-style --session ... --review-file ...`. Both commands optionally accept the same `--evidence-file ...`; use `schema` for its strict format. Without evidence, leave the option out. Review every logical paragraph, repeated functions and appropriate voice references. Keep useful plain sentences, necessary terms and genuine plans. Surface cues locate phrases, never AI probabilities or mandatory edits.

Evidence keeps reference origins and author roles separate. Detector comments quote their tested snapshot; a historical result cannot become a score for a new version. The record binds the session and evidence, covers each comment, and separates labels, explanations, hypotheses and retention counterexamples. A recorded result verifies references and explicit states, not authenticity, natural voice, detector replication or submission approval. No text is uploaded or automatically changed.

## Local feedback library

Humanier v1.4 style records separately cover main-clause/action position, clause attachments, diction, stance, cadence and information gain. Each dimension needs an exact current anchor, a decision and a retention counterexample. These checks do not classify authorship.

Use `feedback-import --db private/feedback.sqlite --evidence-file evidence.json`, `feedback-stats --db private/feedback.sqlite` and `feedback-recall --db private/feedback.sqlite --feature-tag "Plain syntax"` to retain feedback locally. Queries omit draft text by default; `--include-text` is explicit. `feedback-interpret` and `feedback-trial` accept strict JSON from `schema`. Evidence, candidate interpretations and actual retests stay separate, and repeated imports do not increase independent-document counts. Interpretation replacements preserve their earlier record and an explicit link.

The optional library requires a Node runtime with node:sqlite; it was checked on Node 22.18. Other document commands load no database. Store real drafts and libraries outside Git. No detector upload, model training or automatic rule promotion is performed. Package style preparation remains read-only; repository workflow automation is a separate workstation feature.

The versioned taxonomy adds nine review categories and maps 22 source labels to review domains. Run `feedback-taxonomy` to inspect the definitions and retention counterexamples. Run `feedback-categorize --db private/feedback.sqlite` to preview classifications, then add `--apply` to append them. Repeating the same classification does not add another interpretation. `feedback-categories --db private/feedback.sqlite` reports current, non-rejected interpretations and counts unique anchors separately from tag instances. `feedback-recall` also accepts `--category`, `--taxonomy-version` and `--interpretation-history current|all`. Category matching uses current interpretations even when history is requested. A mapped label does not establish an error.

Screenshot observations can retain an attachment hash, visibility, visible text and the relationship between that text and its anchor. Collapsed observations keep tags empty and explanations unknown. A collapsed row cannot establish a detector classification or reveal its hidden explanation.

## English linguistic review

For a closer review of reference, narrative viewpoint and sentence function, prepare a template and save the completed `template` outside stored version folders:

```sh
node bin/essay.mjs prepare-linguistic-review --session "my essay"
node bin/essay.mjs review-linguistic --session "my essay" --review-file "linguistic-review.json"
```

Both commands accept the same optional `--evidence-file`. Review every candidate, logical paragraph and supplied comment. Record exact source spans, the information function, viewpoint, clause function, an explicit decision and a retention counterexample. Reference candidates also need the actual mention and its identification basis. An indefinite article can introduce a specific object, and another person's observable action can belong in a first-person narrative. Necessary terminology and temporal clauses can be retained.

The engine uses sentence segmentation and transparent surface patterns. It does not perform a full syntactic parse or certify reference resolution. Nine bindings protect the session, version, original, body, context, policy, evidence, taxonomy and engine version. Missing, repeated or stale records are rejected. Explicit revision needs, missing sources and unresolved items require rework. A recorded result validates references and coverage, while judgments and author voice still need review. Both commands leave the draft and library unchanged. Apply actual edits through version patches and repeat the existing source, answer and style reviews. This extension retains the Humanier v1.4 policy and its 55 groups.

Engine 1.1.0 adds bounded construction cues with exact component spans. A candidate marked `requiresCompressionCheck` needs a direct alternative or deletion plan, the information lost, paragraph context and a reason for the choice. Compare exact spans from declared `references`, or explain why references are unavailable. Necessary questions and procedural explanations can retain their clauses. Grammar and source validity alone do not establish natural expression. Choosing an alternative, deletion or an unresolved complement role requires rework. Prepare a new review after the engine update; old records remain unchanged, and the policy and taxonomy versions stay the same.

## Discourse review

For complete revisions, run `prepare-discourse-review --session ...`, save the completed template outside version folders, then run `review-discourse --session ... --review-file ...`. Repeat after editing. Discourse engine 1.0.0 covers every sliding three-sentence window across paragraph and block boundaries, and every adjacent logical paragraph transition. A shorter document uses its available sentences.

Explain each sentence's information gain and the connection a reader can recover. Compare a concrete deletion or merge with the facts or voice it loses. Identify paragraph relationships, distinguish chronology from cause, and state the common basis of comparisons. Mixed relations need a comparison basis or an explicit explanation that no comparison is included. Compare the current order with a different complete paragraph order before choosing. Useful repetition, plain statements, subordinate clauses and nonlinear narration may stay.

Exact ordered coverage, spans and seven bindings are validated. Any explicit local revision need, missing source, missing connection, unresolved choice or preferred alternative keeps the result at `needs-rework`. A recorded result does not certify judgments, independent reading, natural voice or detector effects. Both commands are read-only and leave policy, historical sessions, the linguistic engine and the database unchanged. Source, answer, style and linguistic reviews remain separate.

## Essay quality benchmark

New assessments and version comparisons use `prepare-assessment-review --session ... --essay-type common-app --prompt-status supplied`, then `review-assessment --session ... --review-file ...`. The template includes the original benchmark record, a reader-first account, issue attribution, an advisor's revision target and separate readiness declarations. Accepted optional limitations may coexist with a legacy benchmark rework diagnosis. Neither a score nor a declared acceptance certifies authorship or authorizes submission. Rubric 1.0.0, weights and historical scores remain unchanged.

Run `benchmark` only to read the same rubric 1.0.0. Legacy benchmark prepare/review execution remains for historical replay and dependent adapters; new work uses the Assessment path above. Types are `common-app`, `why-major`, `why-school` and `supplement`; the last requires `--task` describing the actual prompt task. Prompt status is explicitly `supplied`, `unselected` or `missing`. An editorial reference prompt does not establish a selected prompt.

The reader rates six dimensions from 0 to 4, with exact body evidence, reasons, limitations, retention counterexamples and local decisions. Only level 0 or an unrated dimension may use an absence explanation instead of a body anchor. Type weights total 100. The tool converts the supplied ratings into five-point intervals, including the lower bound and excluding the upper bound, except that the final 95-100 interval includes 100. It does not grade text automatically. An unrated dimension or unselected prompt keeps the overall band empty. Levels 0-2 still indicate a material weakness and require rework. Explicit local changes, unresolved items or compliance issues cannot be overridden by a high band or an adopt recommendation. Why School requires declared official sources and check dates for clear school-fact status; their truth is not certified by the program.

Weights are provisional until calibrated against actual advisor ratings. Source, answer, style, linguistic and discourse reviews remain separate. Detection results stay in their own evidence records. All benchmark commands are read-only, preserve historical sessions and policy, and provide no admission probability, authorship certification or submission approval.
