/**
 * The headless Chromium the harness drives, through playwright-core: the
 * replay runner's loader (`@codetracer/boundary-replay`), shared so the two
 * legs launch the browser one way.
 */

export {
  loadPlaywright,
  type Browser,
  type BrowserContext,
  type Page,
  type Playwright,
} from "@codetracer/boundary-replay";
