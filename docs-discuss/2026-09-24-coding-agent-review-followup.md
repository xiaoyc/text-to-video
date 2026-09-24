# 2026-09-24 Coding Agent 评审意见复核：Observability / Cache / Asset State

- 日期：2026-09-24
- Repo：`xiaoyc/text-to-video`
- 复核对象：`docs-discuss/2026-09-24-625495e-review.md`
- Coding Agent Review Commit：`f1eb1650ba3a6e6be032af86160b571d0ed78765`
- 被评审实现：`625495e2985eb5a63fee6a7b4c373b3885f73e2c`

---

## 1. 复核结论

Coding Agent 提出的 3 个问题都成立。

建议优先级：

1. **立即修：debug-asset 在 cache entry 缺失时误报 healthy**
2. **立即修：rerun 生成失败没有结构化失败事件**
3. **一起修：asset-state 需要基于图片内容 hash 判断版本变化**

这三个问题都属于：

- 可观测性
- 状态准确性
- cache 行为一致性

不是主工作流架构错误，不需要重新设计 pipeline，也不影响既定 dry-run 方案。

---

# 2. [P1] Cache Entry 缺失时 debug-asset 可能误判 healthy

位置：

```text
src/pipeline/debug.ts
```

当前逻辑只在：

```text
cacheEntry exists
AND
(hash mismatch OR image missing)
```

时把问题归类为：

```text
suspectedLayer: cache
```

但如果：

- active asset 存在
- Vision accepted
- motion compatible
- cache entry 整个不存在

当前代码会继续进入 healthy 分支。

结果：

```text
debug-asset
→ healthy
```

但下一次 normal run：

```text
asset-cache lookup
→ miss
→ image provider 再次生成
```

这会直接影响：

- image quota
- 快速迭代
- debug 准确性

---

## 建议修法

对：

```text
provider != manual
```

的 active asset：

如果：

```text
cacheEntry == missing
```

则：

```text
suspectedLayer = cache
```

并给出类似：

```text
evidence:
- active generated asset has no reusable cache entry

recommendedSourceFix:
Refresh/rebuild the cache entry from the accepted active asset.
Do not regenerate the image unless the active asset itself is invalid.
```

---

## Manual Asset 例外

如果：

```text
provider == manual
```

则没有 cache entry 可以视为正常。

不要把：

```text
manual import
```

强制要求进入 image cache。

---

# 3. [P1] rerun 生成失败没有结构化失败事件

位置：

```text
src/pipeline/rerun.ts
```

影响：

- `rerunAsset`
- `rerunShot`

当前流程：

```text
log rerun start
↓
generateOneAsset()
↓
throws
↓
CLI prints error
```

问题是：

```text
run-events.jsonl
```

里只有：

```text
asset.user-rerun
```

或：

```text
shot.user-rerun
```

没有：

```text
asset.generation-failed
```

导致无法仅靠结构化日志判断：

- provider error
- output file missing
- command failure
- generation exception

---

## 建议修法

不要在：

- rerunAsset
- rerunShot

分别复制 try/catch。

建议抽一个 helper，例如：

```ts
generateCandidateWithLogging(...)
```

职责：

```text
generation-start
↓
generateOneAsset
↓
success -> candidate-generated
↓
failure -> generation-failed
           + assetId
           + shotId
           + error
           + attempt
           + retry hints
           -> rethrow
```

这样 normal run 和 rerun 后续也更容易统一。

---

## 失败事件建议

例如：

```json
{
  "stage": "asset",
  "type": "asset.generation-failed",
  "assetId": "asset-0001",
  "shotId": "shot-001",
  "message": "replacement candidate generation failed",
  "data": {
    "attempt": 2,
    "error": "provider exited with code 1"
  }
}
```

---

# 4. [P2] asset-state 按路径判断图片变化不够可靠

位置：

```text
src/assets/state.ts
```

当前：

```ts
changed =
  !old
  || old.requestHash !== requestHash
  || old.activeImagePath !== asset.imagePath
```

问题：

如果：

```text
same path
same request
different image bytes
```

例如：

```text
assets/asset-0001.png
```

被覆盖，

