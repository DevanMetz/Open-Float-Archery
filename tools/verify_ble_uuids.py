"""Check compiled ARM32 firmware GATT and advertising UUIDs against its clients.

Reads the ELF symbol/section tables using only Python's standard library. It
does not connect to a sensor or modify the image. Keep the unstripped ELF from
the NCS build: symbols identify the actual UUID objects and advertising data.
"""

import argparse
from pathlib import Path
import re
import struct
from uuid import UUID


def read_image(path):
    image = path.read_bytes()
    assert image[:6] == b"\x7fELF\x01\x01", "Expected a little-endian ELF32 image"
    assert struct.unpack_from("<H", image, 18)[0] == 40, "Expected ARM firmware"
    section_offset = struct.unpack_from("<I", image, 32)[0]
    section_stride, section_count = struct.unpack_from("<HH", image, 46)
    assert section_stride == 40, "Unexpected ELF32 section-header size"
    sections = [struct.unpack_from("<10I", image, section_offset + index * section_stride)
                for index in range(section_count)]
    symbols = {}
    for section in sections:
        if section[1] != 2:  # SHT_SYMTAB
            continue
        strings = sections[section[6]]
        names = image[strings[4]:strings[4] + strings[5]]
        assert section[9] == 16, "Unexpected ELF32 symbol size"
        for offset in range(section[4], section[4] + section[5], section[9]):
            name, address, size, info, _, _ = struct.unpack_from("<IIIBBH", image, offset)
            if info & 15 == 1:  # STT_OBJECT
                text = names[name:names.index(0, name)].decode("ascii")
                symbols.setdefault(text, []).append((address, size))

    def bytes_at(address, size):
        for section in sections:
            if section[2] & 2 and section[1] != 8 and section[3] <= address and address + size <= section[3] + section[5]:
                offset = section[4] + address - section[3]
                return image[offset:offset + size]
        raise AssertionError(f"No initialized section contains address 0x{address:x}")

    def object_bytes(name):
        matches = symbols.get(name, [])
        assert len(matches) == 1, f"Expected one {name} object in an unstripped ELF"
        return bytes_at(*matches[0])

    return object_bytes, bytes_at


def verify(path):
    object_bytes, bytes_at = read_image(path)
    actual = {}
    for name in ("SERVICE", "LIVE", "CONTROL"):
        value = object_bytes(f"openfloat_{name.lower()}_uuid")
        assert len(value) == 17 and value[0] == 2, "Expected Zephyr bt_uuid_128"
        actual[name] = str(UUID(bytes=value[1:][::-1]))
        print(f"Compiled {name.lower()} UUID: {actual[name]}")

    repo = Path(__file__).resolve().parents[1]
    clients = {
        "app/device/adapters.js": r'^const OPENFLOAT_(SERVICE|LIVE|CONTROL) = "([^"]+)";',
        "tools/openfloat_ble_client.py": r'^OPENFLOAT_(SERVICE|LIVE|CONTROL)_UUID = "([^"]+)"',
        "tools/verify_offline_queue.py": r'^OPENFLOAT_(SERVICE|LIVE|CONTROL)_UUID = "([^"]+)"',
    }
    for file, pattern in clients.items():
        expected = dict(re.findall(pattern, (repo / file).read_text(encoding="utf-8"), re.MULTILINE))
        assert expected == actual, f"Compiled UUIDs disagree with {file}: {expected}"

    # ARM32 struct bt_data has type/length bytes, two padding bytes, then a pointer.
    advertising = object_bytes("ad")
    assert len(advertising) % 8 == 0, "Unexpected ARM32 bt_data layout"
    services = []
    for offset in range(0, len(advertising), 8):
        kind, length, address = struct.unpack_from("<BB2xI", advertising, offset)
        if kind == 7:  # BT_DATA_UUID128_ALL
            assert length == 16, "Expected one advertised 128-bit service UUID"
            services.append(str(UUID(bytes=bytes_at(address, length)[::-1])))
    assert services == [actual["SERVICE"]], f"Advertising and GATT UUIDs differ: {services}"
    print("Verified GATT and advertised UUID bytes against browser and Python clients.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("elf", type=Path, help="Unstripped firmware/zephyr/zephyr.elf from the NCS build")
    verify(parser.parse_args().elf)
