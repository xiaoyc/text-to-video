# 2026-09-24 Dry Run 预剪辑草案与 Plan Cache 实现方案

- 日期：2026-09-24
- Repo：`xiaoyc/text-to-video`
- 目标：支持 `run --dry-run`，先快速生成可读的剪辑草案，不生图、不跑 Vision、不 Render；正式 `run` 时如果输入未变化，自动复用 dry-run 产物，直接从 Asset 阶段继续。
- 原则：**快速出草案、快速 review、正式生成时复用已确认的导演结果，不重复消耗 LLM / image quota。**
- Scope：只实现 dry-run、precut draft、plan cache 复用与相关测试；不扩展成复杂 workflow engine。

---

## 1. 需求背景

当前工作流已经支持：

```text
Script
→ Director
→ Validate
→ Prompt Compile
→ Image
→ Vision
→ Grounding
→ Motion
→ Preview
→ Precut Summary
→ Lock
→ TTS
→ Render
```

并且已经有：

- image cache
- single asset rerun
- shot rerun
- run-events.jsonl
- asset-state.json
- debug-asset
- precut-summary.md/json

但现在如果用户只是想先看“导演准备怎么剪”，仍然需要走到素材阶段。

希望增加：

```text
run --dry-run
```

让用户先得到一份：

> “如果正式做，这篇文章会被剪成哪些镜头、每个镜头讲什么、主体是什么、预计怎么运镜、需要什么图、会显示什么文字”

并且这个 dry-run 结果在正式 run 时可以复用。

---

# 2. 核心语义

## 2.1 dry run

命令：

```bash
npm run dev -- run \
  --script article.md \
  --out data/my-run \
  --text-command "./my-text-provider" \
  --dry-run
```

只执行：

```text
Script
→ Director
→ Validator
→ Prompt Compiler
→ Precut Draft
→ Exit
```

必须明确 **不执行**：

- Image generation
- Image cache materialization
- Vision review
- Grounding
- Motion resolution from real image
- Preview render
- TTS
- HyperFrames render

因此 dry-run 不消耗 image quota。

---

## 2.2 正式 run

不带：

```text
--dry-run
```

时执行正式工作流。

但正式 run 启动后，应该优先检查：

```text
是否存在可复用的 dry-run plan
```

如果：

- script 未变化
- style 未变化
- aspect ratio 未变化
- Director 输入版本未变化
- prompt compiler contract/version 未变化

则直接复用：

- `director.json`
- `director-findings.json`
- `asset-requests.json`
- `prompts/*.md`

然后从：

```text
ASSET
```

阶段继续。

不要再次调用 Director。

---

# 3. 用户体验

## 3.1 第一次：dry run

```bash
npm run dev -- run \
  --script article.md \
  --out data/my-run \
  --text-command "./my-text-provider" \
  --dry-run
```

输出：

```text
director.json
director-findings.json
asset-requests.json
prompts/*.md
dry-run-state.json
precut-draft.md
precut-draft.json
run-events.jsonl
```

用户只需要看：

```text
precut-draft.md
```

---

## 3.2 草案确认后正式生成

```bash
npm run dev -- run \
  --script article.md \
  --out data/my-run \
  --text-command "./my-text-provider" \
  --image-command "./my-image-provider" \
  --vision-command "./my-vision-provider"
```

如果 dry-run fingerprint 一致：

```text
[plan] dry-run cache hit
[director] reused cached director plan
[prompt] reused cached asset requests
[asset] ...
```

直接开始生图。

---

## 3.3 如果文章被修改

如果：

```text
article.md
```

内容变化，则 fingerprint 不一致：

```text
[plan] dry-run cache miss: script changed
[director] generating new plan
```

重新跑 Director。

不能错误复用旧剪辑草案。

---

# 4. 输出文件设计

## 4.1 dry-run-state.json

建议：

