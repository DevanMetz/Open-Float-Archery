"""Exercise the Python bench client's byte stream without Bluetooth hardware."""

import contextlib
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from openfloat_ble_client import (
    FRAME_STRUCT,
    LIVE_V2_STRUCT,
    MAX_TEXT_LINE_BYTES,
    OpenFloatParser,
    Sample,
)


LEGACY = FRAME_STRUCT.pack(
    b"OF", 1, 1, 65535, 2573, -1200, 250, 16000,
    -192, 400, -600, 10000, -800, 600, -400, 35,
)
LIVE = LIVE_V2_STRUCT.pack(
    b"OF", 2, 1, 42, 901, -12, 3, 16, 10000, -800, 600, -400, 127,
)
EXPECTED_LEGACY = Sample(
    1, 1, 65535, None, 2573, -1200, 250, 16000,
    -12.0, 25.0, -37.5, 1.0, -0.08, 0.06, -0.04, 0, True, 35,
)
EXPECTED_LIVE = Sample(
    2, 1, 42, None, 901, -1200, 300, 1600,
    0.0, 0.0, 0.0, 1.0, -0.08, 0.06, -0.04, 0, True, 127,
)
TEXT = b"OFRAW,1,7,1000,901,-100,250,16000,-16000,32000,-8000,0,0,0,1000000,0,0,0,70000\r\n"
EXPECTED_TEXT = Sample(
    1, 1, 7, 1000, 901, -100, 250, 16000,
    -16.0, 32.0, -8.0, 1.0, 0.0, 0.0, 0.0, 0, True, 0, 70000,
)
FRAMES = ((LEGACY, EXPECTED_LEGACY), (LIVE, EXPECTED_LIVE))


def decode_chunks(chunks):
    parser = OpenFloatParser()
    samples = []
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        for chunk in chunks:
            samples.extend(parser.feed(chunk))
    return samples, output.getvalue()


class BleParserTests(unittest.TestCase):
    def test_every_two_fragment_boundary(self):
        for frame, expected in FRAMES:
            for split in range(1, len(frame)):
                with self.subTest(protocol=expected.protocol, split=split):
                    self.assertEqual(decode_chunks((frame[:split], frame[split:])), ([expected], ""))

    def test_every_three_fragment_boundary(self):
        for frame, expected in FRAMES:
            for first in range(1, len(frame) - 1):
                for second in range(first + 1, len(frame)):
                    with self.subTest(protocol=expected.protocol, first=first, second=second):
                        self.assertEqual(decode_chunks((
                            frame[:first], b"", frame[first:second], frame[second:],
                        )), ([expected], ""))

    def test_printable_binary_payload_stays_binary(self):
        frame = b"OF\x01\x01" + b"X" * 25
        expected = Sample(
            1, 1, 22616, None, 22616, 22616, 22616, 22616,
            1413.5, 1413.5, 1413.5, 2.2616, 2.2616, 2.2616, 2.2616, 0, True, 88,
        )
        for split in range(1, len(frame)):
            with self.subTest(split=split):
                self.assertEqual(decode_chunks((frame[:split], frame[split:])), ([expected], ""))

    def test_binary_payload_markers_are_not_record_boundaries(self):
        frame = bytearray(LEGACY)
        frame[8:17] = b"OF\x02\x01\n#***"
        whole = decode_chunks((bytes(frame),))
        self.assertEqual(len(whole[0]), 1)
        self.assertEqual(whole[1], "")
        self.assertEqual(decode_chunks(bytes((byte,)) for byte in frame), whole)

    def test_text_at_every_fragment_boundary(self):
        for split in range(1, len(TEXT)):
            with self.subTest(split=split):
                self.assertEqual(decode_chunks((TEXT[:split], TEXT[split:])), ([EXPECTED_TEXT], ""))
        self.assertEqual(decode_chunks(bytes((byte,)) for byte in TEXT), ([EXPECTED_TEXT], ""))

    def test_split_utf8_banner_and_generic_status_lines(self):
        data = "# caf\u00e9 ready\r\n* connected\nSettings ready\nOF\n".encode("utf-8")
        expected = ([], "# caf\u00e9 ready\n* connected\nSettings ready\nOF\n")
        self.assertEqual(decode_chunks(bytes((byte,)) for byte in data), expected)

    def test_mixed_records_and_notification_batch_sizes(self):
        shot = bytearray(29)
        shot[:4] = b"OF\x02\x02"
        shot[4:8] = b"\xff\xff\x00\x00"
        shot[24:26] = b"\xff\xff"
        data = b"# ready\n" + TEXT + LEGACY + shot + LIVE * 6 + b"* end\n"
        expected = (
            [EXPECTED_TEXT, EXPECTED_LEGACY] + [EXPECTED_LIVE] * 6,
            "# ready\nOFSHOT(ble) shot_count=4294967295 shot_id=0 shot_sequence=0\n* end\n",
        )
        for size in range(1, len(data) + 1):
            with self.subTest(size=size):
                self.assertEqual(decode_chunks(data[index:index + size]
                    for index in range(0, len(data), size)), expected)

    def test_noise_before_a_split_magic_prefix(self):
        for junk in (b"\x00\xff", b"junk", b"\x00junk"):
            for split in (1, 2, 3):
                with self.subTest(junk=junk, split=split):
                    self.assertEqual(decode_chunks((junk + LIVE[:split], LIVE[split:])), ([EXPECTED_LIVE], ""))

    def test_unsupported_frames_resynchronize_across_all_splits(self):
        for protocol, frame_type in ((0, 1), (3, 7), (255, 1), (1, 99), (2, 4), (65, 1)):
            invalid = bytes((79, 70, protocol, frame_type)) + bytes(25)
            data = invalid + LIVE
            for split in range(1, len(data)):
                with self.subTest(protocol=protocol, frame_type=frame_type, split=split):
                    self.assertEqual(decode_chunks((data[:split], data[split:])), ([EXPECTED_LIVE], ""))

    def test_oversized_text_is_skipped_until_its_line_ends(self):
        data = b"#" + b"x" * 8192 + b"\n" + TEXT
        for size in (1, 20, 120, 4096, len(data)):
            with self.subTest(size=size):
                self.assertEqual(decode_chunks(data[index:index + size]
                    for index in range(0, len(data), size)), ([EXPECTED_TEXT], ""))

    def test_binary_can_resume_after_oversized_unterminated_text(self):
        self.assertEqual(decode_chunks((b"#" + b"x" * 8192 + b"O", LIVE[1:])), ([EXPECTED_LIVE], ""))

    def test_unterminated_text_has_bounded_pending_storage(self):
        parser = OpenFloatParser()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(parser.feed(b"#"), [])
            for _ in range(100):
                self.assertEqual(parser.feed(b"x" * 120), [])
                self.assertLessEqual(len(parser.buffer), MAX_TEXT_LINE_BYTES)
            self.assertEqual(parser.feed(b"\n" + TEXT), [EXPECTED_TEXT])
        self.assertEqual(output.getvalue(), "")

    def test_empty_chunks_do_not_clear_a_pending_record(self):
        self.assertEqual(decode_chunks((b"", LIVE[:2], b"", LIVE[2:4], b"", LIVE[4:], b"")), ([EXPECTED_LIVE], ""))


if __name__ == "__main__":
    unittest.main()
