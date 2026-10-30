// iOS Safari doesn't shrink the layout viewport for the on-screen keyboard (nor honour
// `interactive-widget=resizes-content`): it pans the page instead, pushing the headers off the
// top. The app root follows the visual viewport (`--vv-top`, `--vv-height`, see index.css), so
// it always fills exactly the visible area: headers at the top, the composer right above the
// keyboard (where the home indicator's safe area doesn't apply). While pinch-zoomed the plain
// `100dvh` layout applies, so zooming doesn't re-flow the app.

export function pinToVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const style = document.documentElement.style;
  const update = () => {
    const zoomed = Math.abs(vv.scale - 1) > 0.01;
    const keyboard = !zoomed && window.innerHeight - vv.height > 80;
    for (const [name, value] of [
      ["--vv-top", zoomed ? null : `${vv.offsetTop}px`],
      ["--vv-height", zoomed ? null : `${vv.height}px`],
      ["--safe-bottom", keyboard ? "0px" : null],
    ] as const) {
      if (value === null) style.removeProperty(name);
      else style.setProperty(name, value);
    }
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}
