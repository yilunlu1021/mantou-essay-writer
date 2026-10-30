# Changelog

## 2026-10-30 完成结果与审核状态分离

- 已完成的任务直接展示本次正文并提供复制、下载，主状态明确处理完成，审核待修改/未核和检查失败单列。停止转圈、折叠处理过程，切任务默认正文，丢弃旧轮询回包。
- 空结果、已停止、仅审阅原稿和研究记录分别显示，不把审核未通过改成合规通过；旧任务与模型调用记录不改、不重跑。

- Set the per-model job budget to CNY 10 and keep monetary accounting server-side. Remove price and budget fields from browser responses, including historical results and downloadable review records, while retaining source monetary text and existing daily limits.

## 0.4.0-preview.1

- Add an optional employee website with independent logins, document extraction, advisor instructions and fixed GLM/DeepSeek standard API integrations.
- Reuse all seven current SDK review contracts with exact evidence references, bounded model calls, usage accounting and a single repair pass. Missing or failed reviews remain pending; no submission authorization is provided.
- Keep provider keys encrypted server-side and preserve per-user job isolation, idempotent submissions and cancellation. The local-agent CLI remains available separately.
- Resolve exact quoted evidence offsets in code, preserve source boundaries and reject ambiguous or changed quotes. Run rule batches with bounded concurrency, keep logic reasoning within a validated output budget, and allow one known-issue repair when other reviews remain unavailable. Revalidate every new version and retain incomplete states.
- Make the wire schema accept evidence references, return concrete SDK validation hints, and collect complete problem records and current locators for the single repair. Independent reviews precede aggregate process checks; actual execution metadata never certifies meaning. Keep draft/repair reasoning enabled on DeepSeek and cap the workflow at 48 calls.
- Label original-draft diagnosis and drafting-time questions separately from current review results. Model review opinions remain distinct from measured word counts, runtime records and human adoption.
- Retry a normally completed invalid/empty JSON response once within the same two-attempt limit. Preserve every call's known or unknown usage reservation; transport, timeout and incomplete-response failures are not retried.


## 0.3.0-preview.1

- Add a complete prompt, paragraph, bridge and consequential-claim logic review, required by workflow v2. Explicit local failures cannot be overridden by adoption.
- Inventory to locations and repeated helper/opportunity/purpose frames for contextual review; retain legitimate purposes without a new word quota.
- Detect declared material logic gaps inconsistent with related Common App 4/5 ratings; leave contradictory totals empty, preserve declared arithmetic and unrelated ratings. The rubric remains v2.1.
- Add a Chinese first-use guide, inbox/outbox routing and a native Trae alwaysApply entry. Host file and command access remain necessary; actual cross-model quality is unmeasured.
- Upgrade the language policy to 1.22 with explicit authorization to replace the basic-statement quota, adjacent-SVO ban and blanket finite-clause connection ban with contextual review. Preserve all other prohibitions and historical records.

## 0.2.0-preview.1

- Add executable rule cards, per-unit evidence and detail checks, and full ordered grammar candidate inventories for English and mixed-language application drafts.
- Add prepare-workflow/check-workflow to revalidate six raw review records and mechanical error totals for the current version. Missing, stale or explicitly failed checks cannot become ready for human review.
- Preserve policy 1.21, originals and historical reviews. Grammar categories and atomic obligation coverage remain reviewer judgments, and complete records never authorize submission.
- Add synthetic boundary regressions and a coding-agent workflow guide. Actual cross-model compliance and prose quality remain unmeasured.

## 0.1.0-preview.1

- Bundled local CLI and SDK, with all 55 language policy groups and source documents.
- UTF-8 TXT/Markdown and paragraph-only DOCX import, prompt and body export to Word.
- Original snapshots, immutable versions, precise patches, stale-input checks and writer recovery.
- Read-only diagnostics, help, schema, examples and an end-to-end synthetic demo.
- Native Windows, macOS and Linux CI for Node 22 and 24.

Semantic quality, author voice, factual verification and external delivery remain human responsibilities. The release makes no AI detection claims.
