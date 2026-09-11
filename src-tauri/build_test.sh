#!/bin/bash
cd "$(dirname "$0")"
export RUST_BACKTRACE=full
cargo build 2>&1 | tee build_output.log
