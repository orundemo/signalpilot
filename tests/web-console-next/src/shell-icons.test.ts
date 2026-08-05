// Every icon name the shell emits must be one the shell can render.
//
// The navigation models are dependency-free by design, so they name icons as
// strings and leave resolution to the renderer. That seam broke once: four
// product surfaces were registered in the command palette with icon names only
// the sidebar's map carried, and the palette rendered them with no glyph. No
// typecheck failed and no test caught it, because each renderer owned its own
// map and nothing compared the two.
//
// `ShellIconName` now makes an unresolvable name a compile error. These tests
// cover what the type cannot: a cast, or a name assembled at runtime.

import { SHELL_ICONS, type ShellIconName } from "@web-console-next/components/shell/icons";
import { buildNavSections } from "@web-console-next/components/shell/nav-items";
import { buildSettingsNav, flattenSettingsNav } from "@web-console-next/components/shell/settings-nav";
import { buildBaseCommands } from "@web-console-next/components/shell/command-registry";

const known = new Set(Object.keys(SHELL_ICONS));

function navIconNames(soloMode: boolean): string[] {
  return buildNavSections({ orgSlug: "acme", projectSlug: "web" }, soloMode).flatMap((s) =>
    s.links.map((l) => l.icon as string),
  );
}

describe("shell icon vocabulary", () => {
  it("resolves every sidebar icon, in both profiles", () => {
    for (const soloMode of [true, false]) {
      const names = navIconNames(soloMode);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(known).toContain(name);
    }
  });

  it("resolves every settings-rail icon, in both profiles", () => {
    for (const soloMode of [true, false]) {
      const names = flattenSettingsNav(buildSettingsNav("acme", soloMode)).map(
        (l) => l.icon as string,
      );
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(known).toContain(name);
    }
  });

  it("resolves every command-palette icon", () => {
    // The palette is where the original defect landed: its map was missing the
    // four product surfaces the sidebar's map had.
    const commands = buildBaseCommands({
      orgSlug: "acme",
      projectSlug: "web",
      isLocked: false,
      targets: [{ name: "stage" }],
      // Baseline: the widest command set, so the icon check covers every
      // descriptor rather than just the ones Solo keeps.
      soloMode: false,
    });
    const names = commands.map((c) => c.icon).filter((n): n is ShellIconName => n !== undefined);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(known).toContain(name);
  });

  it("has no icon nothing names — an unused entry is a leftover, not a spare", () => {
    const used = new Set([
      ...navIconNames(true),
      ...navIconNames(false),
      ...flattenSettingsNav(buildSettingsNav("acme", true)).map((l) => l.icon as string),
      ...flattenSettingsNav(buildSettingsNav("acme", false)).map((l) => l.icon as string),
      ...buildBaseCommands({
        orgSlug: "acme",
        projectSlug: "web",
        isLocked: false,
        targets: [{ name: "stage" }],
        soloMode: false,
      })
        .map((c) => c.icon)
        .filter((n): n is ShellIconName => n !== undefined),
    ]);
    expect([...known].filter((name) => !used.has(name))).toEqual([]);
  });
});
