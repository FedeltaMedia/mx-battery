#!/usr/bin/env python3
"""
HID++ battery reader for Logitech MX Master 3S and MX Keys S via Logi Bolt receiver.

Protocol:
  - Vendor 0x046D, Product 0xC548 (Logi Bolt), usage_page 0xFF00
  - Feature 0x1004 (Unified Battery) lives at feature index 0x08
  - device_idx 0x01 = MX Keys S keyboard
  - device_idx 0x02 = MX Master 3S mouse
  - Request:  [0x10, device_idx, 0x08, 0x11, 0x00, 0x00, 0x00]
  - Response byte 4 = battery percentage

Usage:
    battery.py mouse      -> prints integer 0-100 to stdout
    battery.py keyboard   -> prints integer 0-100 to stdout
    Prints -1 on any error.
"""
import sys
import time
import hid

VENDOR_ID  = 0x046D
PRODUCT_ID = 0xC548
USAGE_PAGE = 0xFF00

DEVICE_IDX = {
    "mouse":    0x02,  # MX Master 3S
    "keyboard": 0x01,  # MX Keys S
}

FEATURE_IDX   = 0x08   # index of feature 0x1004 (Unified Battery) in firmware table
FUNCTION_GET_STATUS = 0x11  # (fn=1 << 4) | 0x01


def find_device_path():
    for info in hid.enumerate(VENDOR_ID, PRODUCT_ID):
        if info["usage_page"] == USAGE_PAGE:
            return info["path"]
    return None


def flush(dev, attempts=20):
    for _ in range(attempts):
        if not dev.read(64):
            break


def get_battery(device_type: str) -> int:
    device_idx = DEVICE_IDX.get(device_type)
    if device_idx is None:
        return -1

    path = find_device_path()
    if path is None:
        return -1

    dev = hid.device()
    try:
        dev.open_path(path)
        dev.set_nonblocking(True)

        flush(dev)

        msg = [0x10, device_idx, FEATURE_IDX, FUNCTION_GET_STATUS, 0x00, 0x00, 0x00]
        dev.write(msg)
        time.sleep(0.3)

        response = dev.read(64)
        if response and len(response) > 4:
            return int(response[4])
        return -1
    except Exception:
        return -1
    finally:
        dev.close()


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in DEVICE_IDX:
        sys.stderr.write("Usage: battery.py mouse|keyboard\n")
        print(-1)
        sys.exit(1)

    print(get_battery(sys.argv[1]))
