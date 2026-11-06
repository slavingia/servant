import test from "node:test";
import assert from "node:assert/strict";
import { fitInside, pathFor, strokeWidthFor, toFraction, type Point } from "./sketch-geometry.ts";

const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

test("the picture keeps its shape and fits the room it has", () => {
  const roomy = fitInside(300, 600, 1170, 2532);           // a tall phone picture in a 300 x 600 area is limited by the height
  assert.ok(Math.abs(roomy.height - 600) < 1e-9 && Math.abs(roomy.width / roomy.height - 1170 / 2532) < 1e-9);
  const tall = fitInside(400, 300, 1170, 2532);           // keyboard open: the area is short, so the picture gets narrower
  assert.ok(Math.abs(tall.width / tall.height - 1170 / 2532) < 1e-9);
  assert.ok(tall.height <= 300 && tall.width <= 400);
  assert.deepEqual(fitInside(0, 500, 100, 100), { width: 0, height: 0 });
  assert.deepEqual(fitInside(500, 500, 0, 100), { width: 0, height: 0 });
});

test("a mark stays on the same part of the picture when the picture is drawn at another size", () => {
  const big = fitInside(390, 700, 1170, 2532);
  const small = fitInside(390, 380, 1170, 2532);           // as if the keyboard took half the screen
  // Someone circles the top-right corner of the picture at the big size.
  const touches = [[big.width * 0.8, big.height * 0.1], [big.width * 0.9, big.height * 0.15], [big.width * 0.85, big.height * 0.2]];
  const stored: Point[] = touches.map(([x, y]) => toFraction(x, y, big.width, big.height));
  const bigPath = numbers(pathFor(stored, big.width, big.height));
  const smallPath = numbers(pathFor(stored, small.width, small.height));
  for (let i = 0; i < bigPath.length; i += 2) {
    assert.ok(Math.abs(bigPath[i] / big.width - smallPath[i] / small.width) < 0.002, "same share across");
    assert.ok(Math.abs(bigPath[i + 1] / big.height - smallPath[i + 1] / small.height) < 0.002, "same share down");
  }
  // And flattening it onto the full-size screenshot lands on the same spot too.
  const full = numbers(pathFor(stored, 1170, 2532));
  assert.ok(Math.abs(full[0] / 1170 - 0.8) < 0.001 && Math.abs(full[1] / 2532 - 0.1) < 0.001);
});

test("touches outside the picture are held at its edge, and a lone touch is a dot", () => {
  assert.deepEqual(toFraction(-20, 999, 100, 200), { x: 0, y: 1 });
  assert.deepEqual(toFraction(5, 5, 0, 0), { x: 0, y: 0 });
  assert.equal(pathFor([], 100, 100), "");
  assert.equal(pathFor([{ x: 0.5, y: 0.25 }], 200, 400), "M100.0 100.0 L100.0 100.0");
});

test("the pen is the same share of the picture at any size, never thinner than 2", () => {
  assert.ok(Math.abs(strokeWidthFor(360) - 3.96) < 0.01);
  assert.ok(Math.abs(strokeWidthFor(1170) / 1170 - strokeWidthFor(390) / 390) < 1e-9);
  assert.equal(strokeWidthFor(50), 2);
});
