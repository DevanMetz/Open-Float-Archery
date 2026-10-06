/* SPDX-License-Identifier: Apache-2.0 */
#ifdef _WIN32
#define _CRT_SECURE_NO_WARNINGS
#endif
#include "control_values.h"
#include <assert.h>
#include <stdio.h>

int main(void)
{
	const struct { const char *text; int32_t value; } integers[] = {
		{"0", 0}, {"+0", 0}, {"-0", 0}, {"00052", 52}, {"+600", 600},
		{"-3000", -3000}, {"2147483647", INT32_MAX}, {"-2147483648", INT32_MIN},
	};
	for (unsigned i = 0; i < sizeof(integers) / sizeof(integers[0]); i++) {
		int32_t value = 123;
		assert(openfloat_parse_i32(integers[i].text, &value));
		assert(value == integers[i].value);
	}
	const char *invalid_integers[] = {
		"", "oops", "-", "+", " 0", "0 ", "\t1", "1\n", "1oops", "52Hz",
		"1.0", "1e2", "0x34", "--1", "+-1", "2147483648", "-2147483649",
		"4294967296", "999999999999999999999999999999", "\xff",
	};
	for (unsigned i = 0; i < sizeof(invalid_integers) / sizeof(invalid_integers[0]); i++) {
		int32_t value = -123;
		assert(!openfloat_parse_i32(invalid_integers[i], &value));
		assert(value == -123);
	}
	const struct { const char *text; float value; } fractions[] = {
		{"0", 0}, {"-0", 0}, {"2", 2}, {"+2.0", 2}, {"-2.0", -2},
		{".05", 0.05f}, {"0.50", 0.5f}, {"30.", 30}, {"2e1", 20},
		{"5E-2", 0.05f}, {"1e30", 1e30f}, {"1e-30", 1e-30f},
	};
	for (unsigned i = 0; i < sizeof(fractions) / sizeof(fractions[0]); i++) {
		float value = 123;
		assert(openfloat_parse_float(fractions[i].text, &value));
		assert(value == fractions[i].value);
	}
	const char *invalid_fractions[] = {
		"", ".", "+", "-", "nan", "NaN", "nan(1)", "-nan", "inf", "Infinity",
		"-infinity", " 2", "2 ", "\t2", "2\n", "2g", "0x1p1", "0x2",
		"2.0.0", "1e", "e1", "1+2", "1e+-2", "1e39", "-1e39", "1e-99", "\xff",
	};
	for (unsigned i = 0; i < sizeof(invalid_fractions) / sizeof(invalid_fractions[0]); i++) {
		float value = 0.15f;
		assert(!openfloat_parse_float(invalid_fractions[i], &value));
		assert(value == 0.15f);
	}
	/* Malformed toggles must never be confused with a valid disable command. */
	const char *invalid_toggles[] = {"", "oops", "0oops", "1oops", "-0", "+1", "0 ", "1.0"};
	for (unsigned i = 0; i < sizeof(invalid_toggles) / sizeof(invalid_toggles[0]); i++) {
		uint32_t value = 1;
		assert(!openfloat_parse_u32(invalid_toggles[i], &value));
		assert(value == 1);
	}
	/* Range checks cover the actual persisted units, including zero divisors,
	 * unsupported rates, and values produced by earlier malformed commands.
	 */
	const struct { const char *name; uint32_t minimum; uint32_t maximum; } ranges[] = {
		{"wakesens", 500, 8000}, {"sleeptime", 5000, 600000}, {"sleepsens", 50, 500},
		{"bufnvs", 0, 1}, {"autosleep", 0, 1}, {"followms", 0, 3000},
	};
	for (unsigned i = 0; i < sizeof(ranges) / sizeof(ranges[0]); i++) {
		assert(openfloat_valid_tuning_setting(ranges[i].name, ranges[i].minimum));
		assert(openfloat_valid_tuning_setting(ranges[i].name, ranges[i].maximum));
		if (ranges[i].minimum) {
			assert(!openfloat_valid_tuning_setting(ranges[i].name, ranges[i].minimum - 1));
		}
		assert(!openfloat_valid_tuning_setting(ranges[i].name, ranges[i].maximum + 1));
		assert(!openfloat_valid_tuning_setting(ranges[i].name, UINT32_MAX));
	}
	const uint32_t buffer_rates[] = {0, 52, 104, 208};
	for (unsigned i = 0; i < sizeof(buffer_rates) / sizeof(buffer_rates[0]); i++) {
		assert(openfloat_valid_buffer_rate(buffer_rates[i]));
		assert(openfloat_valid_tuning_setting("bufrate", buffer_rates[i]));
	}
	const uint32_t stream_dividers[] = {1, 2, 5, 10, 20};
	for (unsigned i = 0; i < sizeof(stream_dividers) / sizeof(stream_dividers[0]); i++) {
		assert(openfloat_valid_stream_divider(stream_dividers[i]));
		assert(openfloat_valid_tuning_setting("streamrate", stream_dividers[i]));
	}
	const uint32_t invalid_rates[] = {3, 51, 53, 103, 105, 207, 209, UINT32_MAX};
	for (unsigned i = 0; i < sizeof(invalid_rates) / sizeof(invalid_rates[0]); i++) {
		assert(!openfloat_valid_buffer_rate(invalid_rates[i]));
		assert(!openfloat_valid_tuning_setting("bufrate", invalid_rates[i]));
		assert(!openfloat_valid_stream_divider(invalid_rates[i]));
		assert(!openfloat_valid_tuning_setting("streamrate", invalid_rates[i]));
	}
	assert(!openfloat_valid_tuning_setting("streamrate", 0));
	assert(!openfloat_valid_tuning_setting("unknown", 1));
	/* errno from an overflow cannot poison the next valid settings write. */
	float fraction = 0;
	int32_t integer = 0;
	assert(!openfloat_parse_float("1e39", &fraction));
	assert(openfloat_parse_float("0.15", &fraction) && fraction == 0.15f);
	assert(!openfloat_parse_i32("999999999999999999999999999999", &integer));
	assert(openfloat_parse_i32("300", &integer) && integer == 300);
	puts("Control values: complete decimal values, finite thresholds, and persisted tuning ranges passed.");
	return 0;
}
