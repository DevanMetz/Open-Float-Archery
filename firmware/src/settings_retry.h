/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_SETTINGS_RETRY_H
#define OPENFLOAT_SETTINGS_RETRY_H

#include <stddef.h>
#include <stdint.h>

enum openfloat_setting {
	SETTING_SHOTS, SETTING_SHOTLOG, SETTING_WAKESENS, SETTING_SLEEPTIME,
	SETTING_SLEEPSENS, SETTING_BUFRATE, SETTING_BUFNVS, SETTING_AUTOSLEEP,
	SETTING_STREAMRATE, SETTING_FOLLOWMS, SETTING_CANT_OFFSET, SETTING_PITCH_OFFSET,
	SETTING_COUNT,
};
#define SETTINGS_ALL ((UINT32_C(1) << SETTING_COUNT) - 1)
#define SETTINGS_RETRY_DELAY_MS 1000
#define SETTINGS_RETRY_ATTEMPTS 3

/* Caller serializes queue operations. Each new value gets a fresh token and
 * budget; obsolete I/O results cannot clear/retry its replacement. Deadlines
 * use wrapping milliseconds, with intervals always below INT32_MAX.
 */
struct settings_retry {
	uint32_t pending_mask, failed_mask;
	uint32_t token[SETTING_COUNT], due_ms[SETTING_COUNT];
	uint8_t attempts[SETTING_COUNT], next_key;
};

void settings_retry_request(struct settings_retry *queue, uint32_t mask, uint32_t now_ms);
/* Returns a ready key or -1. Ready keys rotate so one busy key cannot starve
 * the others. Failed keys wait their own deadline even after unrelated updates.
 */
int settings_retry_take(struct settings_retry *queue, uint32_t now_ms, uint32_t *token);
void settings_retry_finish(struct settings_retry *queue, enum openfloat_setting key,
			   uint32_t token, int result, uint32_t now_ms);
/* Zero if some key is ready, UINT32_MAX if none are pending, else next delay. */
uint32_t settings_retry_delay(const struct settings_retry *queue, uint32_t now_ms);
/* Only after sealing updates and draining I/O: account for a final sleep write.
 * A failed final batch remains unsaved without starting another immediate loop.
 */
void settings_retry_settle(struct settings_retry *queue, enum openfloat_setting key, int result);

const char *settings_retry_key(enum openfloat_setting key);
struct sleep_flush_values;
/* The existing twelve Settings layouts, shared by ordinary saves and sleep. */
int settings_retry_save(enum openfloat_setting key, const struct sleep_flush_values *values,
			int (*write)(void *context, const char *key, const void *data, size_t size), void *context);

#endif
