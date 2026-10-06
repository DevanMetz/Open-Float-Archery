#include "boot_restore.h"
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

static const char *const expected_keys[] = {
	"shots", "shotlog", "wakesens", "sleeptime", "sleepsens", "bufrate",
	"bufnvs", "autosleep", "streamrate", "followms", "cant_offset", "pitch_offset",
	"t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9",
};

struct model {
	unsigned int initializes, resets, reads, traces, commits, delays, key_index;
	unsigned int init_failures, key_failures, trace_failures, commit_failures;
	int fail_key, error;
	bool values[22], trace_ready;
};

static int initialize(void *context)
{
	struct model *model = context;
	model->initializes++;
	if (!model->init_failures) return 0;
	model->init_failures--;
	return -ENODEV;
}

static void reset(void *context)
{
	struct model *model = context;
	model->resets++;
	model->key_index = 0;
	memset(model->values, 0, sizeof(model->values));
	model->trace_ready = false;
}

static int restore_setting(void *context, const char *key)
{
	struct model *model = context;
	unsigned int index = model->key_index++;
	assert(index < 22 && !strcmp(key, expected_keys[index]));
	assert(!model->values[index]); /* A partial earlier pass was reset. */
	model->reads++;
	if ((int)index == model->fail_key && model->key_failures) {
		model->key_failures--;
		return model->error;
	}
	model->values[index] = true;
	return 0;
}

static int restore_traces(void *context)
{
	struct model *model = context;
	assert(model->key_index == 22 && !model->trace_ready);
	model->traces++;
	model->trace_ready = true; /* Simulate a partial callback before failure. */
	if (!model->trace_failures) return 0;
	model->trace_failures--;
	return -EIO;
}

static void retry_delay(void *context, uint32_t milliseconds)
{
	struct model *model = context;
	assert(milliseconds == 1000);
	assert(model->delays < model->initializes);
	model->delays++;
}

static int commit_recovered(void *context)
{
	struct model *model = context;
	assert(model->key_index == 22 && model->trace_ready);
	model->commits++;
	if (!model->commit_failures) return 0;
	model->commit_failures--;
	return -EIO;
}

static int run(struct model *model)
{
	const struct boot_restore_io io = {
		.context = model, .initialize = initialize, .reset = reset,
		.restore_setting = restore_setting, .restore_traces = restore_traces,
		.commit_recovered = commit_recovered, .retry_delay = retry_delay,
	};
	return boot_restore(&io);
}

static void check_passes(const struct model *model, unsigned int passes)
{
	assert(model->initializes == passes && model->resets == passes);
	assert(model->reads == 22 * passes && model->traces == passes);
	assert(model->delays == passes - 1);
}

int main(void)
{
	struct model model = { .fail_key = -1 };
	assert(!run(&model));
	check_passes(&model, 1);
	assert(model.commits == 1);
	for (unsigned int key = 0; key < 22; key++) {
		/* Errors at every ordinary and legacy key remain errors, including if
		 * some counters/traces have already been restored in the failed pass. */
		for (unsigned int failures = 1; failures <= 3; failures++) {
			model = (struct model){ .fail_key = (int)key, .key_failures = failures, .error = -EIO };
			assert(run(&model) == (failures < 3 ? 0 : -EIO));
			check_passes(&model, failures < 3 ? failures + 1 : 3);
			assert(model.commits == (failures < 3 ? 1U : 0U));
			if (failures < 3) for (unsigned int i = 0; i < 22; i++) assert(model.values[i]);
		}
		/* Malformed tunings and old traces are skipped; an unreadable count/ID
		 * or queue must never become fresh defaults followed by new writes. */
		const int errors[] = { -EBADMSG, -EMSGSIZE };
		for (unsigned int i = 0; i < 2; i++) {
			model = (struct model){ .fail_key = (int)key, .key_failures = 100, .error = errors[i] };
			assert(run(&model) == (key < 2 ? errors[i] : 0));
			check_passes(&model, key < 2 ? 3 : 1);
			assert(!model.values[key]);
			assert(model.commits == (key < 2 ? 0U : 1U));
		}
	}
	for (unsigned int failures = 1; failures <= 3; failures++) {
		model = (struct model){ .fail_key = -1, .trace_failures = failures };
		assert(run(&model) == (failures < 3 ? 0 : -EIO));
		check_passes(&model, failures < 3 ? failures + 1 : 3);
		assert(model.commits == (failures < 3 ? 1U : 0U));
	}
	for (unsigned int failures = 1; failures <= 3; failures++) {
		model = (struct model){ .fail_key = -1, .commit_failures = failures };
		assert(run(&model) == (failures < 3 ? 0 : -EIO));
		check_passes(&model, failures < 3 ? failures + 1 : 3);
		assert(model.commits == (failures < 3 ? failures + 1 : 3));
	}
	model = (struct model){ .fail_key = -1, .init_failures = 3 };
	assert(run(&model) == -ENODEV);
	assert(model.initializes == 3 && model.delays == 2 && !model.resets && !model.reads && !model.traces && !model.commits);
	model = (struct model){ .fail_key = -1, .init_failures = 2 };
	assert(!run(&model));
	assert(model.initializes == 3 && model.delays == 2 && model.resets == 1 && model.reads == 22 && model.traces == 1);
	/* An exhausted batch is callable again after the caller's longer backoff. */
	model = (struct model){ .fail_key = 0, .key_failures = 6, .error = -EIO };
	assert(run(&model) == -EIO && run(&model) == -EIO);
	assert(!run(&model));
	assert(model.initializes == 7 && model.resets == 7 && model.delays == 4);
	puts("Boot restore checks passed: all 22 keys, initialization/trace/verified-repair faults, no repair after failed reads, bounded retries, partial-RAM reset, malformed-value policy, and recovery after exhaustion.");
	return 0;
}
