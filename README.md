# Mantou Essay Writer

A local writing tool for your existing agent. It prepares writing rules, checks a draft, validates small edits and exports a versioned Word document. It supports Chinese, English and mixed text, with separate rules for academic work, personal narratives, application explanations and advisor feedback.

This preview includes 55 policy groups. Mechanical findings are checked by code. Facts, reasoning, author voice and context-dependent language still need human review. The tool does not predict AI detector scores or approve an essay for submission.

## Start on Windows or macOS

1. Download the release ZIP, or use GitHub **Code → Download ZIP**, and extract it.
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

Use `--role advisor --genre advisor-feedback --channel wechat --stage material` for early WeChat feedback. All rules and their scope are in [language standards](policy/language-standards.md) and [writing collaboration rules](policy/collaboration-writing.md). Semantic rules remain visible in review even when they cannot be checked automatically. This release uses the bundled policy. Task-specific exceptions require human review and do not silently suppress machine findings.

For an English clean draft, supply the verified official limit, for example `--stage clean-draft --max 650`. The default minimum is then 630 words. Explicit `--min` and `--unit` override the length settings. The tool counts English words, Han characters or non-whitespace codepoints. It does not verify an institution's limit. Never invent facts or add filler to reach a target.

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
