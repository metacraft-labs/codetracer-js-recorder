/**
 * The fixture scenarios of the conformance suite (CodeTracer's
 * JS-Boundary-Recording specification, §9.9).
 *
 * A fixture is a contract, not a page: every framework builds its own page
 * for it (the suite's generic build, `fixtures/generic/`, is the page with
 * no framework; the reference micro-framework has its own; a cooperating
 * framework writes its own). Each fixture states
 *
 * - `contract`: what the page renders and does, in prose; the elements its
 *   script touches carry `data-fx="<name>"`;
 * - `steps`: the scripted interaction the harness performs;
 * - `final`: the text the named elements show afterwards (the `interaction`
 *   check: the build really implements the fixture);
 * - `handlers`: each handler invocation the interaction causes, as
 *   `(event type, element)`, with a count (the `inputs` check);
 * - `reads`: the multiset of boundary reads the fixture is known to make
 *   (the `reads` check), as {@link readKeyOf} keys with a lower bound.
 *
 * Pages live at `/<fixture>/index.html` in a build, with a perturbed twin
 * at `/<fixture>/perturbed.html` (level 1): the same page with one unrelated
 * element inserted as the first child of `<body>`, before the fixture's own
 * content (the `targets` check).
 */

import { ROUTES } from "./protocol.js";

/** One step of a scripted interaction. */
export type Step =
  | { op: "click"; fx: string }
  | { op: "type"; fx: string; text: string }
  | { op: "waitFor"; fx: string; text: string }
  | { op: "goBack" }
  | { op: "waitForGateRequest" }
  | { op: "releaseGate" };

/** The text an element shows once the interaction is over. */
export interface FinalText {
  fx: string;
  text: string;
}

/** Handler invocations the interaction causes. */
export interface HandlerExpectation {
  /** The DOM event type the handler is registered for. */
  type: string;
  /** The element it is registered on. */
  fx: string;
  /** How many times the interaction invokes it. */
  count: number;
  /**
   * How many of those invocations are of events that arrived before
   * hydration and were replayed into the handler when it was registered
   * (§9.5): at level 1 their `Input`s belong to the `Task{kind: 11}`.
   */
  prehydration?: number;
}

/** `DomEffect` records the interaction must cause (§9.5, §10.2). */
export interface DomEffectExpectation {
  fx: string;
  /** `DomEffect.effect`: 1 value, 2 checked. */
  effect: number;
  min: number;
}

/** A boundary read the fixture makes, at least `min` times. */
export interface ReadExpectation {
  key: string;
  min: number;
}

export interface Fixture {
  name: string;
  title: string;
  contract: string;
  steps: Step[];
  final: FinalText[];
  handlers: HandlerExpectation[];
  domEffects?: DomEffectExpectation[];
  reads: ReadExpectation[];
  /** Reads only a level-1 build makes (`Task{kind: 11}`). */
  readsAtLevel1?: ReadExpectation[];
  /**
   * The fixture runs long enough in recorded time that a checkpoint falls
   * due before the end (§7.3), so the `checkpoints` check requires one
   * before the final checkpoint.
   */
  midSessionCheckpoint?: boolean;
}

const click = (fx: string): Step => ({ op: "click", fx });
const waitFor = (fx: string, text: string): Step => ({
  op: "waitFor",
  fx,
  text,
});

