package com.lumalink.harness.transfer

/**
 * Base exception for file reassembly errors.
 * Exact parity with packages/core/src/transfer/reassembler.ts [ReassemblyError].
 */
open class ReassemblyException(message: String) : Exception(message)

/**
 * Thrown when reassembly is attempted before all required blocks have been recovered.
 * Exact parity with packages/core/src/transfer/reassembler.ts [IncompleteTransferError].
 */
class IncompleteTransferException(
    val missingBlocks: List<Long>
) : ReassemblyException(
    "Cannot reassemble file: missing ${missingBlocks.size} block(s): [${missingBlocks.take(5).joinToString(", ")}${if (missingBlocks.size > 5) "..." else ""}]"
)

/**
 * Thrown when the reassembled file's SHA-256 hash does not match the manifest digest.
 * Exact parity with packages/core/src/transfer/reassembler.ts [Sha256MismatchError].
 */
class Sha256MismatchException(
    val expected: String,
    val actual: String
) : ReassemblyException(
    "SHA-256 verification failed!\nExpected: $expected\nActual:   $actual"
)
