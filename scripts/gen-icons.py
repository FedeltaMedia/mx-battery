#!/usr/bin/env python3
"""
Generates all PNG icons for the MX Battery Stream Deck plugin.
Run once from the repo root: python3 scripts/gen-icons.py
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = "com.fedeltamedia.mxbattery.sdPlugin/imgs"
GREEN  = "#4CAF50"
WHITE  = "#FFFFFF"
GRAY   = "#AAAAAA"
BG     = (30, 30, 30, 255)
TRANSP = (0, 0, 0, 0)


def font(size):
    for path in [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSDisplay.ttf",
        "/System/Library/Fonts/Arial.ttf",
    ]:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            pass
    return ImageFont.load_default()


def hex_to_rgba(h, a=255):
    h = h.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (r, g, b, a)


def draw_battery(draw, x, y, w, h, fill_pct, color_hex, stroke=4):
    """Draw a horizontal battery icon."""
    c = hex_to_rgba(color_hex)
    nub_w = max(4, w // 8)
    nub_h = h // 3

    # Nub (positive terminal)
    nub_x = x + w
    nub_y = y + (h - nub_h) // 2
    draw.rounded_rectangle([nub_x, nub_y, nub_x + nub_w, nub_y + nub_h], radius=2, fill=c)

    # Outline
    draw.rounded_rectangle([x, y, x + w, y + h], radius=6, outline=c, width=stroke)

    # Fill bar
    pad = stroke + 1
    fill_w = max(0, int((fill_pct / 100) * (w - 2 * pad)))
    if fill_pct > 0:
        draw.rounded_rectangle(
            [x + pad, y + pad, x + pad + fill_w, y + h - pad],
            radius=4, fill=(*hex_to_rgba(color_hex)[:3], 217)
        )


def make_icon(size, label_top, label_bottom, fill_pct=75, color=GREEN):
    img = Image.new("RGBA", (size, size), BG)
    draw = ImageDraw.Draw(img)

    # Battery dimensions
    margin = size // 8
    bw = size - 2 * margin - size // 8
    bh = size // 3
    bx = margin
    by = (size - bh) // 2

    draw_battery(draw, bx, by, bw, bh, fill_pct, color, stroke=max(2, size // 36))

    # Top label (device type)
    if label_top:
        f = font(size // 7)
        bbox = draw.textbbox((0, 0), label_top, font=f)
        tw = bbox[2] - bbox[0]
        draw.text(((size - tw) // 2, by - size // 6), label_top, fill=WHITE, font=f)

    # Bottom label (e.g. "Battery")
    if label_bottom:
        f2 = font(size // 9)
        bbox = draw.textbbox((0, 0), label_bottom, font=f2)
        tw = bbox[2] - bbox[0]
        draw.text(((size - tw) // 2, by + bh + size // 16), label_bottom, fill=GRAY, font=f2)

    return img


def make_plugin_icon(size):
    """Plugin/marketplace icon: battery with MX lettering."""
    img = Image.new("RGBA", (size, size), BG)
    draw = ImageDraw.Draw(img)

    margin = size // 10
    bw = size - 2 * margin - size // 8
    bh = size // 3
    bx = margin
    by = (size - bh) // 2

    draw_battery(draw, bx, by, bw, bh, 80, GREEN, stroke=max(3, size // 48))

    f = font(size // 5)
    text = "MX"
    bbox = draw.textbbox((0, 0), text, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((size - tw) // 2, by + (bh - th) // 2 - 2), text, fill=WHITE, font=f)

    return img


def make_category_icon(size):
    """Small category icon: just the battery outline with no text."""
    img = Image.new("RGBA", (size, size), TRANSP)
    draw = ImageDraw.Draw(img)

    margin = size // 8
    bw = size - 2 * margin - size // 8
    bh = size // 3
    bx = margin
    by = (size - bh) // 2

    draw_battery(draw, bx, by, bw, bh, 80, GREEN, stroke=max(2, size // 32))
    return img


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG")
    print(f"  wrote {path}")


if __name__ == "__main__":
    print("Generating icons...")

    # Plugin / marketplace icons
    save(make_plugin_icon(288), f"{OUT}/plugin/marketplace.png")
    save(make_plugin_icon(576), f"{OUT}/plugin/marketplace@2x.png")

    # Category icons
    save(make_category_icon(54),  f"{OUT}/plugin/category-icon.png")
    save(make_category_icon(108), f"{OUT}/plugin/category-icon@2x.png")

    # Mouse action icon
    save(make_icon(72,  "Mouse", None, fill_pct=80), f"{OUT}/actions/mouse/icon.png")
    save(make_icon(144, "Mouse", None, fill_pct=80), f"{OUT}/actions/mouse/icon@2x.png")

    # Keyboard action icon
    save(make_icon(72,  "Keys", None, fill_pct=80), f"{OUT}/actions/keyboard/icon.png")
    save(make_icon(144, "Keys", None, fill_pct=80), f"{OUT}/actions/keyboard/icon@2x.png")

    print("Done.")