```json
{
  "version": 1,
  "mode": "dry-run",
  "inputFingerprint": "sha256:...",
  "scriptHash": "sha256:...",
  "style": "cinematic historical realism",
  "aspectRatio": "16:9",
  "directorContractVersion": 1,
  "promptCompilerVersion": 1,
  "directorHash": "sha256:...",
  "assetRequestHash": "sha256:...",
  "shotCount": 8,
  "assetRequestCount": 10,
  "generatedAt": "2026-09-24T..."
}
```

这个文件不是业务数据，而是：

> “当前目录下这份 Director / prompts 是否可以安全复用”的 cache manifest。

---

# 5. Fingerprint 设计

新增 helper，例如：

```text
src/runtime/input-fingerprint.ts
```

计算：

```text
SHA256(
  script
  + style
  + aspectRatio
  + directorContractVersion
  + promptCompilerVersion
)
```

第一版不要把太多 runtime 细节放进去。

但必须覆盖：

- script
- style
- aspectRatio
- Director schema/contract version
- Prompt compiler version

因为：

> 代码升级后，即使文章没变，也可能不能继续复用旧 plan。

---

# 6. Plan Cache

建议把 dry-run 产物视为：

```text
Plan Cache
```

与当前已有的：

```text
Image Cache
```

明确分开。

---

## 6.1 Plan Cache

负责：

```text
Script
→ Director
→ Prompts
```

缓存：

