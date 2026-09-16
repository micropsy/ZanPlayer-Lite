import { describe, it, expect } from "vitest";
import {
  enforceRightOfSidebar,
  playerAreaFromViewport,
  sidebarLayoutMode,
} from "./videoLayout";

describe("playerAreaFromViewport (cross-platform intended area)", () => {
  const viewport = { width: 1200, height: 800 };

  it("desktop inline + sidebar open => column right of the sidebar", () => {
    const area = playerAreaFromViewport(viewport, 40, {
      open: true,
      mode: "inline",
      width: 352,
    });
    expect(area).toEqual({ x: 352, y: 40, width: 848, height: 760 });
  });

  it("desktop inline + sidebar closed => full content row (fill-up)", () => {
    const area = playerAreaFromViewport(viewport, 40, {
      open: false,
      mode: "inline",
      width: 352,
    });
    expect(area).toEqual({ x: 0, y: 40, width: 1200, height: 760 });
  });

  it("mobile drawer (open) still keeps the video as the full content row — the opaque drawer paints over it", () => {
    const area = playerAreaFromViewport(viewport, 0, {
      open: true,
      mode: "drawer",
      width: 352,
    });
    expect(area).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it("web fullscreen => no top bar, no sidebar => the whole viewport", () => {
    const area = playerAreaFromViewport(viewport, 0, null);
    expect(area).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it("clamps negative top-bar / sidebar contributions (defensive)", () => {
    const area = playerAreaFromViewport({ width: 800, height: 600 }, 900, {
      open: true,
      mode: "inline",
      width: 1000,
    });
    expect(area.x).toBe(1000);
    // The RightFill is 0 — a sidebar wider than the viewport cannot extend the
    // area: width stays 0, height too. The native surface never renders a
    // negative/absurd box.
    expect(area.width).toBe(0);
    expect(area.y).toBe(900);
    expect(area.height).toBe(0);
  });
});

describe("sidebarLayoutMode (platform-driven inline vs drawer)", () => {
  it("desktop is always inline — even a very narrow window", () => {
    expect(sidebarLayoutMode(false, 1200)).toBe("inline");
    expect(sidebarLayoutMode(false, 700)).toBe("inline");
    expect(sidebarLayoutMode(false, 320)).toBe("inline");
  });

  it("touch device below `md` is a drawer", () => {
    expect(sidebarLayoutMode(true, 375)).toBe("drawer");
    expect(sidebarLayoutMode(true, 767)).toBe("drawer");
  });

  it("touch device at/above `md` upgrades to inline (rotated phone/tablet)", () => {
    expect(sidebarLayoutMode(true, 768)).toBe("inline");
    expect(sidebarLayoutMode(true, 1200)).toBe("inline");
  });
});

describe("enforceRightOfSidebar (native surface never under/over an inline sidebar)", () => {
  const boundary = { right: 352, inline: true };

  it("identity when the rect already starts at the sidebar edge (verbatim flex state)", () => {
    const rect = { x: 352, y: 40, width: 848, height: 760 };
    expect(enforceRightOfSidebar(rect, boundary)).toEqual(rect);
  });

  it("pushes a wrongly full-width rect right of the sidebar (never under it)", () => {
    const rect = enforceRightOfSidebar({ x: 0, y: 40, width: 1200, height: 760 }, boundary);
    expect(rect).toEqual({ x: 352, y: 40, width: 848, height: 760 });
  });

  it("mid-toggle frame: a column still sliding left is snapped to the sidebar edge", () => {
    const rect = enforceRightOfSidebar({ x: 300, y: 40, width: 900, height: 760 }, boundary);
    expect(rect).toEqual({ x: 352, y: 40, width: 848, height: 760 });
  });

  it("fractional sidebar right edge rounds up — no 1px underlap", () => {
    const rect = enforceRightOfSidebar(
      { x: 0, y: 40, width: 1200, height: 760 },
      { right: 352.4, inline: true }
    );
    expect(rect).toEqual({ x: 352, y: 40, width: 848, height: 760 });
  });

  it("leaves the drawer (mobile overlay) rect untouched — video stays full row", () => {
    const rect = { x: 0, y: 0, width: 1200, height: 800 };
    expect(enforceRightOfSidebar(rect, { right: 352, inline: false })).toEqual(rect);
    expect(enforceRightOfSidebar(rect, null)).toEqual(rect);
  });

  it("a sidebar wider than the shifted width yields a degenerate (0-width) rect, never a negative one", () => {
    const rect = enforceRightOfSidebar({ x: 0, y: 40, width: 200, height: 760 }, boundary);
    expect(rect.width).toBe(0);
    expect(rect.x).toBe(352);
    expect(rect.height).toBe(760);
  });
});