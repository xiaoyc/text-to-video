# 2026-09-24 从 video-factory 迁移导演能力到 text-to-video

- 日期：2026-09-24
- Repo：`xiaoyc/text-to-video`
- 参考源：`xiaoyc/video-factory@feat/v1-enhanced-auto-director`
- 背景：周迪文章 dry-run 出现约 160 秒仅 2 个镜头、单镜头 50s/58s、Director Calls=2 的异常，说明当前 Director/repair/validator 缺少全局覆盖和视觉节奏约束。
- 原则：**迁导演语法、质量门和局部修复约束，不迁旧项目的多 Planner / Reviewer orchestration。**

---

## 1. 本次迁移目标

保持 text-to-video 当前主架构：

```text
DIRECT
→ VALIDATE
→ ASSET
→ GROUND
→ RESOLVE
→ RENDER
```

仍然坚持：

- 正常规划只做一次 Director LLM call
- 有 blocking finding 时最多一次 repair call
- renderer 不重新做导演决策
- prompt compiler / motion / cache / preview 继续 deterministic
- dry-run 在生图前暴露导演问题

本次只强化 DIRECT / VALIDATE 的表达能力。

---

# 2. 从 video-factory 迁哪些

参考：

- `.agents/skills/historical-explainer-director/references/cold-open.md`
- `.agents/skills/historical-explainer-director/references/director-playbook.md`
- `docs/discuss/2026-09-22-source-driven-director-and-visual-idle-window.md`
- `docs-discuss/2026-09-22-short-video-attention-camera-rhythm.md`
- `src/director/attention-planner.ts`
- `src/director/shot-templates.ts`
- `src/director/visual-rhythm-replan.ts`

迁移能力：

1. Attention / Hook 语义
2. Narrative Beat 类型
3. 精简 Shot Template catalog
4. Visual idle window
5. Visual events / overlay 作为导演一等语义
6. Motion envelope 语义
7. Repair preservation guard
8. 全局 timeline / beat coverage validator

---

# 3. 不迁哪些

明确不迁：

- 多个独立 Attention Planner / Hook Reviewer / Camera Rhythm Reviewer LLM call
- 多层 replan orchestration
- 旧 video-factory provider/retrieval/WeMM/TV 素材体系
- keyword → template / keyword → effect 创意 hardcode
- renderer 重新阅读 narration 后做导演判断
- fixed 58% / 72% reveal 等创意 timing hardcode
- 复杂 workflow engine

所有语义尽量由单 Director 一次返回。

---

# 4. P0：先解决周迪当前失败

## 4.1 Timeline coverage

Validator 必须阻止：

```text
总时间 160s
但第一镜从 52s 才开始
```

必须检查：

- first shot starts at 0
- shot array 按时间连续
- no gap
- no overlap
- end/start/duration 一致

---

## 4.2 Beat coverage

每个 NarrativeBeat 至少必须有一个 DirectorShot。

避免：

```text
repair 后保留 beats
但删掉对应 shots
```

仍然通过。

---

## 4.3 Visual idle window

不再使用：

```text
shot.duration > 6500
AND assetStates.length > 1
=> pass
```

因为：

```text
50s + before/after
```

仍然可以造成几十秒视觉空窗。

改为计算：

```text
shot-start
+ internal beats
+ reveal
+ informational/structural visual events
+ overlay enter/update
+ shot-end
```

之间的最长间隔。

默认：

- 普通镜头：最长 meaningful idle <= 5s
- readable card：最长 meaningful idle <= 7s

粒子、微推、ambient movement 不能伪装成 meaningful visual refresh。

---

## 4.4 Repair preservation

当前 repair 会重写整个 DirectorPackage。

新增 deterministic guard：

- repair 前合法、且不属于 blocking finding 影响范围的 beat 不允许消失
- unaffected shot 不允许被无故删除
- script/style/aspectRatio 不允许改变
- repair 后仍必须重新跑 timeline / beat coverage / visual rhythm validator

如果 repair 丢镜头：

```text
fail closed
```

不能继续生图。

---

# 5. P1：Attention / Hook

把 video-factory 的 Attention Plan 语义并入当前单 Director contract。

开头 5–12s 应描述：

- pattern interrupt
- curiosity question
- partial payoff
- context transition
- energy curve

允许策略：

- visual-contradiction
- scale-shock
- extreme-detail
- question-gap
- before-after
- identity-withhold
- spatial-reveal
- value-reversal
- silence-freeze

要求：

- Hook 必须来自原文真实叙事
- 不制造 clickbait
- 不要求高频切镜
- 异常物件、局部、尺度、身份延迟、空间揭示都可以作为 hook

周迪类文章优先允许：

