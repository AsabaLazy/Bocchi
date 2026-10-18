# Bocchi Privacy Shield —— 架构与代码量

> 最后更新：2026-10-17（熵削减架构改造完成后）

## 一、设计策略

**熵削减（entropy reduction）**，三层原则：

1. **高熵向量 → per-session 随机化**：canvas / WebGL / audio 的输出在所有网站按「页面加载盐 × 域名种子」做确定性微扰。站内稳定（不破坏网站）、跨站分歧（切断跨站关联）、跨加载轮换（无长期 ID）。
2. **低熵信号 → 原生透传**：UA、平台、语言、locale、`hardwareConcurrency`、`deviceMemory` 等本来就是人群常见值的信号不做任何伪装——伪装制造的可检测矛盾比保护收益更贵。
3. **能一致降级的才降级**：计时器精度钳制（1ms）、Gamepad 禁用、媒体设备枚举降级、字体最小化、GPU 画像池化。凡是无法在全部 realm 保持一致的值（如被 SharedWorker 暴露的固定降级值）一律不做。

## 二、组件与数据流

```
┌─ Chrome MV3 ──────────────────────────────────────────────────────────┐
│ manifest.json                                                          │
│                                                                        │
│  background/service_worker.js                                          │
│   ├─ WebRTC 策略 (disable_non_proxied_udp)                             │
│   ├─ GeoIP 出口时区同步 (4h 缓存, alarm 每小时刷新)                     │
│   └─ chrome.storage.local ◄────┬───────────────────────┐               │
│                                │  tz / fonts / toggles │               │
│  rules/cyt_rules.json          │  / siteBypassList     │               │
│   └─ DNR: 拦截追踪域 + DNT/Sec-GPC 头 ─────────────────┤               │
│                                                        ▼               │
│  每 frame:                                             │               │
│  content/bridge.js (ISOLATED world, document_start) ────┘               │
│   │  握手: __bocchi_req__ → __bocchi_hs__ {t, e}                       │
│   │  配置: CE 随机事件名 + 一次性 token                                 │
│   ▼  payload { t, tz?, fonts?, cfg? }（伪造/窃听均不可行）              │
│  content/stealth_engine.js (MAIN world, document_start)                │
│   ├─ §1  toString 原生化（shared nativeMap，跨 realm）                  │
│   ├─ §2  Canvas 2D / OffscreenCanvas / WebGPU farbling                 │
│   ├─ §3  WebGL 画像池 + readPixels farbling                            │
│   ├─ §4  AudioBuffer 一次性底层变异                                     │
│   ├─ §5  WebRTC SDP 清洗（仅候选地址）                                  │
│   ├─ §6  DOMRect/Range/SVG 字体度量 + 字体最小化 + screen 护栏          │
│   ├─ §7  navigator 标志（webdriver/GPC）+ 计时器钳制 + Gamepad 降级     │
│   ├─ §8  iframe 多 realm 收养（contentWindow 同步补丁）                 │
│   ├─ §9  时区（目标=真实时零包装透传；否则 Date/Intl 换算 + DST 修正）  │
│   └─ §10 Worker bootstrap（时区/字体/GPU 画像/toString，blob 包装）     │
│                                                                        │
│  popup/ + panel/  ── 设置 UI（开关/字体管理/站点旁路）                  │
└────────────────────────────────────────────────────────────────────────┘
```

## 三、随机化模型（种子粒度）

| 向量 | 种子 | 站内 | 跨站 | 跨加载 | 备注 |
|---|---|---|---|---|---|
| Canvas / WebGL / Audio 微扰 | `djb2(host + per-load salt + 向量名)` | 稳定 | 分歧 | 变化 | 防关联核心 |
| GPU 画像（5 池选一） | `djb2(eTLD+1 近似)` | 全站一致 | 分歧* | 稳定 | *源于站点自身域，对追踪者零信息量；跨 frame 天然一致 |
| 时区 | 无（按目标=真实判断） | — | — | — | 一致时零包装；VPN 不一致时才激活换算 |
| screen/DPR | 固定常见画像 + 真实尺寸护栏 | 固定 | 固定 | 固定 | 真实屏幕小于画像或窗口超画像时透传 |

## 四、安全模型

- **配置通道**：MAIN↔ISOLATED 用随机事件名 + 每 frame 一次性 token 握手（document_start 窗口，页面脚本观测不到）；首个合法配置后停止响应握手请求（防钓鱼）。
- **内部状态**：闭包私有为主；仅两处共享结构挂在 `window.top`（混淆常量的 `Symbol.for` 键）：补丁标记 WeakMap（防同源 frame 双重打补丁，正向验证）+ nativeMap（跨 realm toString 原生化，消除 CreepJS `failed toString` 全部 197 条）。残余风险声明：知道源码中字面 key 的页面可触及这两个结构——成本高于收益的最优折中，已在代码注释中记录。
- **iframe**：contentWindow/contentDocument getter 同步收养 + 插入钩子 + 被动 MutationObserver 兜底。

## 五、代码量（2026-10-17）

| 文件 | 行数 | 说明 |
|---|---|---|
| content/stealth_engine.js | 4010 | 81 个 hook，10 个章节，97 处防御性 catch |
| content/bridge.js | 236 | 握手 + 配置同步 |
| background/service_worker.js | 203 | WebRTC 策略 + 时区同步 + 消息 |
| tests/stealth.test.js | 2822 | 单测（vm 沙箱，~55 组断言） |
| popup/ + panel/ | 1151 | 设置 UI |
| manifest + rules | 185 | |
| **合计** | **~8600** | |

引擎章节规模：§2 Canvas 423 行 / §3 WebGL 182 / §4 Audio 71 / §5 WebRTC 428 / §6 字体度量 509 / §7 Navigator 340 / §8 iframe 139 / §9 时区 733 / §10 Worker 390；基础设施（注册表/握手/种子）约 790 行。

## 六、已知限制（诚实清单）

1. **farbling 可被高级检测器识别**：canvas/audio/WebGL 的微扰使值与原生期望不符（CreepJS 判 lied），这是随机化本身的可见代价；换来的是跨站/跨会话关联被切断。残余 3 条 lies 即此类。
2. **SharedWorker 不包装**：blob 包装会破坏跨标签页 worker 共享（Vite/Parcel 曾因此回退）；由此 `hardwareConcurrency`/`deviceMemory` 放弃降级以保一致性。
3. **同站 frame 像素值互异**：per-load 盐无跨 frame 共享通道（共享即暴露给页面，得不偿失）；画像字符串已通过主机名派生做到跨 frame 一致。
4. **eTLD+1 为近似**：`a.example.co.uk` 与 `b.example.co.uk` 归组为 `co.uk`（画像池粒度偏粗，无信息泄露）。
5. **toString 跨 realm 探测**玩家仍可用其它面（如 worker 内 `performance.now` 未钳制）做轻微对比。
6. **真机验证为无头环境**：CreepJS/尺寸类结论在真实桌面下会不同（headless 的 SwiftShader 与软件渲染会放大 GPU 类"可疑"标记）。

## 七、验证状态

- 单元套件：`node tests/stealth.test.js` 全绿（55 组断言），含 S1-S6 回归、池化/一致性/透传/护栏专项。
- 真机（Chrome for Testing 155，无头）：CreepJS `totalLies` 203 → **3**（残余为 canvas/audio/WebGL farbling 固有）；`failed toString` 197 → 0；headless 评分回到裸浏览器基线；stealth 评分 40% → 20%。
