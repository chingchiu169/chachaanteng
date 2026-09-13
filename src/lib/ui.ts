/** Shared control class strings — one place so every view renders identical controls. */
const fieldBase = "border-line-strong text-fg placeholder:text-fg-faint";
export const inputCls = `input input-xs ${fieldBase}`;
export const selectCls = `select select-xs ${fieldBase}`;
export const textareaCls = `textarea textarea-xs ${fieldBase}`;
const ghostBase = "btn btn-xs btn-ghost border border-line bg-raised hover:bg-hover";
/** Plain small ghost button (no weight bump). */
export const ghostBtn = `${ghostBase} text-fg`;
/** Ghost button with medium weight — the app's standard secondary action. */
export const secondaryBtn = `${ghostBtn} font-medium`;
/** Muted-text variant of ghostBtn (icon-only / de-emphasized actions). */
export const ghostBtnMuted = `${ghostBase} text-fg-muted`;
/** Non-ghost sibling of secondaryBtn — for rows that have no border of their own. */
export const raisedBtn = "btn btn-xs border border-line bg-raised hover:bg-hover text-fg font-medium";
export const labelCls = "text-xs text-fg-muted flex items-center gap-1";
