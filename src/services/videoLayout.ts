/**
 * PlayerViewport layout contract.
 *
 * The native surface (macOS/Windows/X11 `mpv_set_layout`, mobile no-op) and the
 * HTML5 fallback share ONE rule: they render inside the PlayerViewport — the
 * `[data-player-viewport]` column the App shell lays out next to the sidebar.
 * The Player consumes that box VERBATIM: it never measures the sidebar, never
 * subtracts it, and never clamps against a derived boundary. App shell flex has
 * already placed the column, so the measured rect IS the region.
 *
 * The only helpers here reason about the *intended* PlayerViewport per platform
 * layout mode (for tests / documentation), independent of DOM measurement:
 *   - inline + sidebar open   -> the column right of the sidebar (x = width)
 *   - inline + sidebar closed -> the full content row below the top bar
 *   - drawer (mobile)         -> the full content row; the opaque drawer
 *                                paints over the video, never vice versa
 * and how the sidebar OCCUPIES space (inline vs drawer), which is
 * PLATFORM-driven, not width-driven.
 */
export interface StageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlayerArea extends StageRect {}

export type SidebarMode = "inline" | "drawer";

/** Tailwind's `md` breakpoint — the widest a real touch device shows the
 *  drawer before it upgrades to the side-by-side inline sidebar. Desktop
 *  platforms never consult this: they are inline at ANY window width. */
export const MD_BREAKPOINT_PX = 768;

/**
 * Decide how the sidebar occupies the layout. The rule is PLATFORM-driven, not
 * purely viewport-driven: the drawer (a floating layer over the video) exists
 * ONLY on real touch devices (Android/iOS) whose viewport is below `md`. A
 * desktop window — macOS/Windows/Linux Tauri or a desktop browser — is always
 * `inline` even when it is narrow (a restored small frame must not turn the
 * sidebar into a layer that overlaps the video).
 */
export const sidebarLayoutMode = (
  isMobileDevice: boolean,
  viewportWidth: number
): SidebarMode =>
  isMobileDevice && viewportWidth < MD_BREAKPOINT_PX ? "drawer" : "inline";

export interface SidebarState {
  open: boolean;
  mode: SidebarMode;
  width: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/**
 * The intended player area given the viewport and sidebar state. Desktop /
 * tablet (inline) mirrors the flex layout: an open sidebar consumes its width,
 * a closed one leaves the full row. On mobile the sidebar is a drawer (`drawer`)
 * that overlays the video, so the video area stays the full content row — the
 * opaque drawer covers it, never the other way around.
 */
export const playerAreaFromViewport = (
  viewport: Viewport,
  topBarHeight: number,
  sidebar: SidebarState | null
): PlayerArea => {
  const inlineOpen = sidebar !== null && sidebar.open && sidebar.mode === "inline";
  const x = inlineOpen ? Math.max(0, sidebar.width) : 0;
  return {
    x,
    y: topBarHeight,
    width: Math.max(0, viewport.width - x),
    height: Math.max(0, viewport.height - topBarHeight),
  };
};

export interface SidebarBoundary {
  /** The sidebar's on-screen right edge in CSS px (top-left origin). */
  right: number;
  /** True when the sidebar OCCUPIES layout space (inline); false when it is
   *  the mobile drawer that floats over the video. */
  inline: boolean;
}

/**
 * RIGHT-OF-SIDEBAR INVARIANT (desktop inline). The native surface's rect must
 * never start to the LEFT of an inline sidebar's right edge — otherwise the
 * picture paints under/over the sidebar instead of beside it. In every correct
 * flex state the measured PlayerViewport already starts exactly at the sidebar
 * edge, so this is an identity transform (the verbatim contract holds). It only
 * corrects a stale, wrongly-measured viewport rect — or a mid-animation toggle
 * frame where the column has not yet finished sliding — that would otherwise
 * let the video bleed under the sidebar.
 *
 * Drawer mode (`inline: false`) is intentionally NOT corrected: there the
 * opaque drawer overlays the video by design, and forcing the surface right of
 * it would wrongly shrink the player on a phone.
 */
export const enforceRightOfSidebar = (
  rect: StageRect,
  boundary: SidebarBoundary | null
): StageRect => {
  if (!boundary || !boundary.inline) return rect;
  const right = Math.round(boundary.right);
  const shift = right - rect.x;
  if (shift <= 0) return rect;
  return {
    x: rect.x + shift,
    y: rect.y,
    width: Math.max(0, rect.width - shift),
    height: rect.height,
  };
};