- director.json
- director-findings.json
- asset-requests.json
- prompts/*.md
- dry-run-state.json

---

## 6.2 Image Cache

现有：

- asset-cache.json
- generated image files

负责：

```text
AssetRequest
→ accepted image
```

因此整体：

```text
Script
 │
 ▼
Plan Cache
 │
 ▼
AssetRequest
 │
 ▼
Image Cache
 │
 ▼
Vision / Motion / Preview
```

不要把两种 cache 混在一起。

---

# 7. Precut Draft

新增：

```text
precut-draft.md
precut-draft.json
```

注意它和现有：

```text
precut-summary.md
precut-summary.json
```

语义不同。

---

## 7.1 precut-draft

表示：

> **没有真实图片参与的导演剪辑草案**

它来源于：

- DirectorPackage
- AssetRequest[]

没有：

- Vision
- Grounding
- actual resolved motion
- cache result
- asset version

---

## 7.2 precut-summary

现有文件继续表示：

> **真实图片落地后的当前执行状态**

来源包括：

- Director
- Asset
- Vision
- Motion
- Cache
- Asset State

---

## 7.3 明确区分

```text
precut-draft.md
= 我打算怎么剪

precut-summary.md
= 现在实际上会怎么剪
```

这个语义不要混。

---

# 8. precut-draft.md 建议格式

例如：

```md
# Dry Run Precut

> 导演剪辑草案。尚未生成真实图片，也未经过 Vision / Grounding / Motion 验证。

- 镜头总数：8
- 预计总时长：42.0s
- 预计图片数：10
- Director Calls：1
- 状态：Draft

## 1. shot-001 — 3.0s
- 作用：开场钩子
- 叙事：周迪拿着铜钱来到扬州城门前。
- 主体：周迪手中的铜钱
- 辅助主体：周迪的手、门栓、守兵靴子
- 构图：极近景保留手和少量城门环境 → 铜钱更强特写
- 运镜意图：缓慢推近铜钱
- 预计显示：1 张主图（primary）
- 文字：底部解说字幕
- 生图 Prompt：prompts/asset-0001.md
- 状态：Draft / 尚未经过真实素材验证

## 2. shot-002 — 3.2s
...
```

用户要能快速判断：

- 镜头是否切得合理
- 主体是否正确
- 镜头是否太长
- 预计多少图片
- 运镜方向
- 文字显示
- Prompt 是否已经准备好

---

# 9. precut-draft.json

建议结构：

```json
{
  "version": 1,
  "generatedAt": "...",
  "overview": {
    "shotCount": 8,
    "totalDurationMs": 42000,
    "assetRequestCount": 10
  },
  "shots": [
    {
      "shotId": "shot-001",
      "beatId": "beat-001",
      "purpose": "hook",
      "durationMs": 3000,
      "narrativeSummary": "...",
      "primarySubject": "...",
      "secondarySubjects": ["..."],
      "compositionSummary": "...",
      "motionIntentSummary": "...",
      "expectedAssets": [
        {
          "assetId": "asset-0001",
          "role": "primary",
          "promptFile": "prompts/asset-0001.md"
        }
      ],
      "textSummary": "...",
      "status": "draft"
    }
  ]
}
```

---

# 10. 文件结构建议

新增：

```text
src/pipeline/dry-run.ts
src/pipeline/precut-draft.ts
src/runtime/input-fingerprint.ts
tests/dry-run.test.ts
```

可选：

```text
src/runtime/plan-cache.ts
```

如果逻辑很小，可以放在：

```text
dry-run.ts
```

避免过度拆分。

---

# 11. run.ts 调整

当前：

```text
runPipeline()
```

直接：

```text
Director
→ Compile
→ Asset
→ Vision
...
```

建议拆出一个轻量的：

```text
preparePlan()
```

例如：

```ts
preparePlan(options)
  -> {
       pkg,
       findings,
       requests,
       source: 'generated' | 'dry-run-cache'
     }
```

正式流程：

```text
preparePlan()
→ Asset
→ Vision
→ Motion
→ Preview
```

dry-run：

```text
preparePlan(forceGenerate=true)
→ writePrecutDraft()
→ exit
```

这样不要维护两套 Director 逻辑。

---

# 12. 推荐代码结构

建议：

```text
runPipeline()
  │
  ├─ preparePlan()
  │   ├─ check reusable dry-run plan
  │   ├─ or run Director
  │   ├─ validate
  │   ├─ compile prompts
  │   └─ write plan artifacts
  │
  ├─ if dryRun
  │   ├─ write precut-draft
  │   ├─ write dry-run-state
  │   └─ return
  │
  └─ continueFullPipeline()
      ├─ image
      ├─ vision
      ├─ motion
      ├─ preview
      └─ precut-summary
```

---

# 13. CLI 行为

在现有：

```text
run
```

命令增加：

```text
--dry-run
```

例如：

```bash
npm run dev -- run \
  --script article.md \
  --out data/run \
  --text-command "./my-text-provider" \
  --dry-run
```

---

## 13.1 dry-run 下 image/vision 参数

允许用户不传：

```text
--image-command
--vision-command
```

不能因为没这些参数而报错。

---

## 13.2 正式 run

正式 run 仍要求：

- image provider / images dir
- vision provider / supplied reviews

但如果 asset 全部来自有效 image cache，可以继续允许没有 image provider。

保留现有行为。

---

# 14. 可选参数

第一版建议支持：

## --dry-run

生成草案并停止。

## --force-director

即使 dry-run fingerprint 命中，也强制重新调用 Director。

这个参数很有用：

```bash
npm run dev -- run ... --force-director
```

适用于：

> “文章没变，但我就是想让 Director 重新想一遍。”

---

# 15. 不建议增加 --resume

不要再增加：

```text
--resume
```

因为正式 run 默认就应该：

> 自动复用可安全复用的东西。

缓存命中是正常行为，不需要用户额外指定。

---

# 16. Dry Run Cache 命中规则

正式 run 前检查：

```text
dry-run-state.json exists
director.json exists
asset-requests.json exists
prompts directory exists
```

然后：

```text
current fingerprint == saved fingerprint
```

才复用。

---

## 16.1 Cache Hit

日志：

```text
[plan] dry-run cache hit
[director] reused director.json
[prompt] reused asset-requests.json
```

---

## 16.2 Cache Miss

日志必须说明原因，例如：

```text
[plan] cache miss: script changed
```

或：

```text
[plan] cache miss: prompt compiler version changed
```

方便调试。

---

# 17. 不能只按文件存在判断

错误做法：

```ts
if (existsSync('director.json')) {
  reuse
}
```

必须有 fingerprint。

否则：

- 文章换了
- style 换了
- aspect ratio 换了

还会复用旧 Director。

这是必须避免的。

---

# 18. Prompt 文件一致性

如果 plan cache 命中：

```text
asset-requests.json
prompts/*.md
```

应该作为同一个 plan artifact 集合复用。

正式 run 不要又重新 compile prompt。

否则可能出现：

```text
Director from cache
Prompt from new compiler
dry-run-state still claims old plan
```

破坏可追踪性。

---

# 19. 与现有 Image Cache 的协作

正式 run：

```text
Plan Cache Hit
↓
Asset Requests
↓
Image Cache
```

如果：

```text
asset-0001
asset-0002
asset-0003
```

其中：

- 0001 hit
- 0002 hit
- 0003 miss

则只生成：

```text
asset-0003
```

这也是最终期望。

---

# 20. 与 rerun-asset 的协作

```text
rerun-asset
```

只修改：

- image candidate
- Vision
- Grounding
- Motion
- Asset State
- Image Cache
- precut-summary

**不要修改 dry-run-state。**

因为 dry-run-state 描述的是：

```text
Plan
```

不是实际图片。

---

# 21. 与 rerun-shot 的协作

同理：

```text
rerun-shot
```

不应使 Plan Cache 失效。

它只是重新 materialize 某些 AssetRequest。

---

# 22. 与 prompt 修改的协作

如果用户手动修改：

```text
prompts/asset-0001.md
```

当前系统需要明确一个原则：

第一版建议：

> prompt md 是输出视图，不是 source of truth。

source of truth 仍然是：

```text
asset-requests.json
```

如果未来要支持用户手工编辑 prompt，再单独设计：

```text
prompt override
```

本轮不要混进来。

---

# 23. 与 precut-summary 的关系

流程：

```text
run --dry-run
→ precut-draft.md

run
→ precut-summary.md
```

如果正式 run 使用的是 dry-run cache：

```text
precut-draft
```

继续保留。

这样用户可以对比：

```text
原计划
vs
真实落地
```

这对后续调 Director 非常有价值。

---

# 24. 建议加入差异可观察性

第一版不必做复杂 diff UI，但正式 run 时可以在日志里写：

```text
[precut] draft plan reused
[precut] actual summary generated
```

未来可考虑：

```text
precut-diff.md
```

但不属于本轮 scope。

---

# 25. 测试计划

## 25.1 dry run 不调用 Image/Vision

测试：

```text
run --dry-run
```

断言：

- text model = 1 call
- image provider = 0 calls
- vision provider = 0 calls
- no preview required
- no assets.json required
- precut-draft.md exists
- dry-run-state.json exists

---

## 25.2 正式 run 复用 dry-run plan

先：

```text
dry run
```

再同输入：

```text
full run
```

断言：

- 第二次 text model = 0 calls
- Director reused
- Asset stage 正常执行

---

## 25.3 script 变化会 invalidate

dry run 后修改 script。

正式 run：

- text model 必须再次调用
- 新 fingerprint
- 新 director.json

---

## 25.4 style 变化会 invalidate

同理。

---

## 25.5 aspect ratio 变化会 invalidate

同理。

---

## 25.6 --force-director

即使 fingerprint 命中：

```text
--force-director
```

也必须重新调用 Director。

---

## 25.7 image cache 继续生效

dry run：

```text
Plan Cache
```

正式 run 后：

```text
Image Cache
```

第三次 full run：

- Director 0 call
- Image 0 call（如果全部 cache hit）
- Vision 当前是否复用依现有设计，不在本轮强行增加 Vision cache

---

## 25.8 dry run 草案字段

至少断言：

- shot count
- total duration
- narrative
- subject
- motion intent
- expected assets
- text summary

---

# 26. Run Metrics

建议补充：

```json
{
  "plan": {
    "source": "generated | dry-run-cache",
    "cacheHit": true
  }
}
```

如果暂时不想改 `RunMetrics` contract，也可以只记录：

```text
run-events.jsonl
```

第一版优先保证功能，不强制改 metrics schema。

---

# 27. run-events.jsonl

建议新增事件：

```text
plan.cache-hit
plan.cache-miss
plan.generated
dry-run.complete
precut.draft-written
```

例如：

```json
{
  "stage": "plan",
  "type": "plan.cache-hit",
  "message": "reused matching dry-run plan"
}
```

---

# 28. AGENTS.md 增加 invariant

建议增加：

> Dry run is a first-class planning mode. It must stop before image/Vision work, persist a reusable fingerprinted plan, and full run should reuse that plan when safe instead of rerunning the Director.

以及：

> Plan cache and image cache are separate concerns.

---

# 29. README 更新

增加：

## Dry run

```bash
npm run dev -- run \
  --script article.md \
  --out data/my-run \
  --text-command "./my-text-provider" \
  --dry-run
```

说明：

- no image generation
- no Vision
- outputs precut-draft
- full run reuses it automatically if input unchanged

---

# 30. 推荐实施批次

## Batch A — Fingerprint / Plan Cache

新增：

- input-fingerprint.ts
- dry-run-state contract
- plan cache validation

## Batch B — Precut Draft

新增：

- precut-draft.ts
- md/json writer
- tests

## Batch C — run --dry-run

CLI：

- parse --dry-run
- skip asset/vision
- write dry-run state
- exit success

## Batch D — Full Run Reuse

正式 run：

- detect matching dry-run-state
- reuse director/requests
- skip Director call
- continue ASSET

## Batch E — Tests / Docs / Observability

- run-events
- README
- AGENTS
- integration tests

---

# 31. 明确不做

本轮不要加入：

- prompt manual editor
- workflow DAG engine
- resume checkpoint engine
- Vision cache
- complex plan version history
- web dashboard
- precut diff UI
- automatic approval workflow

只做：

```text
dry-run
+
precut draft
+
safe plan reuse
```

---

# 32. 完成标准

完成后必须满足：

- 用户输入文章后可以 `run --dry-run`
- dry-run 只调用 Director，不调用 Image/Vision
- 自动生成 `precut-draft.md/json`
- 草案自然语言可快速理解镜头、主体、构图、运动、显示、文字
- 保存 `dry-run-state.json`
- 正式 run 同输入时自动复用 dry-run plan
- 不重新调用 Director
- 正式 run 继续使用现有 image cache
- script/style/aspect ratio/contract 变化时 plan cache 自动失效
- `--force-director` 可强制重新规划
- rerun-asset / rerun-shot 不使 plan cache 失效
- precut-draft 和 precut-summary 语义明确分离
- CI / `npm run check` 通过

---

# 33. 最终工作流

最终期望：

```text
Article
  │
  ├─ run --dry-run
  │    │
  │    ├─ Director
  │    ├─ Validate
  │    ├─ Prompt Compile
  │    ├─ precut-draft.md
  │    └─ Plan Cache
  │
  └─ run
       │
       ├─ reuse Plan Cache
       │
       ├─ Image Cache
       │
       ├─ Image Generation
       │
       ├─ Vision / Grounding
       │
       ├─ Motion
       │
       ├─ Preview
       │
       └─ precut-summary.md
```

这套设计的核心是：

> **先用 dry run 快速看导演剪辑草案；确认后正式 run 不重复规划，直接进入素材阶段；之后再利用 image cache 和局部 rerun 快速迭代。**
