import type { ComponentType } from "react";
import workspace, { workspaceDark } from "../1-workspace";
import console_ from "../2-console";
import messenger from "../3-messenger";
import editorial from "../4-editorial";
import pulse from "../5-pulse";
import { nocturne, nocturneB } from "../6-nocturne";
import { DESKTOP, type DirectionMeta, MANIFEST, MOBILE, SCREENS, type Screen } from "./manifest";

export { DESKTOP, MOBILE, SCREENS, type Screen };

export interface Direction extends DirectionMeta {
  /** Class on the full-bleed root; the direction's CSS scopes its tokens to it. */
  rootClass: string;
  screens: Record<Screen, ComponentType> & Record<string, ComponentType>;
  viewport: (screen: Screen) => [number, number];
}

export interface DirectionImpl {
  rootClass: string;
  /** The four standard screens, plus any extra keys a round-2 `shots` list refers to. */
  screens: Record<Screen, ComponentType> & Record<string, ComponentType>;
}

function build(slug: string, impl: DirectionImpl): Direction {
  const meta = MANIFEST.find((m) => m.slug === slug);
  if (!meta) throw new Error(`no manifest entry for ${slug}`);
  return {
    ...meta,
    ...impl,
    viewport: (s) => (s === "extra" ? meta.extra.viewport : s === "mobile-call" ? MOBILE : DESKTOP),
  };
}

export const DIRECTIONS: Direction[] = [
  build("workspace", workspace),
  build("console", console_),
  build("messenger", messenger),
  build("editorial", editorial),
  build("pulse", pulse),
  build("nocturne", nocturne),
  build("nocturne-b", nocturneB),
  // Bonus variant, reachable by hash only (not in the index): Workspace in dark.
  { ...build("workspace", workspaceDark), slug: "workspace-dark", dark: true },
];