则：

```text
version 不增加
lastChangeReason 不更新
```

资产账本会漏记实际图片变化。

---

## 影响场景

最明显的是：

- manual import
- 固定输出路径 provider
- 本地测试时覆盖同名图片
- 用户手工替换图片文件

这与：

```text
asset-state.json = active asset/version ledger
```

的职责不一致。

---

## 建议修法

给 `ActiveAssetState` 增加：

```ts
contentHash: string
```

例如：

```text
sha256(image bytes)
```

版本判断改成：

```ts
changed =
  !old
  || old.requestHash !== requestHash
  || old.activeImagePath !== asset.imagePath
  || old.contentHash !== currentContentHash
```

这样：

```text
同路径覆盖
```

也会正确产生：

```text
version += 1
```

---

## 性能判断

当前项目图片数量不大。

相对于：

- image generation
- Vision
- render

读取本地图片并做 SHA256 的成本可以忽略。

不需要为了这点做复杂优化。

---

# 5. Coding Agent 的评审基线存在问题

Coding Agent 文档中写道：

> `docs-discuss/2026-09-24-dry-run-precut-plan.md` 在评审时不在工作树或当前 Git 历史中。

这个判断在当前 main 上不成立。

该文档已经在：

```text
235eb3a16337bd730caa6744082e77cb99cda9e5
```

提交。

而 Coding Agent 自己的 review commit：

```text
f1eb1650ba3a6e6be032af86160b571d0ed78765
```

在其之后。

说明 Coding Agent review 时很可能：

- 没有同步最新 main
- checkout 了旧 HEAD
- 或在 stale worktree 上执行

---

# 6. 后续 Coding Agent Review 要求

以后每次 review 前建议强制：

```text
1. fetch/pull latest main
2. print HEAD SHA
3. print target plan/document existence
4. confirm review target SHA
5. then review
```

至少在 review 文档开头记录：

```text
Review HEAD:
Target Commit:
Plan Document:
Plan Document Exists: yes/no
```

否则容易出现：

> 代码问题判断本身没错，但基于旧仓库状态给出过时结论。

---

# 7. 与 Dry Run 实现的关系

这三个修复建议：

```text
cache diagnosis
generation failure logging
asset content versioning
```

都应该在 dry-run 实现前或同时完成。

原因：

dry-run 之后正式 run 会更依赖：

- Plan Cache
- Image Cache
- run-events
- active asset state

如果 observability/state 本身不准确，会增加后续调试成本。

---

# 8. 推荐执行顺序

建议 Coding Agent：

## Step 1

修：

```text
debug.ts
```

让：

```text
generated asset + missing cache entry
```

明确报告 cache 问题。

---

## Step 2

抽统一：

```text
generateCandidateWithLogging
```

修：

- rerunAsset
- rerunShot

generation failure structured events。

---

## Step 3

修：

```text
asset-state
```

增加：

```text
contentHash
```

并以 image bytes hash 判断版本变化。

---

## Step 4

补测试：

### Missing cache entry

断言：

```text
suspectedLayer == cache
```

而不是：

```text
healthy
```

### Rerun generation failure

fake provider throws。

断言：

```text
run-events.jsonl
```

包含：

```text
asset.generation-failed
```

且 active state 未变化。

### Same path / new bytes

覆盖同一路径图片。

断言：

```text
asset version increments
contentHash changes
lastChangeReason updates
```

---

# 9. Scope 控制

本轮不要因为这些 review findings 引入：

- event bus
- generic workflow engine
- database
- persistent state server
- complex cache abstraction
- artifact registry service

继续保持：

> 小而明确的 deterministic helpers + 文件状态。

---

# 10. 最终结论

Coding Agent 的三个技术问题：

```text
1. missing cache entry debug false healthy
2. rerun failure missing structured event
3. same-path image overwrite not reflected in version ledger
```

全部值得修。

优先级：

```text
1 = 必须修
2 = 必须修
3 = 建议一起修
```

同时 Coding Agent 必须修正自己的 review 基线流程：

> 后续 review 先同步 main，再确认 HEAD / target commit / plan document，避免 stale worktree 导致错误上下文。
