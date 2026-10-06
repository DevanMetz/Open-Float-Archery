/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_CONTROL_VALUES_H
#define OPENFLOAT_CONTROL_VALUES_H

#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Parse the complete value before changing device state. strtoul alone accepts
 * negative IDs on the 32-bit target, while atoi treats malformed toggles as 0.
 * Failed conversions leave the caller's value unchanged.
 */
static inline bool openfloat_parse_u32(const char *text, uint32_t *value)
{
	if (*text < '0' || *text > '9') return false;
	char *end;
	errno = 0;
	unsigned long parsed = strtoul(text, &end, 10);
	if (errno || *end || parsed > UINT32_MAX) return false;
	*value = (uint32_t)parsed;
	return true;
}

/* Signed decimal values retain the documented lower/upper clamps for timeout
 * and follow-through commands. Whitespace, suffixes, and overflow are errors.
 */
static inline bool openfloat_parse_i32(const char *text, int32_t *value)
{
	const char *digits = text;
	if (*digits == '-' || *digits == '+') digits++;
	if (*digits < '0' || *digits > '9') return false;
	char *end;
	errno = 0;
	long parsed = strtol(text, &end, 10);
	if (errno || *end || parsed < INT32_MIN || parsed > INT32_MAX) return false;
	*value = (int32_t)parsed;
	return true;
}

/* Accept decimal fractions and exponents, but never NaN, infinity, hexadecimal
 * notation, whitespace, or a partially parsed value. Range errors are rejected
 * before a clamp or float-to-integer conversion can run.
 */
static inline bool openfloat_parse_float(const char *text, float *value)
{
	for (const char *p = text; *p; p++) {
		if ((*p < '0' || *p > '9') && *p != '.' && *p != 'e' && *p != 'E' &&
		    *p != '+' && *p != '-') return false;
	}
	char *end;
	errno = 0;
	float parsed = strtof(text, &end);
	if (errno || end == text || *end || !isfinite(parsed)) return false;
	*value = parsed;
	return true;
}

static inline bool openfloat_valid_buffer_rate(uint32_t value)
{
	return value == 0 || value == 52 || value == 104 || value == 208;
}

static inline bool openfloat_valid_stream_divider(uint32_t value)
{
	return value == 1 || value == 2 || value == 5 || value == 10 || value == 20;
}

/* Persisted values use milli-g and milliseconds. Reject corrupt or older
 * invalid values on restore so the initialized defaults remain in effect.
 */
static inline bool openfloat_valid_tuning_setting(const char *name, uint32_t value)
{
	if (!strcmp(name, "wakesens")) return value >= 500 && value <= 8000;
	if (!strcmp(name, "sleeptime")) return value >= 5000 && value <= 600000;
	if (!strcmp(name, "sleepsens")) return value >= 50 && value <= 500;
	if (!strcmp(name, "bufrate")) return openfloat_valid_buffer_rate(value);
	if (!strcmp(name, "bufnvs") || !strcmp(name, "autosleep")) return value <= 1;
	if (!strcmp(name, "streamrate")) return openfloat_valid_stream_divider(value);
	if (!strcmp(name, "followms")) return value <= 3000;
	return false;
}

#endif
