/**
 * The shell's icon vocabulary — the single place a nav or command icon name is
 * bound to a concrete glyph.
 *
 * The navigation models (`nav-items.ts`, `settings-nav.ts`, `command-registry.ts`)
 * are deliberately dependency-free so their composition is unit-testable, which
 * means they name icons as strings and leave resolution to the renderer. That
 * seam only holds if a name a model emits is a name a renderer can resolve.
 *
 * It did not hold: the sidebar and the command palette each kept their own map,
 * and four product surfaces registered in the palette named icons only the
 * sidebar's map had. The palette rendered them with no glyph, and nothing
 * failed — not typecheck, not a test.
 *
 * So the map is shared and the name is a type. `ShellIconName` is derived from
 * this object's keys, and the models type their `icon` field with it, which
 * makes an unresolvable name a compile error at the point it is written rather
 * than a missing glyph at the point it is rendered.
 */

import {
  Bell,
  Boxes,
  Building2,
  FolderKanban,
  Gauge,
  GitBranch,
  Globe,
  KanbanSquare,
  KeyRound,
  LogOut,
  Mail,
  Plug,
  PlusCircle,
  Receipt,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  User2,
  UserPlus,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";

export const SHELL_ICONS = {
  Bell,
  Boxes,
  Building2,
  FolderKanban,
  Gauge,
  GitBranch,
  Globe,
  KanbanSquare,
  KeyRound,
  LogOut,
  Mail,
  Plug,
  PlusCircle,
  Receipt,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  User2,
  UserPlus,
  Users,
  Webhook,
} satisfies Record<string, LucideIcon>;

/** Every icon name the shell can render. */
export type ShellIconName = keyof typeof SHELL_ICONS;

/**
 * The glyph shown when a descriptor carries no icon at all. Not a fallback for
 * an unknown name — `ShellIconName` makes that unrepresentable.
 */
export const DEFAULT_SHELL_ICON: LucideIcon = Settings;
