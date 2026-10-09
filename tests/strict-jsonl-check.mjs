/**
 * Verify the strict UTF-8 JSONL framing contract used by RPC-oriented test readers.
 */

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readStrictJsonl } from "./strict-jsonl.mjs";

const encoder = new TextEncoder();

/** Collect records from deliberately controlled byte chunks. */
async function collectRecords(chunks) {
	const records = [];
	await readStrictJsonl(Readable.from(chunks), async (record) => {
		records.push(record);
	});
	return records;
}

// Keep raw JSON string separators as payload instead of treating them as record boundaries.
const rawSeparatorValue = `before${String.fromCodePoint(0x2028)}middle${String.fromCodePoint(0x2029)}after`;
const rawSeparatorRecord = `{"value":"${rawSeparatorValue}"}`;
const separatorRecords = await collectRecords([encoder.encode(`${rawSeparatorRecord}\n`)]);
assert.deepEqual(separatorRecords, [rawSeparatorRecord]);
assert.equal(JSON.parse(separatorRecords[0]).value, rawSeparatorValue);
assert.doesNotMatch(rawSeparatorRecord, /\\u2028|\\u2029/);

// Split a four-byte character mid-sequence to require streaming UTF-8 decoding.
const multibyteRecord = JSON.stringify({ value: "split 🧪 UTF-8" });
const multibyteBytes = encoder.encode(`${multibyteRecord}\n`);
const multibyteStart = multibyteBytes.indexOf(0xf0);
assert.notEqual(multibyteStart, -1, "Expected the test record to contain a four-byte UTF-8 character.");
assert.deepEqual(
	await collectRecords([multibyteBytes.subarray(0, multibyteStart + 1), multibyteBytes.subarray(multibyteStart + 1)]),
	[multibyteRecord],
);

// Accept CRLF transport framing while returning the JSON record without its framing CR.
const crlfRecord = JSON.stringify({ framing: "crlf" });
assert.deepEqual(await collectRecords([encoder.encode(`${crlfRecord}\r\n`)]), [crlfRecord]);

// Reject a final record that has bytes but no LF terminator.
await assert.rejects(
	collectRecords([encoder.encode('{"unfinished":true}')]),
	/unterminated tail/,
);

console.log("Strict JSONL framing checks passed.");
