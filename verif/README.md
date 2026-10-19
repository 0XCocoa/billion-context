# verif — 对 kernel 决策核做"真代码求解器验证"的小模块

Issue #3848。目标:把受保护文件里的真实 TypeScript 逻辑翻译成 SMT 约束,
用求解器找违反缓存稳定不变量的反例;反例必须回放真代码复现才算数。

这不是"根据代码写证明",也不是"自己建模":被翻译的就是仓库里的源文件,
翻译器只是镜头,镜头歪了会被回放当场抓住(见下)。

## 四件套

| 部件 | 文件 | 作用 |
|---|---|---|
| 子语言守卫 | `subset-guard.ts` + `guarded-files.ts` + `exceptions.ts` | 守卫清单内的文件只许写可翻译的语法;白名单外 → `tests/verif-subset-guard.test.ts` 红。例外必须显式登记,过期例外也红 |
| 符号执行器 | `symbolic.ts` | 真 TS AST → z3 约束;if 用 ITE 值合并不枚举路径 |
| 反例回放 | `replay.ts` | 求解器 witness 必须在真实编译后的 kernel 代码上复现;不复现 = 翻译器漂移/规格写错,是警报不是通过 |
| 证明冒烟 | `tests/verif-symbolic-smoke.test.ts` | 第一个端到端证明:refs.ts `indexToRef` 越界行为(界内无反例 UNSAT + 界外 witness 回放 + 漂移对照) |

## 守卫怎么工作

- 允许清单制(不是禁止清单制):不认识的内置函数/方法/导入一律违规,
  直到翻译器学会并加入清单。
- 违规 = 修代码,或在 `exceptions.ts` 登记带理由的例外(文件+规则+函数,
  可选精确 detail)。没有第三条路。
- 例外的"过期检测":不再匹配任何违规的例外会让测试失败,强制清理——
  例外清单是受审计的库存,不是垃圾场。

当前守卫范围(Tier A,与 #3848 一致):compress / hide-consumed / refs /
render-refs / truncate / truncate-tools / tokenize / rebuild / wire/openai /
wire/responses。扩范围必须跟着翻译器覆盖走,不许超前。

## 建模决定(诚实清单)

- **数字 = z3 Int**。受保护函数的算术都是整数下标/阈值;浮点重的逻辑
  (如 0.95 之类字面量阈值)暂不在证明范围,进范围前要么 ×100 定标、
  要么换 Real 排序并重新论证。
- `Number.isInteger(int)` = true(Int 排序下显然)。
- `throw` 只关心"抛没抛",不关心抛的值。
- `String(n).padStart` 等字符串渲染 MVP 阶段翻译为 `any`(不影响当前
  已证明的控制流性质);升级为精确翻译前,依赖其返回值的性质不立项。
- 模块级常量(REF_WIDTH、MIN_INDEX…)从源文件真实收集,不手抄。

## 回放锁(为什么这不是自己建模)

1. 求解器说"存在 n₀ 使 P 违反" → 取出具体 n₀;
2. 用 n₀ 调**真实编译后的** kernel 函数;
3. 真代码复现 → 反例成立;真代码不复现 → 翻译器或规格有错,报
   `REPLAY MISMATCH`,修翻译器/规格,绝不"将错就错通过"。

冒烟测试第 3 用例演示了这把锁:故意写错的规格边界在回放处被抓。

## 运行

```bash
node --import tsx --test tests/verif-subset-guard.test.ts    # 子语言守卫(秒级)
node --import tsx --test tests/verif-symbolic-smoke.test.ts  # z3 端到端(需 devDep z3-solver)
```

## 路线(见 #3848)

- 下一步:数组组合子内联(map/filter/every/…)→ 消息数组为符号序列;
  正则字面量 → z3 `re.` 项;`padStart`/`int→str` 精确化。
- 远期靶子:#3676 / #3691 / #3769 / #3805 四个反例由求解器自动找到并回放复现。