```text
异常铜钱/肉铺线索
→ 守兵追问
→ partial payoff
→ 再交代扬州背景
```

而不是先从城市百科式背景开始。

---

# 6. P1：Narrative Beat taxonomy

Beat 可带类型：

- hook
- setup
- tension
- suspense
- contrast
- reveal
- turn
- emotion-peak
- aftermath
- transition

Beat 仍是叙事意群，不按标点机械切。

一个 beat 可对应 1..N shot。

---

# 7. P1：精简 Shot Template catalog

迁移为 Director 的候选导演语法：

- historical-still
- low-angle-reveal
- portrait-identity
- relationship-reveal
- document-insert
- character-card
- citation-card
- chapter-card
- micro-action

模板只定义：

- 适用叙事意图
- 推荐 motion / framing / asset strategy 语义

模板不是 renderer hardcode，也不能靠关键词自动选择。

---

# 8. P1：Visual Events

新增 source-driven visual events：

```ts
{
  atMs,
  type,
  impact: "structural" | "informational" | "decorative",
  purpose
}
```

可表达：

- internal-beat
- overlay-enter
- overlay-update
- asset-state-change
- reveal
- camera-phase
- diagram-update
- deliberate-breath

只有 structural / informational 事件重置 visual idle budget。

---

# 9. P1：Overlay plan

Director 可声明精简 overlay：

- emphasis-word
- identity
- explanation
- citation
- chapter-label

字幕仍由 narrationText 表达。

额外文字不写进图片 prompt。

dry-run 必须把 overlay 自然语言显示出来，方便人工 review。

---

# 10. P1：Motion Envelope

迁移语义：

- steady
- punch-in
- reveal-accelerate-settle
- slow-build-payoff
- float-observe
- whip-settle
- orbit-reveal
- crane-discovery
- map-dive

本阶段 Director 只声明语义。

resolver/renderer 是否完整消费 envelope 可后续逐步实现；不能因为未实现就让 renderer 自行创造新的导演决定。

---

# 11. Dry Run 的作用

改造后 dry-run 必须更像真正的导演审片门。

`precut-draft.md` 每镜显示：

- purpose
- narration
- beat type
- shot template
- subject
- composition
- motion intent
- motion envelope
- visual events
- overlay / text
- expected assets
- visual idle longest interval / budget / pass

如果存在：

```text
50s shot
longest visual idle = 38s
budget = 5s
```

则 dry-run 应 fail closed，不允许进入 image generation。

---

# 12. 周迪回归测试

文章：

```text
articles/周迪夫妇-扬州城里最后三点微光-source.md
```

必须新增/保留回归标准：

- 不能出现首镜 startMs > 0
- 不能有 timeline gap
- 不能有未覆盖 NarrativeBeat
- 50s/58s 级普通镜头不能仅凭 before/after 通过
- Hook 应从文章已有的异常/冲突建立问题，不要求固定某一镜头文本
- repair 不得删除 unaffected shots
- dry-run 在生图前阻止视觉空窗不合格计划

不要把“必须生成 N 个镜头”硬编码为文章专用测试。

测试的是质量契约，不是固定答案。

---

# 13. 实施顺序

## Batch A — Director contract/playbook

- types
- hook/attention semantics
- beat taxonomy
- shot templates
- motion envelope
- visual events
- overlays

## Batch B — Deterministic validators

- timeline coverage
- beat coverage
- visual idle window
- attention reference validation

## Batch C — Repair guard

- compare before/after repair
- preserve unaffected shots/beats
- validate input invariants

## Batch D — Dry-run observability

- precut-draft 输出 template/event/overlay/rhythm
- blocking result 在 image generation 前停止

## Batch E — Tests

- timeline gap
- missing beat
- 50s before/after fail
- meaningful events pass
- repair dropping unaffected shot fails
- hook references valid
- existing golden tests remain green

---

# 14. 完成标准

完成后：

- 周迪这种 160s / 2 shot 的结果不能通过 dry-run validator
- Director prompt 明确要求 source-driven hook 和 partial payoff
- 不按句机械切镜，但也不能几十秒没有新视觉信息
- 每个 beat 有 shot coverage
- timeline 连续
- repair 不能无声删除正常镜头
- dry-run summary 能直接看懂模板、运镜、文字、事件和视觉空窗
- 不新增额外正常路径 LLM 调用
- CI / npm run check 通过

---

## 核心原则

> **迁移 video-factory 已验证的导演知识，但保留 text-to-video 的简单执行架构。**

> **LLM 决定“讲什么、为什么这样拍、什么时候出现新信息”；deterministic code 负责验证“有没有漏、有没有空窗、有没有破坏已确认内容”。**
