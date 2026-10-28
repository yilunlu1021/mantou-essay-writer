# 用 coding agent 执行文字规则

这一版由你的现成agent读取和修改文字，本地工具核对版本、记录、候选覆盖、数量及明确失败。全部适用规则继续执行。实际语法分类、事实和作者声音需要复核，完整记录不等于判断正确。

## 开始使用

把项目目录交给能读取文件、调用本地命令的agent，告诉它：

> 先读AGENTS.md、WORKFLOW.md和当前完整规则。按题目导入原稿，运行prepare-workflow。分轮检查来源、句法和内容，用版本补丁返修。最后运行check-workflow，交正文和准确的未解项。

发行包已带运行依赖。先运行README里的doctor与demo。原稿、题目、会话、检查文件都放在Git之外。GitHub保存工具、政策和合成测试。

## 每篇的流程

1. 按README的import导入原稿，固定题目、语言、体裁、长度及修改范围。
2. 运行prepare-workflow，读取步骤和ruleReview里的全部适用规则卡、候选及未核模板。
3. 先诊断整篇与来源，再用原有prepare/revise提交准确补丁。每次修改都生成新版本。
4. 针对当前全文完成规则复核，分别检查过程/来源、句法及内容。一个编号单元含多个义务时，details须分别记录。不能用总PASS代替子项。
5. 用原有prepare-source/answer/style/linguistic/discourse-review生成模板，完成后分别运行对应review命令。
6. 把六份完整复核输入装入工作流模板的reviews字段。使用原始记录，不能填命令返回的摘要。没有外部参考/检测证据时evidence保持null。
7. 运行check-workflow。待返修项通过新的补丁处理，正文改变后重新生成当前版本的全部记录。反复修复仍无法解决时，保留具体失败和来源缺口。

命令示例，路径按本次实际文件替换：

```sh
node bin/essay.mjs prepare-workflow --session "my essay"
node bin/essay.mjs prepare-rule-review --session "my essay"
node bin/essay.mjs review-rules --session "my essay" --review-file "rules.json"
node bin/essay.mjs check-workflow --session "my essay" --review-file "workflow.json"
```

命令把JSON输出到终端。agent可使用自己的文件工具保存prepare结果与其中的template，保存位置必须在不可变版本目录之外。rules.json最多8MB，workflow.json最多20MB。schema命令提供两种完整格式。

## 检查记录

每个适用核对单元保留checkId和requirementHash，填写status、reason、evidence、authority及details。状态为PASS、FAIL、UNVERIFIED、NOT_APPLICABLE或EXEMPT。证据引用当前正文、原稿的精确Unicode codepoint范围，或说明实际过程。N/A须说明适用条件，例外须给明确依据。缺证据、缺子项或空理由保持未核。程序不认证N/A、例外和自由文本理由的真实性，也不证明所有原子义务已拆全。

英文及混合语言的学生申请文书另外覆盖整篇句子、ing后缀、some系列和a/an候选。后缀命中不代表禁用词。逐处判断真实进行时、词形排除或禁止用途，每句列出名词性从句和基本陈述的准确范围。程序按声明核对两个150词上限、100词数量与间距、跨段相邻SVO，以及明确标出的禁止结构。不能用be前缀冒充时体判断，也不能靠不列从句/基本陈述隐去实际结构。

execution中的供应商、模型及设置只记录确实可见的信息。未知保持null，程序不验证后台身份。分轮审阅由agent执行，工具本身不调用模型。

## 结果怎么读

| workflowStatus | 含义与下一步 |
| --- | --- |
| needs-rework | 机器错误或某份记录存在明确待改，保留问题并返修。退出码2。 |
| needs-review | 缺记录、缺证据、未解判断或结果截断，继续复核。退出码3。 |
| ready-for-human-review | 六类记录已验证且无已知阻塞，交本人/顾问通读。退出码仍为3。 |

deliveryAuthorized始终false。现有status/audit继续报告其机械与人工待核状态，check-workflow单独汇总复核。原有working-draft.docx仍可用于内部审阅，不能凭文件已生成称合规或正式采用。正式评分、本人确认与提交独立执行。

## 怎样验证改进

运行pnpm check会检查合成反例、记录缺项、错误总数、过期绑定及导出首跑。它验证工程合同，不证明实际模型遵守率。对比指令或模型时固定材料、题目和设置，保留真实模型信息与失败，分别比较共有规则、新增规则、事实/声音及盲评偏好。未运行的模型实验保持未测。
