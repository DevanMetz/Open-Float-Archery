/* SPDX-License-Identifier: Apache-2.0 */
#ifdef _WIN32
#define _CRT_SECURE_NO_WARNINGS
#endif
#include "shot_control.h"
#include "shot_recovery.h"
#include "control_values.h"
#include "metadata_frame.h"
#include "trace_buffer.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>

static void write_frame(FILE *output, uint8_t type, const struct openfloat_shot_counters *counters)
{
	uint8_t frame[29] = {'O', 'F', 2, type};
	openfloat_write_shot_counters(frame, counters->count, counters->shot_id);
	assert(fwrite(frame, 1, sizeof(frame), output) == sizeof(frame));
}

static void check_id_recovery(FILE *output)
{
	static struct stored_shot_log log;
	static struct stored_trace traces[TRACE_RAM_SLOTS];
	const struct {
		uint32_t count, id, log_id, trace_id, next_count, next_id;
		bool counter_present, have_log, full_log, have_trace;
	} cases[] = {
		{ 50, 69999, 70001, 70002, 51, 70003, true, true, true, true },
		{ 0, 70004, 70000, 70003, 1, 70005, true, true, true, true },
		{ 200, 90000, 80000, 85000, 201, 90001, true, true, true, true },
		{ UINT32_MAX, UINT32_MAX - 1, UINT32_MAX, 0, UINT32_MAX, 1, true, true, true, true },
		{ 100, 0, UINT32_MAX, 0, 101, 1, true, true, true, true },
		{ 0, 0, UINT32_MAX, 0, 1, 0, false, true, true, false },
		{ 0, 0, 0, UINT32_MAX, 1, 0, false, false, false, true },
		{ 12345, 70000, 50000, 70001, 12346, 70002, true, true, false, true },
	};
	for (unsigned int i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
		memset(&log, 0, sizeof(log));
		memset(traces, 0, sizeof(traces));
		log.count = cases[i].have_log;
		log.shots[0] = (struct stored_shot){ .shot_id = cases[i].log_id, .shot_count = 65535 };
		traces[7] = (struct stored_trace){ .shot_id = cases[i].trace_id, .version = 1, .count = cases[i].have_trace };
		struct openfloat_shot_counters counters = { cases[i].count, cases[i].id };
		assert(!shot_recover_id(&counters, cases[i].counter_present, &log, cases[i].full_log, traces, TRACE_RAM_SLOTS));
		assert(counters.count == cases[i].count);
		struct openfloat_shot_counters persisted = counters;
		memset(&counters, 0, sizeof(counters));
		assert(openfloat_restore_shot_counters(&counters, (uint8_t *)&persisted, sizeof(persisted)));
		openfloat_advance_shot(&counters);
		assert(counters.count == cases[i].next_count && counters.shot_id == cases[i].next_id);
		if (cases[i].full_log && cases[i].have_log) assert(counters.shot_id != cases[i].log_id);
		if (cases[i].have_trace) assert(counters.shot_id != cases[i].trace_id);
		write_frame(output, 2, &counters);
	}
	/* Maximum backlog crossing wrap plus traces in every cyclic slot order. */
	log.count = STORED_SHOT_CAPACITY;
	for (unsigned int i = 0; i < log.count; i++) log.shots[i].shot_id = UINT32_MAX - 49 + i;
	for (unsigned int rotation = 0; rotation < TRACE_RAM_SLOTS; rotation++) {
		for (unsigned int i = 0; i < TRACE_RAM_SLOTS; i++) {
			traces[(i + rotation) % TRACE_RAM_SLOTS] = (struct stored_trace){ .shot_id = 50 + i, .version = 1, .count = 1 };
		}
		struct openfloat_shot_counters counters = { 7, UINT32_MAX - 100 };
		assert(!shot_recover_id(&counters, true, &log, true, traces, TRACE_RAM_SLOTS));
		assert(counters.count == 7 && counters.shot_id == 59);
		openfloat_advance_shot(&counters);
		assert(counters.count == 8 && counters.shot_id == 60);
	}
	/* Exact half-range cannot be ordered. Rejection leaves both counters intact
	 * even when an earlier candidate was accepted. Empty traces never fence IDs. */
	memset(traces, 0, sizeof(traces));
	log.count = 1; log.shots[0].shot_id = 8;
	traces[9] = (struct stored_trace){ .shot_id = UINT32_C(0x80000008), .version = 1, .count = 1 };
	struct openfloat_shot_counters counters = { 0, 1 }, original = counters;
	assert(shot_recover_id(&counters, true, &log, true, traces, TRACE_RAM_SLOTS) == -EBADMSG);
	assert(!memcmp(&counters, &original, sizeof(counters)));
	traces[9].count = 0;
	assert(!shot_recover_id(&counters, true, &log, true, traces, TRACE_RAM_SLOTS));
	assert(counters.count == 0 && counters.shot_id == 8);
	log.count = 0; counters = (struct openfloat_shot_counters){ 17, 0 };
	assert(!shot_recover_id(&counters, false, &log, false, traces, TRACE_RAM_SLOTS));
	assert(counters.count == 17 && counters.shot_id == 0);
}

