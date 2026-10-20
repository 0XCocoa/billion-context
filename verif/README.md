# verif — 对 kernel 决策核做"真代码求解器验证"的小模块

Issue #3848。目标:把受保护文件里的真实 TypeScript 逻辑翻译成 SMT 约束,
用求解器找违反缓存稳定不变量的反例;反例必须回放真代码复现才算数。

这不是"根据代码写证明",也不是"自己建模":被翻译的就是仓库里的源文件,
翻译器只是镜头,镜头歪了会被回放当场抓住(见下)。

## 部件

| 部件 | 文件 | 作用 |
|---|---|---|
| 子语言守卫 | `subset-guard.ts` + `guarded-files.ts` + `exceptions.ts` | 守卫清单内的文件只许写可翻译的语法;白名单外 → `tests/verif-subset-guard.test.ts` 红。例外必须显式登记,过期例外也红 |
| 符号执行器 | `symbolic.ts` | 真 TS AST → 符号值;分支用 ITE 值合并不枚举路径;本地函数内联(不换算子);跨文件 import 图解析 |
| SMT 项门面 | `terms.ts` | 自研 DAG Term(不走 z3-solver WASM——它 2GB 堆上限扛不住两轮公式);常量折叠;`smt2Of` 发射带 define-fun 共享的 SMT-LIB2 |
| 求解器桥 | `solve.ts` | 进程外求解,优先 cvc5(经 `VERIF_PYTHON` 指定的 python),回退 z3 二进制;可用 `VERIF_SOLVER_CMD` 覆盖 |
| 反例回放 | `replay.ts` | 求解器 witness 必须在真实 kernel 代码上复现;不复现 = 翻译器漂移/规格写错,是警报不是通过 |

## 运行

```bash
# 守卫 + 冒烟不需要求解器
node --import tsx --test tests/verif-subset-guard.test.ts tests/verif-symbolic-smoke.test.ts

# 求解器测试需要 cvc5(cvc5 优先,z3 WASM 只够冒烟级公式)
VERIF_PYTHON=/path/to/python-with-cvc5 node --import tsx --test tests/verif-bug*.test.ts tests/verif-generic-*.test.ts tests/verif-induction-*.test.ts
# 没有求解器的环境自动 skip,CI 不会红
```

## 测试布局(每一层证明什么)

| 测试 | 层 | 证明内容 |
|---|---|---|
| `verif-subset-guard` | 守卫 | 守护文件仍在可翻译子语言内 + 负控制(塞进 async/node:fs 会红) |
| `verif-symbolic-smoke` | 引擎保真 | indexToRef 界内 UNSAT / 界外 witness 回放 / 错误规格被拒(翻译保真) |
| `verif-bug3691-oscillation` | 定向不变量 | 紧急截断在门限处可触发(SAT+witness)且门限下不可触发(UNSAT);两轮回放展示同一重发历史出站字节翻转 |
| `verif-bug3769-orphan-window` | 定向不变量 | 只增不删的历史里"可见的必须保持可见"被孤儿窗口破坏;窗口调大后稳定 |
| `verif-bug3676-wire-reorder` | 定向不变量 | openai wire 重建 [file,text]→[text,file] 部件重排(SAT + 真代码回放) |
| `verif-bug3805-durable-ref-migration` | 定向不变量 | 保护解除时 BLOCKED→数字引用迁移给已发送字节中途加标签;非 durable 追加稳定(UNSAT) |
| `verif-generic-append-stability` | **任意输入** | 消息全符号化、唯一不变量"只增不删的字节稳定":Q1 SAT(#3805 形状泛化重现)、Q2 SAT(**求解器自己发现的新 bug #3945**:id 撞车重打标,零保护解除)、Q3 UNSAT(排除两个已知形状后界内无第三种) |
| `verif-induction-append-stability` | **归纳判官** | 任意消息数的 append-only 稳定性:前缀抽象成一个符号绑定,归纳步 UNSAT(id 不重复时任何前缀状态都动不了);撤掉约束 SAT = #3945;真代码随机抽查 60 轮 |
| `verif-view-latch-discipline` | **锁存纪律判官**(#3989) | 安静轮 latch 字节逐字回放(Q1 UNSAT,任意 pre/post/latch 文本)+ 真代码行为矩阵(quiet 回放 / 到达锁存 / 折叠重置 / 稳态零churn)。已知缺口:pass-through 形状的符号断言因嵌套循环+分支的数组槽位合并仍会出幻影臂(见下"诚实建模"节),先用真代码矩阵钉住 |

## 无作弊规则(写新 harness 前必读)

1. **只调真入口函数**:harness 通过 `translateFunction` 编译仓库里的真实
   文件,不复制逻辑、不复述算法。
2. **不变量必须是通用性质**(幂等/单调/append-only 稳定…),绝不在 bug
   行号附近写断言。允许手工挑选的只有"场景脚本"(输入的形状),因为宿主
   行为是开放集。
3. **反例必须回放真代码**:witness 代入真实函数,行为不符 = 引擎 bug,
   修引擎,绝不放宽断言。
4. **port 是公开接缝**:token 计数器、isProtected 这类真实可注入参数用
   `portImpls` 提供符号实现;但本地函数名和 import 的真实函数**永远优先于
   port**,防止用 port 偷换真实逻辑。
5. **负控制必须有**:每个 SAT 证明配一个"已知修好/排除后 UNSAT"的对照,
   证明判官不是永真式。

## 建模决定(诚实清单)

- 数字 = Real(有理数);整数性用 `IsInt` 约束,不静默取整。
- 求解不可判定的角落**降级并登记**,不假装:降级项会出现在
  `exec().degradations`,harness 断言空列表才能立案。
- 动态正则(ownTagRe)按"锚定前缀"过近似:前缀不匹配 → 精确 false;
  匹配 → 未解释函数 + 降级标记(仅可达时)。
- `String(n)` / `toFixed` 等确定性渲染 = 未解释函数(同名同参同值),
  保证跨轮稳定;witness 回放仍然落在真代码上。
- 循环展开 K(默认 8)、数组槽位 N(默认 8):**有界模型检测**。要"任意
  消息数"不用加 N —— 用归纳判官(`verif-induction-*`)。
- 模块级常量从源文件真实收集,不手抄。
- **已知缺口(未修)**:嵌套循环+分支下的数组槽位合并,幻影臂
  (undef-loses 折叠)会让 pass-through 形状出现假 SAT
  (`verif-view-latch-discipline` 的 Q2 因此暂不断言,用真代码矩阵钉住);
  修法方向 = push 槽位写入携带各臂路径守卫。

## 已发现的 bug(求解器自动 + 回放确认)

- #3691 紧急截断震荡(harness 定向找到;回放顺带发现截断结果比原文长 → #3935)
- #3769 失败压缩轮换的孤儿窗口
- #3676 openai wire 重建重排
- #3805 durable 引用迁移重打标
- **#3945 重复 id 重打标 —— 通用输入 harness 在任意输入下自己发现的新形状**

## 扩展

- 加守护文件:改 `guarded-files.ts`,先确认翻译器支持其语法(守卫会告诉你
  缺什么),例外登记 `exceptions.ts`。
- 加不变量:新 harness 文件,遵守上面的无作弊规则;SAT → 回放 → 真 bug
  开 issue + 回归钉;UNSAT → 界内证无,写清楚界。
- 从有界到无界:归纳判官模板 = 前缀抽象 + 单步 UNSAT + 已知例外 SAT +
  真代码随机锚点。
