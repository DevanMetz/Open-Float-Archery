#ifdef _MSC_VER
#define _CRT_SECURE_NO_WARNINGS
#endif
#include "trace_buffer.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static struct trace_ring ring;
static struct stored_trace frozen, restored;
static uint8_t legacy[7008];

int main(int argc, char **argv)
{
	struct trace_point point = { .roll_cdeg = 123, .pitch_cdeg = -456,
		.yaw_cdeg = 789, .mic_amp = 12 };
	trace_ring_push(&ring, point, UINT32_MAX - 5);
	trace_ring_push(&ring, point, 4);
	trace_ring_freeze(&ring, &frozen, 42, 0);
	assert(frozen.count == 2 && frozen.first_time_ms == -6);
	assert(frozen.points[0].dt_ms == 0 && frozen.points[1].dt_ms == 10);
	assert(trace_restore(&restored, (const uint8_t *)&frozen, sizeof(frozen)));
	assert(memcmp(&frozen, &restored, sizeof(frozen)) == 0);
	trace_ring_push(&ring, point, 260);
	assert(ring.count == 1 && ring.points[0].dt_ms == 0);
	trace_ring_freeze(&ring, &frozen, 43, 250);
	assert(frozen.first_time_ms == 10);
	frozen.count = TRACE_CAPACITY + 1;
	assert(!trace_restore(&restored, (const uint8_t *)&frozen, sizeof(frozen)));
	assert(!trace_chunk_count(&frozen, 3));

	legacy[0] = 42; legacy[4] = 1;
	legacy[6] = 123; legacy[8] = 0x38; legacy[9] = 0xfe;
	legacy[10] = 0x15; legacy[11] = 3; legacy[12] = 12;
	assert(trace_restore(&restored, legacy, sizeof(legacy)));
	assert(restored.shot_id == 42 && restored.count == 1 && restored.flags == 0);
	assert(restored.points[0].pitch_cdeg == -456 && restored.points[0].yaw_cdeg == 789);
	assert(restored.points[0].mic_amp == 12 && restored.points[0].dt_ms == 0);
	assert(!trace_restore(&restored, legacy, sizeof(legacy) - 1));

	memset(&ring, 0, sizeof(ring));
	for (unsigned int i = 0; i < 1100; i++) {
		point.roll_cdeg = (int16_t)i;
		trace_ring_push(&ring, point, 1000 + i * 5);
	}
	trace_ring_freeze(&ring, &frozen, 44, 5000);
	assert(frozen.count == 1000 && frozen.points[0].roll_cdeg == 100);
	assert(frozen.points[999].roll_cdeg == 1099 && frozen.first_time_ms == -3500);
	assert(frozen.points[0].dt_ms == 0);
	assert(trace_chunk_count(&frozen, 1) == 0);
	assert(trace_chunk_count(&frozen, 2) == 467);
	assert(trace_chunk_count(&frozen, 3) == 535);
	uint8_t frame[TRACE_FRAME_SIZE];
	assert(!trace_build_chunk(&frozen, 1, 0, 0, frame));
	assert(!trace_build_chunk(&frozen, 3, 535, 0, frame));
	frozen.count = 692;
	assert(trace_chunk_count(&frozen, 1) == 255);
	assert(trace_build_chunk(&frozen, 1, 254, 0, frame));
	assert(frame[7] == 255 && frame[8] == 18);
	frozen.count = 693;
	assert(trace_chunk_count(&frozen, 1) == 0);

	/* Golden transfer for the actual JavaScript decoder: varied intervals,
	 * signed angles, 32-bit shot ID, and a release between recorded samples. */
	memset(&ring, 0, sizeof(ring));
	uint32_t now = 100000;
	for (unsigned int i = 0; i < 1000; i++) {
		if (i) now += i % 3 == 0 ? 19 : (i % 3 == 1 ? 10 : 5);
		point = (struct trace_point){ .roll_cdeg = (int16_t)i - 500,
			.pitch_cdeg = 1000 - (int16_t)i, .yaw_cdeg = (int16_t)(i * 3) - 1500,
			.mic_amp = (uint8_t)i };
		trace_ring_push(&ring, point, now);
	}
	trace_ring_freeze(&ring, &frozen, UINT32_C(0xfedcba98), 111000);
	assert(frozen.first_time_ms == -11000 && now == 111322);
	uint32_t crc = trace_wire_crc(&frozen);
	if (argc == 2) {
		FILE *output = fopen(argv[1], "wb");
		assert(output);
		for (uint16_t i = 0; i < trace_chunk_count(&frozen, 3); i++) {
			assert(trace_build_chunk(&frozen, 3, i, crc, frame));
			assert(fwrite(frame, 1, sizeof(frame), output) == sizeof(frame));
		}
		assert(fclose(output) == 0);
	}
	puts("Trace buffer checks passed: clock wrap, gaps, ring wrap, migration, bounds, and wire encoding.");
	return 0;
}