/** The fixtures, in report order. */
export const FIXTURES: readonly Fixture[] = [
  {
    name: "counter",
    title: "Counter clicks",
    contract:
      'On load, reads `localStorage.getItem("ct-fixture-count")` once (absent: ' +
      "the count starts at 0) and shows the count in `count`. A `click` handler on the button `inc` adds one to the count, reads `Date.now()` once and shows the new count.",
    steps: [click("inc"), click("inc"), click("inc")],
    final: [{ fx: "count", text: "3" }],
    handlers: [{ type: "click", fx: "inc", count: 3 }],
    reads: [
      { key: "StorageRead:1:ct-fixture-count", min: 1 },
      { key: "Clock:1", min: 3 },
    ],
  },
  {
    name: "text-input",
    title: "Text input with default actions",
    contract:
      "A text `input` `name` whose `input` handler reads `performance.now()` once " +
      "and shows the input's value upper-cased in `echo`. The browser's default action (the typed character) changes the value before the handler runs.",
    steps: [{ op: "type", fx: "name", text: "hello" }],
    final: [{ fx: "echo", text: "HELLO" }],
    handlers: [{ type: "input", fx: "name", count: 5 }],
    domEffects: [{ fx: "name", effect: 1, min: 5 }],
    reads: [{ key: "Clock:2", min: 5 }],
  },
  {
    name: "password-form",
    title: "A form with a password field",
    contract:
      "A `form` `form` holding a text `input` `user`, an `input type=password` " +
      "`pass` and a submit `button` `submit`. Each input has an `input` handler that keeps its value in the page's state. The form's `submit` handler prevents the default action and sends `POST " +
      ROUTES.login +
      '` with the JSON body `{"user":…,"pass":…}`, then shows `welcome <user>` in `status` from the answer.',
    steps: [
      { op: "type", fx: "user", text: "ada" },
      { op: "type", fx: "pass", text: "s3cret" },
      click("submit"),
    ],
    final: [{ fx: "status", text: "welcome ada" }],
    handlers: [
      { type: "input", fx: "user", count: 3 },
      { type: "input", fx: "pass", count: 6 },
      { type: "submit", fx: "form", count: 1 },
    ],
    domEffects: [
      { fx: "user", effect: 1, min: 3 },
      { fx: "pass", effect: 1, min: 6 },
    ],
    reads: [
      { key: `NetRequest:1:POST:${ROUTES.login}`, min: 1 },
      { key: "TaskReg:4", min: 1 },
      { key: "Task:4", min: 1 },
      { key: `NetResponse:${ROUTES.login}`, min: 1 },
    ],
  },
  {
    name: "fetch-list",
    title: "A fetch-driven list",
    contract:
      "On load, and on each `click` of the button `reload`, fetches `GET " +
      ROUTES.items +
      "`, renders one `li` per item in the list `list`, reads `list`'s `getBoundingClientRect()` once, and shows the number of loads so far in `loads` and `<n> items` in `summary`.",
    steps: [waitFor("loads", "1"), click("reload"), waitFor("loads", "2")],
    final: [
      { fx: "loads", text: "2" },
      { fx: "summary", text: "3 items" },
    ],
    handlers: [{ type: "click", fx: "reload", count: 1 }],
    reads: [
      { key: `NetRequest:1:GET:${ROUTES.items}`, min: 2 },
      { key: "TaskReg:4", min: 2 },
      { key: "Task:4", min: 2 },
      { key: `NetResponse:${ROUTES.items}`, min: 2 },
      { key: "LayoutRead:getBoundingClientRect@list", min: 2 },
    ],
  },
  {
    name: "timers",
    title: "Timers and animation frames",
    contract:
      "A `click` handler on the button `start` reads `Date.now()`, then sets a " +
      "50 ms `setTimeout`, whose callback requests one animation frame, whose callback starts a 300 ms `setInterval`. Each interval tick reads `Date.now()` and shows the number of ticks in `ticks`; the eighth clears the interval.",
    steps: [click("start"), waitFor("ticks", "8")],
    final: [{ fx: "ticks", text: "8" }],
    handlers: [{ type: "click", fx: "start", count: 1 }],
    reads: [
      { key: "TaskReg:1", min: 1 },
      { key: "Task:1", min: 1 },
      { key: "TaskReg:3", min: 1 },
      { key: "Task:3", min: 1 },
      { key: "Clock:4", min: 1 },
      { key: "TaskReg:2", min: 1 },
      { key: "Task:2", min: 8 },
      { key: "Clock:1", min: 9 },
    ],
    midSessionCheckpoint: true,
  },
  {
    name: "prehydration",
    title: "A click before hydration",
    contract:
      "The page shows the button `early` and the count `clicks` (0) before it " +
      "hydrates. Before hydrating it fetches `GET " +
      ROUTES.hydrateGate +
      "`, which the harness answers only after the first click; a `click` on `early` before then is queued and replayed into the handler once it is registered. The `click` handler reads `Date.now()` once and shows the number of clicks.",
    steps: [
      { op: "waitForGateRequest" },
      click("early"),
      { op: "releaseGate" },
      waitFor("clicks", "1"),
      click("early"),
      waitFor("clicks", "2"),
    ],
    final: [{ fx: "clicks", text: "2" }],
    handlers: [{ type: "click", fx: "early", count: 2, prehydration: 1 }],
    reads: [
      { key: `NetRequest:1:GET:${ROUTES.hydrateGate}`, min: 1 },
      { key: "TaskReg:4", min: 1 },
      { key: "Task:4", min: 1 },
      { key: "Clock:1", min: 2 },
    ],
    readsAtLevel1: [{ key: "Task:11", min: 1 }],
  },
  {
    name: "client-nodes",
    title: "Client-created nodes",
    contract:
      "A `click` handler on the button `add` creates a row in the list `rows` " +
      "with the client's own code, labelled with `Math.random()` (read once), holding a button `row-done-<n>` (n from 1) whose `click` handler marks the row done; `done-count` shows how many rows are done. These elements exist only on the client: at level 1 they are addressed by `ord:` (or by a stable id the framework gives client-created nodes, §9.3).",
    steps: [click("add"), click("add"), click("add"), click("row-done-2")],
    final: [{ fx: "done-count", text: "1" }],
    handlers: [
      { type: "click", fx: "add", count: 3 },
      { type: "click", fx: "row-done-2", count: 1 },
    ],
    reads: [{ key: "Random:1", min: 3 }],
  },
  {
    name: "navigation",
    title: "pushState navigation",
    contract:
      "Two links, `nav-about` and `nav-home`, whose `click` handlers prevent the " +
      "default action, call `history.pushState` with the query `?view=about` or `?view=home` and show the view's name in `view`; a `popstate` listener shows the view of the restored URL. The interaction ends with the browser's back button, a `popstate` the browser dispatches.",
    steps: [
      click("nav-about"),
      waitFor("view", "about"),
      click("nav-home"),
      waitFor("view", "home"),
      { op: "goBack" },
      waitFor("view", "about"),
    ],
    final: [{ fx: "view", text: "about" }],
    handlers: [
      { type: "click", fx: "nav-about", count: 1 },
      { type: "click", fx: "nav-home", count: 1 },
    ],
    reads: [
      { key: "Navigation:1", min: 2 },
      { key: "Navigation:3", min: 1 },
      { key: "Task:12", min: 1 },
    ],
  },
];

/** The fixture named `name`. Throws for an unknown name. */
export function fixtureNamed(name: string): Fixture {
  const f = FIXTURES.find((x) => x.name === name);
  if (f === undefined) {
    throw new Error(
      `no fixture named ${JSON.stringify(name)}; the fixtures are ${FIXTURES.map((x) => x.name).join(", ")}`,
    );
  }
  return f;
}
