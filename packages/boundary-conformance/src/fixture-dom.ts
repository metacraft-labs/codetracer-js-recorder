/**
 * The one DOM helper the fixture apps share: the element a fixture names
 * by `data-fx`. Throws when the page lacks it, so a broken page fails the
 * `interaction` check rather than running half a fixture.
 */
export function fx(name: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(`[data-fx="${name}"]`);
  if (el === null) throw new Error(`the page has no [data-fx="${name}"]`);
  return el as HTMLElement;
}