int main(int argc, char **argv)
{
	assert(argc == 2);
	const struct {
		const char *text;
		uint32_t value;
	} valid[] = {
		{"0", 0}, {"00042", 42}, {"65535", 65535}, {"65536", 65536},
		{"2147483647", 2147483647}, {"2147483648", UINT32_C(2147483648)},
		{"4294967295", UINT32_MAX},
	};
	for (unsigned i = 0; i < sizeof(valid) / sizeof(valid[0]); i++) {
		uint32_t value = 123;
		assert(openfloat_parse_u32(valid[i].text, &value));
		assert(value == valid[i].value);
	}
	const char *invalid[] = {
		"", "-1", "+1", " 1", "1 ", "\t1", "1\n", "oops", "1oops",
		"1.5", "1e3", "0x10", "4294967296", "18446744073709551615",
		"18446744073709551616", "999999999999999999999999999999999999",
	};
	for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
		uint32_t value = UINT32_C(2147483648);
		assert(!openfloat_parse_u32(invalid[i], &value));
		assert(value == UINT32_C(2147483648));
	}
	/* A failed conversion must not poison a later valid command via errno. */
	uint32_t value = 0;
	assert(openfloat_parse_u32("4294967295", &value) && value == UINT32_MAX);
	for (unsigned i = 0; i < sizeof(valid) / sizeof(valid[0]); i++) {
		struct openfloat_shot_counters counters = {0};
		assert(openfloat_restore_shot_counters(&counters, (const uint8_t *)&valid[i].value, 4));
		assert(counters.count == valid[i].value && counters.shot_id == valid[i].value);
		openfloat_advance_shot(&counters);
		assert(counters.count == (valid[i].value == UINT32_MAX ? UINT32_MAX : valid[i].value + 1));
		assert(counters.shot_id == (uint32_t)(valid[i].value + UINT32_C(1)));
	}
	FILE *output = fopen(argv[1], "wb");
	assert(output);
	struct openfloat_shot_counters counters = {100, 70000};
	write_frame(output, 2, &counters);
	openfloat_set_shot_count(&counters, 10);
	assert(counters.count == 10 && counters.shot_id == 70000);
	/* Simulate a reboot using the same eight-byte Settings value as firmware. */
	struct openfloat_shot_counters persisted = counters;
	memset(&counters, 0, sizeof(counters));
	assert(openfloat_restore_shot_counters(&counters, (const uint8_t *)&persisted, sizeof(persisted)));
	write_frame(output, 3, &counters);
	openfloat_advance_shot(&counters);
	assert(counters.count == 11 && counters.shot_id == 70001);
	write_frame(output, 2, &counters);
	openfloat_set_shot_count(&counters, 0);
	persisted = counters;
	assert(openfloat_restore_shot_counters(&counters, (const uint8_t *)&persisted, sizeof(persisted)));
	assert(counters.count == 0 && counters.shot_id == 70001);
	write_frame(output, 3, &counters);
	openfloat_advance_shot(&counters);
	assert(counters.count == 1 && counters.shot_id == 70002);
	write_frame(output, 2, &counters);
	struct stored_trace trace = {.shot_id = counters.shot_id, .version = 1, .count = 3};
	for (uint16_t index = 0; index < trace_chunk_count(&trace, 2); index++) {
		uint8_t frame[29];
		assert(trace_build_chunk(&trace, 2, index, 0, frame));
		assert(fwrite(frame, 1, sizeof(frame), output) == sizeof(frame));
	}
	const uint8_t invalid_record[12] = {0};
	const size_t invalid_sizes[] = {0, 1, 2, 3, 5, 6, 7, 9, 12};
	for (unsigned i = 0; i < sizeof(invalid_sizes) / sizeof(invalid_sizes[0]); i++) {
		assert(!openfloat_restore_shot_counters(&counters, invalid_record, invalid_sizes[i]));
		assert(counters.count == 1 && counters.shot_id == 70002);
	}
	counters = (struct openfloat_shot_counters){UINT32_MAX - 1, UINT32_MAX};
	openfloat_advance_shot(&counters);
	assert(counters.count == UINT32_MAX && counters.shot_id == 0);
	openfloat_advance_shot(&counters);
	assert(counters.count == UINT32_MAX && counters.shot_id == 1);
	check_id_recovery(output);
	assert(fclose(output) == 0);
	puts("Shot controls: strict values, independent IDs, boot backlog/trace fencing, missing/legacy counters, count corrections, saturation/wrap, and ambiguous-ID rejection passed.");
	return 0;
}
