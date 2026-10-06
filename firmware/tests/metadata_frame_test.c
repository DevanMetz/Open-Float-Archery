/* SPDX-License-Identifier: Apache-2.0 */
#ifdef _WIN32
#define _CRT_SECURE_NO_WARNINGS
#endif
#include "metadata_frame.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void put16(uint8_t *frame, unsigned offset, uint16_t value)
{
	frame[offset] = (uint8_t)value;
	frame[offset + 1] = (uint8_t)(value >> 8);
}

int main(int argc, char **argv)
{
	assert(argc == 2);
	FILE *output = fopen(argv[1], "wb");
	assert(output);
	const uint32_t cases[][2] = {
		{0, 0}, {65535, 65535}, {65536, 65536},
		{2147483647, 0xfedcba98}, {UINT32_MAX, UINT32_MAX},
	};
	for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
		uint8_t frame[29] = {'O', 'F', 0, 2};
		put16(frame, 8, (uint16_t)-1200);
		put16(frame, 10, 250);
		put16(frame, 12, 16000);
		put16(frame, 14, 325);
		put16(frame, 16, (uint16_t)-123);
		put16(frame, 18, 456);
		put16(frame, 20, (uint16_t)-789);
		put16(frame, 26, 65535);
		uint8_t before[29]; memcpy(before, frame, sizeof(frame));
		openfloat_write_shot_counters(frame, cases[i][0], cases[i][1]);
		assert(frame[2] == 2 && memcmp(frame + 8, before + 8, 14) == 0);
		assert(memcmp(frame + 26, before + 26, 3) == 0);
		assert(fwrite(frame, 1, sizeof(frame), output) == sizeof(frame));
		frame[3] = 3;
		assert(fwrite(frame, 1, sizeof(frame), output) == sizeof(frame));
		memset(frame, 0, sizeof(frame));
		frame[0] = 'O'; frame[1] = 'F'; frame[3] = 5;
		put16(frame, 6, 7);
		put16(frame, 8, (uint16_t)cases[i][1]);
		put16(frame, 10, 1); put16(frame, 12, 3);
		put16(frame, 14, (uint16_t)(cases[i][1] >> 16)); put16(frame, 16, 4);
		memcpy(before, frame, sizeof(frame));
		openfloat_write_storage_count(frame, cases[i][0]);
		assert(frame[2] == 2 && memcmp(frame + 6, before + 6, 12) == 0);
		assert(fwrite(frame, 1, sizeof(frame), output) == sizeof(frame));
	}
	assert(fclose(output) == 0);
	puts("Metadata counter frames emitted for C-to-browser verification.");
	return 0;
}
