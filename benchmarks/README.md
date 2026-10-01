# Benchmarks & Performance Instrumentation (`benchmarks`)

This directory houses automated performance benchmarks and instrumentation tools.

## Key Metrics

The primary end-to-end efficiency metric for LumaLink is **Verified Goodput**:

$$\text{Verified Goodput} = \frac{\text{Verified Original File Bytes}}{\text{Total Wall-Clock Transfer Time}}$$

Future benchmarks will track:

- FEC encoding/decoding throughput (symbols/sec, MB/s)
- Packet serialization overhead
- Cryptographic AEAD encryption/decryption throughput
- End-to-end simulated optical transmission goodput

## Status

**Phase 0 Status**: Initial directory structure created. Benchmarking suites will be added alongside core algorithms.
