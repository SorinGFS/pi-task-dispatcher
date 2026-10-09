/**
 * Decode UTF-8 JSONL test streams with LF as the only record delimiter.
 */

/** Deliver complete LF-framed records while preserving raw Unicode JSON string content. */
export async function readStrictJsonl(input, onRecord) {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let tail = "";

	/** Emit buffered records and remove at most one CR from each LF terminator. */
	const emitRecords = async () => {
		let lineFeed = tail.indexOf("\n");
		// Drain complete LF-framed records before retaining an incomplete tail.
		while (lineFeed !== -1) {
			const record = tail.slice(0, lineFeed);
			tail = tail.slice(lineFeed + 1);
			await onRecord(record.endsWith("\r") ? record.slice(0, -1) : record);
			lineFeed = tail.indexOf("\n");
		}
	};

	// Decode chunks incrementally so an incomplete multibyte character cannot become replacement text.
	for await (const chunk of input) {
		tail += decoder.decode(chunk, { stream: true });
		await emitRecords();
	}
	// Flush pending decoder bytes before deciding whether the final record was properly framed.
	tail += decoder.decode();
	await emitRecords();
	// Reject a nonempty EOF tail instead of accepting an ambiguous partial JSON record.
	if (tail !== "") throw new Error("Strict JSONL input ended with an unterminated tail.");
}
