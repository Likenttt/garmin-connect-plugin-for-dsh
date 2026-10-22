# Garmin 数据可视化增强指南 (Antigravity Generative UI)

当在 Google Antigravity 环境中，用户要求将 Garmin Connect 的运动活动、睡眠质量、HRV 趋势、身体电量或训练准备度以**图表、卡片或交互式仪表盘**形式展示时，读取本指南。

---

## 一、 设计与架构原则

1. **Antigravity Generative UI 规范**：
   - 依赖项：仅使用官方唯一允许的 Tailwind CDN：
     ```html
     <script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>
     ```
     （由于严格的内容安全策略 CSP，严禁引用其他外部 CDN 如 unpkg、cdnjs 或 Chart.js 外部脚本）。
   - 图表渲染技术：采用**纯 HTML5 + 响应式 SVG + 原生 JavaScript / Canvas**。纯 SVG 具有零外部依赖、高清晰度、体积轻量、暗色/亮色自适应的优势。
   - 语义化主题变量：使用 host 注入的设计系统 token，确保在暗色（Dark）和亮色（Light）模式下自适应：
     - 卡片背景：`bg-[var(--card)]`
     - 主文字：`text-[var(--foreground)]`
     - 次级/辅助文字：`text-[var(--muted-foreground)]`
     - 边框：`border-[var(--border)]`
     - 主题色：`bg-[var(--primary)]` / `text-[var(--primary-foreground)]`
   - 字号下限：不得使用低于 12px 的字体（以 `text-xs` 为底线）。

2. **交付形态 (Placement)**：
   - **Standalone Artifact（推荐）**：将仪表盘保存为独立 `.html` 文件存入 Artifact 目录，并在元数据中设置 `UserFacing: true`，用户可在右侧独立面板中获得完整沉浸式交互。
   - **Inline Widget（内联嵌入）**：紧凑型卡片（高度建议在 400px 以内）可使用 `<agent-embed src="file:///path/to/widget.html"></agent-embed>` 直接嵌入在聊天流中。

---

## 二、 核心场景图表规范与模板

### 1. 跑步活动分析仪表盘 (Running Activity Dashboard)

用于呈现 `get_garmin_activities` 返回的单次运动数据。

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>
</head>
<body class="bg-transparent text-[var(--foreground)] antialiased p-4">
  <div class="bg-[var(--card)] border border-[var(--border)] rounded-2xl p-6 shadow-sm max-w-2xl mx-auto space-y-6">
    <!-- 头部信息 -->
    <div class="flex items-center justify-between border-b border-[var(--border)] pb-4">
      <div>
        <h2 class="text-xl font-bold text-[var(--foreground)]">晨间间歇跑</h2>
        <p class="text-xs text-[var(--muted-foreground)]">2026-10-20 07:15 · 户外跑步</p>
      </div>
      <span class="px-3 py-1 bg-emerald-500/10 text-emerald-500 text-xs font-semibold rounded-full border border-emerald-500/20">
        训练效果：门槛提升
      </span>
    </div>

    <!-- 关键指标网格 -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <div class="p-3 bg-[var(--background)] rounded-xl border border-[var(--border)]">
        <p class="text-xs text-[var(--muted-foreground)]">距离</p>
        <p class="text-2xl font-bold text-[var(--foreground)] mt-1">10.02 <span class="text-xs font-normal">km</span></p>
      </div>
      <div class="p-3 bg-[var(--background)] rounded-xl border border-[var(--border)]">
        <p class="text-xs text-[var(--muted-foreground)]">平均配速</p>
        <p class="text-2xl font-bold text-[var(--foreground)] mt-1">4'52" <span class="text-xs font-normal">/km</span></p>
      </div>
      <div class="p-3 bg-[var(--background)] rounded-xl border border-[var(--border)]">
        <p class="text-xs text-[var(--muted-foreground)]">平均心率</p>
        <p class="text-2xl font-bold text-[var(--foreground)] mt-1">158 <span class="text-xs font-normal">bpm</span></p>
      </div>
      <div class="p-3 bg-[var(--background)] rounded-xl border border-[var(--border)]">
        <p class="text-xs text-[var(--muted-foreground)]">平均步频</p>
        <p class="text-2xl font-bold text-[var(--foreground)] mt-1">182 <span class="text-xs font-normal">spm</span></p>
      </div>
    </div>

    <!-- 心率区间分布条 (SVG) -->
    <div class="space-y-2">
      <div class="flex justify-between items-center text-xs">
        <span class="font-semibold text-[var(--foreground)]">心率区间分布</span>
        <span class="text-[var(--muted-foreground)]">最大心率: 188 bpm</span>
      </div>
      <!-- 堆叠色条 -->
      <div class="w-full h-4 rounded-full overflow-hidden flex bg-[var(--background)]">
        <div style="width: 10%" class="bg-gray-400" title="Z1 暖身: 10%"></div>
        <div style="width: 25%" class="bg-blue-500" title="Z2 燃脂: 25%"></div>
        <div style="width: 35%" class="bg-green-500" title="Z3 有氧: 35%"></div>
        <div style="width: 25%" class="bg-amber-500" title="Z4 门槛: 25%"></div>
        <div style="width: 5%" class="bg-rose-500" title="Z5 无氧: 5%"></div>
      </div>
      <!-- 图例 -->
      <div class="grid grid-cols-5 text-center text-xs text-[var(--muted-foreground)] pt-1">
        <span>Z1 (10%)</span>
        <span>Z2 (25%)</span>
        <span>Z3 (35%)</span>
        <span>Z4 (25%)</span>
        <span>Z5 (5%)</span>
      </div>
    </div>
  </div>
