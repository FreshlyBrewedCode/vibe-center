import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DIRECTIONS, SCREENS, type Screen } from "./directions";
import "./styles.css";

/** `#/<slug>/<screen>` renders one screen full-bleed (what shoot.ts captures); no hash shows the index. */
function useHash() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function App() {
  const hash = useHash();
  const [slug = "", screen = ""] = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const dir = DIRECTIONS.find((d) => d.slug === slug);
  if (dir && (SCREENS as readonly string[]).includes(screen)) {
    const Screen = dir.screens[screen as Screen];
    return (
      <div className={dir.rootClass} style={{ height: "100%", background: "var(--bg)", color: "var(--fg)" }}>
        <Screen />
      </div>
    );
  }
  return <Index />;
}

function Index() {
  return (
    <div className="mx-auto max-w-[1600px] p-8 font-sans text-neutral-900">
      <h1 className="font-semibold text-2xl">Vibe Center — design explorations</h1>
      <p className="mt-1 text-neutral-500 text-sm">
        Live mocks. Each tile is the real React mock at its native size, scaled down. Open a screen for full
        size; see <code>screenshots/</code> and <code>gallery.html</code> for the rendered PNGs.
      </p>
      {DIRECTIONS.map((d) => (
        <section key={d.slug} className="mt-10">
          <h2 className="font-semibold text-lg">
            {d.index}. {d.name}
          </h2>
          <p className="mt-1 max-w-3xl text-neutral-600 text-sm">{d.idea}</p>
          <div className="mt-4 flex flex-wrap gap-4">
            {SCREENS.map((s) => {
              const [w, h] = d.viewport(s);
              const scale = s.startsWith("mobile") ? 0.42 : 0.33;
              return (
                <a
                  key={s}
                  href={`#/${d.slug}/${s}`}
                  className="block overflow-hidden rounded-lg border border-neutral-200 bg-neutral-100 shadow-sm"
                  style={{ width: w * scale, height: h * scale }}
                  title={s}
                >
                  <iframe
                    title={`${d.name} ${s}`}
                    src={`#/${d.slug}/${s}`}
                    style={{
                      width: w,
                      height: h,
                      transform: `scale(${scale})`,
                      transformOrigin: "0 0",
                      border: 0,
                    }}
                  />
                </a>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
