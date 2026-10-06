"""Check firmware counter bytes with the actual Python bench-client decoders."""
import contextlib
import io
import sys
from pathlib import Path

from openfloat_ble_client import OpenFloatParser, binary_frame_len, parse_binary_frame
from verify_offline_queue import StorageStatus, parse_storage_status


def printed(frame):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        assert parse_binary_frame(frame) is None, "Metadata became a live sample"
    return output.getvalue().strip()


def main():
    data = Path(sys.argv[1]).read_bytes()
    cases = [(0, 0), (65535, 65535), (65536, 65536), (2147483647, 0xfedcba98), (0xffffffff, 0xffffffff)]
    assert len(data) == len(cases) * 3 * 29
    metadata_lines = []
    for index, (count, shot_id) in enumerate(cases):
        offset = index * 3 * 29
        assert printed(data[offset:offset + 29]) == f"OFSHOT(ble) shot_count={count} shot_id={shot_id} shot_sequence=65535"
        assert printed(data[offset + 29:offset + 58]) == f"OFCOUNT(ble) shot_count={count}"
        metadata_lines.extend((
            f"OFSHOT(ble) shot_count={count} shot_id={shot_id} shot_sequence=65535",
            f"OFCOUNT(ble) shot_count={count}",
        ))
        frame = data[offset + 58:offset + 87]
        assert parse_storage_status(frame) == StorageStatus(count, 7, shot_id, True, 3, 4)
        legacy = bytearray(frame); legacy[2] = 1
        assert parse_storage_status(legacy).shot_count == count % 65536
        unknown = bytearray(frame); unknown[2] = 3
        assert parse_storage_status(unknown) is None
    for size in (1, 2, 3, 4, 20, 29, 120, len(data)):
        parser = OpenFloatParser()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            for offset in range(0, len(data), size):
                assert not parser.feed(data[offset:offset + size]), "Fragmented metadata became a live sample"
        assert output.getvalue().splitlines() == metadata_lines, f"Metadata changed at chunk size {size}"
    stored = bytearray(29); stored[:4] = b"OF\x01\x04"
    stored[6:8] = (0xba98).to_bytes(2, "little"); stored[26:28] = (0xfedc).to_bytes(2, "little")
    assert printed(stored) == "OFSTORED(ble) shot_count=0 shot_id=4275878552"
    stored[2] = 2; assert printed(stored) == ""
    assert parse_storage_status(b"OF") is None
    for protocol in (0, 3, 255):
        for frame_type in (1, 2, 3, 4, 5, 6, 7, 99):
            unknown = bytearray(29); unknown[:4] = bytes((79, 70, protocol, frame_type))
            assert binary_frame_len(unknown) is None and printed(unknown) == ""
    unknown = bytearray(20); unknown[:4] = b"OF\x03\x01"
    live = bytearray(20); live[:4] = b"OF\x02\x01"; live[4:6] = (123).to_bytes(2, "little")
    assert binary_frame_len(live) == 20
    samples = OpenFloatParser().feed(unknown + live)
    assert len(samples) == 1 and samples[0].sequence == 123 and samples[0].protocol == 2
    unknown_type = bytearray(29); unknown_type[:4] = b"OF\x01\x63"
    assert binary_frame_len(unknown_type) is None
    assert len(OpenFloatParser().feed(unknown_type + live)) == 1
    print("Verified firmware metadata with Python clients: full counters, stored IDs, version/type bounds, fragmented notifications, and stream recovery.")


if __name__ == "__main__":
    main()