</body>
</html>
```

---

### 2. 睡眠质量与分期堆叠图 (Sleep Stages Breakdown)

用于呈现 `get_garmin_sleep` 返回的夜间睡眠评分与四阶段时长。

- **配色标准**：
  - 深睡（Deep Sleep）：深蓝色/紫色（如 `#4f46e5` 或 `bg-indigo-600`）
  - 浅睡（Light Sleep）：浅蓝色（如 `#38bdf8` 或 `bg-sky-400`）
  - 快速眼动（REM Sleep）：蓝绿色/青色（如 `#2dd4bf` 或 `bg-teal-400`）
  - 清醒（Awake）：浅粉色/粉红（如 `#f43f5e` 或 `bg-rose-500`）

---

### 3. HRV 状态与 7 天夜间基线趋势 (HRV Status & 7-Day Trend)

用于呈现 `get_garmin_hrv` 及 `get_garmin_hrv_summaries`。

- **核心呈现要素**：
  1. 状态胶囊：`Balanced`（平衡，绿色）、`Unbalanced`（失衡，黄色/橙色）、`Low`（偏低，红色）；
  2. 昨夜均值 vs 7 天基线范围；
  3. SVG 折线图：绘制 7 天的夜间读数折线，并以半透明背景带标出基准区间（Baseline Range 上限与下限）。折线在基线范围内表示恢复良好，持续低于基线提示神经系统疲劳。

---

### 4. 身体电量与压力时序图 (Body Battery & Stress Dual-Axis)

用于呈现 `get_garmin_body_battery` 和 `get_garmin_stress`。

- 绘制 24 小时曲线：
  - 身体电量（0-100% 充电/放电曲线）：使用亮蓝色渐变折线；
  - 压力指数（0-100 柱状或折线）：使用橙色/黄色区域；
  - 标明全天充电总量（+Charge）与消耗总量（-Drain）。

---

## 三、 Agent 执行流程指南

当 Antigravity 中的用户提出数据分析请求时：

1. **按需调用只读 MCP 工具**：通过 `get_garmin_activities`、`get_garmin_sleep` 或 `get_garmin_hrv` 获取真实数据。
2. **提取关键数据点**：换算数值（米 $\rightarrow$ 公里，秒 $\rightarrow$ 分/秒配速，毫秒 $\rightarrow$ HRV 等）。
3. **生成 Generative UI Artifact**：
   - 组织干净完整的 HTML 代码，内嵌 SVG 动态绘制坐标点和曲线；
   - 写入 `<artifact_dir>/garmin_activity_report.html` 或 `<artifact_dir>/sleep_hrv_dashboard.html`；
   - 元数据中配置 `UserFacing: true` 并给出清晰摘要；
4. **对话回复**：简明指出关键发现和趋势，引导用户在侧边栏查看富交互图表。
