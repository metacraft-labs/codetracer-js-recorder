/**
 * The markup of the suite's own two builds of the fixtures: the generic
 * build (plain pages for the generic shim, level 0) and the reference
 * micro-framework's build (level 1). One table, so the two builds render
 * the same documents and differ only in their scripts.
 *
 * Every element a fixture's script touches carries `data-fx` (the
 * fixture contract). The reference build also stamps `data-iid`, the
 * reference framework's stable id: the fixture's name and the element's
 * role, which no unrelated edit changes.
 */

/** How a page's elements are annotated. */
export interface MarkupOptions {
  /** Stamp the reference framework's `data-iid` on every `data-fx` element. */
  iids: boolean;
}

/** The `<body>` content of each fixture's page. */
const BODIES: Record<string, (a: (role: string) => string) => string> = {
  counter: (a) =>
    `<main id="app"><h1>Counter</h1>` +
    `<button type="button" ${a("inc")}>+1</button> ` +
    `<output ${a("count")}>0</output></main>`,
  "text-input": (a) =>
    `<main id="app"><h1>Text input</h1>` +
    `<label>Name <input type="text" ${a("name")} aria-label="Name"></label> ` +
    `<output ${a("echo")}></output></main>`,
  "password-form": (a) =>
    `<main id="app"><h1>Sign in</h1><form ${a("form")} aria-label="Sign in">` +
    `<label>User <input type="text" ${a("user")} aria-label="User"></label> ` +
    `<label>Password <input type="password" ${a("pass")} aria-label="Password"></label> ` +
    `<button type="submit" ${a("submit")}>Sign in</button></form>` +
    `<p ${a("status")}></p></main>`,
  "fetch-list": (a) =>
    `<main id="app"><h1>Items</h1>` +
    `<button type="button" ${a("reload")}>Reload</button>` +
    `<ul ${a("list")}></ul><p>Loads: <span ${a("loads")}>0</span></p>` +
    `<p ${a("summary")}></p></main>`,
  timers: (a) =>
    `<main id="app"><h1>Timers</h1>` +
    `<button type="button" ${a("start")}>Start</button> ` +
    `<output ${a("ticks")}>0</output></main>`,
  prehydration: (a) =>
    `<main id="app"><h1>Before hydration</h1>` +
    `<button type="button" ${a("early")}>Click</button> ` +
    `<output ${a("clicks")}>0</output></main>`,
  "client-nodes": (a) =>
    `<main id="app"><h1>Rows</h1>` +
    `<button type="button" ${a("add")}>Add row</button>` +
    `<ul ${a("rows")}></ul><p>Done: <span ${a("done-count")}>0</span></p></main>`,
  navigation: (a) =>
    `<main id="app"><nav>` +
    `<a href="?view=about" ${a("nav-about")}>About</a> ` +
    `<a href="?view=home" ${a("nav-home")}>Home</a></nav>` +
    `<h1 ${a("view")}>home</h1></main>`,
};

/** The fixtures whose page hydrates late (the pre-hydration queue). */
export const DEFERRED_HYDRATION: ReadonlySet<string> = new Set([
  "prehydration",
]);

/** The fixture names the builds cover: every fixture of the suite. */
export const PAGE_FIXTURES: readonly string[] = Object.keys(BODIES);

/**
 * The element the perturbed page inserts as the first child of `<body>`:
 * unrelated to the fixture, so a stable target id must not change.
 */
export const PERTURBATION = `<p class="ct-unrelated">An unrelated paragraph.</p>`;

/** The body markup of `fixture`'s page. */
export function bodyMarkup(fixture: string, options: MarkupOptions): string {
  const body = BODIES[fixture];
  if (body === undefined) throw new Error(`no page for fixture ${fixture}`);
  return body((role) =>
    options.iids
      ? `data-fx="${role}" data-iid="${fixture}/${role}"`
      : `data-fx="${role}"`,
  );
}

/** A whole page: the doctype, `<head>` with `head`, and `<body>`. */
export function page(options: {
  title: string;
  head: string;
  body: string;
  htmlAttributes?: string;
}): string {
  const attrs = options.htmlAttributes ? ` ${options.htmlAttributes}` : "";
  return (
    `<!doctype html>\n<html lang="en"${attrs}><head><meta charset="utf-8">` +
    `<title>${options.title}</title>${options.head}</head>\n` +
    `<body>${options.body}</body></html>\n`
  );
}
