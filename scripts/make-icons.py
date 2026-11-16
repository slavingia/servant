#!/usr/bin/env python3
"""Derive every icon file from the app icon.

    python3 scripts/make-icons.py            # reads and writes app/assets/

The source is app/assets/icon.png: a tennis ball on a navy field whose seam is a white S.
Everything else is cut from it, so the files cannot drift apart:

  android-icon-foreground.png  the ball and its shadow on a clear canvas, at two thirds of the icon's scale
  android-icon-background.png  the navy field alone, at the same scale
  android-icon-monochrome.png  the ball as one flat shape with the seam cut out (Android themed icons)
  notification-icon.png        the same shape, white, 96 x 96 (Android status bar)
  favicon.png                  the icon drawn closer, 48 x 48, so the ball can be made out in a browser tab

Needs Pillow and numpy. It is not part of any build or test; run it only when icon.png changes, then look
at the results.
"""
import os
import sys

import numpy as np
from PIL import Image

SIZE = 1024
# The ball in icon.png: measured from the picture (its edge is one pixel of antialiasing wide).
BALL_CENTRE = 511.5
BALL_RADIUS = 320.0
# The field is a radial gradient about this point, lighter at its centre.
FIELD_CENTRE = (512.0, 420.0)
# An adaptive icon is a 108 dp canvas of which a 72 dp circle or rounded square is shown: two thirds.
ADAPTIVE_SCALE = 72 / 108
# The seam is the only part of the ball with much blue in it.
SEAM_BLUE = 200
# A browser tab draws the icon 16 pixels wide: the ball is drawn this much larger there.
FAVICON_SCALE = 1.3


def field_model(rgb):
    """The field with no ball on it: its colour as a straight line of the distance from the gradient's centre."""
    yy, xx = np.mgrid[0:SIZE, 0:SIZE].astype(float)
    from_ball = np.hypot(xx - BALL_CENTRE, yy - BALL_CENTRE)
    distance = np.hypot(xx - FIELD_CENTRE[0], yy - FIELD_CENTRE[1])
    # Fit on the field only: clear of the ball, and clear of the shadow under it.
    clear = (from_ball > BALL_RADIUS + 15) & ~((yy > BALL_CENTRE) & (from_ball < BALL_RADIUS + 150))
    fits = [np.polyfit(distance[clear], rgb[..., channel][clear], 1) for channel in range(3)]
    return lambda d: np.stack([np.polyval(fit, d) for fit in fits], axis=-1), distance, from_ball


def scaled_grid(scale):
    """For each pixel of a canvas, where it comes from in the icon when the icon is drawn at `scale` about its middle."""
    yy, xx = np.mgrid[0:SIZE, 0:SIZE].astype(float)
    middle = (SIZE - 1) / 2
    return middle + (xx - middle) / scale, middle + (yy - middle) / scale


def inward(values, from_ball):
    """The ball's last pixel is blended with the field. Give that ring the values just inside it instead."""
    yy, xx = np.mgrid[0:SIZE, 0:SIZE].astype(float)
    ring = from_ball > BALL_RADIUS - 2
    pull = np.where(ring, (BALL_RADIUS - 3.5) / np.maximum(from_ball, 1), 1.0)
    sx = np.clip(np.rint(BALL_CENTRE + (xx - BALL_CENTRE) * pull), 0, SIZE - 1).astype(int)
    sy = np.clip(np.rint(BALL_CENTRE + (yy - BALL_CENTRE) * pull), 0, SIZE - 1).astype(int)
    return values[sy, sx]


def save(image, name, directory):
    path = os.path.join(directory, name)
    image.save(path, optimize=True)
    print(f"{path}: {image.size[0]} x {image.size[1]} {image.mode}")


def main(directory):
    icon = Image.open(os.path.join(directory, "icon.png"))
    if icon.size != (SIZE, SIZE) or icon.mode != "RGB":
        sys.exit(f"icon.png must be {SIZE} x {SIZE} RGB with no alpha (an iPhone refuses a clear icon); got {icon.size} {icon.mode}")
    rgb = np.asarray(icon).astype(float)
    model, distance, from_ball = field_model(rgb)

    # The ball, with the same one-pixel soft edge as the picture.
    ball = np.clip(BALL_RADIUS + 0.5 - from_ball, 0, 1)
    # Its shadow: how much darker the field is than the gradient says, as black of that strength.
    expected = model(distance)
    shadow = np.clip(1 - rgb.sum(-1) / expected.sum(-1), 0, 1)
    shadow[shadow < 0.012] = 0  # the fit's own noise
    alpha = ball + (1 - ball) * shadow
    colour = np.where((ball > 0)[..., None], inward(rgb, from_ball), 0.0)
    layer = np.dstack([colour, alpha * 255]).round().clip(0, 255).astype(np.uint8)
    shrunk = int(round(SIZE * ADAPTIVE_SCALE))
    foreground = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    foreground.paste(Image.fromarray(layer, "RGBA").resize((shrunk, shrunk), Image.LANCZOS), ((SIZE - shrunk) // 2, (SIZE - shrunk) // 2))
    save(foreground, "android-icon-foreground.png", directory)

    # The field at the same scale, carried on past the icon's edges by the same gradient.
    sx, sy = scaled_grid(ADAPTIVE_SCALE)
    background = model(np.hypot(sx - FIELD_CENTRE[0], sy - FIELD_CENTRE[1]))
    save(Image.fromarray(background.round().clip(0, 255).astype(np.uint8), "RGB"), "android-icon-background.png", directory)

    # One flat shape: the ball with the seam cut out of it.
    seam = inward(np.clip((rgb[..., 2] - (SEAM_BLUE - 40)) / 80, 0, 1), from_ball)
    shape = Image.fromarray((ball * (1 - seam) * 255).round().astype(np.uint8), "L")
    white = Image.new("L", (SIZE, SIZE), 255)
    mark = Image.merge("RGBA", (white, white, white, shape))
    monochrome = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    monochrome.paste(mark.resize((shrunk, shrunk), Image.LANCZOS), ((SIZE - shrunk) // 2, (SIZE - shrunk) // 2))
    save(monochrome, "android-icon-monochrome.png", directory)

    # The status bar draws only the shape, small: the ball fills the canvas.
    edge = int(round(BALL_CENTRE - BALL_RADIUS))
    save(mark.crop((edge - 8, edge - 8, SIZE - edge + 8, SIZE - edge + 8)).resize((96, 96), Image.LANCZOS), "notification-icon.png", directory)

    # Closer: the same picture about its middle, so the field is cropped and nothing has to be invented.
    cut = SIZE / FAVICON_SCALE
    box = ((SIZE - cut) / 2, (SIZE - cut) / 2, (SIZE + cut) / 2, (SIZE + cut) / 2)
    save(icon.resize((48, 48), Image.LANCZOS, box=box).convert("RGBA"), "favicon.png", directory)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "assets"))
