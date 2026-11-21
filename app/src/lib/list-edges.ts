// Which ends of a scrolling list have rows past them. The wide layout's sidebar draws a line at such an end, so
// rows go under an edge. Without one they were cut off in mid-air: under the search field once the list was
// scrolled, and above the Deep work switch whenever the list was longer than its space.

export type ListEdges = { above: boolean; below: boolean };
export const NO_EDGES: ListEdges = { above: false, below: false };

/**
 * `offset` is how far the list is scrolled, `viewport` the height that shows and `content` the height of
 * everything in it. Half a point of slack takes up layouts that do not land on whole points; a list that has
 * not been measured yet has nothing past either end.
 */
export function listEdges(offset: number, viewport: number, content: number): ListEdges {
  if (!(viewport > 0) || !(content > 0)) return NO_EDGES;
  return { above: offset > 0.5, below: content - viewport - offset > 0.5 };
}

export const sameEdges = (a: ListEdges, b: ListEdges) => a.above === b.above && a.below === b.below;
