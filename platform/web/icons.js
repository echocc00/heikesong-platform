// web/icons.js — 内联 SVG 图标原语
//
// ⚠️ **为什么不能用 emoji 当图标**（这是本文件存在的唯一理由）：
//   ① **渲染不一致**：同一个 ☑ 在 macOS 是单色字形、在 Windows 是彩色 emoji、
//      在 Linux 上可能是豆腐块 —— 同一份代码在三个平台长成三个东西。
//   ② **读屏会念**：emoji 的可访问名由 Unicode 名称推导（"BALLOT BOX WITH CHECK"
//      / "WHITE CHECK MARK"），中文用户听到的是英文音译，不是「已完成」。
//   ③ **无法控制颜色与描边**：emoji 只能用字体的彩色位图，跟不上 currentColor。
//   ⇒ 一律换成内联 SVG：跟着 currentColor 变色、描边统一、尺寸可控、
//      且能配 aria-label / aria-hidden 精确控制语义。
//
// ⛔ 零依赖、零 IO：纯字符串模板函数。
//
// ⚠️ **aria 纪律**（每加一个图标都要问）：
//   - 图标**是唯一的语义载体**（如"仅图标按钮"）⇒ 必须给 aria-label，
//     且图标本身 aria-hidden="true"（避免名字重复）。
//   - 图标**只是装饰**（旁边有文字）⇒ aria-hidden="true"，让读屏直接读文字。
//   - 图标**传达了额外的状态**（如里程碑已完成）⇒ 不能只靠颜色，
//     必须配一段 sr-only 文字说明状态，否则读屏用户只听到标题、不知道做没做到。

/**
 * 图标统一规格：
 * - 24×24 视框（当前字号下笔画不至于糊）
 * - 1.75 描边（和项目其它 1px 边框、13px 正文搭配不抢戏）
 * - round 端点 + round 连接（与 --r-full 的圆角基调一致）
 * - currentColor 描边 ⇒ 继承文字颜色，无需为每种色调写一份图标
 */
const svg = (body, { size = 20, fill = 'none', stroke = 'currentColor' } = {}) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" `
  + `fill="${fill}" stroke="${stroke}" stroke-width="1.75" stroke-linecap="round" `
  + `stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

/** 空态图标：一只空碗/空容器（表示「这里还没有东西」）。 */
export const iconEmpty = (size) => svg(
  '<path d="M3 9h18"/><path d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/>'
  + '<path d="M8 5.5 12 2l4 3.5"/>',
  { size },
);

/** 错误态图标：三角警示（比 emoji ⚠ 更清晰，且线宽可控）。 */
export const iconWarn = (size) => svg(
  '<path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/>'
  + '<path d="M12 9v4"/><path d="M12 17h.01"/>',
  { size },
);

/** 已达成：圆底对勾。 */
export const iconCheck = (size) => svg(
  '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>',
  { size },
);

/** 未达成：空圆圈（与已达成同尺寸同形状，只是没有勾 —— 形状差异让色觉障碍用户也能分辨）。 */
export const iconUnchecked = (size) => svg(
  '<circle cx="12" cy="12" r="9"/>',
  { size },
);

/** 中性待办：小圆点（对应 tier.js 里那个 ·）。 */
export const iconDot = (size) => svg(
  '<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>',
  { size },
);

/**
 * 里程碑状态标记：已完成 / 未完成。
 *
 * ⚠️ **状态不能只靠颜色或形状** —— 读屏用户与色觉障碍用户都需要文字依据。
 *    所以这里返回图标 + sr-only 状态文字，两者成对出现。
 *
 * @param {boolean} achieved 是否已达成
 * @param {object}  [opts]
 * @param {number}  [opts.size] 图标尺寸（px）
 * @returns {string} HTML 片段（图标 + sr-only 文字）
 */
export function milestoneMark(achieved, { size = 16 } = {}) {
  const icon = achieved ? iconCheck(size) : iconUnchecked(size);
  const text = achieved ? '已达成' : '未达成';
  return `${icon}<span class="sr-only">${text}</span>`;
}
